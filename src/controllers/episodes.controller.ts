import { Context } from 'hono';
import { validationError } from '../utils/errors';
import { extractEpisodes, Episode, ZangetsuEpisodeJson } from '../extractor/extractEpisodes';
import { extractSeasonChain, orderSeasons } from '../extractor/extractSeasonChain';
import { extractSuggestions, SuggestionAjaxResponse } from '../extractor/extractSuggestions';
import { buildEpisodeChain, EpisodeGroup, EpisodeNumberBasis } from '../services/episodeChain';
import {
  animeNumId,
  bootstrapSession,
  zangetsuRequest,
  ZangetsuSession,
} from '../services/zangetsu';
import { createTtlCache, HOUR_MS } from '../utils/ttlCache';

interface EpisodesAjaxResponse {
  success: boolean;
  episodes: ZangetsuEpisodeJson[];
}

export interface EpisodesResponse {
  animeId: string;
  aniListId: string | null;
  resolvedBy: 'slug' | 'anilist-search';
  /** One continuous ascending list addressed by absolute episode number — what the player plays. */
  episodes: Episode[];
  /** Display metadata only: which season each stretch of the list belongs to. */
  groups: EpisodeGroup[];
  firstEpisode: number;
  lastEpisode: number;
  totalEpisodes: number;
  numberSource: EpisodeNumberBasis;
  partial: boolean;
  truncated: boolean;
  failedSeasons: string[];
  seasonsConsidered: number;
}

const FULL_TTL_MS = 6 * HOUR_MS;
const PARTIAL_TTL_MS = 60_000;
const SLUG_TTL_MS = 7 * 24 * HOUR_MS;
const CANDIDATE_LIMIT = 4;

const chainCache = createTtlCache<EpisodesResponse>(64);
const slugCache = createTtlCache<string>(256);

const fetchSeasonEpisodes = async (slug: string, session: ZangetsuSession): Promise<Episode[]> => {
  const payload = await zangetsuRequest<EpisodesAjaxResponse>(
    `/ajax/episodes?animeId=${encodeURIComponent(animeNumId(slug))}`,
    session
  );
  if (!payload.success || !Array.isArray(payload.episodes)) return [];
  return extractEpisodes(payload.episodes);
};

/**
 * The provider's search matches a hyphenated show slug (`one-piece`), not a natural-language
 * query: "One Piece" returns nothing in any encoding.
 */
const slugifyKeyword = (title: string): string =>
  title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * A provider slug is `<show-slug>-<numericId>`, so the candidate whose slug *is* the searched
 * title is the show itself; films and spin-offs of the same name sort after it. Checking that
 * first matters in practice: verifying a candidate costs its whole episode list, and One
 * Piece's is 1180 rows.
 */
const isExactEntry = (slug: string, keyword: string): boolean => {
  if (!slug.startsWith(`${keyword}-`)) return false;
  return /^\d+$/.test(slug.slice(keyword.length + 1));
};

const searchCandidates = async (keyword: string, session: ZangetsuSession): Promise<string[]> => {
  const payload = await zangetsuRequest<SuggestionAjaxResponse>(
    `/ajax/search?keyword=${encodeURIComponent(keyword)}`,
    session
  );
  if (!Array.isArray(payload.response)) return [];
  const ids = extractSuggestions(payload)
    .map(entry => entry.id)
    .filter((entry): entry is string => Boolean(entry));
  return ids.sort((a, b) => Number(isExactEntry(b, keyword)) - Number(isExactEntry(a, keyword)));
};

/**
 * The provider has no AniList lookup, so the only route from an AniList id to a provider
 * entry is a title search — which is why `title` is mandatory. Candidates are accepted only
 * when their own episodes assert the requested AniList id, so a wrong title match is
 * detectable rather than silent.
 */
const resolveSlugByAniListId = async (aniListId: string, title: string): Promise<string> => {
  const cached = slugCache.get(aniListId);
  if (cached) return cached;

  // One session for the whole search: the provider takes these calls with any referer, and
  // bootstrapping per candidate would cost two fetches each.
  const session = await bootstrapSession('/home');
  const keywords = [slugifyKeyword(title), title.trim()];

  for (const keyword of keywords) {
    if (!keyword) continue;
    let candidates: string[];
    try {
      candidates = await searchCandidates(keyword, session);
    } catch (error) {
      console.warn(`episode chain: search for "${keyword}" failed`, error);
      continue;
    }

    for (const slug of candidates.slice(0, CANDIDATE_LIMIT)) {
      try {
        const episodes = await fetchSeasonEpisodes(slug, session);
        if (episodes.some(episode => episode.aniListId === aniListId)) {
          slugCache.set(aniListId, slug, SLUG_TTL_MS);
          return slug;
        }
      } catch (error) {
        // Wrong show, or the entry is unreachable: either way, try the next candidate. The
        // list is dropped, so a slow season like One Piece's 1180 rows can time out here and
        // the retry is invisible unless it's logged.
        console.warn(`episode chain: candidate "${slug}" not usable`, error);
      }
    }
  }

  throw new validationError(`no provider entry matched AniList id ${aniListId}`, {
    hint: 'pass the show title so it can be searched',
  });
};

const readMaxSeasons = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(1, Math.min(Math.floor(value), 40)) : undefined;
};

const episodesController = async (c: Context): Promise<EpisodesResponse> => {
  const id = c.req.param('id');
  if (!id) throw new validationError('id is required');

  const byAniList = /^\d+$/.test(id);
  let slug: string;
  let aniListId: string | null = null;

  if (byAniList) {
    const title = c.req.query('title')?.trim();
    if (!title) {
      throw new validationError('title is required when id is an AniList id', {
        example: '/api/v2/episodes/21?title=One%20Piece',
      });
    }
    aniListId = id;
    slug = await resolveSlugByAniListId(id, title);
  } else {
    slug = id;
  }

  const cacheKey = byAniList ? `ani:${aniListId}` : `slug:${slug}`;
  const cached = chainCache.get(cacheKey);
  if (cached) return cached;

  let session: ZangetsuSession;
  try {
    session = await bootstrapSession(`/watch/${slug}?ep=1`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    throw new validationError(message || 'make sure the id is correct', {
      validIdEX: 'one-piece-12',
    });
  }

  const seasons = orderSeasons(extractSeasonChain(session.html), slug);
  const chain = await buildEpisodeChain(
    seasons,
    seasonSlug => fetchSeasonEpisodes(seasonSlug, session),
    {
      maxSeasons: readMaxSeasons(c.req.query('maxSeasons')),
    }
  );

  // Nothing at all came back means the slug is wrong or the provider is unreachable. An
  // unmergeable chain is a different case: it answers with its relative numbers and says so.
  if (chain.episodes.length === 0 && chain.numberSource !== 'ambiguous') {
    throw new validationError('make sure the id is correct', { validIdEX: 'one-piece-12' });
  }

  const numbers = chain.episodes.map(episode => episode.episodeNumber);
  const data: EpisodesResponse = {
    animeId: slug,
    aniListId: aniListId ?? chain.groups[0]?.aniListId ?? null,
    resolvedBy: byAniList ? 'anilist-search' : 'slug',
    episodes: chain.episodes,
    groups: chain.groups,
    firstEpisode: numbers.length > 0 ? Math.min(...numbers) : 0,
    lastEpisode: numbers.length > 0 ? Math.max(...numbers) : 0,
    totalEpisodes: chain.episodes.length,
    numberSource: chain.numberSource,
    partial: chain.partial,
    truncated: chain.truncated,
    failedSeasons: chain.failedSeasons,
    seasonsConsidered: seasons.length,
  };

  // A degraded merge must not stick around: cache it briefly so the next request retries.
  chainCache.set(cacheKey, data, data.partial ? PARTIAL_TTL_MS : FULL_TTL_MS);
  return data;
};

export default episodesController;
