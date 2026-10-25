import { configStore } from "../config";
import { tr } from "../i18n";
import type { CaptionTrackInfo, Cue, VideoMetadata } from "../types";
import { subtitleCache } from "./cache";
import {
  alignLyricsToAsrEvents,
  computeCuesFingerprint,
  findActiveCueIndex,
  findCurrentOrNextCueIndex,
  parseJson3ToCues,
} from "./cue-builder";
import {
  extractCaptionTracks,
  extractVideoMetadata,
  fetchSubtitleJson3,
  selectBestCaptionTrack,
} from "./extractor";
import { translateCueBatch } from "./llm-client";
import {
  fetchExternalLyricsForVideo,
  shouldAttemptLyricsLookup,
} from "./lyrics";
import { MetadataTranslator } from "./metadata-translator";
import { SubtitleOverlay } from "./overlay";

const CONTEXT_WINDOW_CUES = 4;
const SENTENCE_END_SNAP_REGEX = /[.?!。？！…]+["')\]）】》”’]*$/;

/**
 * Extends a batch end index by up to `maxExtra` cues so the batch ends cleanly
 * on a complete sentence boundary whenever possible, allowing the LLM to reorganize
 * 2-4 adjacent breath-group slots of the same sentence together.
 */
function snapBatchEndIndex(
  cues: Cue[],
  startIdx: number,
  baseCount: number,
  maxExtra: number,
): number {
  if (cues.length === 0) return 0;
  const rawLastIdx = Math.min(cues.length - 1, startIdx + baseCount - 1);
  if (rawLastIdx >= cues.length - 1) return cues.length;

  const limitIdx = Math.min(cues.length - 1, rawLastIdx + maxExtra);
  for (let i = rawLastIdx; i <= limitIdx; i++) {
    if (SENTENCE_END_SNAP_REGEX.test(cues[i].sourceText.trim())) {
      return i + 1;
    }
  }
  return rawLastIdx + 1;
}

export class SubtitleManager {
  private overlay = new SubtitleOverlay();
  private metadataTranslator = new MetadataTranslator();
  private currentVideoId: string | null = null;
  private currentTrack: CaptionTrackInfo | null = null;
  private tracks: CaptionTrackInfo[] = [];
  private metadata: VideoMetadata | null = null;
  private cues: Cue[] = [];
  private activeCueIndex = -1;

  private videoEl: HTMLVideoElement | null = null;
  private boundaryTimer: ReturnType<typeof setTimeout> | null = null;
  private seekDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  private pipelineAbort: AbortController | null = null;
  private pipelineGeneration = 0;
  private trackLoadGeneration = 0;

  /**
   * Demand-driven buffering gate state:
   * Only pauses playback when the playback cursor actually reaches an untranslated cue,
   * and unlocks as soon as the first 2 cues ahead of the cursor stream in via SSE.
   */
  private bufferingLockActive = false;
  private resumePlayAfterUnlock = false;
  private fastBatchRunning = false;
  private fastBatchStatusText = "准备字幕...";
  private holdBypassedGeneration = -1;
  private lastInternalPauseAt = 0;

  constructor() {
    this.overlay.setOnSkipBuffering(() => {
      this.skipBufferingWait();
    });
    configStore.subscribe((cfg) => {
      this.overlay.applyConfigStyles();
      this.refreshCurrentCueDisplay();
      if (!cfg.holdPlaybackForFastBatch && this.bufferingLockActive) {
        this.unlockBuffering();
      }
      if (
        (cfg.subtitleMode === "bilingual" || cfg.subtitleMode === "target") &&
        cfg.apiBaseUrl.trim() &&
        cfg.model.trim() &&
        this.cues.length > 0 &&
        !this.pipelineAbort
      ) {
        this.scheduleFromCursor("initial");
      }
    });
  }

  getAvailableTracks(): CaptionTrackInfo[] {
    return this.tracks;
  }

  getCurrentTrack(): CaptionTrackInfo | null {
    return this.currentTrack;
  }

  getCues(): Cue[] {
    return this.cues;
  }

  getCueAtTimeMs(timeMs: number): Cue | null {
    const idx = findActiveCueIndex(this.cues, timeMs);
    return idx >= 0 ? this.cues[idx] : null;
  }

  async attachToVideo(videoId: string): Promise<void> {
    if (this.currentVideoId === videoId && this.cues.length > 0) {
      return;
    }

    this.reset();
    this.currentVideoId = videoId;

    const player = document.getElementById("movie_player");
    const video = document.querySelector<HTMLVideoElement>(
      "#movie_player video, video.html5-main-video",
    );
    if (!player || !video) {
      return;
    }

    this.overlay.mount(player);
    this.bindVideoEvents(video);
    void this.metadataTranslator.attachToVideo(videoId);

    if (this.shouldUseBufferingLock()) {
      this.lockBuffering(true, tr("正在加载字幕...", "Loading captions..."));
    }

    let tracks = extractCaptionTracks(videoId);
    for (let attempt = 0; attempt < 6 && tracks.length === 0; attempt++) {
      await new Promise((r) => setTimeout(r, 300));
      if (this.currentVideoId !== videoId) return;
      tracks = extractCaptionTracks(videoId);
    }

    this.tracks = tracks;
    this.metadata = extractVideoMetadata(videoId);

    const bestTrack = selectBestCaptionTrack(tracks);
    if (!bestTrack) {
      this.unlockBuffering();
      return;
    }

    await this.loadTrack(videoId, bestTrack);
  }

  async switchTrack(track: CaptionTrackInfo): Promise<void> {
    if (!this.currentVideoId) return;
    this.cancelActivePipeline();
    await this.loadTrack(this.currentVideoId, track);
  }

  retranslateAll(): void {
    if (!this.currentVideoId || this.cues.length === 0) return;
    this.cancelActivePipeline();
    for (const cue of this.cues) {
      delete cue.targetText;
    }
    this.refreshCurrentCueDisplay();
    this.scheduleFromCursor("initial");
  }

  private shouldUseBufferingLock(): boolean {
    const cfg = configStore.get();
    return Boolean(
      cfg.holdPlaybackForFastBatch &&
        (cfg.subtitleMode === "bilingual" || cfg.subtitleMode === "target") &&
        cfg.apiBaseUrl.trim() &&
        cfg.model.trim(),
    );
  }

  private lockBuffering(forceResumeOnUnlock: boolean, statusText: string): void {
    if (!this.videoEl) return;
    if (this.holdBypassedGeneration === this.pipelineGeneration) return;
    if (!this.bufferingLockActive) {
      this.resumePlayAfterUnlock = forceResumeOnUnlock || !this.videoEl.paused;
      this.bufferingLockActive = true;
    }
    this.overlay.setBuffering(true, statusText);
    if (!this.videoEl.paused) {
      this.lastInternalPauseAt = performance.now();
      this.videoEl.pause();
    }
  }

  skipBufferingWait(): void {
    this.holdBypassedGeneration = this.pipelineGeneration;
    if (!this.bufferingLockActive) return;
    this.resumePlayAfterUnlock = true;
    this.unlockBuffering();
  }

  private unlockBuffering(): void {
    const wasLocked = this.bufferingLockActive;
    const shouldResume = this.resumePlayAfterUnlock;
    this.bufferingLockActive = false;
    this.resumePlayAfterUnlock = false;
    this.overlay.setBuffering(false, null);

    if (wasLocked && shouldResume && this.videoEl && this.videoEl.paused) {
      void this.videoEl.play().catch(() => {});
    }
  }

  private async loadTrack(videoId: string, track: CaptionTrackInfo): Promise<void> {
    const loadGen = ++this.trackLoadGeneration;
    this.currentTrack = track;
    if (this.shouldUseBufferingLock()) {
      this.lockBuffering(true, tr("正在加载字幕...", "Loading captions..."));
    }

    const payload = await fetchSubtitleJson3(videoId, track);
    if (this.currentVideoId !== videoId || this.trackLoadGeneration !== loadGen) {
      return;
    }

    if (!payload) {
      this.unlockBuffering();
      this.overlay.setStatus(tr("字幕加载失败", "Failed to load captions"));
      setTimeout(() => this.overlay.setStatus(null), 2500);
      return;
    }

    const metadata = extractVideoMetadata(videoId);
    this.metadata = metadata;

    // 3-Tier Subtitle Source Waterfall:
    // Tier 1: Creator manual captions (track.kind !== "asr")
    // Tier 2: External lyrics site (Genius / LRCLIB) phonetically aligned onto ASR word timestamps
    // Tier 3: ASR word stream + DP breath-group segmentation + LLM context restoration
    let normalized: Cue[] | null = null;
    if (shouldAttemptLyricsLookup(track, metadata, payload)) {
      if (this.bufferingLockActive) {
        this.overlay.setBuffering(true, tr("正在检索外部轴与文稿...", "Checking external transcript..."));
      }
      const externalLyrics = await fetchExternalLyricsForVideo(metadata);
      if (this.currentVideoId !== videoId || this.trackLoadGeneration !== loadGen) {
        return;
      }
      if (externalLyrics && Array.isArray(payload.events)) {
        normalized = alignLyricsToAsrEvents(externalLyrics, payload.events);
      }
    }

    if (!normalized || normalized.length === 0) {
      normalized = parseJson3ToCues(payload, track.kind);
    }

    this.cues = normalized;
    this.activeCueIndex = -1;

    if (normalized.length === 0) {
      this.unlockBuffering();
      return;
    }

    const cfg = configStore.get();
    if (cfg.model.trim()) {
      const cacheKey = subtitleCache.makeKey(
        videoId,
        track.vssId || track.languageCode,
        computeCuesFingerprint(normalized),
        cfg.targetLang,
        cfg.model.trim(),
      );
      const cached = await subtitleCache.get(cacheKey);
      if (
        cached &&
        this.currentVideoId === videoId &&
        this.trackLoadGeneration === loadGen &&
        this.cues === normalized
      ) {
        for (const [idxStr, translated] of Object.entries(cached)) {
          const idx = Number.parseInt(idxStr, 10);
          if (normalized[idx] && translated) {
            normalized[idx].targetText = translated;
          }
        }
      }
    }

    if (this.currentVideoId !== videoId || this.trackLoadGeneration !== loadGen) {
      return;
    }

    this.refreshCurrentCueDisplay();
    this.metadata = extractVideoMetadata(videoId);
    this.scheduleFromCursor("initial");
  }

  private bindVideoEvents(video: HTMLVideoElement): void {
    this.unbindVideoEvents();
    this.videoEl = video;

    video.addEventListener("timeupdate", this.onTimeUpdate);
    video.addEventListener("play", this.onPlay);
    video.addEventListener("playing", this.onPlay);
    video.addEventListener("pause", this.onPause);
    video.addEventListener("ratechange", this.onRateChange);
    video.addEventListener("seeking", this.onSeeking);
    video.addEventListener("seeked", this.onSeeked);
    this.scheduleNextBoundarySync();
  }

  private unbindVideoEvents(): void {
    this.clearBoundaryTimer();
    if (!this.videoEl) return;
    this.videoEl.removeEventListener("timeupdate", this.onTimeUpdate);
    this.videoEl.removeEventListener("play", this.onPlay);
    this.videoEl.removeEventListener("playing", this.onPlay);
    this.videoEl.removeEventListener("pause", this.onPause);
    this.videoEl.removeEventListener("ratechange", this.onRateChange);
    this.videoEl.removeEventListener("seeking", this.onSeeking);
    this.videoEl.removeEventListener("seeked", this.onSeeked);
    this.videoEl = null;
  }

  private clearBoundaryTimer(): void {
    if (this.boundaryTimer !== null) {
      clearTimeout(this.boundaryTimer);
      this.boundaryTimer = null;
    }
  }

  private scheduleNextBoundarySync(): void {
    this.clearBoundaryTimer();
    if (!this.videoEl || this.videoEl.paused || this.cues.length === 0) {
      return;
    }

    const timeMs = this.videoEl.currentTime * 1000;
    const idx = this.activeCueIndex;
    let nextBoundaryMs = -1;

    if (idx >= 0 && idx < this.cues.length) {
      const activeCue = this.cues[idx];
      if (timeMs < activeCue.endMs) {
        nextBoundaryMs = activeCue.endMs;
      } else if (idx + 1 < this.cues.length) {
        nextBoundaryMs = this.cues[idx + 1].startMs;
      }
    } else {
      const nextIdx = findCurrentOrNextCueIndex(this.cues, timeMs);
      if (nextIdx >= 0) {
        nextBoundaryMs = this.cues[nextIdx].startMs;
      }
    }

    if (nextBoundaryMs <= timeMs) {
      return;
    }

    const rate = Math.max(0.25, this.videoEl.playbackRate || 1);
    const waitMs = Math.min(1000, Math.max(12, (nextBoundaryMs - timeMs) / rate + 4));
    this.boundaryTimer = setTimeout(() => {
      this.boundaryTimer = null;
      if (!this.videoEl) return;
      this.syncCueAtTime(this.videoEl.currentTime * 1000);
    }, waitMs);
  }

  private onTimeUpdate = (): void => {
    if (!this.videoEl) return;
    this.syncCueAtTime(this.videoEl.currentTime * 1000);
  };

  private onPlay = (): void => {
    if (this.bufferingLockActive && this.videoEl && !this.videoEl.paused) {
      this.resumePlayAfterUnlock = true;
      this.lastInternalPauseAt = performance.now();
      this.videoEl.pause();
      return;
    }
    if (this.videoEl) {
      this.syncCueAtTime(this.videoEl.currentTime * 1000);
    }
  };

  private onPause = (): void => {
    this.clearBoundaryTimer();
  };

  private onRateChange = (): void => {
    this.scheduleNextBoundarySync();
  };

  private onSeeking = (): void => {
    if (!this.videoEl || this.cues.length === 0) return;
    this.syncCueAtTime(this.videoEl.currentTime * 1000);
  };

  private onSeeked = (): void => {
    if (!this.videoEl) return;
    const cursorMs = this.videoEl.currentTime * 1000;
    this.syncCueAtTime(cursorMs);

    // Lock immediately if seek destination has untranslated cues in the fast-batch window
    if (this.shouldUseBufferingLock() && this.cues.length > 0) {
      const startIdx = findCurrentOrNextCueIndex(this.cues, cursorMs);
      if (startIdx >= 0) {
        const fastSize = Math.max(1, configStore.get().fastBatchSize || 10);
        const fastEndExclusive = snapBatchEndIndex(this.cues, startIdx, fastSize, 3);
        const fastWindow = this.cues.slice(startIdx, fastEndExclusive);
        if (fastWindow.some((c) => !c.targetText)) {
          this.lockBuffering(true, tr("正在翻译字幕...", "Translating captions..."));
        }
      }
    }

    if (this.seekDebounceTimer) {
      clearTimeout(this.seekDebounceTimer);
    }
    this.seekDebounceTimer = setTimeout(() => {
      this.scheduleFromCursor("seek");
    }, 120);
  };

  private syncCueAtTime(timeMs: number): void {
    const idx = findActiveCueIndex(this.cues, timeMs);
    if (idx !== this.activeCueIndex) {
      this.activeCueIndex = idx;
      this.overlay.renderCue(idx >= 0 ? this.cues[idx] : null);
    }
    this.scheduleNextBoundarySync();
  }

  private refreshCurrentCueDisplay(): void {
    if (!this.videoEl) return;
    const idx = findActiveCueIndex(this.cues, this.videoEl.currentTime * 1000);
    this.activeCueIndex = idx;
    this.overlay.renderCue(idx >= 0 ? this.cues[idx] : null);
    this.scheduleNextBoundarySync();
  }

  private scheduleFromCursor(trigger: "initial" | "seek"): void {
    const cfg = configStore.get();
    if (cfg.subtitleMode !== "bilingual" && cfg.subtitleMode !== "target") {
      this.unlockBuffering();
      return;
    }
    if (!cfg.apiBaseUrl.trim() || !cfg.model.trim()) {
      this.unlockBuffering();
      this.overlay.setStatus(tr("未配置翻译接口", "Translation API not configured"));
      return;
    }
    if (!this.videoEl || this.cues.length === 0 || !this.currentVideoId || !this.currentTrack) {
      this.unlockBuffering();
      return;
    }

    const cursorMs = this.videoEl.currentTime * 1000;
    const startIdx = findCurrentOrNextCueIndex(this.cues, cursorMs);
    if (startIdx < 0) {
      this.unlockBuffering();
      return;
    }

    const fastSize = Math.max(1, cfg.fastBatchSize || 10);
    const fastEndExclusive = snapBatchEndIndex(this.cues, startIdx, fastSize, 3);
    const fastWindow = this.cues.slice(startIdx, fastEndExclusive);
    const missingInFastWindow = fastWindow.filter((c) => !c.targetText);

    if (missingInFastWindow.length === 0) {
      this.unlockBuffering();
      if (this.pipelineAbort) {
        return;
      }
    }

    this.cancelActivePipeline(missingInFastWindow.length > 0);
    const generation = ++this.pipelineGeneration;
    const abortController = new AbortController();
    this.pipelineAbort = abortController;

    void this.runPipeline(
      generation,
      abortController.signal,
      startIdx,
      missingInFastWindow,
      trigger,
    );
  }

  private async runPipeline(
    generation: number,
    signal: AbortSignal,
    cursorCueIdx: number,
    missingFastCues: Cue[],
    trigger: "initial" | "seek",
  ): Promise<void> {
    const cfg = configStore.get();
    const videoId = this.currentVideoId;
    const track = this.currentTrack;
    if (!videoId || !track) return;

    const cacheKey = subtitleCache.makeKey(
      videoId,
      track.vssId || track.languageCode,
      computeCuesFingerprint(this.cues),
      cfg.targetLang,
      cfg.model.trim(),
    );
    const metadata = this.metadata || extractVideoMetadata(videoId);

    try {
      // Stage 1: Fast Batch with clean unified pill indicator
      if (missingFastCues.length > 0) {
        this.fastBatchRunning = true;
        this.fastBatchStatusText = tr("正在翻译字幕...", "Translating captions...");

        if (cfg.holdPlaybackForFastBatch) {
          this.lockBuffering(trigger === "initial", this.fastBatchStatusText);
        } else {
          this.overlay.setStatus(this.fastBatchStatusText);
        }

        const firstIdx = missingFastCues[0].index;
        const lastFastIdx = missingFastCues[missingFastCues.length - 1].index;
        const contextCues = this.cues.slice(Math.max(0, firstIdx - CONTEXT_WINDOW_CUES), firstIdx);
        const followingCues = this.cues.slice(lastFastIdx + 1, lastFastIdx + 4);

        const partialCache: Record<number, string> = {};
        await translateCueBatch({
          config: cfg,
          cues: missingFastCues,
          contextCues,
          followingCues,
          metadata,
          signal,
          onCueTranslated: (cueIdx, text) => {
            if (this.pipelineGeneration !== generation) return;
            if (this.cues[cueIdx]) {
              this.cues[cueIdx].targetText = text;
              partialCache[cueIdx] = text;
              if (cueIdx === this.activeCueIndex) {
                this.overlay.renderCue(this.cues[cueIdx]);
              }
            }
          },
        });

        if (this.pipelineGeneration !== generation || signal.aborted) return;

        if (Object.keys(partialCache).length > 0) {
          void subtitleCache.merge(cacheKey, partialCache);
        }

        this.fastBatchRunning = false;
        this.overlay.setStatus(null);
        this.refreshCurrentCueDisplay();
        this.unlockBuffering();
      } else {
        this.fastBatchRunning = false;
        this.unlockBuffering();
      }

      // Stage 2: Background 50-Cue Batch Pipeline
      const batchSize = Math.max(10, cfg.batchSize || 50);
      const maxBatches = cfg.prefetchBatches > 0 ? cfg.prefetchBatches : Infinity;
      let batchesRun = 0;
      let scanIndex = cursorCueIdx;

      while (batchesRun < maxBatches && !signal.aborted && this.pipelineGeneration === generation) {
        let nextUntranslated = -1;
        for (let i = scanIndex; i < this.cues.length; i++) {
          if (!this.cues[i].targetText) {
            nextUntranslated = i;
            break;
          }
        }

        if (nextUntranslated === -1) {
          break;
        }

        const batchEndExclusive = snapBatchEndIndex(
          this.cues,
          nextUntranslated,
          batchSize,
          4,
        );
        const batchCues: Cue[] = [];
        for (let i = nextUntranslated; i < batchEndExclusive; i++) {
          if (!this.cues[i].targetText) {
            batchCues.push(this.cues[i]);
          } else if (batchCues.length > 0) {
            break;
          }
        }

        if (batchCues.length === 0) break;

        const firstBatchCueIdx = batchCues[0].index;
        const lastBatchCueIdx = batchCues[batchCues.length - 1].index;
        const contextCues = this.cues.slice(
          Math.max(0, firstBatchCueIdx - CONTEXT_WINDOW_CUES),
          firstBatchCueIdx,
        );
        const followingCues = this.cues.slice(lastBatchCueIdx + 1, lastBatchCueIdx + 4);

        const partialCache: Record<number, string> = {};
        await translateCueBatch({
          config: configStore.get(),
          cues: batchCues,
          contextCues,
          followingCues,
          metadata,
          signal,
          onCueTranslated: (cueIdx, text) => {
            if (this.pipelineGeneration !== generation) return;
            if (this.cues[cueIdx]) {
              this.cues[cueIdx].targetText = text;
              partialCache[cueIdx] = text;
              if (cueIdx === this.activeCueIndex) {
                this.overlay.renderCue(this.cues[cueIdx]);
              }
            }
          },
        });

        if (this.pipelineGeneration !== generation || signal.aborted) return;

        if (Object.keys(partialCache).length > 0) {
          void subtitleCache.merge(cacheKey, partialCache);
        }

        scanIndex = batchCues[batchCues.length - 1].index + 1;
        batchesRun++;
      }
    } catch (err) {
      if (signal.aborted || this.pipelineGeneration !== generation) {
        return;
      }
      this.fastBatchRunning = false;
      this.unlockBuffering();
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[YT+] Subtitle translation error:", msg);
      this.overlay.setStatus(`${tr("翻译失败", "Translation failed")}: ${msg.slice(0, 48)}`);
      setTimeout(() => {
        if (this.pipelineGeneration === generation) {
          this.overlay.setStatus(null);
        }
      }, 4000);
    } finally {
      if (this.pipelineGeneration === generation) {
        this.pipelineAbort = null;
      }
    }
  }

  private cancelActivePipeline(keepBufferingLock = false): void {
    this.fastBatchRunning = false;
    if (!keepBufferingLock) {
      this.unlockBuffering();
    }
    if (this.pipelineAbort) {
      this.pipelineAbort.abort();
      this.pipelineAbort = null;
    }
  }

  reset(): void {
    this.trackLoadGeneration++;
    this.cancelActivePipeline(false);
    if (this.seekDebounceTimer) {
      clearTimeout(this.seekDebounceTimer);
      this.seekDebounceTimer = null;
    }
    this.unbindVideoEvents();
    this.currentVideoId = null;
    this.currentTrack = null;
    this.tracks = [];
    this.metadata = null;
    this.cues = [];
    this.activeCueIndex = -1;
    this.overlay.clear();
    this.metadataTranslator.reset();
  }
}
