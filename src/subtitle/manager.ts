import { configStore } from "../config";
import type { CaptionTrackInfo, Cue, VideoMetadata } from "../types";
import { subtitleCache } from "./cache";
import {
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
import { SubtitleOverlay } from "./overlay";

const CONTEXT_WINDOW_CUES = 4;

export class SubtitleManager {
  private overlay = new SubtitleOverlay();
  private currentVideoId: string | null = null;
  private currentTrack: CaptionTrackInfo | null = null;
  private tracks: CaptionTrackInfo[] = [];
  private metadata: VideoMetadata | null = null;
  private cues: Cue[] = [];
  private activeCueIndex = -1;

  private videoEl: HTMLVideoElement | null = null;
  private rafId: number | null = null;
  private seekDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  private pipelineAbort: AbortController | null = null;
  private pipelineGeneration = 0;

  /**
   * When true, locks the video in a paused + native buffering spinner state
   * until the initial/seek 10-cue fast batch finishes.
   */
  private bufferingLockActive = false;
  private resumePlayAfterUnlock = false;

  constructor() {
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

    // If fast-batch hold is enabled and translation is active, lock buffering immediately on video load
    if (this.shouldUseBufferingLock()) {
      this.lockBuffering(true, "加载字幕...");
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
    if (!this.bufferingLockActive) {
      this.resumePlayAfterUnlock = forceResumeOnUnlock || !this.videoEl.paused;
      this.bufferingLockActive = true;
    }
    this.overlay.setBuffering(true, statusText);
    if (!this.videoEl.paused) {
      this.videoEl.pause();
    }
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
    this.currentTrack = track;
    if (this.shouldUseBufferingLock()) {
      this.lockBuffering(true, "加载字幕...");
    }

    const payload = await fetchSubtitleJson3(videoId, track);
    if (this.currentVideoId !== videoId) return;

    if (!payload) {
      this.unlockBuffering();
      this.overlay.setStatus("字幕加载失败");
      setTimeout(() => this.overlay.setStatus(null), 2500);
      return;
    }

    const normalized = parseJson3ToCues(payload, track.kind);
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
        this.cues.length,
        cfg.targetLang,
        cfg.model.trim(),
      );
      const cached = await subtitleCache.get(cacheKey);
      if (cached && this.currentVideoId === videoId) {
        for (const [idxStr, translated] of Object.entries(cached)) {
          const idx = Number.parseInt(idxStr, 10);
          if (this.cues[idx] && translated) {
            this.cues[idx].targetText = translated;
          }
        }
      }
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
    video.addEventListener("seeking", this.onSeeking);
    video.addEventListener("seeked", this.onSeeked);
    this.startSyncLoop();
  }

  private unbindVideoEvents(): void {
    this.stopSyncLoop();
    if (!this.videoEl) return;
    this.videoEl.removeEventListener("timeupdate", this.onTimeUpdate);
    this.videoEl.removeEventListener("play", this.onPlay);
    this.videoEl.removeEventListener("playing", this.onPlay);
    this.videoEl.removeEventListener("seeking", this.onSeeking);
    this.videoEl.removeEventListener("seeked", this.onSeeked);
    this.videoEl = null;
  }

  private startSyncLoop(): void {
    this.stopSyncLoop();
    const tick = () => {
      if (this.videoEl) {
        if (this.bufferingLockActive && !this.videoEl.paused) {
          this.videoEl.pause();
        } else if (!this.videoEl.paused) {
          this.syncCueAtTime(this.videoEl.currentTime * 1000);
        }
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopSyncLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private onTimeUpdate = (): void => {
    if (!this.videoEl) return;
    this.syncCueAtTime(this.videoEl.currentTime * 1000);
  };

  private onPlay = (): void => {
    // Keep playback locked in buffering state while fast-batch translation is in progress
    if (this.bufferingLockActive && this.videoEl && !this.videoEl.paused) {
      this.resumePlayAfterUnlock = true;
      this.videoEl.pause();
    }
  };

  private onSeeking = (): void => {
    if (!this.videoEl || this.cues.length === 0) return;
    this.syncCueAtTime(this.videoEl.currentTime * 1000);
  };

  private onSeeked = (): void => {
    if (!this.videoEl) return;
    const cursorMs = this.videoEl.currentTime * 1000;
    this.syncCueAtTime(cursorMs);

    // Check immediately if seek destination has untranslated cues in the 10-cue window;
    // if so, lock buffering right away so the video doesn't play untranslated frames during debounce.
    if (this.shouldUseBufferingLock() && this.cues.length > 0) {
      const startIdx = findCurrentOrNextCueIndex(this.cues, cursorMs);
      if (startIdx >= 0) {
        const fastSize = Math.max(1, configStore.get().fastBatchSize || 10);
        const fastWindow = this.cues.slice(startIdx, Math.min(this.cues.length, startIdx + fastSize));
        if (fastWindow.some((c) => !c.targetText)) {
          this.lockBuffering(true, "翻译字幕...");
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
  }

  private refreshCurrentCueDisplay(): void {
    if (!this.videoEl) return;
    const idx = findActiveCueIndex(this.cues, this.videoEl.currentTime * 1000);
    this.activeCueIndex = idx;
    this.overlay.renderCue(idx >= 0 ? this.cues[idx] : null);
  }

  private scheduleFromCursor(trigger: "initial" | "seek"): void {
    const cfg = configStore.get();
    if (cfg.subtitleMode !== "bilingual" && cfg.subtitleMode !== "target") {
      this.unlockBuffering();
      return;
    }
    if (!cfg.apiBaseUrl.trim() || !cfg.model.trim()) {
      this.unlockBuffering();
      this.overlay.setStatus("未配置翻译接口");
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
    const fastEndExclusive = Math.min(this.cues.length, startIdx + fastSize);
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
      this.cues.length,
      cfg.targetLang,
      cfg.model.trim(),
    );
    const metadata = this.metadata || extractVideoMetadata(videoId);

    try {
      // Stage 1: 10-Cue Fast Batch with playback locked in buffering state
      if (missingFastCues.length > 0) {
        const totalFast = missingFastCues.length;
        let completedInFast = 0;

        if (cfg.holdPlaybackForFastBatch) {
          this.lockBuffering(trigger === "initial", `翻译字幕 0/${totalFast}`);
        } else {
          this.overlay.setStatus(`翻译字幕 0/${totalFast}`);
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
              completedInFast++;
              const progressText = `翻译字幕 ${Math.min(completedInFast, totalFast)}/${totalFast}`;
              if (this.bufferingLockActive) {
                this.overlay.setBuffering(true, progressText);
              } else {
                this.overlay.setStatus(progressText);
              }
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

        this.refreshCurrentCueDisplay();
        this.unlockBuffering();
      } else {
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

        const batchCues: Cue[] = [];
        for (
          let i = nextUntranslated;
          i < this.cues.length && batchCues.length < batchSize;
          i++
        ) {
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
      this.unlockBuffering();
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[YT+] Subtitle translation error:", msg);
      this.overlay.setStatus(`翻译失败: ${msg.slice(0, 48)}`);
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
    if (!keepBufferingLock) {
      this.unlockBuffering();
    }
    if (this.pipelineAbort) {
      this.pipelineAbort.abort();
      this.pipelineAbort = null;
    }
  }

  reset(): void {
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
  }
}
