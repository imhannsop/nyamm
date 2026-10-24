import { load } from 'cheerio';
import { Element } from 'domhandler';
import { Season } from '../types/anime';

/**
 * The provider lists a series' sibling seasons as separate anime entries. Their DOM order is
 * the release order, which is the only ordering signal available for chains that AniList
 * models as several entries.
 */
export const extractSeasonChain = (html: string): Season[] => {
  const $ = load(html);
  const seasons: Season[] = [];

  $('#main-content .block_area-seasons')
    .find('.os-list .os-item')
    .each((_i: number, el: Element) => {
      const href = $(el).find('a').attr('href') || $(el).attr('href');
      const posterStyle = $(el).find('.season-poster').attr('style');
      const posterMatch = posterStyle?.match(/url\((['"])?(.*?)\1\)/);
      seasons.push({
        title: $(el).attr('title') || null,
        id: href?.split('/').pop() || null,
        alternativeTitle: $(el).find('.title').text() || null,
        poster: posterMatch ? posterMatch[2] : null,
        isActive: $(el).hasClass('active'),
      });
    });

  return seasons.filter(season => season.id !== null);
};

/**
 * Canonical season order, with the entry we resolved as the anchor. A provider page that
 * lists no siblings still has to yield its own entry, otherwise a single-season anime would
 * return an empty chain.
 */
export const orderSeasons = (seasons: Season[], currentSlug: string): Season[] => {
  const unique = new Map<string, Season>();
  for (const season of seasons) {
    if (season.id && !unique.has(season.id)) unique.set(season.id, season);
  }
  if (!unique.has(currentSlug)) {
    unique.set(currentSlug, {
      title: null,
      id: currentSlug,
      alternativeTitle: null,
      poster: null,
      isActive: true,
    });
  }
  return [...unique.values()];
};
