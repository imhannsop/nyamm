import { Context } from 'hono';
import config from '../config/config';
import { proxyBaseFor, toProxyUrl } from '../services/streamProxy';
import { resolveEmbedSources } from '../extractor/extractEmbedSources';
import { validationError } from '../utils/errors';

export interface ExtractResponse {
  anilistId: number;
  episode: number;
  type: 'sub' | 'dub';
  provider: string;
  embedUrl: string;
  streams: { url: string; quality: string | null; kind: string; activeStatus: string }[];
  subtitles: { url: string; lang: string | null; title: string | null }[];
}

/**
 * Every url here is already wrapped in the stream proxy: handing the player a raw
 * provider url makes hls.js resolve its relative segments against the app origin,
 * and providers that bind playback tokens to the fetching IP reject the split
 * between a browser-side playlist request and a server-side segment request.
 */
const extractController = async (c: Context): Promise<ExtractResponse> => {
  const anilistId = Number(c.req.param('id'));
  const episode = Number(c.req.query('e') ?? c.req.query('episode') ?? '1');
  const type = (c.req.query('type') || 'sub').toLowerCase();

  if (!Number.isInteger(anilistId) || anilistId < 1) {
    throw new validationError('id must be a numeric AniList id', { validIdEX: '21' });
  }
  if (!Number.isInteger(episode) || episode < 1) {
    throw new validationError('e must be a positive episode number');
  }
  if (type !== 'sub' && type !== 'dub') {
    throw new validationError('type must be sub or dub');
  }

  const embedUrl = `${config.embedCdn}/embed/hd-2/ani/${anilistId}/${episode}/${type}?k=1&autoPlay=0&skipIntro=0&skipOutro=0`;

  const resolved = await resolveEmbedSources(embedUrl);
  const proxyBase = proxyBaseFor(c.req.url);

  return {
    anilistId,
    episode,
    type,
    provider: 'hd-2',
    embedUrl,
    streams: resolved.sources.map((source, index) => ({
      url: toProxyUrl(proxyBase, source.url),
      quality: source.quality,
      kind: source.kind,
      activeStatus: index === 0 ? 'active' : 'unknown',
    })),
    subtitles: resolved.subtitles.map(subtitle => ({
      ...subtitle,
      url: toProxyUrl(proxyBase, subtitle.url),
    })),
  };
};

export default extractController;
