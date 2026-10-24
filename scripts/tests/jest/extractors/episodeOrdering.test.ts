import { describe, it, expect } from '@jest/globals';
import { extractEpisodes, ZangetsuEpisodeJson } from '../../../../src/extractor/extractEpisodes';

/** Provider-shaped rows, because nothing here may depend on input position. */
const row = (
  id: string | number,
  ani: string | null,
  number: number | null,
  overrides: Partial<ZangetsuEpisodeJson> = {}
): ZangetsuEpisodeJson => ({
  id,
  ani,
  number,
  titles: { en: `Episode ${number ?? id}` },
  sub: true,
  dub: false,
  embed_id: String(id),
  filler: false,
  ...overrides,
});

const numbers = (rows: ZangetsuEpisodeJson[]) =>
  extractEpisodes(rows).map(episode => episode.episodeNumber);

describe('extractEpisodes ordering', () => {
  it('sorts a newest-first scraper array ascending', () => {
    expect(
      numbers([
        row('5', '21/5', 5),
        row('4', '21/4', 4),
        row('3', '21/3', 3),
        row('2', '21/2', 2),
        row('1', '21/1', 1),
      ])
    ).toEqual([1, 2, 3, 4, 5]);
  });

  it('sorts an array whose rows alternate between seasons', () => {
    expect(
      numbers([
        row('1', '21/1', 1),
        row('11', '21/11', 11),
        row('2', '21/2', 2),
        row('12', '21/12', 12),
        row('3', '21/3', 3),
      ])
    ).toEqual([1, 2, 3, 11, 12]);
  });

  it('reads the absolute number and entry out of a long-running series ani pair', () => {
    const [episode] = extractEpisodes([row('6226', '21/1031', 9)]);
    expect(episode.aniListId).toBe('21');
    expect(episode.absoluteEpisodeNumber).toBe(1031);
    // The absolute number wins over the season-relative one.
    expect(episode.episodeNumber).toBe(1031);
    expect(episode.providerEpisodeNumber).toBe(9);
    expect(episode.numberSource).toBe('ani');
    // Verbatim, because embed urls interpolate it directly.
    expect(episode.aniId).toBe('21/1031');
  });

  it('ignores an unreadable ani pair and falls back to the provider number', () => {
    const [episode] = extractEpisodes([row('7', 'two/eleven', 7)]);
    expect(episode.aniListId).toBeNull();
    expect(episode.absoluteEpisodeNumber).toBeNull();
    expect(episode.episodeNumber).toBe(7);
    expect(episode.numberSource).toBe('provider');
  });

  it('collapses two provider ids that describe the same slot', () => {
    const merged = extractEpisodes([
      row('80', '21/8', 8, { sub: true, dub: false }),
      row('81', '21/8', 8, { sub: false, dub: true, titles: { en: 'Episode 8 (dub)' } }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: '80', sub: true, dub: true });
  });

  it('keeps same-numbered episodes apart when they belong to different entries', () => {
    const result = extractEpisodes([
      row('40', '50/2', 2),
      row('10', '21/1', 1),
      row('20', '21/2', 2),
      row('30', '50/1', 1),
    ]);
    expect(result.map(episode => [episode.aniListId, episode.episodeNumber])).toEqual([
      ['21', 1],
      ['50', 1],
      ['21', 2],
      ['50', 2],
    ]);
  });

  it('numbers an unnumbered row after the highest known slot of its page, never by array position', () => {
    const result = extractEpisodes([
      row('99', null, null), // first in the array, last in the series
      row('1', '21/1', 1),
      row('2', '21/2', 2),
      row('3', '21/3', 3),
    ]);
    expect(result.map(episode => episode.episodeNumber)).toEqual([1, 2, 3, 4]);
    expect(result[3].numberSource).toBe('inferred');
  });

  it('orders two unnumbered rows by provider id, which is assigned in release order', () => {
    const result = extractEpisodes([
      row('12', '21/1', 1),
      row('30', null, null),
      row('20', null, null),
    ]);
    expect(result.map(episode => [episode.episodeNumber, episode.id])).toEqual([
      [1, '12'],
      [2, '20'],
      [3, '30'],
    ]);
  });

  it('tolerates an empty or non-array payload', () => {
    expect(extractEpisodes([])).toEqual([]);
    expect(extractEpisodes(undefined as unknown as ZangetsuEpisodeJson[])).toEqual([]);
  });
});
