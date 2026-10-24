export interface EpisodeTitles {
  en: string | null;
  romaji: string | null;
  ja: string | null;
}

/** Where an episode's number came from, so a caller can judge how much to trust it. */
export type EpisodeNumberSource = 'ani' | 'provider' | 'inferred';

export interface Episode {
  title: string | null;
  alternativeTitle: string | null;
  id: string | null;
  isFiller: boolean;
  /** Global position in the series: what the player is asked to fetch and what the UI labels. */
  episodeNumber: number;
  /** AniList entry this episode belongs to, parsed out of `aniId`. */
  aniListId: string | null;
  /** Absolute number as the provider states it in `ani` (`"21/1031"` -> 1031), if parseable. */
  absoluteEpisodeNumber: number | null;
  providerEpisodeNumber: number | null;
  numberSource: EpisodeNumberSource;
  sub: boolean;
  dub: boolean;
  embedId: string | null;
  /**
   * Verbatim `ani` from the provider — `"<aniListId>/<episodeNumber>"`, which is what
   * `buildEmbedUrl` interpolates into `/embed/hd-2/ani/<value>/<type>`. Parsing it into
   * the fields above must not rewrite it, or every embed built from it breaks.
   */
  aniId: string | null;
  malId: string | null;
}

/**
 * Mirrors what the provider's JSON actually contains — the template emits `null` rather
 * than omitting keys — so fixtures and live payloads type-check the same way.
 */
export interface ZangetsuEpisodeJson {
  id?: string | number | null;
  number?: number | null;
  titles?: { en?: string; romaji?: string; ja?: string } | null;
  title?: string | null;
  alternativeTitle?: string | null;
  sub?: boolean | null;
  dub?: boolean | null;
  embed_id?: string | number | null;
  ani?: string | null;
  mal?: string | null;
  filler?: boolean | null;
}

const toPositiveInt = (value: unknown): number | null => {
  const num = typeof value === 'string' ? Number(value) : value;
  return typeof num === 'number' && Number.isFinite(num) && num >= 1 ? Math.floor(num) : null;
};

/** Provider ids are assigned in release order, so they are the only tie-break left. */
const toSortableId = (value: unknown): number => toPositiveInt(value) ?? Number.MAX_SAFE_INTEGER;

const parseAni = (raw: unknown): { aniListId: string; episodeNumber: number } | null => {
  if (typeof raw !== 'string') return null;
  const [entry, episode] = raw.split('/');
  const episodeNumber = toPositiveInt(episode);
  if (!entry || !/^\d+$/.test(entry.trim()) || episodeNumber === null) return null;
  return { aniListId: entry.trim(), episodeNumber };
};

type Draft = {
  episode: Episode;
  /** Absolute number the provider itself asserts, or null when it never said. */
  known: number | null;
  sortableId: number;
};

const mergeInto = (target: Episode, source: Episode) => {
  target.sub = target.sub || source.sub;
  target.dub = target.dub || source.dub;
  target.isFiller = target.isFiller || source.isFiller;
  target.title ??= source.title;
  target.alternativeTitle ??= source.alternativeTitle;
  target.embedId ??= source.embedId;
  target.malId ??= source.malId;
  target.absoluteEpisodeNumber ??= source.absoluteEpisodeNumber;
  target.providerEpisodeNumber ??= source.providerEpisodeNumber;
  if (target.numberSource === 'inferred' && source.numberSource !== 'inferred') {
    target.numberSource = source.numberSource;
  }
};

const toDraft = (ep: ZangetsuEpisodeJson): Draft => {
  const ani = parseAni(ep.ani);
  const providerNumber = toPositiveInt(ep.number);
  const title = ep.titles?.en || (typeof ep.title === 'string' ? ep.title : null) || null;
  const alternativeTitle =
    ep.titles?.romaji ||
    ep.titles?.ja ||
    (typeof ep.alternativeTitle === 'string' ? ep.alternativeTitle : null) ||
    null;
  const known = ani?.episodeNumber ?? providerNumber;

  return {
    known,
    sortableId: toSortableId(ep.id),
    episode: {
      title,
      alternativeTitle,
      id: ep.id !== undefined && ep.id !== null ? String(ep.id) : null,
      isFiller: Boolean(ep.filler),
      episodeNumber: known ?? 0,
      aniListId: ani?.aniListId ?? null,
      absoluteEpisodeNumber: ani?.episodeNumber ?? null,
      providerEpisodeNumber: providerNumber,
      numberSource: ani ? 'ani' : providerNumber !== null ? 'provider' : 'inferred',
      sub: Boolean(ep.sub),
      dub: Boolean(ep.dub),
      embedId: ep.embed_id !== undefined && ep.embed_id !== null ? String(ep.embed_id) : null,
      aniId: ep.ani || null,
      malId: ep.mal || null,
    },
  };
};

const byKnownThenId = (a: Draft, b: Draft) =>
  (a.known ?? Number.MAX_SAFE_INTEGER) - (b.known ?? Number.MAX_SAFE_INTEGER) ||
  a.sortableId - b.sortableId;

const byEpisodeOrder = (a: Episode, b: Episode) =>
  a.episodeNumber - b.episodeNumber || toSortableId(a.id) - toSortableId(b.id);

const UNRESOLVED = '__unresolved__';

/**
 * A row that states neither `ani` nor a number has no entry of its own, but it did come off
 * the same provider page as the rows around it, so the entry they overwhelmingly belong to
 * is the sequence it continues.
 */
const dominantEntryOf = (drafts: Draft[]): string => {
  const counts = new Map<string, number>();
  let dominant = UNRESOLVED;
  let dominantCount = 0;
  for (const draft of drafts) {
    const key = draft.episode.aniListId;
    if (key === null) continue;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (count > dominantCount) {
      dominant = key;
      dominantCount = count;
    }
  }
  return dominant;
};

/**
 * Numbering is resolved per AniList entry: an entry that never states a number inherits
 * the next slot after the highest number its siblings did assert. Falling back to the
 * array position is what produced duplicate and scattered numbers, so unnumbered items
 * are ordered by provider id instead.
 */
const assignNumbers = (drafts: Draft[]): Draft[] => {
  const dominant = dominantEntryOf(drafts);
  const byEntry = new Map<string, Draft[]>();
  for (const draft of drafts) {
    const key = draft.episode.aniListId ?? dominant;
    const bucket = byEntry.get(key);
    if (bucket) bucket.push(draft);
    else byEntry.set(key, [draft]);
  }

  const resolved: Draft[] = [];
  for (const bucket of byEntry.values()) {
    bucket.sort(byKnownThenId);
    let next = 0;
    for (const draft of bucket) {
      if (draft.known !== null) next = Math.max(next, draft.known);
    }
    for (const draft of bucket) {
      if (draft.known !== null) continue;
      draft.episode.numberSource = 'inferred';
      next += 1;
      draft.episode.episodeNumber = next;
      draft.known = next;
    }
    resolved.push(...bucket);
  }
  return resolved;
};

const dedupe = (drafts: Draft[]): Episode[] => {
  const byProviderId = new Map<string, Draft>();
  const orphans: Draft[] = [];
  for (const draft of drafts) {
    const id = draft.episode.id;
    if (id === null) orphans.push(draft);
    else {
      const seen = byProviderId.get(id);
      if (seen) mergeInto(seen.episode, draft.episode);
      else byProviderId.set(id, draft);
    }
  }

  // Two provider rows can describe the same slot under different ids; the number wins.
  const bySlot = new Map<string, Draft>();
  for (const draft of [...byProviderId.values(), ...orphans]) {
    const key = `${draft.episode.aniListId ?? '-'}:${draft.episode.episodeNumber}`;
    const seen = bySlot.get(key);
    if (seen) mergeInto(seen.episode, draft.episode);
    else bySlot.set(key, draft);
  }
  return [...bySlot.values()].sort(byKnownThenId).map(draft => draft.episode);
};

/**
 * Turns the provider's episode array into a strictly ascending, de-duplicated list keyed
 * by absolute episode number. The provider hands rows back in whatever order its template
 * rendered them, so nothing here may depend on input position.
 */
export const extractEpisodes = (episodes: ZangetsuEpisodeJson[]): Episode[] => {
  if (!Array.isArray(episodes)) return [];
  return dedupe(assignNumbers(episodes.map(toDraft)));
};

/**
 * Merges already-extracted season lists (see `services/episodeChain.ts`). Slot identity is
 * the AniList entry plus the absolute number, so two seasons that both assert episode 7 of
 * the same entry collapse instead of duplicating.
 */
export const mergeEpisodeSlots = (episodes: Episode[]): Episode[] => {
  const bySlot = new Map<string, Episode>();
  for (const episode of episodes) {
    const key = `${episode.aniListId ?? '-'}:${episode.episodeNumber}`;
    const seen = bySlot.get(key);
    if (seen) mergeInto(seen, episode);
    else bySlot.set(key, episode);
  }
  return [...bySlot.values()].sort(byEpisodeOrder);
};
