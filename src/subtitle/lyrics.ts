import type { CaptionTrackInfo, VideoMetadata } from "../types";
import { hasAsrAutoPunctuation, type Json3Payload } from "./cue-builder";

interface GmResponse {
  status: number;
  statusText: string;
  responseText: string;
}

interface GmRequestDetails {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  timeout?: number;
  onload?: (res: GmResponse) => void;
  onerror?: (err: unknown) => void;
  ontimeout?: () => void;
}

declare function GM_xmlhttpRequest(details: GmRequestDetails): { abort?: () => void };

const lyricsCacheByVideo = new Map<string, string | null>();

const MUSIC_OR_LYRIC_HINT_REGEX =
  /\b(?:erb|epic\s+rap\s+battles|rap\s+battle|lyrics?|official\s+(?:music\s+)?video|music\s+video|mv|song|feat\.?|ft\.?|versus|vs\.?|cypher|diss\s+track|freestyle|remix|soundtrack|ost)\b/i;

const TITLE_NOISE_REGEX =
  /\s*(?:\(|\[)(?:official\s*(?:music\s*)?video|official\s*audio|lyric\s*video|lyrics?|hd|4k|hq|visualizer|explicit|clean|mv)(?:\)|\])\s*/gi;

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "official",
  "video",
  "music",
  "lyrics",
  "lyric",
  "audio",
  "part",
  "episode",
]);

function httpGetText(url: string, timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {
      Accept: "application/json, text/html, */*",
    };

    if (typeof GM_xmlhttpRequest === "function") {
      try {
        GM_xmlhttpRequest({
          method: "GET",
          url,
          headers,
          timeout: timeoutMs,
          onload: (res) => {
            if (res.status >= 200 && res.status < 300 && res.responseText) {
              resolve(res.responseText);
            } else {
              resolve(null);
            }
          },
          onerror: () => resolve(null),
          ontimeout: () => resolve(null),
        });
        return;
      } catch {
        // Fall through to fetch
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    fetch(url, { headers, signal: controller.signal })
      .then(async (res) => {
        clearTimeout(timer);
        if (!res.ok) return null;
        return await res.text();
      })
      .then(resolve)
      .catch(() => {
        clearTimeout(timer);
        resolve(null);
      });
  });
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

/**
 * Extracts plain-text lyrics from Genius HTML page by parsing balanced `data-lyrics-container="true"` divs.
 */
export function extractGeniusLyricsFromHtml(html: string): string {
  const marker = 'data-lyrics-container="true"';
  const blocks: string[] = [];
  let pos = 0;

  while (pos < html.length) {
    const idx = html.indexOf(marker, pos);
    if (idx === -1) break;
    const contentStart = html.indexOf(">", idx);
    if (contentStart === -1) break;

    let depth = 1;
    let cur = contentStart + 1;
    while (depth > 0 && cur < html.length) {
      const nextOpen = html.indexOf("<div", cur);
      const nextClose = html.indexOf("</div", cur);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        cur = nextOpen + 4;
      } else {
        depth--;
        if (depth === 0) {
          blocks.push(html.slice(contentStart + 1, nextClose));
        }
        cur = nextClose + 5;
      }
    }
    pos = cur;
  }

  if (blocks.length === 0) return "";

  const rawLines = blocks
    .map((block) =>
      decodeHtmlEntities(
        block
          .replace(
            /<div[^>]*data-exclude-from-selection="true"[^>]*>[\s\S]*?<\/div>/gi,
            "",
          )
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<[^>]+>/g, ""),
      ),
    )
    .join("\n");

  return rawLines
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(
      (line) =>
        Boolean(line) &&
        !/^\[.*\]$/.test(line) &&
        !/^\d+\s*Contributors/i.test(line) &&
        !/Lyrics$/i.test(line),
    )
    .join("\n");
}

function buildSearchQueries(metadata: VideoMetadata): string[] {
  const rawTitle = (metadata.title || "")
    .replace(TITLE_NOISE_REGEX, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!rawTitle) return [];

  const queries: string[] = [rawTitle];

  // If title has "A - B" or "A. Epic Rap Battles...", also add the primary segment
  const dotParts = rawTitle.split(/\s*(?:\.|\||—|-)\s*/).filter(Boolean);
  if (dotParts.length >= 2 && dotParts[0].length >= 6) {
    const firstPart = dotParts[0].trim();
    if (metadata.author && !firstPart.toLowerCase().includes(metadata.author.toLowerCase())) {
      queries.push(`${firstPart} ${metadata.author}`);
    }
    queries.push(firstPart);
  } else if (
    metadata.author &&
    !rawTitle.toLowerCase().includes(metadata.author.toLowerCase())
  ) {
    queries.push(`${rawTitle} ${metadata.author}`);
  }

  return Array.from(new Set(queries));
}

function extractSignificantTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

function isGeniusHitMatchingVideo(
  hitResult: {
    title?: string;
    full_title?: string;
    artist_names?: string;
    url?: string;
  },
  metadata: VideoMetadata,
): boolean {
  const url = hitResult.url || "";
  if (!url.endsWith("-lyrics") || /annotated|guide|chapter|book/i.test(url)) {
    return false;
  }

  const candidateText = `${hitResult.full_title || ""} ${hitResult.title || ""} ${hitResult.artist_names || ""}`;
  const candidateTokens = new Set(extractSignificantTokens(candidateText));

  const primaryTitle = (metadata.title || "")
    .replace(TITLE_NOISE_REGEX, " ")
    .split(/\s*(?:\.|\||—)\s*/)[0] || metadata.title;
  const titleTokens = extractSignificantTokens(primaryTitle);
  if (titleTokens.length === 0) return false;

  let matched = 0;
  for (const t of titleTokens) {
    if (candidateTokens.has(t)) matched++;
  }

  return matched / titleTokens.length >= 0.6;
}

/**
 * Determines whether Tier 2 (External Lyrics Lookup) should be attempted for this track.
 * Tier 1 (Manual track) always takes precedence (`track.kind !== "asr"` -> false).
 */
export function shouldAttemptLyricsLookup(
  track: CaptionTrackInfo,
  metadata: VideoMetadata,
  payload: Json3Payload,
): boolean {
  const isAsr = track.kind === "asr" || track.vssId?.startsWith("a.");
  if (!isAsr) return false;

  const events = payload.events || [];
  if (!hasAsrAutoPunctuation(events)) {
    return true;
  }

  const combinedMeta = `${metadata.title || ""} ${metadata.author || ""} ${(metadata.keywords || []).join(" ")}`;
  return MUSIC_OR_LYRIC_HINT_REGEX.test(combinedMeta);
}

/**
 * Fetches ground-truth plain lyrics for a music / rap battle video from Genius (with LRCLIB fallback).
 */
export async function fetchExternalLyricsForVideo(
  metadata: VideoMetadata,
): Promise<string | null> {
  if (!metadata.videoId || !metadata.title) return null;
  if (lyricsCacheByVideo.has(metadata.videoId)) {
    return lyricsCacheByVideo.get(metadata.videoId) ?? null;
  }

  const queries = buildSearchQueries(metadata);
  for (const q of queries) {
    const searchUrl = `https://genius.com/api/search?q=${encodeURIComponent(q)}`;
    const rawSearch = await httpGetText(searchUrl, 4500);
    if (!rawSearch) continue;

    try {
      const parsed = JSON.parse(rawSearch);
      const hits: Array<{
        result?: {
          title?: string;
          full_title?: string;
          artist_names?: string;
          url?: string;
        };
      }> = Array.isArray(parsed?.response?.hits) ? parsed.response.hits : [];

      for (const hit of hits.slice(0, 4)) {
        const res = hit.result;
        if (!res || !res.url || !isGeniusHitMatchingVideo(res, metadata)) {
          continue;
        }
        const pageHtml = await httpGetText(res.url, 5500);
        if (!pageHtml) continue;
        const lyrics = extractGeniusLyricsFromHtml(pageHtml);
        if (lyrics && lyrics.split("\n").length >= 6) {
          lyricsCacheByVideo.set(metadata.videoId, lyrics);
          return lyrics;
        }
      }
    } catch {
      // Ignore parse error and try next query/fallback
    }
  }

  // Fallback: LRCLIB public API
  for (const q of queries.slice(0, 2)) {
    const lrcUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(q)}`;
    const rawLrc = await httpGetText(lrcUrl, 3500);
    if (!rawLrc) continue;
    try {
      const list = JSON.parse(rawLrc);
      if (Array.isArray(list) && list.length > 0) {
        const plain: string | undefined = list[0]?.plainLyrics;
        if (plain && plain.trim().split(/\r?\n/).length >= 6) {
          lyricsCacheByVideo.set(metadata.videoId, plain.trim());
          return plain.trim();
        }
      }
    } catch {
      // Ignore
    }
  }

  lyricsCacheByVideo.set(metadata.videoId, null);
  return null;
}
