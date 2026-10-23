export type SubtitleMode = "bilingual" | "target" | "source" | "off";

export interface Cue {
  /** 0-based sequential index in the normalized timeline */
  index: number;
  /** Start timestamp in milliseconds */
  startMs: number;
  /** End timestamp in milliseconds */
  endMs: number;
  /** Normalized full-sentence source text */
  sourceText: string;
  /** Translated text filled in by the segment translator */
  targetText?: string;
}

export interface SubtitleSegment {
  /** 0-based segment index */
  segmentIndex: number;
  /** Inclusive start cue index */
  startCueIndex: number;
  /** Inclusive end cue index */
  endCueIndex: number;
  /** Start time in ms of first cue in segment */
  startMs: number;
  /** End time in ms of last cue in segment */
  endMs: number;
  /** Translation lifecycle state */
  status: "idle" | "translating" | "completed" | "error";
  /** Count of cues already filled in this segment */
  translatedCount: number;
  /** Error message if last attempt failed */
  errorMessage?: string;
}

export interface CaptionTrackInfo {
  baseUrl: string;
  name: string;
  vssId: string;
  languageCode: string;
  kind?: string;
  isTranslatable?: boolean;
}

export interface VideoMetadata {
  videoId: string;
  title: string;
  author: string;
  description: string;
  keywords?: string[];
}

export interface AppConfig {
  /** OpenAI-compatible API base URL (user-configured, empty by default) */
  apiBaseUrl: string;
  /** API Key for the endpoint (optional for local proxies without auth) */
  apiKey: string;
  /** Selected model ID (user-configured) */
  model: string;
  /** Target translation language */
  targetLang: string;
  /** Extra custom prompt instructions (e.g. terminology or style) */
  customPrompt: string;
  /** Subtitle display mode */
  subtitleMode: SubtitleMode;
  /** Fast-start & seek priority micro-batch size (default: 10 cues) */
  fastBatchSize: number;
  /** Standard background batch size (default: 50 cues) */
  batchSize: number;
  /** Pause playback until the initial/seek 10-cue fast batch finishes translating */
  holdPlaybackForFastBatch: boolean;
  /** Number of 50-cue batches ahead of playback cursor to prefetch (0 = whole video) */
  prefetchBatches: number;
  /** Subtitle font scale multiplier */
  fontSizeScale: number;
  /** Subtitle vertical distance from bottom of player (%) */
  subtitleBottomPercent: number;
  /** Show semi-transparent dark backdrop behind subtitles */
  subtitleBackdrop: boolean;

  /** Performance optimizations */
  perfDisableAmbient: boolean;
  perfDisableInlinePreview: boolean;
  perfContentVisibility: boolean;
  perfHideShorts: boolean;
  perfHideEndscreen: boolean;

  /** Windows Tablet / Touch adaptations */
  touchGesturesEnabled: boolean;
  touchEnlargeControls: boolean;
  touchSingleTapToggleControls: boolean;
  touchDoubleTapSeekSec: number;
}
