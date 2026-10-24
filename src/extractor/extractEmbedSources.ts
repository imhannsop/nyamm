import { fetchStreamResource } from '../services/streamProxy';
import { validationError } from '../utils/errors';

export interface ResolvedSource {
  url: string;
  kind: 'hls' | 'mp4';
  quality: string | null;
}

export interface ResolvedSubtitle {
  url: string;
  lang: string | null;
  title: string | null;
}

export interface EmbedSources {
  sources: ResolvedSource[];
  subtitles: ResolvedSubtitle[];
}

interface RawSource {
  file?: unknown;
  url?: unknown;
  label?: unknown;
}

interface RawTrack {
  file?: unknown;
  label?: unknown;
  kind?: unknown;
  lang?: unknown;
}

const SOURCES_URL = /sourcesUrl\s*=\s*['"]([^'"]+)['"]/;
const INLINE_MEDIA = /['"](https?:\/\/[^'"]+\.(?:m3u8|mp4)[^'"]*)['"]/gi;

const cleanUrl = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\\\//g, '/');
  return trimmed || null;
};

const absolutise = (value: unknown, base: string): string | null => {
  const raw = cleanUrl(value);
  if (!raw) return null;
  try {
    return new URL(raw, base).toString();
  } catch {
    return null;
  }
};

/**
 * Providers hand back relative `/p?t=` media paths and a `type` of `hls` or
 * `mp4`. Confirming the bytes rather than trusting the label is what keeps an
 * expired-token error page from being served to the player as a stream.
 */
const confirmPlayable = async (url: string, referer: string): Promise<'hls' | 'mp4' | null> => {
  try {
    const { response } = await fetchStreamResource(url, {
      referer,
      range: 'bytes=0-1024',
    });
    if (!response.ok && response.status !== 206) return null;
    const head = new Uint8Array(await response.arrayBuffer());
    const text = new TextDecoder('latin1').decode(head.subarray(0, 24));
    if (text.startsWith('#EXTM3U')) return 'hls';
    if (text.slice(4, 8) === 'ftyp') return 'mp4';
    return null;
  } catch {
    return null;
  }
};

export const resolveEmbedSources = async (embedUrl: string): Promise<EmbedSources> => {
  const embed = await fetchStreamResource(embedUrl);
  if (!embed.response.ok) {
    throw new validationError(`embed page returned ${embed.response.status}`, { embedUrl });
  }
  const html = await embed.response.text();
  const sourcesPath = cleanUrl(html.match(SOURCES_URL)?.[1]);

  let rawSources: Array<RawSource | string> = [];
  let rawTracks: RawTrack[] = [];
  let resolveBase = embed.finalUrl;
  const failures: string[] = [];

  if (sourcesPath) {
    const sourcesUrl = new URL(sourcesPath, embed.finalUrl).toString();
    const payload = await fetchStreamResource(sourcesUrl, { referer: embed.finalUrl });
    if (!payload.response.ok) {
      failures.push(`getSources returned ${payload.response.status}`);
    } else {
      const data = (await payload.response.json().catch(() => null)) as {
        sources?: unknown;
        tracks?: unknown;
      } | null;
      if (!data) {
        failures.push('getSources returned a non-JSON body');
      } else {
        // Segments and subtitles are relative to getSources, not to the embed page.
        resolveBase = payload.finalUrl;
        rawSources = Array.isArray(data.sources) ? (data.sources as Array<RawSource | string>) : [];
        rawTracks = Array.isArray(data.tracks) ? (data.tracks as RawTrack[]) : [];
      }
    }
  } else {
    const inline = [...html.matchAll(INLINE_MEDIA)]
      .map(match => match[1])
      .filter((value, index, list) => list.indexOf(value) === index);
    rawSources = inline;
    if (inline.length === 0) failures.push('embed html had no sourcesUrl and no media url');
  }

  const sources: ResolvedSource[] = [];
  for (const entry of rawSources) {
    const url =
      typeof entry === 'string'
        ? absolutise(entry, resolveBase)
        : absolutise(entry.file ?? entry.url, resolveBase);
    if (!url) continue;
    const kind = await confirmPlayable(url, embed.finalUrl);
    if (!kind) {
      failures.push(`candidate ${new URL(url).pathname} was not playable`);
      continue;
    }
    const label = typeof entry === 'object' ? cleanUrl(entry.label) : null;
    sources.push({ url, kind, quality: label });
  }

  const subtitles: ResolvedSubtitle[] = rawTracks.flatMap(track => {
    if (track.kind !== 'captions') return [];
    const url = absolutise(track.file, resolveBase);
    if (!url) return [];
    return [
      {
        url,
        lang: cleanUrl(track.lang) ?? cleanUrl(track.label),
        title: cleanUrl(track.label),
      },
    ];
  });

  if (sources.length === 0) {
    throw new validationError('no playable stream found for this episode', {
      embedUrl,
      attempts: failures.slice(0, 5),
    });
  }

  return { sources, subtitles };
};
