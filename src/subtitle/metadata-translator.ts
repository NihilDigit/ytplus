import { configStore } from "../config";
import type { VideoMetadata } from "../types";
import { el, upsertStyle } from "../utils/dom";
import { extractVideoMetadata } from "./extractor";
import {
  type TranslatedMetadataResult,
  translateVideoMetadata,
} from "./llm-client";

const META_STYLE_ID = "ytpp-metadata-translator-style";
const CACHE_PREFIX = "ytpp_meta_v1:";

const memoryCache = new Map<string, TranslatedMetadataResult>();

export class MetadataTranslator {
  private currentVideoId: string | null = null;
  private abortController: AbortController | null = null;
  private latestResult: TranslatedMetadataResult | null = null;
  private domObserver: MutationObserver | null = null;

  constructor() {
    this.injectStyles();
    configStore.subscribe(() => {
      this.syncDomVisibility();
      if (
        this.currentVideoId &&
        !this.latestResult &&
        !this.abortController &&
        this.shouldTranslate()
      ) {
        void this.attachToVideo(this.currentVideoId, true);
      }
    });
  }

  private injectStyles(): void {
    upsertStyle(
      META_STYLE_ID,
      `
      .ytpp-meta-title {
        display: block;
        margin-top: 3px;
        font-family: inherit;
        font-size: 0.78em;
        font-weight: 500;
        line-height: 1.35;
        color: inherit;
        opacity: 0.76;
        word-break: break-word;
      }

      /* Inside ytd-text-inline-expander: collapsed = compact 2-line preview, expanded = full text */
      .ytpp-meta-desc {
        font-family: Roboto, "PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei UI", sans-serif;
        font-size: 1.4rem;
        line-height: 2rem;
        color: inherit;
        word-break: break-word;
      }

      ytd-text-inline-expander:not([is-expanded]) .ytpp-meta-desc {
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        white-space: normal;
        margin-bottom: 4px;
        opacity: 0.9;
      }

      ytd-text-inline-expander[is-expanded] .ytpp-meta-desc {
        display: block;
        white-space: pre-wrap;
        margin-bottom: 12px;
        padding-bottom: 12px;
        border-bottom: 1px solid rgba(128, 128, 128, 0.24);
      }
      `,
    );
  }

  private shouldTranslate(): boolean {
    const cfg = configStore.get();
    return Boolean(
      cfg.translateMetadata &&
        cfg.subtitleMode !== "off" &&
        cfg.apiBaseUrl.trim() &&
        cfg.model.trim(),
    );
  }

  private makeCacheKey(videoId: string): string {
    const cfg = configStore.get();
    return `${CACHE_PREFIX}${videoId}::${cfg.targetLang}::${cfg.model.trim()}`;
  }

  private getCached(videoId: string): TranslatedMetadataResult | null {
    const key = this.makeCacheKey(videoId);
    if (memoryCache.has(key)) {
      return memoryCache.get(key) ?? null;
    }
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw) as TranslatedMetadataResult;
        if (parsed && (parsed.title || parsed.description)) {
          memoryCache.set(key, parsed);
          return parsed;
        }
      }
    } catch {
      // Ignore storage errors
    }
    return null;
  }

  private setCached(videoId: string, res: TranslatedMetadataResult): void {
    const key = this.makeCacheKey(videoId);
    memoryCache.set(key, res);
    try {
      localStorage.setItem(key, JSON.stringify(res));
    } catch {
      // Ignore storage quota errors
    }
  }

  async attachToVideo(videoId: string, force = false): Promise<void> {
    if (this.currentVideoId === videoId && !force && this.latestResult) {
      this.renderToDom();
      return;
    }

    this.reset();
    this.currentVideoId = videoId;

    if (!this.shouldTranslate()) {
      return;
    }

    let metadata: VideoMetadata = extractVideoMetadata(videoId);
    for (let i = 0; i < 6 && !metadata.title; i++) {
      await new Promise((r) => setTimeout(r, 350));
      if (this.currentVideoId !== videoId) return;
      metadata = extractVideoMetadata(videoId);
    }

    if (!metadata.title && !metadata.description) {
      return;
    }

    const cached = this.getCached(videoId);
    if (cached) {
      this.latestResult = cached;
      this.renderToDom();
      this.observeWatchMetadataDom();
      return;
    }

    const controller = new AbortController();
    this.abortController = controller;

    try {
      const result = await translateVideoMetadata(
        configStore.get(),
        metadata,
        controller.signal,
      );
      if (this.currentVideoId !== videoId || controller.signal.aborted || !result) {
        return;
      }
      this.setCached(videoId, result);
      this.latestResult = result;
      this.renderToDom();
      this.observeWatchMetadataDom();
    } catch {
      // Non-blocking metadata translation ignore
    } finally {
      if (this.abortController === controller) {
        this.abortController = null;
      }
    }
  }

  private observeWatchMetadataDom(): void {
    this.domObserver?.disconnect();
    const watchMeta = document.querySelector("ytd-watch-metadata, #above-the-fold");
    if (!watchMeta) return;

    this.domObserver = new MutationObserver(() => {
      if (!this.latestResult || !this.shouldTranslate()) return;
      if (!document.querySelector(".ytpp-meta-title")) {
        this.renderToDom();
      }
    });
    this.domObserver.observe(watchMeta, { childList: true, subtree: false });
  }

  private syncDomVisibility(): void {
    const show = this.shouldTranslate() && Boolean(this.latestResult);
    const titleEl = document.querySelector<HTMLElement>(".ytpp-meta-title");
    const descEl = document.querySelector<HTMLElement>(".ytpp-meta-desc");
    if (titleEl) titleEl.style.display = show ? "" : "none";
    if (descEl) descEl.style.display = show ? "" : "none";
  }

  private renderToDom(): void {
    const res = this.latestResult;
    if (!res || !this.shouldTranslate()) return;

    // 1. Mount translated title directly inside #title h1 so it inherits exact Light/Dark text color
    if (res.title) {
      const h1El = document.querySelector<HTMLElement>(
        "ytd-watch-metadata #title h1, #above-the-fold #title h1",
      );
      if (h1El) {
        const nativeTextEl = h1El.querySelector<HTMLElement>("yt-formatted-string");
        let transTitleEl = h1El.querySelector<HTMLElement>(".ytpp-meta-title");
        if (!transTitleEl) {
          transTitleEl = el("div", { className: "ytpp-meta-title" });
          h1El.appendChild(transTitleEl);
        }
        if (nativeTextEl) {
          const computedColor = getComputedStyle(nativeTextEl).color;
          if (computedColor) {
            transTitleEl.style.color = computedColor;
          }
        }
        transTitleEl.textContent = res.title;
        transTitleEl.style.display = "";
      }
    }

    // 2. Mount translated description inside ytd-text-inline-expander#description-inline-expander
    // so it automatically clamps to 2 lines when collapsed and expands only when clicked
    if (res.description) {
      const expander = document.querySelector<HTMLElement>(
        "ytd-watch-metadata ytd-text-inline-expander#description-inline-expander, #above-the-fold #description-inline-expander",
      );
      if (expander) {
        const refSnippet = expander.querySelector<HTMLElement>(
          "#attributed-snippet-text, #snippet, yt-attributed-string",
        );
        let transDescEl = expander.querySelector<HTMLElement>(".ytpp-meta-desc");
        if (!transDescEl) {
          transDescEl = el("div", { className: "ytpp-meta-desc" });
          expander.insertBefore(transDescEl, expander.firstChild);
        }
        if (refSnippet) {
          const computedColor = getComputedStyle(refSnippet).color;
          if (computedColor) {
            transDescEl.style.color = computedColor;
          }
        }
        transDescEl.textContent = res.description;
        transDescEl.style.display = "";
      }
    }
  }

  reset(): void {
    this.domObserver?.disconnect();
    this.domObserver = null;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.currentVideoId = null;
    this.latestResult = null;
    document.querySelectorAll(".ytpp-meta-title, .ytpp-meta-desc").forEach((node) => {
      node.remove();
    });
  }
}
