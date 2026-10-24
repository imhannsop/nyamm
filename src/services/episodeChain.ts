import { Episode, mergeEpisodeSlots } from '../extractor/extractEpisodes';
import { Season } from '../types/anime';

/**
 * How the merged numbers were derived. `ambiguous` means the seasons could not be proven to
 * line up, so the list must not be treated as one continuous series.
 */
export type EpisodeNumberBasis = 'single' | 'ani' | 'offset' | 'ambiguous';

export type EpisodeGroup = {
  id: string;
  label: string;
  kind: 'season' | 'entry';
  providerAnimeId: string | null;
  aniListId: string | null;
  numberOffset: number;
  start: number;
  end: number;
  count: number;
};

export type EpisodeChain = {
  episodes: Episode[];
  groups: EpisodeGroup[];
  numberSource: EpisodeNumberBasis;
  partial: boolean;
  truncated: boolean;
  failedSeasons: string[];
};

export type ChainOptions = {
  maxSeasons?: number;
  concurrency?: number;
  /** Wall-clock budget for the whole merge; past it the chain stops being extended. */
  deadlineMs?: number;
};

const DEFAULT_MAX_SEASONS = 20;
const HARD_MAX_SEASONS = 40;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_DEADLINE_MS = 20000;

const mapWithLimit = async <T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  expired: () => boolean
): Promise<{ results: (R | null)[]; skipped: number[] }> => {
  const results: (R | null)[] = new Array(items.length).fill(null);
  const skipped: number[] = [];
  let cursor = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      if (expired()) {
        skipped.push(index);
        continue;
      }
      try {
        results[index] = await worker(items[index], index);
      } catch {
        results[index] = null;
      }
    }
  });

  await Promise.all(runners);
  return { results, skipped };
};

const entryIdsOf = (episodes: Episode[]): Set<string> =>
  new Set(episodes.map(episode => episode.aniListId).filter((id): id is string => id !== null));

/**
 * One shared AniList entry means the provider's own numbers are already global. Disjoint
 * entries mean each season restarts and must be offset. Anything else is left ambiguous
 * rather than guessed at, because a wrong offset silently plays the wrong episode.
 */
const detectBasis = (perSeason: Set<string>[]): EpisodeNumberBasis => {
  if (perSeason.length === 0) return 'single';
  const first = perSeason[0];
  if (first.size === 1) {
    const shared = [...first][0];
    if (perSeason.every(ids => ids.size === 1 && ids.has(shared)))
      return perSeason.length === 1 ? 'single' : 'ani';
  }
  const union = new Set<string>();
  for (const ids of perSeason) {
    if (ids.size !== 1) return 'ambiguous';
    const [only] = [...ids];
    if (union.has(only)) return 'ambiguous';
    union.add(only);
  }
  return union.size === perSeason.length && union.size > 0 ? 'offset' : 'ambiguous';
};

const groupLabel = (season: Season, index: number): string =>
  (season.title || season.alternativeTitle || '').trim() || `Season ${index + 1}`;

/**
 * Fetches every season of a chain and folds them into one ascending list addressed by
 * absolute episode number, plus the season ranges the UI groups itself by.
 */
export const buildEpisodeChain = async (
  seasons: Season[],
  fetchEpisodes: (slug: string) => Promise<Episode[]>,
  options: ChainOptions = {}
): Promise<EpisodeChain> => {
  const maxSeasons = Math.min(options.maxSeasons ?? DEFAULT_MAX_SEASONS, HARD_MAX_SEASONS);
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const startedAt = Date.now();
  const expired = () => Date.now() - startedAt >= deadlineMs;

  const considered = seasons.slice(0, maxSeasons);
  const beyond = seasons.slice(considered.length);

  const { results, skipped } = await mapWithLimit(
    considered,
    options.concurrency ?? DEFAULT_CONCURRENCY,
    season => fetchEpisodes(season.id as string),
    expired
  );

  const fetched = considered.map((season, index) => ({ season, episodes: results[index] }));
  const successful = fetched.filter(
    (entry): entry is { season: Season; episodes: Episode[] } => entry.episodes !== null
  );
  const failedSeasons = [
    ...considered
      .filter(season => !successful.some(entry => entry.season === season))
      .map(season => season.id as string),
    ...beyond.map(season => season.id as string),
  ];
  const truncated = beyond.length > 0 || skipped.length > 0;
  const basis = detectBasis(successful.map(entry => entryIdsOf(entry.episodes)));

  // Cumulative offsets are only sound while nothing before them is missing, so an offset
  // chain stops at the first failed season. A shared-entry chain has no such dependency:
  // its numbers come from the provider, so a hole there is just a hole in the list.
  const firstFailure = considered.findIndex(
    season => !successful.some(entry => entry.season === season)
  );
  const usable =
    basis === 'offset' && firstFailure >= 0 ? successful.slice(0, firstFailure) : successful;

  const groups: EpisodeGroup[] = [];
  const merged: Episode[] = [];
  // Next free global slot. An offset season maps its own lowest number onto it, and is never
  // pulled below what the provider already claims for it.
  let nextSlot = 1;

  for (const entry of usable) {
    const numbers = entry.episodes.map(episode => episode.episodeNumber);
    const lowest = Math.min(...numbers);
    const shift = basis === 'offset' ? Math.max(0, nextSlot - lowest) : 0;
    let highest = lowest + shift;

    for (const episode of entry.episodes) {
      episode.episodeNumber += shift;
      highest = Math.max(highest, episode.episodeNumber);
      merged.push(episode);
    }
    nextSlot = highest + 1;

    groups.push({
      id: `s${groups.length}:${entry.season.id}`,
      label: groupLabel(entry.season, groups.length),
      kind: entry.season.isActive ? 'season' : 'entry',
      providerAnimeId: entry.season.id,
      aniListId: [...entryIdsOf(entry.episodes)][0] ?? null,
      numberOffset: shift,
      start: lowest + shift,
      end: highest,
      count: entry.episodes.length,
    });
  }

  // A hole in an offset chain would number everything after it from a wrong base, which
  // silently plays the wrong episode. Report the whole list as unmergeable instead.
  const offsetBroken = basis === 'offset' && (failedSeasons.length > 0 || truncated);
  if (offsetBroken) {
    groups.length = 0;
    merged.length = 0;
  }

  return {
    episodes:
      basis === 'ani' || basis === 'single'
        ? mergeEpisodeSlots(merged)
        : merged.sort((a, b) => a.episodeNumber - b.episodeNumber),
    groups,
    numberSource: offsetBroken ? 'ambiguous' : basis,
    partial: offsetBroken || failedSeasons.length > 0 || truncated || basis === 'ambiguous',
    truncated,
    failedSeasons,
  };
};
