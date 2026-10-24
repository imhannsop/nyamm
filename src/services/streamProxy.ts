import config from '../config/config';
import { validationError } from '../utils/errors';

export const PROXY_PATH = '/api/stream-proxy';

/**
 * Only hosts the providers actually serve media from may be fetched: a public
 * proxy that accepts any URL is an SSRF primitive. Redirect targets must be
 * listed too (cdn.4animo.xyz 301s to novuscloud.buzz).
 */
const allowedHosts = new Set(config.streamHosts.map(host => host.toLowerCase()));

const MAX_REDIRECTS = 4;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * These providers answer 400/403 intermittently when a player drives many parallel
 * fragment requests. Without a retry that transient answer becomes a hard playback
 * stall, so each hop is retried with backoff (GETs only — no body to replay).
 */
const FETCH_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([400, 403, 408, 429, 500, 502, 503, 504]);
const RETRY_BASE_DELAY = 250;
/** Some edges reject our own url-as-referer and answer when told to look like the embed CDN. */
const FALLBACK_REFERER = `${config.embedCdn}/`;

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.5',
};

/**
 * Hosted runtimes terminate TLS at their edge and hand the container plain HTTP, so
 * `c.req.url` reports `http:` for an https visitor. That scheme reaches the browser via
 * the proxy URLs we mint, and mixed-content blocking kills playback before any request
 * is even attempted. Only ever upgrades: the host is left alone, and a local request
 * carries no forwarded header to begin with.
 */
export const proxyBaseFor = (requestUrl: string, forwardedProto?: string | null): string => {
  const url = new URL(requestUrl);
  const proto = forwardedProto?.split(',')[0]?.trim().replace(/:$/, '');
  if (proto === 'https') url.protocol = 'https:';
  return `${url.origin}${PROXY_PATH}`;
};

export const toProxyUrl = (proxyBase: string, target: string): string =>
  target.startsWith(proxyBase) ? target : `${proxyBase}?url=${encodeURIComponent(target)}`;

/** Validates a client-supplied target and rejects anything but the media hosts. */
export const safeStreamTarget = (raw: string | null | undefined): string => {
  const value = typeof raw === 'string' ? raw.trim().replace(/\\\//g, '/') : '';
  if (!value) throw new validationError('url is required');

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new validationError('url must be an absolute URL');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new validationError('url must be http(s)');
  }
  if (parsed.username || parsed.password) {
    throw new validationError('url must not embed credentials');
  }
  if (!allowedHosts.has(parsed.hostname.toLowerCase())) {
    throw new validationError(`host ${parsed.hostname} is not an allowed stream host`);
  }
  return parsed.toString();
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** One hop, retried. A 400/403 is re-issued with the embed CDN as Referer before giving up. */
const fetchHop = async (
  url: string,
  referer: string | undefined,
  range: string | undefined,
  signal: AbortSignal | undefined
): Promise<Response> => {
  let last: Response | null = null;

  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    if (signal?.aborted) break;

    const rejected: boolean = last !== null && (last.status === 400 || last.status === 403);
    try {
      const response: Response = await fetch(url, {
        headers: {
          ...BROWSER_HEADERS,
          Referer: rejected ? FALLBACK_REFERER : (referer ?? url),
          ...(range ? { Range: range } : {}),
        },
        redirect: 'manual',
        signal,
      });

      if (response.ok || !RETRYABLE_STATUS.has(response.status)) return response;

      // Keep the final answer's body intact — the caller still has to read it.
      if (last) void last.body?.cancel().catch(() => {});
      last = response;
    } catch (error) {
      if (signal?.aborted) break;
      last = null;
      if (attempt === FETCH_ATTEMPTS - 1) throw error;
    }

    await sleep(RETRY_BASE_DELAY * 2 ** attempt);
  }

  if (last) return last;
  throw new validationError(`request to ${new URL(url).host} failed`);
};

/**
 * Fetches with redirects resolved by us, one hop at a time, so a provider cannot
 * bounce the request to a host that never passed the allowlist.
 */
export const fetchStreamResource = async (
  target: string,
  options: { referer?: string; range?: string; signal?: AbortSignal } = {}
): Promise<{ response: Response; finalUrl: string }> => {
  let next = target;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetchHop(next, options.referer, options.range, options.signal);

    if (!REDIRECT_STATUSES.has(response.status)) return { response, finalUrl: next };

    const location = response.headers.get('location');
    void response.body?.cancel().catch(() => {});
    if (!location) throw new validationError(`redirect at hop ${hop} had no location`);
    next = safeStreamTarget(new URL(location, next).toString());
  }

  throw new validationError('too many redirects');
};

const URI_ATTRIBUTE = /URI="([^"]+)"/;

/**
 * hls.js resolves every URI against the playlist URL, which is the provider host,
 * so the browser would bypass the proxy after the first request. Rewriting each
 * URI back through the proxy keeps the whole session server-side — required for
 * providers whose playback tokens are bound to the IP that fetched them.
 */
export const rewritePlaylist = (text: string, finalUrl: string, proxyBase: string): string => {
  const wrap = (raw: string): string => {
    const value = raw.trim();
    if (!value || value.startsWith(proxyBase)) return value;
    try {
      return toProxyUrl(proxyBase, new URL(value, finalUrl).toString());
    } catch {
      return value;
    }
  };

  return text
    .split(/\r?\n/)
    .map(line => {
      const attribute = line.match(URI_ATTRIBUTE);
      if (attribute) return line.replace(URI_ATTRIBUTE, `URI="${wrap(attribute[1])}"`);
      if (!line.trim() || line.trimStart().startsWith('#')) return line;
      return wrap(line);
    })
    .join('\n');
};

/**
 * Upstream CORS/length headers are dropped on purpose: forwarding a second
 * `access-control-allow-origin` alongside the app's own CORS middleware produces
 * the `*, *` value browsers reject, and a rewritten playlist no longer matches the
 * upstream `content-length`.
 */
const FORWARD_RESPONSE_HEADERS = ['content-range', 'accept-ranges', 'cache-control', 'etag'];

export const responseHeaders = (upstream: Headers, extra: Record<string, string> = {}) => {
  const headers: Record<string, string> = { ...extra };
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const value = upstream.get(name);
    if (value) headers[name] = value;
  }
  return headers;
};
