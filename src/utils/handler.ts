import { Context, Next } from 'hono';
import { fail, success } from './response';
import { AppError } from './errors';

type RouteFn = (c: Context, next: Next) => Promise<unknown> | unknown;

const handler = (fn: RouteFn) => {
  return async (c: Context, next: Next) => {
    try {
      const result = await fn(c, next);

      return success(c, result, 200);
    } catch (error: unknown) {
      if (error instanceof AppError) {
        return fail(c, error.message, error.statusCode, error.details);
      }
      if (error instanceof Error) {
        console.error(error.message);
        return fail(c, error.message, 500);
      }
      return fail(c, 'Internal server error', 500);
    }
  };
};

/**
 * Resolves a controller on the first request that needs it rather than at boot. The scraping
 * graph pulls in cheerio, which costs most of the module-init time of the whole app; routes
 * that never parse HTML should not pay for it. `import()` is itself cached, so this is a
 * one-time cost per instance, and a load failure is not remembered — the next request retries.
 */
export const lazyHandler = (load: () => Promise<{ default: RouteFn }>) => {
  let resolved: Promise<RouteFn> | undefined;

  return handler(async (c: Context, next: Next) => {
    if (!resolved) {
      const pending = load().then(mod => mod.default);
      resolved = pending;
      pending.catch(() => {
        if (resolved === pending) resolved = undefined;
      });
    }

    const fn = await resolved;
    return fn(c, next);
  });
};

export default handler;
