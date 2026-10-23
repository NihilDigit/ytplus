import { configStore } from "../config";
import type { Cue } from "../types";
import { el, upsertStyle } from "../utils/dom";

const OVERLAY_STYLE_ID = "ytpp-subtitle-overlay-style";

export class SubtitleOverlay {
  private container: HTMLElement | null = null;
  private box: HTMLElement | null = null;
  private targetLine: HTMLElement | null = null;
  private sourceLine: HTMLElement | null = null;
  private statusTextEl: HTMLElement | null = null;

  private isDragging = false;
  private dragStartY = 0;
  private dragCurrentDy = 0;
  private dragStartBottom = 10;

  constructor() {
    this.injectStyles();
    configStore.subscribe(() => this.applyConfigStyles());
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

      /* Lock player visual state to native YouTube buffering spinner during fast-batch translation */
      #movie_player.ytpp-buffering .ytp-spinner {
        display: block !important;
        opacity: 1 !important;
      }

      .ytpp-subtitle-layer {
        position: absolute;
        left: 8%;
        right: 8%;
        bottom: 6%;
        z-index: 70;
        display: flex;
        flex-direction: column;
        align-items: center;
        pointer-events: none;
        user-select: none;
        will-change: transform;
      }

      /* Hide player progress bar & bottom controls while dragging subtitles so user can place them at the very bottom */
      #movie_player.ytpp-dragging-subtitle .ytp-chrome-bottom,
      #movie_player.ytpp-dragging-subtitle .ytp-gradient-bottom {
        opacity: 0 !important;
        pointer-events: none !important;
        transition: opacity 0.1s ease !important;
      }

      .ytpp-subtitle-status {
        pointer-events: none;
        margin-bottom: 6px;
        padding: 2px 8px;
        border-radius: 4px;
        background: rgba(8, 8, 8, 0.75);
        color: #aaaaaa;
        font-family: "YouTube Noto", Roboto, Arial, sans-serif;
        font-size: 12px;
        line-height: 1.4;
      }

      .ytpp-subtitle-box {
        pointer-events: auto;
        cursor: grab;
        max-width: 88%;
        padding: 4px 10px;
        border-radius: 4px;
        text-align: center;
        line-height: 1.35;
        font-family: "YouTube Noto", Roboto, Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
        touch-action: none;
      }

      .ytpp-subtitle-box:active {
        cursor: grabbing;
      }

      .ytpp-subtitle-box.ytpp-with-backdrop {
        background: rgba(8, 8, 8, 0.75);
      }

      .ytpp-subtitle-target {
        color: #ffffff;
        font-weight: 400;
        font-size: calc(clamp(14px, 1.55vw, 20px) * var(--ytpp-font-scale, 1));
        text-shadow: 0 0 2px rgba(0, 0, 0, 0.9), 0 1px 2px rgba(0, 0, 0, 0.8);
        word-break: break-word;
      }

      .ytpp-subtitle-source {
        margin-top: 2px;
        color: rgba(255, 255, 255, 0.78);
        font-weight: 400;
        font-size: calc(clamp(12px, 1.18vw, 15px) * var(--ytpp-font-scale, 1));
        text-shadow: 0 0 2px rgba(0, 0, 0, 0.9);
        word-break: break-word;
      }
      `,
    );
  }

  mount(player: HTMLElement): void {
    if (this.container && player.contains(this.container)) {
      this.applyConfigStyles();
      return;
    }

    this.statusTextEl = el("div", {
      className: "ytpp-subtitle-status",
      style: { display: "none" },
    });

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
      e.stopPropagation();
      this.isDragging = true;
      this.dragStartY = e.clientY;
      this.dragCurrentDy = 0;
      this.dragStartBottom = configStore.get().subtitleBottomPercent;
      this.container?.classList.add("ytpp-dragging");
      player.classList.add("ytpp-dragging-subtitle");
      box.setPointerCapture(e.pointerId);
    });

    box.addEventListener("pointermove", (e: PointerEvent) => {
      if (!this.isDragging || !this.container) return;
      e.stopPropagation();
      this.dragCurrentDy = e.clientY - this.dragStartY;
      // GPU-composited translate3d during drag: 0 layout reflow, sub-pixel smooth
      this.container.style.transform = `translate3d(0, ${this.dragCurrentDy}px, 0)`;
    });

    const endDrag = (e: PointerEvent) => {
      if (!this.isDragging || !this.container) return;
      e.stopPropagation();
      this.isDragging = false;
      this.container.classList.remove("ytpp-dragging");
      player.classList.remove("ytpp-dragging-subtitle");
      try {
        box.releasePointerCapture(e.pointerId);
      } catch {
        // Ignore
      }

      const rect = player.getBoundingClientRect();
      this.container.style.transform = "";
      if (rect.height > 0 && Math.abs(this.dragCurrentDy) > 1) {
        const deltaPercent = (-this.dragCurrentDy / rect.height) * 100;
        const nextBottom = Number(
          Math.max(1, Math.min(88, this.dragStartBottom + deltaPercent)).toFixed(2),
        );
        configStore.update({ subtitleBottomPercent: nextBottom });
      }
    };

    box.addEventListener("pointerup", endDrag);
    box.addEventListener("pointercancel", endDrag);
  }

  setBuffering(active: boolean, statusText?: string | null): void {
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

    this.container.style.bottom = `${cfg.subtitleBottomPercent}%`;
    this.container.style.setProperty("--ytpp-font-scale", String(cfg.fontSizeScale));
    this.box.classList.toggle("ytpp-with-backdrop", cfg.subtitleBackdrop);

    if (cfg.subtitleMode === "off") {
      this.box.style.display = "none";
      if (this.statusTextEl) this.statusTextEl.style.display = "none";
      player?.classList.remove("ytpp-buffering");
    }
  }

  setStatus(message: string | null): void {
    if (!this.statusTextEl) return;
    if (!message || configStore.get().subtitleMode === "off") {
      this.statusTextEl.style.display = "none";
      this.statusTextEl.textContent = "";
    } else {
      this.statusTextEl.textContent = message;
      this.statusTextEl.style.display = "block";
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
