import { configStore } from "../config";
import { tr } from "../i18n";
import type { VideoMetadata } from "../types";
import { clearChildren, el, upsertStyle } from "../utils/dom";
import { extractVideoMetadata } from "./extractor";
import {
  type TranslatedMetadataResult,
  translateVideoMetadata,
} from "./llm-client";

const META_STYLE_ID = "ytpp-metadata-translator-style";
const CACHE_PREFIX = "ytpp_meta_v1:";
const SVG_NS = "http://www.w3.org/2000/svg";

// Standard Material "translate" (文A) 24x24 icon path
const TRANSLATE_WEN_A_ICON_PATH =
  "M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z";

// Upward & downward triangles for expand/collapse
const TRIANGLE_UP_PATH = "M7 14l5-5 5 5H7z";
const TRIANGLE_DOWN_PATH = "M7 10l5 5 5-5H7z";

function createSvgIcon(pathD: string, size = 18): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", pathD);
  path.setAttribute("fill", "currentColor");
  svg.appendChild(path);
  return svg;
}

const memoryCache = new Map<string, TranslatedMetadataResult>();

type DescViewMode = "translated" | "original";

const RICH_TOKEN_REGEX =
  /(https?:\/\/[^\s<>"']+)|((?:^|(?<=[\s([【（]))(?:\d{1,2}:)?\d{1,2}:\d{2}(?=$|[\s)\]】），。,.!?;:]))|((?:^|(?<=[\s([【（]))#[a-zA-Z0-9_\u4e00-\u9fa5]{1,48})/gm;

function parseTimestampToSeconds(raw: string): number | null {
  const parts = raw.trim().split(":").map((p) => Number.parseInt(p, 10));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return null;
}

function splitTrailingUrlPunctuation(rawUrl: string): { cleanUrl: string; trailing: string } {
  let cleanUrl = rawUrl;
  let trailing = "";
  while (cleanUrl.length > 0 && /[.,!?;:，。！？；：)'"”’\]】）]$/.test(cleanUrl)) {
    const lastChar = cleanUrl[cleanUrl.length - 1];
    if (lastChar === ")") {
      const opens = (cleanUrl.match(/\(/g) || []).length;
      const closes = (cleanUrl.match(/\)/g) || []).length;
      if (closes <= opens) break;
    }
    trailing = lastChar + trailing;
    cleanUrl = cleanUrl.slice(0, -1);
  }
  return { cleanUrl, trailing };
}

function formatDisplayUrl(cleanUrl: string): string {
  try {
    const u = new URL(cleanUrl);
    const host = u.hostname.replace(/^www\./, "");
    const rest = `${u.pathname === "/" ? "" : u.pathname}${u.search}${u.hash}`;
    const full = `${host}${rest}`;
    return full.length > 56 ? `${full.slice(0, 53)}...` : full;
  } catch {
    return cleanUrl.length > 56 ? `${cleanUrl.slice(0, 53)}...` : cleanUrl;
  }
}

export function renderRichDescriptionInto(container: HTMLElement, text: string): void {
  clearChildren(container);
  const regex = new RegExp(RICH_TOKEN_REGEX.source, "gm");
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const matchStart = match.index;
    if (matchStart > lastIndex) {
      container.appendChild(document.createTextNode(text.slice(lastIndex, matchStart)));
    }

    const fullMatch = match[0];
    const urlToken = match[1];
    const timeToken = match[2];
    const hashToken = match[3];

    if (urlToken) {
      const { cleanUrl, trailing } = splitTrailingUrlPunctuation(urlToken);
      const link = el("a", {
        className: "ytpp-desc-link",
        text: formatDisplayUrl(cleanUrl),
        attrs: {
          href: cleanUrl,
          target: "_blank",
          rel: "noopener noreferrer",
          title: cleanUrl,
        },
        on: {
          click: (e) => e.stopPropagation(),
        },
      });
      container.appendChild(link);
      if (trailing) {
        container.appendChild(document.createTextNode(trailing));
      }
    } else if (timeToken) {
      const seconds = parseTimestampToSeconds(timeToken);
      if (seconds !== null) {
        const chip = el("button", {
          className: "ytpp-desc-timestamp",
          text: timeToken,
          attrs: {
            type: "button",
            title: `${tr("跳转至", "Seek to")} ${timeToken}`,
          },
          on: {
            click: (e) => {
              e.stopPropagation();
              e.preventDefault();
              const video = document.querySelector<HTMLVideoElement>(
                "#movie_player video, video.html5-main-video",
              );
              if (video) {
                video.currentTime = seconds;
                void video.play().catch(() => {});
              }
            },
          },
        });
        container.appendChild(chip);
      } else {
        container.appendChild(document.createTextNode(fullMatch));
      }
    } else if (hashToken) {
      const tagName = hashToken.replace(/^#/, "");
      const tagLink = el("a", {
        className: "ytpp-desc-hashtag",
        text: hashToken,
        attrs: {
          href: `/hashtag/${encodeURIComponent(tagName)}`,
        },
        on: {
          click: (e) => e.stopPropagation(),
        },
      });
      container.appendChild(tagLink);
    } else {
      container.appendChild(document.createTextNode(fullMatch));
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    container.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}

export class MetadataTranslator {
  private currentVideoId: string | null = null;
  private abortController: AbortController | null = null;
  private latestResult: TranslatedMetadataResult | null = null;
  private latestMetadata: VideoMetadata | null = null;
  private domObserver: MutationObserver | null = null;
  private expanderAttrObserver: MutationObserver | null = null;
  private viewMode: DescViewMode = "translated";

  private toolbarEl: HTMLElement | null = null;
  private langToggleBtn: HTMLButtonElement | null = null;
  private collapseBtn: HTMLButtonElement | null = null;
  private descContainerEl: HTMLElement | null = null;
  private boundHeaderClickCard: HTMLElement | null = null;

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
      /* Neutralize YouTube's colored ambient tint on the description card */
      ytd-watch-metadata #description,
      #above-the-fold #description {
        position: relative;
        background-color: var(--yt-spec-badge-chip-background, rgba(128, 128, 128, 0.1)) !important;
      }

      html[dark] ytd-watch-metadata #description,
      html[dark] #above-the-fold #description {
        background-color: rgba(255, 255, 255, 0.08) !important;
      }

      html:not([dark]) ytd-watch-metadata #description,
      html:not([dark]) #above-the-fold #description {
        background-color: rgba(0, 0, 0, 0.05) !important;
      }

      /* Make the entire top header row (views, date, products) clickable to toggle expand/collapse */
      ytd-watch-metadata #info-container,
      #above-the-fold #info-container,
      ytd-watch-metadata #description-inner > ytd-watch-info-text,
      ytd-watch-metadata #tooltip {
        cursor: pointer !important;
        user-select: none;
      }

      ytd-watch-metadata #info-container,
      #above-the-fold #info-container {
        padding-right: 72px;
      }

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

      /* Top-right icon toolbar anchored at the upper-right corner of the description card */
      .ytpp-desc-toolbar {
        position: absolute;
        top: 6px;
        right: 8px;
        display: flex;
        align-items: center;
        gap: 2px;
        z-index: 6;
      }

      .ytpp-desc-icon-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        padding: 0;
        border-radius: 50%;
        border: none;
        background: transparent;
        color: var(--yt-spec-text-secondary, inherit);
        opacity: 0.78;
        cursor: pointer;
        user-select: none;
        transition: background 0.14s ease, color 0.14s ease, opacity 0.14s ease;
      }

      .ytpp-desc-icon-btn:hover {
        background: rgba(128, 128, 128, 0.16);
        color: var(--yt-spec-text-primary, inherit);
        opacity: 1;
      }

      .ytpp-desc-icon-btn.ytpp-active {
        color: var(--yt-spec-text-primary, inherit);
        background: rgba(128, 128, 128, 0.18);
        opacity: 1;
      }

      /* Inside ytd-text-inline-expander: collapsed = compact 2-line preview, expanded = full rich text */
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
        margin-bottom: 2px;
      }

      ytd-text-inline-expander[is-expanded] .ytpp-meta-desc {
        display: block;
        white-space: pre-wrap;
        margin-bottom: 12px;
      }

      /* Hide duplicate native English snippet when YT+ translated view is active */
      ytd-text-inline-expander.ytpp-showing-translated #attributed-snippet-text,
      ytd-text-inline-expander.ytpp-showing-translated #plain-snippet-text,
      ytd-text-inline-expander.ytpp-showing-translated #snippet,
      ytd-text-inline-expander.ytpp-showing-translated #expanded {
        display: none !important;
      }

      ytd-text-inline-expander.ytpp-showing-original .ytpp-meta-desc {
        display: none !important;
      }

      /* Rich text tokens inside YT+ translated description */
      .ytpp-desc-link {
        color: #3ea6ff;
        text-decoration: none;
        font-weight: 500;
        background: rgba(62, 166, 255, 0.1);
        padding: 1px 6px;
        border-radius: 5px;
        transition: background 0.12s ease;
      }

      .ytpp-desc-link:hover {
        background: rgba(62, 166, 255, 0.2);
        text-decoration: underline;
      }

      .ytpp-desc-timestamp {
        border: none;
        background: rgba(62, 166, 255, 0.14);
        color: #3ea6ff;
        font-family: inherit;
        font-size: 0.92em;
        font-weight: 500;
        font-variant-numeric: tabular-nums;
        padding: 1px 6px;
        border-radius: 5px;
        cursor: pointer;
        transition: background 0.12s ease;
      }

      .ytpp-desc-timestamp:hover {
        background: rgba(62, 166, 255, 0.26);
      }

      .ytpp-desc-hashtag {
        color: #3ea6ff;
        text-decoration: none;
        font-weight: 500;
      }

      .ytpp-desc-hashtag:hover {
        text-decoration: underline;
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
    this.viewMode = "translated";

    // Always mount the top-right expand/collapse triangle & header-row click handler immediately
    this.mountDescriptionControls();

    if (!this.shouldTranslate()) {
      return;
    }

    let metadata: VideoMetadata = extractVideoMetadata(videoId);
    for (let i = 0; i < 8 && (!metadata.title || !metadata.description); i++) {
      await new Promise((r) => setTimeout(r, 350));
      if (this.currentVideoId !== videoId) return;
      metadata = extractVideoMetadata(videoId);
    }

    if (!metadata.title && !metadata.description) {
      return;
    }
    this.latestMetadata = metadata;

    const cached = this.getCached(videoId);
    if (cached && cached.title && (cached.description || !metadata.description)) {
      this.latestResult = cached;
      await this.waitAndRenderToDom(videoId);
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
      await this.waitAndRenderToDom(videoId);
      this.observeWatchMetadataDom();
    } catch (err) {
      console.warn("[YT+] Metadata translation error:", err);
    } finally {
      if (this.abortController === controller) {
        this.abortController = null;
      }
    }
  }

  private async waitAndRenderToDom(videoId: string): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt++) {
      if (this.currentVideoId !== videoId) return;
      this.renderToDom();
      const hasTitleEl = !this.latestResult?.title || Boolean(document.querySelector(".ytpp-meta-title"));
      const hasDescEl = !this.latestResult?.description || Boolean(document.querySelector(".ytpp-meta-desc"));
      if (hasTitleEl && hasDescEl) {
        return;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  private observeWatchMetadataDom(): void {
    this.domObserver?.disconnect();
    const watchMeta = document.querySelector("ytd-watch-metadata, #above-the-fold, ytd-watch-flexy");
    if (!watchMeta) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    this.domObserver = new MutationObserver(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        this.mountDescriptionControls();
        if (!this.latestResult || !this.shouldTranslate()) return;
        const missingTitle = this.latestResult?.title && !document.querySelector(".ytpp-meta-title");
        const missingDesc = this.latestResult?.description && !document.querySelector(".ytpp-meta-desc");
        if (missingTitle || missingDesc) {
          this.renderToDom();
        }
      }, 150);
    });
    this.domObserver.observe(watchMeta, { childList: true, subtree: true });
  }

  private isDescriptionExpanded(expander?: HTMLElement | null): boolean {
    const targetExpander =
      expander ||
      document.querySelector<HTMLElement>(
        "ytd-watch-metadata ytd-text-inline-expander#description-inline-expander, #above-the-fold #description-inline-expander",
      );
    if (targetExpander?.hasAttribute("is-expanded")) {
      return true;
    }
    const watchMeta = document.querySelector<HTMLElement>("ytd-watch-metadata");
    if (watchMeta && !watchMeta.hasAttribute("description-collapsed") && targetExpander) {
      return targetExpander.hasAttribute("is-expanded");
    }
    return false;
  }

  private expandDescription(expander: HTMLElement): void {
    const expandBtn = document.querySelector<HTMLElement>(
      "ytd-watch-metadata tp-yt-paper-button#expand, ytd-watch-metadata #description-inline-expander #expand, #description-inline-expander #expand-sizer, tp-yt-paper-button#expand",
    );
    if (expandBtn) {
      expandBtn.click();
    }
    expander.setAttribute("is-expanded", "");
    (expander as unknown as { isExpanded?: boolean }).isExpanded = true;
    const watchMeta = document.querySelector<HTMLElement>("ytd-watch-metadata");
    watchMeta?.removeAttribute("description-collapsed");
    this.syncToolbarButtons(expander);
  }

  private collapseDescription(expander: HTMLElement): void {
    const lessBtn = document.querySelector<HTMLElement>(
      "ytd-watch-metadata tp-yt-paper-button#collapse, ytd-watch-metadata #description-inner #collapse, #description-inline-expander #collapse, tp-yt-paper-button#collapse",
    );
    if (lessBtn) {
      lessBtn.click();
    }
    expander.removeAttribute("is-expanded");
    (expander as unknown as { isExpanded?: boolean }).isExpanded = false;
    const watchMeta = document.querySelector<HTMLElement>("ytd-watch-metadata");
    watchMeta?.setAttribute("description-collapsed", "");

    const descCard = document.querySelector<HTMLElement>(
      "ytd-watch-metadata #description, #above-the-fold #description",
    );
    if (descCard) {
      const rect = descCard.getBoundingClientRect();
      if (rect.top < 64) {
        descCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }
    this.syncToolbarButtons(expander);
  }

  private toggleDescriptionExpanded(expander?: HTMLElement | null): void {
    const targetExpander =
      expander ||
      document.querySelector<HTMLElement>(
        "ytd-watch-metadata ytd-text-inline-expander#description-inline-expander, #above-the-fold #description-inline-expander",
      );
    if (!targetExpander) return;
    if (this.isDescriptionExpanded(targetExpander)) {
      this.collapseDescription(targetExpander);
    } else {
      this.expandDescription(targetExpander);
    }
  }

  private observeExpanderState(expander: HTMLElement): void {
    this.expanderAttrObserver?.disconnect();
    const watchMeta = document.querySelector("ytd-watch-metadata, #above-the-fold");
    this.expanderAttrObserver = new MutationObserver(() => {
      this.syncToolbarButtons(expander);
    });
    this.expanderAttrObserver.observe(expander, {
      attributes: true,
      attributeFilter: ["is-expanded"],
    });
    if (watchMeta) {
      this.expanderAttrObserver.observe(watchMeta, {
        attributes: true,
        attributeFilter: ["description-collapsed"],
      });
    }
    this.syncToolbarButtons(expander);
  }

  private mountDescriptionControls(): HTMLElement | null {
    const expander = document.querySelector<HTMLElement>(
      "ytd-watch-metadata ytd-text-inline-expander#description-inline-expander, #above-the-fold #description-inline-expander",
    );
    if (!expander) return null;

    const descCard =
      document.querySelector<HTMLElement>(
        "ytd-watch-metadata #description, #above-the-fold #description",
      ) || expander;

    // Make clicking anywhere on the top header row (#info-container / views / date) toggle expand/collapse
    if (this.boundHeaderClickCard !== descCard) {
      this.boundHeaderClickCard = descCard;
      descCard.addEventListener(
        "click",
        (e: MouseEvent) => {
          const target = e.target as Element | null;
          if (!target) return;
          if (target.closest(".ytpp-desc-toolbar, a, button, tp-yt-paper-button")) {
            return;
          }
          const inHeaderRow = Boolean(
            target.closest("#info-container, ytd-watch-info-text, #tooltip"),
          );
          const clickOffsetY = e.clientY - descCard.getBoundingClientRect().top;
          const isTopBand = clickOffsetY >= 0 && clickOffsetY <= 40;

          if ((inHeaderRow || isTopBand) && this.isDescriptionExpanded(expander)) {
            e.stopPropagation();
            e.preventDefault();
            this.collapseDescription(expander);
          } else if (inHeaderRow && !this.isDescriptionExpanded(expander)) {
            e.stopPropagation();
            e.preventDefault();
            this.expandDescription(expander);
          }
        },
        { capture: true },
      );
    }

    let toolbar = descCard.querySelector<HTMLElement>(".ytpp-desc-toolbar");
    if (!toolbar) {
      this.langToggleBtn = el(
        "button",
        {
          className: "ytpp-desc-icon-btn ytpp-active",
          attrs: {
            type: "button",
            "aria-label": tr("切换译文与原文", "Toggle translation"),
          },
          on: {
            click: (e) => {
              e.stopPropagation();
              e.preventDefault();
              this.viewMode =
                this.viewMode === "translated" ? "original" : "translated";
              this.syncToolbarButtons(expander);
            },
          },
        },
        [createSvgIcon(TRANSLATE_WEN_A_ICON_PATH, 16)],
      );

      this.collapseBtn = el(
        "button",
        {
          className: "ytpp-desc-icon-btn ytpp-collapse-btn",
          attrs: {
            type: "button",
            "aria-label": tr("展开或收起详情栏", "Expand or collapse description"),
          },
          on: {
            click: (e) => {
              e.stopPropagation();
              e.preventDefault();
              this.toggleDescriptionExpanded(expander);
            },
          },
        },
        [createSvgIcon(TRIANGLE_DOWN_PATH, 20)],
      );

      toolbar = el("div", { className: "ytpp-desc-toolbar" }, [
        this.langToggleBtn,
        this.collapseBtn,
      ]);
      descCard.appendChild(toolbar);
      this.observeExpanderState(expander);
    }
    this.toolbarEl = toolbar;
    this.syncToolbarButtons(expander);
    return expander;
  }

  private syncToolbarButtons(expander?: HTMLElement | null): void {
    const targetExpander =
      expander ||
      document.querySelector<HTMLElement>(
        "ytd-watch-metadata ytd-text-inline-expander#description-inline-expander, #above-the-fold #description-inline-expander",
      );
    const isExpanded = this.isDescriptionExpanded(targetExpander);
    const hasTranslation = this.shouldTranslate() && Boolean(this.latestResult?.description);

    if (this.langToggleBtn) {
      this.langToggleBtn.style.display = hasTranslation ? "inline-flex" : "none";
      const isTrans = this.viewMode === "translated";
      this.langToggleBtn.classList.toggle("ytpp-active", isTrans);
      this.langToggleBtn.title = isTrans
        ? tr("切换回原文", "Show original")
        : tr("切换为译文", "Show translation");
    }

    if (this.collapseBtn) {
      this.collapseBtn.style.display = "inline-flex";
      const pathEl = this.collapseBtn.querySelector("path");
      if (pathEl) {
        pathEl.setAttribute("d", isExpanded ? TRIANGLE_UP_PATH : TRIANGLE_DOWN_PATH);
      }
      this.collapseBtn.title = isExpanded
        ? tr("收起详情栏", "Collapse description")
        : tr("展开详情栏", "Expand description");
    }

    if (targetExpander) {
      targetExpander.classList.toggle(
        "ytpp-showing-translated",
        hasTranslation && this.viewMode === "translated",
      );
      targetExpander.classList.toggle(
        "ytpp-showing-original",
        !hasTranslation || this.viewMode === "original",
      );
    }

    const titleEl = document.querySelector<HTMLElement>(".ytpp-meta-title");
    if (titleEl) {
      const showTitle =
        this.shouldTranslate() &&
        Boolean(this.latestResult?.title) &&
        this.viewMode === "translated";
      titleEl.style.display = showTitle ? "" : "none";
    }
  }

  private syncDomVisibility(): void {
    this.syncToolbarButtons();
  }

  private renderToDom(): void {
    this.mountDescriptionControls();
    const res = this.latestResult;
    if (!res || !this.shouldTranslate()) return;

    // 1. Mount translated title directly inside #title h1
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
      }
    }

    // 2. Mount rich translated description inside #description-inline-expander
    if (res.description) {
      const expander = this.mountDescriptionControls();
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
        this.descContainerEl = transDescEl;
        renderRichDescriptionInto(transDescEl, res.description);
      }
    }

    this.syncDomVisibility();
  }

  reset(): void {
    this.domObserver?.disconnect();
    this.domObserver = null;
    this.expanderAttrObserver?.disconnect();
    this.expanderAttrObserver = null;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.currentVideoId = null;
    this.latestResult = null;
    this.latestMetadata = null;
    this.toolbarEl = null;
    this.langToggleBtn = null;
    this.collapseBtn = null;
    this.descContainerEl = null;
    document
      .querySelectorAll("ytd-text-inline-expander.ytpp-showing-translated, ytd-text-inline-expander.ytpp-showing-original")
      .forEach((node) => {
        node.classList.remove("ytpp-showing-translated", "ytpp-showing-original");
      });
    document
      .querySelectorAll(".ytpp-meta-title, .ytpp-meta-desc, .ytpp-desc-toolbar")
      .forEach((node) => {
        node.remove();
      });
  }
}
