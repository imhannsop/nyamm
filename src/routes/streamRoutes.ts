import { Hono } from 'hono';
import {
  fetchStreamResource,
  proxyBaseFor,
  responseHeaders,
  rewritePlaylist,
  safeStreamTarget,
} from '../services/streamProxy';
import { fail } from '../utils/response';

const STREAM_TIMEOUT = 25000;

// Content-type is authoritative; the path fallbacks cover providers that label
// manifests generically. Deliberately not pattern-matching the query string: these
// providers use opaque `/p?t=<token>` paths for segments too, and a false positive
// here would text-decode binary video data.
const isPlaylist = (contentType: string, url: string): boolean =>
  contentType.includes('mpegurl') ||
  contentType.includes('m3u8') ||
  contentType.includes('x-mpegurl') ||
  /\.m3u8([?#]|$)/i.test(url) ||
  /\/m3u8([/?#]|$)/i.test(url);

const isTextPayload = (contentType: string): boolean =>
  contentType.startsWith('text/') || contentType.includes('vtt') || contentType.includes('json');

const streamRoutes = new Hono();

streamRoutes.get('/stream-proxy', async c => {
  let target: string;
  try {
    target = safeStreamTarget(c.req.query('url'));
  } catch (error) {
    return fail(c, (error as Error).message, 400);
  }

  // Deliberately not tied to c.req.raw.signal: that signal fires once the client's
  // GET has been consumed, which aborted the upstream media stream mid-transfer.
  const signal = AbortSignal.timeout(STREAM_TIMEOUT);
  const range = c.req.header('range');

  let upstream: Response;
  let finalUrl: string;
  try {
    ({ response: upstream, finalUrl } = await fetchStreamResource(target, {
      referer: target,
      range,
      signal,
    }));
  } catch (error) {
    return fail(c, (error as Error).message, 502);
  }

  if (!upstream.ok && upstream.status !== 206) {
    void upstream.body?.cancel().catch(() => {});
    return fail(c, `upstream returned ${upstream.status}`, 502);
  }

  const contentType = upstream.headers.get('content-type') ?? '';

  if (isPlaylist(contentType, finalUrl)) {
    // A player may range-request a playlist (Chrome's native HLS does). Serving the
    // 206 body un-rewritten would leak provider-relative URIs back to the browser,
    // so playlists are always returned whole and rewritten. They are small.
    if (upstream.status !== 200) {
      void upstream.body?.cancel().catch(() => {});
      try {
        ({ response: upstream, finalUrl } = await fetchStreamResource(target, {
          referer: target,
          signal,
        }));
      } catch (error) {
        return fail(c, (error as Error).message, 502);
      }
      if (!upstream.ok) return fail(c, `upstream returned ${upstream.status}`, 502);
    }
    const text = await upstream.text();
    return c.body(rewritePlaylist(text, finalUrl, proxyBaseFor(c.req.url)), 200, {
      ...responseHeaders(upstream.headers),
      'Content-Type': 'application/vnd.apple.mpegurl',
    });
  }

  if (isTextPayload(contentType) && upstream.status === 200) {
    return c.body(await upstream.text(), 200, {
      ...responseHeaders(upstream.headers),
      'Content-Type': contentType,
    });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders(upstream.headers, {
      'Content-Type': contentType || 'application/octet-stream',
    }),
  });
});

export default streamRoutes;
