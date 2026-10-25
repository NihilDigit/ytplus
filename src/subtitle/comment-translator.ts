import { configStore } from "../config";
import { tr } from "../i18n";
import { clearChildren, el, upsertStyle } from "../utils/dom";
import { extractVideoMetadata, getCurrentVideoId } from "./extractor";
import { translateCommentText } from "./llm-client";
import { renderRichDescriptionInto } from "./metadata-translator";

const COMMENT_STYLE_ID = "ytpp-comment-translator-style";
const COMMENT_SELECTOR = "ytd-comment-view-model, ytd-comment-renderer";
const SVG_NS = "http://www.w3.org/2000/svg";

// Standard Material "translate" (文A) 24x24 icon path
const TRANSLATE_WEN_A_ICON_PATH =
  "M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z";

function createTranslateWenAIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", TRANSLATE_WEN_A_ICON_PATH);
  path.setAttribute("fill", "currentColor");
  svg.appendChild(path);
  return svg;
}

const commentMemoryCache = new Map<string, string>();

function hashCommentKey(text: string, targetLang: string, model: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${targetLang}::${model}::${text.length}::${(h >>> 0).toString(16)}`;
}

export class CommentTranslator {
  private commentsObserver: MutationObserver | null = null;
  private observedRoot: Element | null = null;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;

  init(): void {
    this.injectStyles();
    this.scheduleScan();
    window.addEventListener("yt-navigate-finish", () => this.scheduleScan());
    window.addEventListener("yt-page-data-updated", () => this.scheduleScan());
    window.addEventListener("scroll", () => this.scheduleScan(), { passive: true });
    configStore.subscribe(() => {
      this.refreshButtonLabels();
    });
  }

  private injectStyles(): void {
    upsertStyle(
      COMMENT_STYLE_ID,
      `
      /* Hide YouTube's native translate button when YT+ comment button is mounted */
      ytd-comment-view-model .ytpp-comment-btn-mounted ~ ytd-tri-state-button-view-model,
      ytd-comment-renderer .ytpp-comment-btn-mounted ~ #translate-button {
        display: none !important;
      }

      @keyframes ytpp-comment-spin {
        to { transform: rotate(360deg); }
      }

      .ytpp-comment-translate-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        padding: 0;
        margin-left: 4px;
        border-radius: 50%;
        border: none;
        background: transparent;
        color: var(--yt-spec-text-secondary, inherit);
        cursor: pointer;
        user-select: none;
        vertical-align: middle;
        transition: background 0.14s ease, color 0.14s ease;
      }

      .ytpp-comment-translate-btn:hover {
        background: rgba(128, 128, 128, 0.16);
        color: var(--yt-spec-text-primary, inherit);
      }

      .ytpp-comment-translate-btn.ytpp-active {
        color: var(--yt-spec-text-primary, inherit);
        background: rgba(128, 128, 128, 0.18);
      }

      .ytpp-comment-translate-btn[disabled] {
        opacity: 0.6;
        cursor: default;
      }

      .ytpp-comment-spinner {
        width: 14px;
        height: 14px;
        border: 2px solid currentColor;
        border-right-color: transparent;
        border-radius: 50%;
        animation: ytpp-comment-spin 0.65s linear infinite;
      }

      /* In-place replacement: inherits exact typography & spacing of native #content-text */
      .ytpp-comment-inline-text {
        display: block;
        color: var(--yt-spec-text-primary, inherit);
        font-family: Roboto, Arial, "PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei UI", sans-serif;
        font-size: 1.4rem;
        line-height: 2rem;
        font-weight: 400;
        white-space: pre-wrap;
        word-break: break-word;
      }
      `,
    );
  }

  private scheduleScan(): void {
    if (this.scanTimer) return;
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      this.scanComments();
    }, 180);
  }

  private ensureCommentsObserver(): void {
    const commentsRoot = document.querySelector("ytd-comments#comments #contents, ytd-comments#comments");
    if (!commentsRoot || commentsRoot === this.observedRoot) {
      return;
    }
    this.commentsObserver?.disconnect();
    this.observedRoot = commentsRoot;
    this.commentsObserver = new MutationObserver(() => {
      this.scheduleScan();
    });
    this.commentsObserver.observe(commentsRoot, {
      childList: true,
      subtree: true,
    });
  }

  private scanComments(): void {
    this.ensureCommentsObserver();
    const commentNodes = document.querySelectorAll<HTMLElement>(COMMENT_SELECTOR);
    for (const commentEl of Array.from(commentNodes)) {
      this.mountButtonOnComment(commentEl);
    }
  }

  private mountButtonOnComment(commentEl: HTMLElement): void {
    const contentTextEl = commentEl.querySelector<HTMLElement>(
      "#content-text, yt-attributed-string#content-text",
    );
    if (!contentTextEl) return;

    const toolbarEl = commentEl.querySelector<HTMLElement>(
      "#toolbar, ytd-comment-engagement-bar #toolbar",
    );
    if (!toolbarEl) return;

    if (toolbarEl.querySelector(".ytpp-comment-translate-btn")) {
      return;
    }

    let state: "idle" | "loading" | "translated" | "original" = "idle";
    let cachedTranslation = "";
    let inlineTransEl: HTMLElement | null = null;

    const syncBtnAppearance = (btn: HTMLButtonElement) => {
      clearChildren(btn);
      btn.dataset.ytppState = state;
      if (state === "loading") {
        btn.appendChild(el("span", { className: "ytpp-comment-spinner" }));
        btn.title = tr("正在翻译评论...", "Translating comment...");
        btn.classList.remove("ytpp-active");
        btn.disabled = true;
      } else if (state === "translated") {
        btn.appendChild(createTranslateWenAIcon());
        btn.title = tr("切换回原文", "Show original");
        btn.classList.add("ytpp-active");
        btn.disabled = false;
      } else if (state === "original") {
        btn.appendChild(createTranslateWenAIcon());
        btn.title = tr("切换为译文", "Show translation");
        btn.classList.remove("ytpp-active");
        btn.disabled = false;
      } else {
        btn.appendChild(createTranslateWenAIcon());
        btn.title = tr("翻译评论", "Translate comment");
        btn.classList.remove("ytpp-active");
        btn.disabled = false;
      }
    };

    const showTranslatedInPlace = (text: string) => {
      if (!inlineTransEl || !commentEl.contains(inlineTransEl)) {
        inlineTransEl = el("div", { className: "ytpp-comment-inline-text" });
        const cs = getComputedStyle(contentTextEl);
        if (cs.color) inlineTransEl.style.color = cs.color;
        if (cs.fontSize) inlineTransEl.style.fontSize = cs.fontSize;
        if (cs.lineHeight) inlineTransEl.style.lineHeight = cs.lineHeight;
        contentTextEl.parentElement?.insertBefore(inlineTransEl, contentTextEl.nextSibling);
      }
      renderRichDescriptionInto(inlineTransEl, text);
      contentTextEl.style.display = "none";
      inlineTransEl.style.display = "block";
    };

    const showOriginalInPlace = () => {
      if (inlineTransEl) {
        inlineTransEl.style.display = "none";
      }
      contentTextEl.style.display = "";
    };

    const btn = el("button", {
      className: "ytpp-comment-translate-btn ytpp-comment-btn-mounted",
      attrs: {
        type: "button",
        "aria-label": tr("翻译评论", "Translate comment"),
      },
      on: {
        click: async (e) => {
          e.stopPropagation();
          e.preventDefault();

          if (state === "loading") return;

          if (state === "translated") {
            showOriginalInPlace();
            state = "original";
            syncBtnAppearance(btn);
            return;
          }

          if (state === "original" && cachedTranslation) {
            showTranslatedInPlace(cachedTranslation);
            state = "translated";
            syncBtnAppearance(btn);
            return;
          }

          const rawText = (contentTextEl.textContent || "").trim();
          if (!rawText) return;

          const cfg = configStore.get();
          const cacheKey = hashCommentKey(rawText, cfg.targetLang, cfg.model.trim());
          const existing = commentMemoryCache.get(cacheKey);

          if (existing) {
            cachedTranslation = existing;
            showTranslatedInPlace(existing);
            state = "translated";
            syncBtnAppearance(btn);
            return;
          }

          state = "loading";
          syncBtnAppearance(btn);

          try {
            const vid = getCurrentVideoId();
            const metadata = vid ? extractVideoMetadata(vid) : null;
            const translated = await translateCommentText(cfg, rawText, metadata);
            if (!translated) {
              throw new Error(tr("未返回译文", "Empty translation"));
            }
            commentMemoryCache.set(cacheKey, translated);
            cachedTranslation = translated;
            showTranslatedInPlace(translated);
            state = "translated";
            syncBtnAppearance(btn);
          } catch (err) {
            state = "idle";
            syncBtnAppearance(btn);
            const msg = err instanceof Error ? err.message : String(err);
            btn.title = msg;
          }
        },
      },
    });

    syncBtnAppearance(btn);
    toolbarEl.appendChild(btn);
  }

  private refreshButtonLabels(): void {
    const buttons = document.querySelectorAll<HTMLButtonElement>(".ytpp-comment-translate-btn");
    for (const btn of Array.from(buttons)) {
      const st = btn.dataset.ytppState;
      if (st === "translated") {
        btn.title = tr("切换回原文", "Show original");
      } else if (st === "original") {
        btn.title = tr("切换为译文", "Show translation");
      } else if (st !== "loading") {
        btn.title = tr("翻译评论", "Translate comment");
      }
    }
  }
}
