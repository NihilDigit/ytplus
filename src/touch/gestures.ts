import { configStore } from "../config";
import { tr } from "../i18n";
import type { SubtitleManager } from "../subtitle/manager";
import { el, formatTimeMs, removeStyle, upsertStyle } from "../utils/dom";

const TOUCH_STYLE_ID = "ytpp-touch-adaptation-style";
const SVG_NS = "http://www.w3.org/2000/svg";
const PLAY_ICON_PATH = "M8 5v14l11-7z";
const PAUSE_ICON_PATH = "M6 19h4V5H6v14zm8-14v14h4V5h-4z";

function createPlayerSvgIcon(pathD: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "28");
  svg.setAttribute("height", "28");
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
  private centerPlayBtn: HTMLElement | null = null;
  private hudHideTimer: ReturnType<typeof setTimeout> | null = null;
  private controlsHideTimer: ReturnType<typeof setTimeout> | null = null;

  private activePointers = new Map<number, ActivePointer>();
  private gestureMode: "none" | "seek" | "volume" | "brightness" | "pinch" = "none";

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
    configStore.subscribe(() => this.applyStyles());
  }

  attachToPlayer(player: HTMLElement): void {
    if (player.dataset.ytppTouchBound === "1") {
      return;
    }
    player.dataset.ytppTouchBound = "1";

    this.mountHudAndCenterControls(player);

    // Use capture phase so we can cleanly intercept touch taps before YouTube's mouse-oriented handlers
    player.addEventListener("pointerdown", (e) => this.onPointerDown(e, player), {
      capture: true,
    });
    player.addEventListener("pointermove", (e) => this.onPointerMove(e, player), {
      capture: true,
    });
    player.addEventListener("pointerup", (e) => this.onPointerUp(e, player), {
      capture: true,
    });
    player.addEventListener("pointercancel", (e) => this.onPointerCancel(e, player), {
      capture: true,
    });

    // Prevent YouTube's default click-to-pause on touch devices when our gesture layer handles taps
    player.addEventListener(
      "click",
      (e: MouseEvent) => {
        const cfg = configStore.get();
        if (!cfg.touchGesturesEnabled) return;
        const sourceCapabilities = (e as unknown as { sourceCapabilities?: { firesTouchEvents?: boolean } })
          .sourceCapabilities;
        const isTouchClick =
          player.dataset.ytppLastPointerType === "touch" ||
          player.dataset.ytppLastPointerType === "pen" ||
          Boolean(sourceCapabilities?.firesTouchEvents);

        if (!isTouchClick) return;
        if (this.isInteractiveControl(e.target as Element | null)) return;

        if (cfg.touchSingleTapToggleControls) {
          e.stopPropagation();
          e.preventDefault();
        }
      },
      { capture: true },
    );
  }

  private applyStyles(): void {
    const cfg = configStore.get();
    const rules: string[] = [
      `
      .ytpp-gesture-hud {
        position: absolute;
        top: 12%;
        left: 50%;
        transform: translateX(-50%);
        z-index: 75;
        padding: 6px 14px;
        border-radius: 4px;
        background: rgba(28, 28, 28, 0.9);
        color: #f1f1f1;
        font-family: Roboto, Arial, sans-serif;
        font-size: 13px;
        font-weight: 500;
        text-align: center;
        pointer-events: none;
        user-select: none;
        opacity: 0;
        transition: opacity 0.12s ease;
        max-width: 80%;
      }
      .ytpp-gesture-hud.ytpp-visible {
        opacity: 1;
      }
      .ytpp-gesture-hud-sub {
        margin-top: 2px;
        font-size: 12px;
        font-weight: 400;
        color: #aaaaaa;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .ytpp-touch-center-btn {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        z-index: 68;
        width: 56px;
        height: 56px;
        border-radius: 50%;
        background: rgba(0, 0, 0, 0.6);
        border: none;
        color: #ffffff;
        font-size: 22px;
        display: none;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        user-select: none;
      }
      #movie_player.ytpp-touch-controls-shown .ytpp-touch-center-btn {
        display: flex;
      }
      #movie_player.ytpp-touch-controls-shown .ytp-chrome-bottom,
      #movie_player.ytpp-touch-controls-shown .ytp-gradient-bottom,
      #movie_player.ytpp-touch-controls-shown .ytp-chrome-top,
      #movie_player.ytpp-touch-controls-shown .ytp-gradient-top {
        opacity: 1 !important;
        display: block !important;
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
            height: 34px !important;
            top: -20px !important;
          }
          .ytp-scrubber-button {
            width: 18px !important;
            height: 18px !important;
            border-radius: 9px !important;
            top: -5px !important;
          }
          /* Ensure feed 3-dot action menus are visible without mouse hover on tablets */
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
    if (!this.hudEl || !player.contains(this.hudEl)) {
      this.hudEl = el("div", { className: "ytpp-gesture-hud" });
      player.appendChild(this.hudEl);
    }

    if (!this.centerPlayBtn || !player.contains(this.centerPlayBtn)) {
      this.centerPlayBtn = el("button", {
        className: "ytpp-touch-center-btn",
        attrs: { type: "button", "aria-label": "播放或暂停" },
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
      });
      this.centerPlayBtn.appendChild(createPlayerSvgIcon(PAUSE_ICON_PATH));
      player.appendChild(this.centerPlayBtn);
    }

    const video = this.getVideo(player);
    if (video && video.dataset.ytppIconSyncBound !== "1") {
      video.dataset.ytppIconSyncBound = "1";
      video.addEventListener("play", () => this.syncCenterPlayIcon(video));
      video.addEventListener("pause", () => this.syncCenterPlayIcon(video));
      this.syncCenterPlayIcon(video);
    }
  }

  private syncCenterPlayIcon(video: HTMLVideoElement | null): void {
    if (!this.centerPlayBtn || !video) return;
    const pathEl = this.centerPlayBtn.querySelector("path");
    const targetPath = video.paused ? PLAY_ICON_PATH : PAUSE_ICON_PATH;
    if (pathEl) {
      pathEl.setAttribute("d", targetPath);
    } else {
      while (this.centerPlayBtn.firstChild) {
        this.centerPlayBtn.removeChild(this.centerPlayBtn.firstChild);
      }
      this.centerPlayBtn.appendChild(createPlayerSvgIcon(targetPath));
    }
  }

  private getVideo(player: HTMLElement): HTMLVideoElement | null {
    return player.querySelector<HTMLVideoElement>("video.html5-main-video, video");
  }

  private isInteractiveControl(target: Element | null): boolean {
    if (!target) return false;
    return Boolean(
      target.closest(
        ".ytp-chrome-bottom, .ytp-chrome-top, .ytp-settings-menu, .ytp-popup, .ytpp-subtitle-box, .ytpp-status-interactive, .ytpp-popover, .ytpp-panel-backdrop, .ytpp-touch-center-btn, button, a, input, select, textarea",
      ),
    );
  }

  private showHud(primaryText: string, secondaryText?: string, autoHideMs = 1100): void {
    if (!this.hudEl) return;
    while (this.hudEl.firstChild) {
      this.hudEl.removeChild(this.hudEl.firstChild);
    }
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

  private onPointerDown(e: PointerEvent, player: HTMLElement): void {
    player.dataset.ytppLastPointerType = e.pointerType;

    // Only activate touch gesture state machine for touch/pen inputs; keep desktop mouse untouched
    if (e.pointerType !== "touch" && e.pointerType !== "pen") {
      return;
    }

    const cfg = configStore.get();
    if (!cfg.touchGesturesEnabled) return;
    if (this.isInteractiveControl(e.target as Element | null)) return;

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
        const isLeftHalf = pt.startX - rect.left < rect.width * 0.5;
        this.gestureMode = isLeftHalf ? "brightness" : "volume";
      }
    }

    const rect = player.getBoundingClientRect();
    const video = this.getVideo(player);
    if (!video || rect.width <= 0 || rect.height <= 0) return;

    if (this.gestureMode === "seek") {
      e.stopPropagation();
      // Full width swipe corresponds to 160 seconds
      const deltaSec = ((dx / rect.width) * 160);
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
      e.stopPropagation();
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
      e.stopPropagation();
      const deltaBri = (-dy / (rect.height * 0.65)) * 80;
      const nextBri = Math.round(
        Math.max(35, Math.min(145, this.gestureStartBrightness + deltaBri)),
      );
      this.currentBrightness = nextBri;
      video.style.filter = nextBri === 100 ? "" : `brightness(${nextBri}%)`;
      this.showHud(`${tr("亮度", "Brightness")} ${nextBri}%`, undefined, 800);
    }
  }

  private onPointerUp(e: PointerEvent, player: HTMLElement): void {
    const pt = this.activePointers.get(e.pointerId);
    if (!pt) return;
    this.activePointers.delete(e.pointerId);

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

    // It was a clean tap (movement < 14px)
    const dx = Math.abs(e.clientX - pt.startX);
    const dy = Math.abs(e.clientY - pt.startY);
    if (dx < 14 && dy < 14 && this.activePointers.size === 0) {
      this.handleTouchTap(e.clientX, e.clientY, player);
    }
  }

  private onPointerCancel(e: PointerEvent, player: HTMLElement): void {
    this.activePointers.delete(e.pointerId);
    this.clearLongPress(player);
    if (this.activePointers.size === 0) {
      this.gestureMode = "none";
    }
  }

  private handleTouchTap(clientX: number, clientY: number, player: HTMLElement): void {
    const now = performance.now();
    const dt = now - this.lastTapTime;
    const dist = Math.hypot(clientX - this.lastTapX, clientY - this.lastTapY);

    if (dt < 280 && dist < 48) {
      // Double tap detected!
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
    }, 260);
  }

  private executeSingleTap(player: HTMLElement): void {
    const cfg = configStore.get();
    if (!cfg.touchSingleTapToggleControls) return;

    const isShown = player.classList.toggle("ytpp-touch-controls-shown");
    if (isShown) {
      const video = this.getVideo(player);
      this.syncCenterPlayIcon(video);
      player.classList.remove("ytp-autohide");
      this.scheduleAutoHideTouchControls(player);
    } else {
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

    if (relX < 0.35) {
      video.currentTime = Math.max(0, video.currentTime - seekSec);
      this.showHud(`${tr("快退", "Rewind")} ${seekSec}s`);
    } else if (relX > 0.65) {
      const dur = Number.isFinite(video.duration) ? video.duration : video.currentTime + seekSec;
      video.currentTime = Math.min(dur, video.currentTime + seekSec);
      this.showHud(`${tr("快进", "Forward")} ${seekSec}s`);
    } else {
      if (video.paused) {
        void video.play();
        this.showHud(tr("播放", "Play"));
      } else {
        video.pause();
        this.showHud(tr("暂停", "Pause"));
      }
    }
  }

  private getPinchDistance(): number {
    const pts = Array.from(this.activePointers.values());
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].currX - pts[1].currX, pts[0].currY - pts[1].currY);
  }
}
