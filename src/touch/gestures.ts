import { configStore } from "../config";
import { tr } from "../i18n";
import type { SubtitleManager } from "../subtitle/manager";
import { clearChildren, el, formatTimeMs, removeStyle, upsertStyle } from "../utils/dom";

const TOUCH_STYLE_ID = "ytpp-touch-adaptation-style";
const SVG_NS = "http://www.w3.org/2000/svg";
const PLAY_ICON_PATH = "M8 5v14l11-7z";
const PAUSE_ICON_PATH = "M6 19h4V5H6v14zm8-14v14h4V5h-4z";
const REWIND_ICON_PATH = "M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z";
const FORWARD_ICON_PATH = "M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z";

function createPlayerSvgIcon(pathD: string, size = 28): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", pathD);
  path.setAttribute("fill", "#ffffff");
  svg.appendChild(path);
  return svg;
}

interface YtPlayerWithVolume extends HTMLElement {
  getVolume?: () => number;
  setVolume?: (vol: number) => void;
  unMute?: () => void;
  isMuted?: () => boolean;
  toggleFullscreen?: () => void;
}

interface ActivePointer {
  pointerId: number;
  startX: number;
  startY: number;
  currX: number;
  currY: number;
}

export class TouchGestureController {
  private subtitleManager: SubtitleManager;
  private hudEl: HTMLElement | null = null;
  private surfaceEl: HTMLElement | null = null;
  private centerClusterEl: HTMLElement | null = null;
  private centerPlayBtn: HTMLElement | null = null;
  private hudHideTimer: ReturnType<typeof setTimeout> | null = null;
  private controlsHideTimer: ReturnType<typeof setTimeout> | null = null;

  private activePointers = new Map<number, ActivePointer>();
  private gestureMode:
    | "none"
    | "seek"
    | "volume"
    | "brightness"
    | "fullscreen"
    | "pinch" = "none";

  private seekStartTimeSec = 0;
  private targetSeekTimeSec = 0;
  private gestureStartVolume = 100;
  private currentBrightness = 100;
  private gestureStartBrightness = 100;
  private initialPinchDistance = 0;

  private lastTapTime = 0;
  private lastTapX = 0;
  private lastTapY = 0;
  private singleTapTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressActive = false;
  private savedPlaybackRate = 1;

  constructor(subtitleManager: SubtitleManager) {
    this.subtitleManager = subtitleManager;
  }

  init(): void {
    this.applyStyles();
    configStore.subscribe((cfg) => {
      this.applyStyles();
      const player = document.getElementById("movie_player");
      if (player) {
        player.classList.toggle("ytpp-touch-mode-enabled", cfg.touchGesturesEnabled);
        if (!cfg.touchGesturesEnabled) {
          player.classList.remove("ytpp-touch-controls-shown");
        }
      }
    });
  }

  attachToPlayer(player: HTMLElement): void {
    const cfg = configStore.get();
    player.classList.toggle("ytpp-touch-mode-enabled", cfg.touchGesturesEnabled);
    this.mountHudAndCenterControls(player);
  }

  private applyStyles(): void {
    const cfg = configStore.get();
    const rules: string[] = [
      `
      /* Dedicated gesture surface sitting above <video> (z-index: 15) and below subtitles (70) & chrome (60) */
      .ytpp-touch-surface {
        position: absolute;
        inset: 0;
        z-index: 15;
        display: none;
        touch-action: none !important;
        user-select: none;
        -webkit-user-select: none;
        -webkit-tap-highlight-color: transparent;
        background: transparent;
      }

      #movie_player.ytpp-touch-mode-enabled .ytpp-touch-surface {
        display: block;
      }

      /* Hide YouTube's desktop center play/pause flash bezel & native center play button when touch player mode is enabled */
      #movie_player.ytpp-touch-mode-enabled .ytp-bezel-text-hide,
      #movie_player.ytpp-touch-mode-enabled .ytp-bezel,
      #movie_player.ytpp-touch-mode-enabled .ytp-bezel-text-wrapper,
      #movie_player.ytpp-touch-mode-enabled .ytp-large-play-button,
      #movie_player.ytpp-touch-mode-enabled .ytp-large-play-button-bg,
      #movie_player.ytpp-touch-mode-enabled .ytp-cued-thumbnail-overlay .ytp-large-play-button {
        display: none !important;
        opacity: 0 !important;
        pointer-events: none !important;
      }

      .ytpp-gesture-hud {
        position: absolute;
        top: 12%;
        left: 50%;
        transform: translateX(-50%);
        z-index: 75;
        padding: 6px 12px;
        border-radius: 10px;
        background: rgba(16, 16, 20, 0.92);
        border: 1px solid rgba(255, 255, 255, 0.12);
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
        color: #f3f3f5;
        font-family: "YouTube Sans", Roboto, "PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei UI", sans-serif;
        font-size: 12.5px;
        font-weight: 500;
        font-variant-numeric: tabular-nums;
        line-height: 1.35;
        text-align: center;
        pointer-events: none;
        user-select: none;
        opacity: 0;
        transition: opacity 0.12s ease;
        max-width: 80%;
        -webkit-font-smoothing: antialiased;
      }
      .ytpp-gesture-hud.ytpp-visible {
        opacity: 1;
      }
      .ytpp-gesture-hud-sub {
        margin-top: 2px;
        font-size: 11.5px;
        font-weight: 400;
        color: rgba(255, 255, 255, 0.65);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      /* Mobile-style center 3-button cluster (Rewind 10s / Play-Pause / Forward 10s) */
      .ytpp-touch-center-cluster {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        z-index: 68;
        display: none;
        align-items: center;
        gap: 36px;
        pointer-events: none;
        user-select: none;
      }

      #movie_player.ytpp-touch-controls-shown .ytpp-touch-center-cluster,
      #movie_player.ytpp-touch-mode-enabled.unstarted-mode:not(.ytpp-buffering) .ytpp-touch-center-cluster,
      #movie_player.ytpp-touch-mode-enabled.cued-mode:not(.ytpp-buffering) .ytpp-touch-center-cluster {
        display: flex;
      }

      .ytpp-touch-center-btn,
      .ytpp-touch-step-btn {
        pointer-events: auto;
        border-radius: 50%;
        background: rgba(16, 16, 20, 0.68);
        border: 1px solid rgba(255, 255, 255, 0.14);
        color: #ffffff;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        user-select: none;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
        transition: transform 0.12s ease, background 0.12s ease;
      }

      .ytpp-touch-center-btn {
        width: 60px;
        height: 60px;
      }

      .ytpp-touch-step-btn {
        width: 46px;
        height: 46px;
      }

      .ytpp-touch-center-btn:active,
      .ytpp-touch-step-btn:active {
        transform: scale(0.92);
        background: rgba(32, 32, 38, 0.85);
      }

      /* When touch mode is enabled and controls are NOT shown, force bottom/top bars hidden even if fake hover lingers */
      #movie_player.ytpp-touch-mode-enabled:not(.ytpp-touch-controls-shown):not(.ytpp-popover-open):not(.paused-mode) .ytp-chrome-bottom,
      #movie_player.ytpp-touch-mode-enabled:not(.ytpp-touch-controls-shown):not(.ytpp-popover-open):not(.paused-mode) .ytp-gradient-bottom,
      #movie_player.ytpp-touch-mode-enabled:not(.ytpp-touch-controls-shown):not(.ytpp-popover-open):not(.paused-mode) .ytp-chrome-top,
      #movie_player.ytpp-touch-mode-enabled:not(.ytpp-touch-controls-shown):not(.ytpp-popover-open):not(.paused-mode) .ytp-gradient-top {
        opacity: 0 !important;
        pointer-events: none !important;
      }

      /* When touch controls ARE shown, force bottom/top bars visible and interactive */
      #movie_player.ytpp-touch-controls-shown .ytp-chrome-bottom,
      #movie_player.ytpp-touch-controls-shown .ytp-gradient-bottom,
      #movie_player.ytpp-touch-controls-shown .ytp-chrome-top,
      #movie_player.ytpp-touch-controls-shown .ytp-gradient-top {
        opacity: 1 !important;
        display: block !important;
        pointer-events: auto !important;
      }

      #movie_player.ytpp-video-zoom-cover video.html5-main-video {
        object-fit: cover !important;
      }
      `,
    ];

    if (cfg.touchEnlargeControls) {
      rules.push(`
        /* Enlarge scrubber bar & control hitboxes for Windows Tablet & coarse pointers */
        #movie_player .ytp-progress-bar-padding {
          height: 28px !important;
          top: -16px !important;
        }
        @media (pointer: coarse) {
          #movie_player .ytp-progress-bar-padding {
            height: 36px !important;
            top: -20px !important;
          }
          .ytp-scrubber-button {
            width: 18px !important;
            height: 18px !important;
            border-radius: 9px !important;
            top: -5px !important;
          }
          #movie_player .ytp-right-controls .ytp-button {
            margin: 0 2px !important;
          }
          yt-lockup-view-model button[aria-label="More actions"],
          ytd-rich-item-renderer #menu yt-icon-button,
          ytd-compact-video-renderer #menu yt-icon-button,
          ytd-video-renderer #menu yt-icon-button {
            opacity: 0.88 !important;
            visibility: visible !important;
          }
        }
      `);
    }

    if (rules.length > 0) {
      upsertStyle(TOUCH_STYLE_ID, rules.join("\n"));
    } else {
      removeStyle(TOUCH_STYLE_ID);
    }
  }

  private mountHudAndCenterControls(player: HTMLElement): void {
    if (!this.surfaceEl || !player.contains(this.surfaceEl)) {
      const surface = el("div", { className: "ytpp-touch-surface" });

      // Eat native click, dblclick, mousedown, mouseup, and contextmenu on the video surface
      // so YouTube's desktop video click-to-pause / double-click-to-fullscreen never fire
      const swallowEvent = (ev: Event) => {
        if (!configStore.get().touchGesturesEnabled) return;
        ev.stopPropagation();
        ev.preventDefault();
      };
      surface.addEventListener("click", swallowEvent);
      surface.addEventListener("dblclick", swallowEvent);
      surface.addEventListener("mousedown", swallowEvent);
      surface.addEventListener("mouseup", swallowEvent);
      surface.addEventListener("contextmenu", swallowEvent);

      surface.addEventListener("pointerdown", (e) => this.onPointerDown(e, player, surface));
      surface.addEventListener("pointermove", (e) => this.onPointerMove(e, player));
      surface.addEventListener("pointerup", (e) => this.onPointerUp(e, player, surface));
      surface.addEventListener("pointercancel", (e) => this.onPointerCancel(e, player, surface));

      this.surfaceEl = surface;
      player.appendChild(surface);
    }

    if (!this.hudEl || !player.contains(this.hudEl)) {
      this.hudEl = el("div", { className: "ytpp-gesture-hud" });
      player.appendChild(this.hudEl);
    }

    if (!this.centerClusterEl || !player.contains(this.centerClusterEl)) {
      const stepRewindBtn = el(
        "button",
        {
          className: "ytpp-touch-step-btn",
          attrs: { type: "button", "aria-label": tr("快退 10 秒", "Rewind 10s") },
          on: {
            click: (e) => {
              e.stopPropagation();
              e.preventDefault();
              this.stepSeekBy(player, -(configStore.get().touchDoubleTapSeekSec || 10));
              this.scheduleAutoHideTouchControls(player);
            },
          },
        },
        [createPlayerSvgIcon(REWIND_ICON_PATH, 22)],
      );

      this.centerPlayBtn = el(
        "button",
        {
          className: "ytpp-touch-center-btn",
          attrs: { type: "button", "aria-label": tr("播放或暂停", "Play or Pause") },
          on: {
            click: (e) => {
              e.stopPropagation();
              e.preventDefault();
              const video = this.getVideo(player);
              if (!video) return;
              if (video.paused) {
                void video.play();
              } else {
                video.pause();
              }
              this.syncCenterPlayIcon(video);
              this.scheduleAutoHideTouchControls(player);
            },
          },
        },
        [createPlayerSvgIcon(PAUSE_ICON_PATH, 30)],
      );

      const stepForwardBtn = el(
        "button",
        {
          className: "ytpp-touch-step-btn",
          attrs: { type: "button", "aria-label": tr("快进 10 秒", "Forward 10s") },
          on: {
            click: (e) => {
              e.stopPropagation();
              e.preventDefault();
              this.stepSeekBy(player, configStore.get().touchDoubleTapSeekSec || 10);
              this.scheduleAutoHideTouchControls(player);
            },
          },
        },
        [createPlayerSvgIcon(FORWARD_ICON_PATH, 22)],
      );

      this.centerClusterEl = el("div", { className: "ytpp-touch-center-cluster" }, [
        stepRewindBtn,
        this.centerPlayBtn,
        stepForwardBtn,
      ]);
      player.appendChild(this.centerClusterEl);
    }

    const video = this.getVideo(player);
    if (video && video.dataset.ytppIconSyncBound !== "1") {
      video.dataset.ytppIconSyncBound = "1";
      video.addEventListener("play", () => this.syncCenterPlayIcon(video));
      video.addEventListener("pause", () => this.syncCenterPlayIcon(video));
      this.syncCenterPlayIcon(video);
    }
  }

  private stepSeekBy(player: HTMLElement, deltaSec: number): void {
    const video = this.getVideo(player);
    if (!video) return;
    const dur = Number.isFinite(video.duration) ? video.duration : video.currentTime + 3600;
    video.currentTime = Math.max(0, Math.min(dur, video.currentTime + deltaSec));
    const absSec = Math.abs(deltaSec);
    this.showHud(
      deltaSec < 0
        ? `${tr("快退", "Rewind")} ${absSec}s`
        : `${tr("快进", "Forward")} ${absSec}s`,
    );
  }

  private syncCenterPlayIcon(video: HTMLVideoElement | null): void {
    if (!this.centerPlayBtn || !video) return;
    const pathEl = this.centerPlayBtn.querySelector("path");
    const targetPath = video.paused ? PLAY_ICON_PATH : PAUSE_ICON_PATH;
    if (pathEl) {
      pathEl.setAttribute("d", targetPath);
    } else {
      clearChildren(this.centerPlayBtn);
      this.centerPlayBtn.appendChild(createPlayerSvgIcon(targetPath, 30));
    }
  }

  private getVideo(player: HTMLElement): HTMLVideoElement | null {
    return player.querySelector<HTMLVideoElement>("video.html5-main-video, video");
  }

  private showHud(primaryText: string, secondaryText?: string, autoHideMs = 1100): void {
    if (!this.hudEl) return;
    clearChildren(this.hudEl);
    this.hudEl.appendChild(el("div", { text: primaryText }));
    if (secondaryText) {
      this.hudEl.appendChild(
        el("div", { className: "ytpp-gesture-hud-sub", text: secondaryText }),
      );
    }
    this.hudEl.classList.add("ytpp-visible");

    if (this.hudHideTimer) {
      clearTimeout(this.hudHideTimer);
      this.hudHideTimer = null;
    }
    if (autoHideMs > 0) {
      this.hudHideTimer = setTimeout(() => {
        this.hudEl?.classList.remove("ytpp-visible");
      }, autoHideMs);
    }
  }

  private hideHud(): void {
    if (this.hudHideTimer) {
      clearTimeout(this.hudHideTimer);
      this.hudHideTimer = null;
    }
    this.hudEl?.classList.remove("ytpp-visible");
  }

  private onPointerDown(
    e: PointerEvent,
    player: HTMLElement,
    surface: HTMLElement,
  ): void {
    const cfg = configStore.get();
    if (!cfg.touchGesturesEnabled) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;

    e.stopPropagation();
    try {
      surface.setPointerCapture(e.pointerId);
    } catch {
      // Ignore
    }

    this.activePointers.set(e.pointerId, {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      currX: e.clientX,
      currY: e.clientY,
    });

    if (this.activePointers.size === 2) {
      this.clearLongPress(player);
      this.gestureMode = "pinch";
      this.initialPinchDistance = this.getPinchDistance();
      return;
    }

    if (this.activePointers.size === 1) {
      this.gestureMode = "none";
      const video = this.getVideo(player);
      if (video) {
        this.seekStartTimeSec = video.currentTime;
        this.targetSeekTimeSec = video.currentTime;
      }
      const ytPlayer = player as YtPlayerWithVolume;
      this.gestureStartVolume =
        typeof ytPlayer.getVolume === "function"
          ? ytPlayer.getVolume()
          : (video?.volume ?? 1) * 100;
      this.gestureStartBrightness = this.currentBrightness;

      this.clearLongPress(player);
      this.longPressTimer = setTimeout(() => {
        if (this.activePointers.size === 1 && this.gestureMode === "none") {
          const v = this.getVideo(player);
          if (v && !v.paused) {
            this.longPressActive = true;
            this.savedPlaybackRate = v.playbackRate || 1;
            v.playbackRate = 2.0;
            this.showHud(tr("2.0x 倍速播放中", "2.0x Speed"), undefined, 0);
          }
        }
      }, 480);
    }
  }

  private clearLongPress(player: HTMLElement): void {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
    if (this.longPressActive) {
      this.longPressActive = false;
      const v = this.getVideo(player);
      if (v) {
        v.playbackRate = this.savedPlaybackRate || 1;
      }
      this.hideHud();
    }
  }

  private onPointerMove(e: PointerEvent, player: HTMLElement): void {
    const pt = this.activePointers.get(e.pointerId);
    if (!pt) return;
    e.stopPropagation();
    pt.currX = e.clientX;
    pt.currY = e.clientY;

    if (this.gestureMode === "pinch" && this.activePointers.size === 2) {
      const dist = this.getPinchDistance();
      if (this.initialPinchDistance > 20) {
        const ratio = dist / this.initialPinchDistance;
        if (ratio > 1.18) {
          player.classList.add("ytpp-video-zoom-cover");
          this.showHud(tr("画面比例: 裁切铺满", "Zoom: Fill"));
        } else if (ratio < 0.84) {
          player.classList.remove("ytpp-video-zoom-cover");
          this.showHud(tr("画面比例: 原始适应", "Zoom: Fit"));
        }
      }
      return;
    }

    if (this.activePointers.size !== 1) {
      return;
    }

    const dx = pt.currX - pt.startX;
    const dy = pt.currY - pt.startY;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);

    if (this.gestureMode === "none") {
      if (absX < 14 && absY < 14) return;
      this.clearLongPress(player);

      const rect = player.getBoundingClientRect();
      if (absX > absY * 1.25) {
        this.gestureMode = "seek";
      } else if (absY > absX * 1.25) {
        const relX = (pt.startX - rect.left) / Math.max(1, rect.width);
        if (relX < 0.33) {
          this.gestureMode = "brightness";
        } else if (relX > 0.67) {
          this.gestureMode = "volume";
        } else {
          this.gestureMode = "fullscreen";
        }
      }
    }

    const rect = player.getBoundingClientRect();
    const video = this.getVideo(player);
    if (!video || rect.width <= 0 || rect.height <= 0) return;

    if (this.gestureMode === "seek") {
      const deltaSec = (dx / rect.width) * 160;
      const duration = Number.isFinite(video.duration) ? video.duration : 36000;
      this.targetSeekTimeSec = Math.max(0, Math.min(duration, this.seekStartTimeSec + deltaSec));
      const sign = deltaSec >= 0 ? "+" : "-";
      const offsetStr = `${sign}${Math.abs(Math.round(deltaSec))}s`;
      const targetMs = this.targetSeekTimeSec * 1000;
      const previewCue = this.subtitleManager.getCueAtTimeMs(targetMs);
      const previewText = previewCue?.targetText || previewCue?.sourceText;
      this.showHud(`${formatTimeMs(targetMs)} (${offsetStr})`, previewText, 0);
      return;
    }

    if (this.gestureMode === "volume") {
      const deltaVol = (-dy / (rect.height * 0.65)) * 100;
      const nextVol = Math.round(Math.max(0, Math.min(100, this.gestureStartVolume + deltaVol)));
      const ytPlayer = player as YtPlayerWithVolume;
      if (typeof ytPlayer.setVolume === "function") {
        ytPlayer.unMute?.();
        ytPlayer.setVolume(nextVol);
      }
      video.muted = false;
      video.volume = nextVol / 100;
      this.showHud(`${tr("音量", "Volume")} ${nextVol}%`, undefined, 800);
      return;
    }

    if (this.gestureMode === "brightness") {
      const deltaBri = (-dy / (rect.height * 0.65)) * 80;
      const nextBri = Math.round(
        Math.max(35, Math.min(145, this.gestureStartBrightness + deltaBri)),
      );
      this.currentBrightness = nextBri;
      video.style.filter = nextBri === 100 ? "" : `brightness(${nextBri}%)`;
      this.showHud(`${tr("亮度", "Brightness")} ${nextBri}%`, undefined, 800);
      return;
    }

    if (this.gestureMode === "fullscreen") {
      if (dy < -42) {
        this.showHud(tr("上滑进入全屏", "Swipe up for Fullscreen"), undefined, 600);
      } else if (dy > 42) {
        this.showHud(tr("下滑退出全屏", "Swipe down to exit Fullscreen"), undefined, 600);
      }
    }
  }

  private onPointerUp(
    e: PointerEvent,
    player: HTMLElement,
    surface: HTMLElement,
  ): void {
    const pt = this.activePointers.get(e.pointerId);
    if (!pt) return;
    this.activePointers.delete(e.pointerId);
    e.stopPropagation();
    try {
      surface.releasePointerCapture(e.pointerId);
    } catch {
      // Ignore
    }

    if (this.longPressActive) {
      this.clearLongPress(player);
      return;
    }
    this.clearLongPress(player);

    const video = this.getVideo(player);

    if (this.gestureMode === "seek") {
      if (video) {
        video.currentTime = this.targetSeekTimeSec;
      }
      this.showHud(
        `${tr("跳转至", "Seek to")} ${formatTimeMs(this.targetSeekTimeSec * 1000)}`,
        undefined,
        700,
      );
      this.gestureMode = "none";
      return;
    }

    if (this.gestureMode === "fullscreen") {
      const dy = e.clientY - pt.startY;
      const isFs = Boolean(
        document.fullscreenElement || player.classList.contains("ytp-fullscreen"),
      );
      if (dy < -48 && !isFs) {
        this.togglePlayerFullscreen(player);
      } else if (dy > 48 && isFs) {
        this.togglePlayerFullscreen(player);
      }
      this.gestureMode = "none";
      return;
    }

    if (
      this.gestureMode === "volume" ||
      this.gestureMode === "brightness" ||
      this.gestureMode === "pinch"
    ) {
      if (this.activePointers.size === 0) {
        this.gestureMode = "none";
      }
      return;
    }

    // Clean tap (movement < 14px)
    const dx = Math.abs(e.clientX - pt.startX);
    const dy = Math.abs(e.clientY - pt.startY);
    if (dx < 14 && dy < 14 && this.activePointers.size === 0) {
      this.handleTap(e.clientX, e.clientY, player);
    }
  }

  private togglePlayerFullscreen(player: HTMLElement): void {
    const ytPlayer = player as YtPlayerWithVolume;
    if (typeof ytPlayer.toggleFullscreen === "function") {
      ytPlayer.toggleFullscreen();
      return;
    }
    const fsBtn = player.querySelector<HTMLElement>(".ytp-fullscreen-button");
    fsBtn?.click();
  }

  private onPointerCancel(
    e: PointerEvent,
    player: HTMLElement,
    surface: HTMLElement,
  ): void {
    this.activePointers.delete(e.pointerId);
    try {
      surface.releasePointerCapture(e.pointerId);
    } catch {
      // Ignore
    }
    this.clearLongPress(player);
    if (this.activePointers.size === 0) {
      this.gestureMode = "none";
    }
  }

  private handleTap(clientX: number, clientY: number, player: HTMLElement): void {
    const now = performance.now();
    const dt = now - this.lastTapTime;
    const dist = Math.hypot(clientX - this.lastTapX, clientY - this.lastTapY);

    if (dt < 280 && dist < 52) {
      // Double tap detected
      if (this.singleTapTimer) {
        clearTimeout(this.singleTapTimer);
        this.singleTapTimer = null;
      }
      this.lastTapTime = 0;
      this.executeDoubleTap(clientX, player);
      return;
    }

    this.lastTapTime = now;
    this.lastTapX = clientX;
    this.lastTapY = clientY;

    if (this.singleTapTimer) {
      clearTimeout(this.singleTapTimer);
    }
    this.singleTapTimer = setTimeout(() => {
      this.singleTapTimer = null;
      this.executeSingleTap(player);
    }, 230);
  }

  private executeSingleTap(player: HTMLElement): void {
    const isShown = player.classList.toggle("ytpp-touch-controls-shown");
    if (isShown) {
      const video = this.getVideo(player);
      this.syncCenterPlayIcon(video);
      player.classList.remove("ytp-autohide");
      this.scheduleAutoHideTouchControls(player);
    } else {
      player.classList.add("ytp-autohide");
      if (this.controlsHideTimer) {
        clearTimeout(this.controlsHideTimer);
        this.controlsHideTimer = null;
      }
    }
  }

  private scheduleAutoHideTouchControls(player: HTMLElement): void {
    if (this.controlsHideTimer) {
      clearTimeout(this.controlsHideTimer);
    }
    this.controlsHideTimer = setTimeout(() => {
      player.classList.remove("ytpp-touch-controls-shown");
    }, 3200);
  }

  private executeDoubleTap(clientX: number, player: HTMLElement): void {
    const video = this.getVideo(player);
    if (!video) return;
    const rect = player.getBoundingClientRect();
    if (rect.width <= 0) return;

    const relX = (clientX - rect.left) / rect.width;
    const seekSec = configStore.get().touchDoubleTapSeekSec || 10;

    if (relX < 0.3) {
      this.stepSeekBy(player, -seekSec);
    } else if (relX > 0.7) {
      this.stepSeekBy(player, seekSec);
    } else {
      if (video.paused) {
        void video.play();
        this.showHud(tr("播放", "Play"));
      } else {
        video.pause();
        this.showHud(tr("暂停", "Pause"));
      }
      this.syncCenterPlayIcon(video);
    }
  }

  private getPinchDistance(): number {
    const pts = Array.from(this.activePointers.values());
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].currX - pts[1].currX, pts[0].currY - pts[1].currY);
  }
}
