import config from '../config/config';
import { createTtlCache } from '../utils/ttlCache';

const TOKEN_RE = /window\.AJAX_TOKEN\s*=\s*"([^"]+)"/;
const TIMEOUT = 15000;
const SESSION_TTL_MS = 5 * 60 * 1000;
/**
 * A session carries the whole page it was scraped from, and referer paths are per-anime
 * (`/watch/<slug>?ep=1`), so an unbounded store grows with traffic instead of with shows.
 */
const SESSION_LRU_MAX = 16;

const ua = (config.headers as Record<string, string>)?.['User-Agent'] || 'Mozilla/5.0';

const withTimeout = () => {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), TIMEOUT);
  return { signal: controller.signal, done: () => clearTimeout(id) };
};

/** Raised when the provider refuses a token it previously handed out. */
export class SessionExpiredError extends Error {
  constructor(message = 'zangetsu session rejected') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

export type ZangetsuSession = {
  token: string;
  cookie: string;
  /** Raw HTML the token was scraped from, so a caller can parse the page without refetching. */
  html: string;
  refererPath: string;
  acquiredAt: number;
};

const sessions = createTtlCache<ZangetsuSession>(SESSION_LRU_MAX);

/** Bootstraps currently in flight, so concurrent cold requests share one page fetch. */
const inflight = new Map<string, Promise<ZangetsuSession>>();

const readCookie = (res: Response): string => {
  const getter = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const rawCookies = typeof getter === 'function' ? getter.call(res.headers) : [];
  return rawCookies.map(entry => entry.split(';')[0].trim()).join('; ');
};

/** Fetches a page and scrapes a fresh token off it. */
const acquire = async (refererPath: string): Promise<ZangetsuSession> => {
  const page = withTimeout();
  // Cleared even when the fetch rejects: a dangling abort timer outlives the request that set it.
  const pageRes = await fetch(`${config.baseurl}${refererPath}`, {
    headers: {
      'User-Agent': ua,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Referer: `${config.baseurl}/home`,
    },
    signal: page.signal,
  }).finally(page.done);

  if (!pageRes.ok) throw new Error(`Session bootstrap failed: HTTP ${pageRes.status}`);

  const html = await pageRes.text();
  const token = html.match(TOKEN_RE)?.[1];
  if (!token) throw new Error('Session bootstrap failed: no page token found');

  return {
    token,
    cookie: readCookie(pageRes),
    html,
    refererPath,
    acquiredAt: Date.now(),
  };
};

/**
 * Every provider AJAX call needs a token scraped off a live page, which makes a naive
 * request two fetches: the page, then the call. Merging a season chain would otherwise
 * pay that twice per season, so the pair is cached and reused.
 */
export const bootstrapSession = async (
  refererPath = '/home',
  force = false
): Promise<ZangetsuSession> => {
  if (!force) {
    const cached = sessions.get(refererPath);
    if (cached) return cached;
    const pending = inflight.get(refererPath);
    if (pending) return pending;
  } else {
    // The caller holds a token the provider just refused, so neither a cached entry nor an
    // in-flight bootstrap started before that refusal can be handed back here.
    sessions.delete(refererPath);
  }

  const run = acquire(refererPath);
  inflight.set(refererPath, run);
  try {
    const session = await run;
    sessions.set(refererPath, session, SESSION_TTL_MS);
    return session;
  } finally {
    // Only a fulfilled session is ever kept, so one failed page fetch cannot poison the key.
    if (inflight.get(refererPath) === run) inflight.delete(refererPath);
  }
};

export const zangetsuCall = async <T>(ajaxPath: string, session: ZangetsuSession): Promise<T> => {
  const ajax = withTimeout();
  let res: Response;
  try {
    res = await fetch(`${config.baseurl}${ajaxPath}`, {
      headers: {
        'User-Agent': ua,
        Accept: 'application/json',
        Referer: `${config.baseurl}${session.refererPath}`,
        'X-Requested-With': 'XMLHttpRequest',
        'X-Page-Token': session.token,
        ...(session.cookie ? { Cookie: session.cookie } : {}),
      },
      signal: ajax.signal,
    });
  } finally {
    ajax.done();
  }

  if (res.status === 401 || res.status === 403) throw new SessionExpiredError(`HTTP ${res.status}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

  const payload = (await res.text()).trim();
  // The provider answers an expired token with an empty body rather than an error code.
  if (payload.length === 0) throw new SessionExpiredError('empty response');
  try {
    return JSON.parse(payload) as T;
  } catch {
    throw new SessionExpiredError('non-json response');
  }
};

/** One AJAX call on a known session, re-bootstrapping exactly once if it was refused. */
export const zangetsuRequest = async <T>(
  ajaxPath: string,
  session: ZangetsuSession
): Promise<T> => {
  try {
    return await zangetsuCall<T>(ajaxPath, session);
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      return zangetsuCall<T>(ajaxPath, await bootstrapSession(session.refererPath, true));
    }
    // The provider answers its largest payloads (One Piece: 1180 episodes) with a 502 now and
    // then while it rewrites them. One immediate repeat is enough to land most of them.
    if (!(err instanceof Error) || !/^HTTP 5\d\d/.test(err.message)) throw err;
    return zangetsuCall<T>(ajaxPath, session);
  }
};

export const zangetsuAjax = async <T>(
  ajaxPath: string,
  refererPath: string = '/home'
): Promise<T> => {
  const session = await bootstrapSession(refererPath);
  return zangetsuRequest<T>(ajaxPath, session);
};

export const animeNumId = (id: string): string => id.split('-').at(-1) || id;

export type ServerType = 'sub' | 'dub';

export const buildEmbedUrl = (
  serverName: string,
  episodeId: string,
  type: ServerType,
  aniId?: string | null,
  malId?: string | null
): string => {
  if (serverName === 's-2') {
    return `${config.embedCdn}/embed/hd-1/${episodeId}/${type}?k=1&autoPlay=0&skipIntro=0&skipOutro=0`;
  }
  if (serverName === 's-3') {
    const base = aniId
      ? `${config.embedCdn}/embed/hd-2/ani/${aniId}/${type}`
      : malId
        ? `${config.embedCdn}/embed/hd-2/mal/${malId}/${type}`
        : `${config.embedCdn}/embed/hd-2/${episodeId}/${type}`;
    return `${base}?k=1&autoPlay=0&skipIntro=0&skipOutro=0`;
  }
  const base = aniId
    ? `${config.flixera}/embed/ani/${aniId}/${type}`
    : malId
      ? `${config.flixera}/embed/mal/${malId}/${type}`
      : `${config.flixera}/embed/ani/${episodeId}/${type}`;
  return `${base}?autoplay=0&skipintro=0&skipoutro=0`;
};
