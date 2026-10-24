import { Hono } from 'hono';
import handler, { lazyHandler } from '../utils/handler';

import allGenresController from '../controllers/allGenres.controller';
import filterOptions from '../utils/filter';

const router = new Hono();

/**
 * The webpackMode comment is not decorative: `vercel-build` runs ncc over api/index.ts, and a
 * bare `import()` is a split point that emits sibling chunk files into api/ — where the platform
 * treats each one as its own serverless entry rather than a dependency, so the load fails at
 * request time. Eager keeps one self-contained file while Bun still defers the real import.
 */

// Order is load-bearing: /filter/options must stay before /filter, and
// /animes/:query/:category? catches anything under /animes/.
router.get(
  '/home',
  lazyHandler(() => import(/* webpackMode: "eager" */ '../controllers/homepage.controller'))
);
router.get(
  '/top-search',
  lazyHandler(() => import(/* webpackMode: "eager" */ '../controllers/topSearch.controller'))
);
router.get(
  '/schedules',
  lazyHandler(() => import(/* webpackMode: "eager" */ '../controllers/schedules.controller'))
);
router.get(
  '/schedule/next/:id',
  lazyHandler(
    () => import(/* webpackMode: "eager" */ '../controllers/nextEpisodeSchedule.controller')
  )
);
router.get(
  '/anime/extract/:id',
  lazyHandler(() => import(/* webpackMode: "eager" */ '../controllers/extract.controller'))
);
router.get(
  '/anime/:id',
  lazyHandler(() => import(/* webpackMode: "eager" */ '../controllers/detailpage.controller'))
);
router.get(
  '/animes/:query/:category?',
  lazyHandler(() => import(/* webpackMode: "eager" */ '../controllers/listpage.controller'))
);
router.get(
  '/search',
  lazyHandler(() => import(/* webpackMode: "eager" */ '../controllers/search.controller'))
);
router.get(
  '/filter/options',
  handler(async () => filterOptions)
);
router.get(
  '/filter',
  lazyHandler(() => import(/* webpackMode: "eager" */ '../controllers/filter.controller'))
);
router.get(
  '/suggestion',
  lazyHandler(() => import(/* webpackMode: "eager" */ '../controllers/suggestion.controller'))
);
router.get(
  '/characters/:id',
  lazyHandler(() => import(/* webpackMode: "eager" */ '../controllers/characters.controller'))
);
router.get(
  '/character/:id',
  lazyHandler(() => import(/* webpackMode: "eager" */ '../controllers/characterDetail.controller'))
);
router.get(
  '/episodes/:id',
  lazyHandler(() => import(/* webpackMode: "eager" */ '../controllers/episodes.controller'))
);
router.get(
  '/servers/:episodeId',
  lazyHandler(() => import(/* webpackMode: "eager" */ '../controllers/servers.controller'))
);
// Static data with no scraper graph behind it, so there is nothing to defer.
router.get('/genres', handler(allGenresController));
router.get(
  '/news',
  lazyHandler(() => import(/* webpackMode: "eager" */ '../controllers/news.controller'))
);
router.get(
  '/random',
  lazyHandler(() => import(/* webpackMode: "eager" */ '../controllers/random.controller'))
);

export default router;
