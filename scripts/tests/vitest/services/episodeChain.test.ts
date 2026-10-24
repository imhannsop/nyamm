import { describe, it, expect } from 'vitest';
import { buildEpisodeChain } from '../../../../src/services/episodeChain';
import { extractSeasonChain, orderSeasons } from '../../../../src/extractor/extractSeasonChain';
import { extractEpisodes, ZangetsuEpisodeJson } from '../../../../src/extractor/extractEpisodes';
import { Season } from '../../../../src/types/anime';
import { mockHtmlData } from '../../data/mocks';

/**
 * Nothing here touches the network: `buildEpisodeChain` is handed a fetch stub, so these
 * cases are about the numbering rules alone.
 */
const row = (id: number, ani: string | null, number: number | null): ZangetsuEpisodeJson => ({
  id: String(id),
  ani,
  number,
  titles: { en: `Episode ${number ?? id}` },
  sub: true,
  dub: false,
  embed_id: String(id),
  filler: false,
});

const season = (id: string, title: string, isActive = false): Season => ({
  id,
  title,
  alternativeTitle: null,
  poster: null,
  isActive,
});

const fetcherFor = (table: Record<string, ZangetsuEpisodeJson[]>) => async (slug: string) => {
  const rows = table[slug];
  if (!rows) throw new Error(`provider has no entry ${slug}`);
  return extractEpisodes(rows);
};

describe('buildEpisodeChain', () => {
  it('concatenates seasons that share one AniList entry and collapses the overlapping slot', async () => {
    const chain = await buildEpisodeChain(
      [season('season-1', 'Season 1', true), season('season-2', 'Season 2')],
      fetcherFor({
        'season-1': [row(30, '21/2', 2), row(10, '21/1', 1)],
        'season-2': [row(50, '21/4', 4), row(40, '21/3', 3)],
      })
    );

    expect(chain.numberSource).toBe('ani');
    expect(chain.episodes.map(episode => episode.episodeNumber)).toEqual([1, 2, 3, 4]);
    expect(chain.groups.map(group => [group.label, group.start, group.end])).toEqual([
      ['Season 1', 1, 2],
      ['Season 2', 3, 4],
    ]);
    expect(chain.partial).toBe(false);
  });

  it('offsets seasons that AniList models as separate entries, keeping each entry-relative number', async () => {
    const chain = await buildEpisodeChain(
      [season('s1', 'Courage the Peddler', true), season('s2', 'Fight the Future')],
      fetcherFor({
        s1: [row(10, '21/1', 1), row(11, '21/2', 2), row(12, '21/3', 3)],
        s2: [row(20, '50/1', 1), row(21, '50/2', 2)],
      })
    );

    expect(chain.numberSource).toBe('offset');
    expect(chain.episodes.map(episode => episode.episodeNumber)).toEqual([1, 2, 3, 4, 5]);
    // Playback addresses the embed by its own entry and its own number, never the offset one.
    expect(
      chain.episodes.map(episode => [episode.aniListId, episode.absoluteEpisodeNumber])
    ).toEqual([
      ['21', 1],
      ['21', 2],
      ['21', 3],
      ['50', 1],
      ['50', 2],
    ]);
    expect(chain.groups[1]).toMatchObject({ numberOffset: 3, start: 4, end: 5 });
  });

  it('never shifts a season down when its own numbers already run ahead of the cursor', async () => {
    const chain = await buildEpisodeChain(
      [season('s1', 'Part 1', true), season('s2', 'Part 2')],
      fetcherFor({
        s1: [row(10, '21/1', 1)],
        s2: [row(20, '50/101', 101)],
      })
    );

    expect(chain.numberSource).toBe('offset');
    expect(chain.episodes.map(episode => episode.episodeNumber)).toEqual([1, 101]);
    expect(chain.groups[1]).toMatchObject({ numberOffset: 0, start: 101, end: 101 });
  });

  it('keeps global numbers when a season of a shared-entry chain fails', async () => {
    const chain = await buildEpisodeChain(
      [season('s1', 'Season 1', true), season('s2', 'Season 2'), season('s3', 'Season 3')],
      fetcherFor({
        s1: [row(10, '21/1', 1), row(11, '21/2', 2)],
        s3: [row(30, '21/5', 5), row(31, '21/6', 6)],
      })
    );

    expect(chain.numberSource).toBe('ani');
    expect(chain.episodes.map(episode => episode.episodeNumber)).toEqual([1, 2, 5, 6]);
    expect(chain.partial).toBe(true);
    expect(chain.failedSeasons).toEqual(['s2']);
  });

  it('refuses to offset past a missing season instead of guessing later numbers', async () => {
    const chain = await buildEpisodeChain(
      [season('s1', 'Season 1', true), season('s2', 'Season 2'), season('s3', 'Season 3')],
      fetcherFor({
        s1: [row(10, '21/1', 1)],
        s3: [row(30, '70/1', 1)],
      })
    );

    expect(chain.numberSource).toBe('ambiguous');
    expect(chain.episodes).toEqual([]);
    expect(chain.groups).toEqual([]);
    expect(chain.partial).toBe(true);
    expect(chain.failedSeasons).toEqual(['s2']);
  });

  it('leaves relative numbers and flags the list when a season spans two AniList entries', async () => {
    const chain = await buildEpisodeChain(
      [season('s1', 'Season 1', true), season('s2', 'Mixed')],
      fetcherFor({
        s1: [row(10, '21/1', 1), row(11, '21/2', 2)],
        s2: [row(20, '21/2', 2), row(21, '50/7', 7)],
      })
    );

    expect(chain.numberSource).toBe('ambiguous');
    expect(chain.partial).toBe(true);
    expect(chain.episodes.map(episode => episode.episodeNumber)).toEqual([1, 2, 2, 7]);
  });

  it('marks the chain truncated once seasons pass the limit', async () => {
    const table: Record<string, ZangetsuEpisodeJson[]> = {
      s1: [row(10, '21/1', 1)],
      s2: [row(20, '21/2', 2)],
      s3: [row(30, '21/3', 3)],
    };
    const chain = await buildEpisodeChain(
      [season('s1', 'Season 1', true), season('s2', 'Season 2'), season('s3', 'Season 3')],
      fetcherFor(table),
      { maxSeasons: 2 }
    );

    expect(chain.truncated).toBe(true);
    expect(chain.episodes.map(episode => episode.episodeNumber)).toEqual([1, 2]);
    expect(chain.failedSeasons).toEqual(['s3']);
  });
});

describe('extractSeasonChain', () => {
  it('reads the provider season block in DOM order', () => {
    const seasons = extractSeasonChain(mockHtmlData.seasonChainHtml);
    expect(seasons.map(entry => entry.id)).toEqual([
      'one-piece-12',
      'one-piece-war-marine-format-17',
    ]);
    expect(seasons[0].isActive).toBe(true);
    expect(seasons[0].poster).toBe('https://example.com/s1.jpg');
  });

  it('keeps a page that lists no siblings resolvable as its own one-entry chain', () => {
    const seasons = orderSeasons(extractSeasonChain('<div id="main-content"></div>'), 'solo-9');
    expect(seasons).toHaveLength(1);
    expect(seasons[0].id).toBe('solo-9');
  });
});
