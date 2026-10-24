import { configStore } from "../config";
import { tr } from "../i18n";
import type { Cue } from "../types";
import { el, upsertStyle } from "../utils/dom";

const OVERLAY_STYLE_ID = "ytpp-subtitle-overlay-style";

export class SubtitleOverlay {
  private playerEl: HTMLElement | null = null;
  private container: HTMLElement | null = null;
  private box: HTMLElement | null = null;
  private targetLine: HTMLElement | null = null;
  private sourceLine: HTMLElement | null = null;
  private statusTextEl: HTMLElement | null = null;
  private statusLabelEl: HTMLElement | null = null;
  private statusProgressWrapEl: HTMLElement | null = null;
  private statusProgressFillEl: HTMLElement | null = null;
  private statusSkipBtnEl: HTMLElement | null = null;

  private isDragging = false;
  private pointerArmed = false;
  private activePointerId: number | null = null;
  private dragStartY = 0;
  private dragCurrentDy = 0;
  private dragStartBottom = 6;
  private bufferingActive = false;
  private onSkipBuffering: (() => void) | null = null;

  constructor() {
    this.injectStyles();
    configStore.subscribe(() => this.applyConfigStyles());
  }

  setOnSkipBuffering(callback: () => void): void {
    this.onSkipBuffering = callback;
  }

  private injectStyles(): void {
    upsertStyle(
      OVERLAY_STYLE_ID,
      `
      /* Always hide native YouTube caption window since YT+ takes over the CC button */
      #movie_player .ytp-caption-window-container {
        display: none !important;
        opacity: 0 !important;
        pointer-events: none !important;
      }

      /* During YT+ buffering hold, show YouTube's native .ytp-spinner ring cleanly in center
         and hide any raw .ytp-spinner-message text or center play/pause badges */
      #movie_player.ytpp-buffering .ytp-spinner {
        display: block !important;
        opacity: 1 !important;
        z-index: 80 !important;
        pointer-events: none !important;
      }

      #movie_player .ytp-spinner-message,
      #movie_player.ytpp-buffering .ytp-spinner-message {
        display: none !important;
        opacity: 0 !important;
      }

      #movie_player.ytpp-buffering .ytp-large-play-button,
      #movie_player.ytpp-buffering .ytp-cued-thumbnail-overlay,
      #movie_player.ytpp-buffering .ytp-pause-overlay,
      #movie_player.ytpp-buffering .ytp-bezel,
      #movie_player.ytpp-buffering .ytp-bezel-text-hide,
      #movie_player.ytpp-buffering .ytp-bezel-text-wrapper,
      #movie_player.ytpp-buffering .ytpp-touch-center-btn {
        display: none !important;
        opacity: 0 !important;
        pointer-events: none !important;
      }

      .ytpp-subtitle-layer {
        position: absolute;
        left: 6%;
        right: 6%;
        bottom: var(--ytpp-sub-bottom, 6%);
        z-index: 70;
        display: flex;
        flex-direction: column;
        align-items: center;
        pointer-events: none;
        user-select: none;
        will-change: transform, bottom;
        transition: bottom 0.18s cubic-bezier(0.22, 1, 0.36, 1);
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
      }

      /* Match native YouTube caption window lift when bottom chrome is shown */
      #movie_player:not(.ytp-autohide):not(.ytpp-dragging-subtitle) .ytpp-subtitle-layer,
      #movie_player.ytpp-touch-controls-shown:not(.ytpp-dragging-subtitle) .ytpp-subtitle-layer,
      #movie_player.ytpp-popover-open:not(.ytpp-dragging-subtitle) .ytpp-subtitle-layer {
        bottom: max(var(--ytpp-sub-bottom, 6%), 64px);
      }

      #movie_player.ytp-big-mode:not(.ytp-autohide):not(.ytpp-dragging-subtitle) .ytpp-subtitle-layer,
      #movie_player.ytp-fullscreen:not(.ytp-autohide):not(.ytpp-dragging-subtitle) .ytpp-subtitle-layer {
        bottom: max(var(--ytpp-sub-bottom, 6%), 84px);
      }

      /* Hide player progress bar & bottom controls while dragging subtitles so user can place them at the very bottom */
      #movie_player.ytpp-dragging-subtitle .ytp-chrome-bottom,
      #movie_player.ytpp-dragging-subtitle .ytp-gradient-bottom {
        opacity: 0 !important;
        pointer-events: none !important;
        transition: opacity 0.1s ease !important;
      }

      @keyframes ytpp-pulse-dot {
        0%, 100% { opacity: 0.45; transform: scale(0.88); }
        50% { opacity: 1; transform: scale(1.08); }
      }

      .ytpp-subtitle-status {
        pointer-events: auto;
        margin-bottom: 8px;
        padding: 6px 12px;
        border-radius: 999px;
        background: rgba(18, 18, 22, 0.78);
        backdrop-filter: blur(16px) saturate(140%);
        -webkit-backdrop-filter: blur(16px) saturate(140%);
        border: 1px solid rgba(255, 255, 255, 0.12);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.42);
        color: #f1f1f1;
        font-family: "YouTube Sans", Roboto, "PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei UI", sans-serif;
        font-size: 12.5px;
        font-weight: 500;
        font-variant-numeric: tabular-nums;
        line-height: 1.3;
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }

      .ytpp-status-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #ff2a55;
        box-shadow: 0 0 8px rgba(255, 42, 85, 0.8);
        animation: ytpp-pulse-dot 1.4s ease-in-out infinite;
        flex-shrink: 0;
      }

      .ytpp-status-progress {
        width: 48px;
        height: 4px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.16);
        overflow: hidden;
        flex-shrink: 0;
      }

      .ytpp-status-progress-fill {
        height: 100%;
        width: 0%;
        border-radius: 999px;
        background: linear-gradient(90deg, #ff0033, #ff4d79);
        transition: width 0.2s cubic-bezier(0.22, 1, 0.36, 1);
      }

      .ytpp-status-skip-btn {
        border: 1px solid rgba(255, 255, 255, 0.16);
        background: rgba(255, 255, 255, 0.1);
        color: #ffffff;
        font-family: inherit;
        font-size: 11.5px;
        font-weight: 500;
        padding: 2px 8px;
        border-radius: 999px;
        cursor: pointer;
        transition: background 0.14s ease, border-color 0.14s ease;
      }

      .ytpp-status-skip-btn:hover {
        background: rgba(255, 255, 255, 0.22);
        border-color: rgba(255, 255, 255, 0.3);
      }

      /* Modern refined dual-line subtitle container */
      .ytpp-subtitle-box {
        pointer-events: auto;
        cursor: grab;
        max-width: min(86%, 980px);
        padding: 6px 14px;
        border-radius: 8px;
        text-align: center;
        line-height: 1.38;
        font-family: "YouTube Sans", "YouTube Noto", Roboto, "PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei UI", sans-serif;
        touch-action: none;
        transition: background 0.15s ease, box-shadow 0.15s ease;
      }

      .ytpp-subtitle-box:active {
        cursor: grabbing;
      }

      .ytpp-subtitle-box.ytpp-with-backdrop {
        background: rgba(10, 10, 14, var(--ytpp-backdrop-alpha, 0.42));
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
        border: 1px solid rgba(255, 255, 255, calc(var(--ytpp-backdrop-alpha, 0.42) * 0.14));
        box-shadow: 0 4px 16px rgba(0, 0, 0, calc(var(--ytpp-backdrop-alpha, 0.42) * 0.55));
      }

      .ytpp-subtitle-target {
        color: #ffffff;
        font-weight: 500;
        letter-spacing: 0.01em;
        font-size: calc(clamp(15px, 1.65vw, 23px) * var(--ytpp-font-scale, 1));
        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.92), 0 0 2px rgba(0, 0, 0, 0.85);
        text-wrap: balance;
        word-break: break-word;
      }

      .ytpp-subtitle-source {
        margin-top: 3px;
        color: rgba(255, 255, 255, 0.8);
        font-weight: 400;
        font-size: calc(clamp(12px, 1.18vw, 15.5px) * var(--ytpp-font-scale, 1));
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
        text-wrap: balance;
        word-break: break-word;
      }
      `,
    );
  }

  mount(player: HTMLElement): void {
    this.playerEl = player;

    if (this.container && player.contains(this.container)) {
      this.applyConfigStyles();
      return;
    }

    this.statusLabelEl = el("span", { className: "ytpp-status-label" });
    this.statusProgressFillEl = el("div", { className: "ytpp-status-progress-fill" });
    this.statusProgressWrapEl = el(
      "div",
      { className: "ytpp-status-progress", style: { display: "none" } },
      [this.statusProgressFillEl],
    );
    this.statusSkipBtnEl = el("button", {
      className: "ytpp-status-skip-btn",
      text: tr("跳过等待", "Skip"),
      attrs: { type: "button", title: tr("立即播放视频", "Play immediately") },
      style: { display: "none" },
      on: {
        click: (e) => {
          e.stopPropagation();
          e.preventDefault();
          this.onSkipBuffering?.();
        },
      },
    });

    this.statusTextEl = el(
      "div",
      {
        className: "ytpp-subtitle-status",
        style: { display: "none" },
      },
      [
        el("span", { className: "ytpp-status-dot" }),
        this.statusLabelEl,
        this.statusProgressWrapEl,
        this.statusSkipBtnEl,
      ],
    );

    this.targetLine = el("div", { className: "ytpp-subtitle-target" });
    this.sourceLine = el("div", { className: "ytpp-subtitle-source" });

    this.box = el(
      "div",
      {
        className: "ytpp-subtitle-box",
        style: { display: "none" },
      },
      [this.targetLine, this.sourceLine],
    );

    this.setupDragHandlers(this.box, player);

    this.container = el("div", { className: "ytpp-subtitle-layer" }, [
      this.statusTextEl,
      this.box,
    ]);

    player.appendChild(this.container);
    this.applyConfigStyles();
  }

  private setupDragHandlers(box: HTMLElement, player: HTMLElement): void {
    box.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      this.pointerArmed = true;
      this.isDragging = false;
      this.activePointerId = e.pointerId;
      this.dragStartY = e.clientY;
      this.dragCurrentDy = 0;
      this.dragStartBottom = configStore.get().subtitleBottomPercent;
    });

    box.addEventListener("pointermove", (e: PointerEvent) => {
      if (!this.pointerArmed || e.pointerId !== this.activePointerId || !this.container) {
        return;
      }
      const dy = e.clientY - this.dragStartY;
      if (!this.isDragging) {
        if (Math.abs(dy) < 5) return;
        this.isDragging = true;
        this.container.classList.add("ytpp-dragging");
        player.classList.add("ytpp-dragging-subtitle");
        try {
          box.setPointerCapture(e.pointerId);
        } catch {
          // Ignore
        }
      }
      e.stopPropagation();
      this.dragCurrentDy = dy;
      this.container.style.transform = `translate3d(0, ${this.dragCurrentDy}px, 0)`;
    });

    const endDrag = (e: PointerEvent) => {
      if (!this.pointerArmed || e.pointerId !== this.activePointerId) return;
      this.pointerArmed = false;
      this.activePointerId = null;

      if (!this.isDragging || !this.container) {
        return;
      }

      e.stopPropagation();
      this.isDragging = false;
      this.container.classList.remove("ytpp-dragging");
      player.classList.remove("ytpp-dragging-subtitle");
      try {
        box.releasePointerCapture(e.pointerId);
      } catch {
        // Ignore
      }

      // Suppress the synthetic click event after finishing a drag so the video doesn't toggle play/pause
      const suppressClick = (clickEv: MouseEvent) => {
        clickEv.stopPropagation();
        clickEv.preventDefault();
      };
      player.addEventListener("click", suppressClick, { capture: true, once: true });
      setTimeout(() => {
        player.removeEventListener("click", suppressClick, { capture: true });
      }, 80);

      const rect = player.getBoundingClientRect();
      this.container.style.transform = "";
      if (rect.height > 0 && Math.abs(this.dragCurrentDy) > 1) {
        const deltaPercent = (-this.dragCurrentDy / rect.height) * 100;
        const nextBottom = Number(
          Math.max(1, Math.min(85, this.dragStartBottom + deltaPercent)).toFixed(1),
        );
        configStore.update({ subtitleBottomPercent: nextBottom });
      }
    };

    box.addEventListener("pointerup", endDrag);
    box.addEventListener("pointercancel", endDrag);
  }

  setBuffering(active: boolean, statusText?: string | null): void {
    this.bufferingActive = active;
    const player = document.getElementById("movie_player");
    if (player) {
      player.classList.toggle("ytpp-buffering", active);
    }
    this.setStatus(statusText ?? null);
  }

  applyConfigStyles(): void {
    const cfg = configStore.get();
    const player = document.getElementById("movie_player");
    if (player) {
      player.classList.toggle("ytpp-subtitles-active", cfg.subtitleMode !== "off");
    }
    if (!this.container || !this.box) return;

    this.container.style.setProperty("--ytpp-sub-bottom", `${cfg.subtitleBottomPercent}%`);
    this.container.style.setProperty("--ytpp-font-scale", String(cfg.fontSizeScale));
    const alpha = Math.max(0, Math.min(0.95, cfg.subtitleBackdropOpacity ?? 0.42));
    this.container.style.setProperty("--ytpp-backdrop-alpha", String(alpha));
    this.box.classList.toggle("ytpp-with-backdrop", cfg.subtitleBackdrop && alpha > 0.01);
    if (this.statusSkipBtnEl) {
      this.statusSkipBtnEl.textContent = tr("跳过等待", "Skip");
      this.statusSkipBtnEl.title = tr("立即播放视频", "Play immediately");
    }

    if (cfg.subtitleMode === "off") {
      this.box.style.display = "none";
      if (this.statusTextEl) this.statusTextEl.style.display = "none";
      player?.classList.remove("ytpp-buffering");
    }
  }

  setStatus(message: string | null): void {
    if (!message || configStore.get().subtitleMode === "off") {
      if (this.statusTextEl) {
        this.statusTextEl.style.display = "none";
      }
      if (this.statusLabelEl) {
        this.statusLabelEl.textContent = "";
      }
      return;
    }

    if (this.statusLabelEl) {
      this.statusLabelEl.textContent = message;
    }

    const ratioMatch = message.match(/(\d+)\s*\/\s*(\d+)/);
    if (ratioMatch && this.statusProgressWrapEl && this.statusProgressFillEl) {
      const done = Number.parseInt(ratioMatch[1], 10) || 0;
      const total = Math.max(1, Number.parseInt(ratioMatch[2], 10) || 1);
      const pct = Math.min(100, Math.max(6, Math.round((done / total) * 100)));
      this.statusProgressFillEl.style.width = `${pct}%`;
      this.statusProgressWrapEl.style.display = "block";
    } else if (this.statusProgressWrapEl) {
      this.statusProgressWrapEl.style.display = "none";
    }

    if (this.statusSkipBtnEl) {
      this.statusSkipBtnEl.style.display = this.bufferingActive ? "inline-flex" : "none";
    }

    if (this.statusTextEl) {
      this.statusTextEl.style.display = "inline-flex";
    }
  }

  renderCue(cue: Cue | null): void {
    if (!this.box || !this.targetLine || !this.sourceLine) return;
    const mode = configStore.get().subtitleMode;

    if (!cue || mode === "off") {
      this.box.style.display = "none";
      return;
    }

    const hasTarget = Boolean(cue.targetText && cue.targetText.trim());

    if (mode === "source") {
      this.targetLine.textContent = cue.sourceText;
      this.targetLine.style.display = "block";
      this.sourceLine.style.display = "none";
      this.box.style.display = "block";
      return;
    }

    if (mode === "target") {
      this.targetLine.textContent = hasTarget ? cue.targetText! : cue.sourceText;
      this.targetLine.style.display = "block";
      this.sourceLine.style.display = "none";
      this.box.style.display = "block";
      return;
    }

    if (hasTarget) {
      this.targetLine.textContent = cue.targetText!;
      this.targetLine.style.display = "block";
      this.sourceLine.textContent = cue.sourceText;
      this.sourceLine.style.display = "block";
    } else {
      this.targetLine.textContent = cue.sourceText;
      this.targetLine.style.display = "block";
      this.sourceLine.style.display = "none";
    }
    this.box.style.display = "block";
  }

  clear(): void {
    this.setBuffering(false, null);
    this.renderCue(null);
  }
}
