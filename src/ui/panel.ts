import { configStore } from "../config";
import { getModeLabel, isEn, tr } from "../i18n";
import {
  ALL_SPONSOR_CATEGORIES,
  getSponsorCategoryLabel,
  SPONSOR_CATEGORY_META,
} from "../sponsorblock/manager";
import { fetchAvailableModels } from "../subtitle/llm-client";
import type { SubtitleManager } from "../subtitle/manager";
import type { SubtitleMode } from "../types";
import { clearChildren, el, upsertStyle } from "../utils/dom";

const UI_STYLE_ID = "ytpp-ui-panel-style";
const SVG_NS = "http://www.w3.org/2000/svg";

const YT_CC_PATH_24 =
  "M5,5 C3.9,5 3,5.9 3,7 L3,17 C3,18.1 3.9,19 5,19 L19,19 C20.1,19 21,18.1 21,17 L21,7 C21,5.9 20.1,5 19,5 L5,5 Z M11,11 L9.5,11 L9.5,10.5 L7.5,10.5 L7.5,13.5 L9.5,13.5 L9.5,13 L11,13 L11,14 C11,14.55 10.55,15 10,15 L7,15 C6.45,15 6,14.55 6,14 L6,10 C6,9.45 6.45,9 7,9 L10,9 C10.55,9 11,9.45 11,10 L11,11 Z M18,11 L16.5,11 L16.5,10.5 L14.5,10.5 L14.5,13.5 L16.5,13.5 L16.5,13 L18,13 L18,14 C18,14.55 17.55,15 17,15 L14,15 C13.45,15 13,14.55 13,14 L13,10 C13,9.45 13.45,9 14,9 L17,9 C17.55,9 18,9.45 18,10 L18,11 Z";

// Exact cubic Bézier screen path and play triangle from youtube-svgrepo-com.svg
const YT_SVGREPO_SCREEN_PATH =
  "M20.5245 6.00694C20.3025 5.81544 20.0333 5.70603 19.836 5.63863C19.6156 5.56337 19.3637 5.50148 19.0989 5.44892C18.5677 5.34348 17.9037 5.26005 17.1675 5.19491C15.6904 5.06419 13.8392 5 12 5C10.1608 5 8.30956 5.06419 6.83246 5.1949C6.09632 5.26005 5.43231 5.34348 4.9011 5.44891C4.63628 5.50147 4.38443 5.56337 4.16403 5.63863C3.96667 5.70603 3.69746 5.81544 3.47552 6.00694C3.26514 6.18846 3.14612 6.41237 3.07941 6.55976C3.00507 6.724 2.94831 6.90201 2.90314 7.07448C2.81255 7.42043 2.74448 7.83867 2.69272 8.28448C2.58852 9.18195 2.53846 10.299 2.53846 11.409C2.53846 12.5198 2.58859 13.6529 2.69218 14.5835C2.74378 15.047 2.81086 15.4809 2.89786 15.8453C2.97306 16.1603 3.09841 16.5895 3.35221 16.9023C3.58757 17.1925 3.92217 17.324 4.08755 17.3836C4.30223 17.461 4.55045 17.5218 4.80667 17.572C5.32337 17.6733 5.98609 17.7527 6.72664 17.8146C8.2145 17.9389 10.1134 18 12 18C13.8865 18 15.7855 17.9389 17.2733 17.8146C18.0139 17.7527 18.6766 17.6733 19.1933 17.572C19.4495 17.5218 19.6978 17.461 19.9124 17.3836C20.0778 17.324 20.4124 17.1925 20.6478 16.9023C20.9016 16.5895 21.0269 16.1603 21.1021 15.8453C21.1891 15.4809 21.2562 15.047 21.3078 14.5835C21.4114 13.6529 21.4615 12.5198 21.4615 11.409C21.4615 10.299 21.4115 9.18195 21.3073 8.28448C21.2555 7.83868 21.1874 7.42043 21.0969 7.07448C21.0517 6.90201 20.9949 6.72401 20.9206 6.55976C20.8539 6.41236 20.7349 6.18846 20.5245 6.00694Z";

const YT_SVGREPO_TRIANGLE_PATH =
  "M14.5385 11.5L10.0962 14.3578L10.0962 8.64207L14.5385 11.5Z";

const YT_SVGREPO_PLUS_PATH = "M19.2 14V19M16.7 16.5H21.7";

const ACTIVE_MODES: SubtitleMode[] = ["bilingual", "target", "source"];

type TabId = "subtitle" | "api" | "sponsorblock" | "system";

let iconMaskSeq = 0;

function createYtPlusSvgIcon(referenceBtn?: Element | null): SVGSVGElement {
  const refSvg = referenceBtn?.querySelector("svg");
  let svg: SVGSVGElement;
  if (refSvg) {
    svg = refSvg.cloneNode(false) as SVGSVGElement;
    const refVb = (refSvg.getAttribute("viewBox") || "")
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (refVb.length === 4 && refVb[2] === 36 && refVb[3] === 36) {
      svg.setAttribute("viewBox", "-6 -6 36 36");
    } else {
      svg.setAttribute("viewBox", "0 0 24 24");
    }
  } else {
    svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("height", "100%");
    svg.setAttribute("version", "1.1");
    svg.setAttribute("viewBox", "-6 -6 36 36");
    svg.setAttribute("width", "100%");
  }
  svg.setAttribute("fill", "none");

  const maskId = `ytpp-plus-mask-${++iconMaskSeq}`;
  const defs = document.createElementNS(SVG_NS, "defs");
  const mask = document.createElementNS(SVG_NS, "mask");
  mask.setAttribute("id", maskId);

  const bgRect = document.createElementNS(SVG_NS, "rect");
  bgRect.setAttribute("x", "-8");
  bgRect.setAttribute("y", "-8");
  bgRect.setAttribute("width", "40");
  bgRect.setAttribute("height", "40");
  bgRect.setAttribute("fill", "white");

  const cutCircle = document.createElementNS(SVG_NS, "circle");
  cutCircle.setAttribute("cx", "19.2");
  cutCircle.setAttribute("cy", "16.5");
  cutCircle.setAttribute("r", "4.1");
  cutCircle.setAttribute("fill", "black");

  mask.appendChild(bgRect);
  mask.appendChild(cutCircle);
  defs.appendChild(mask);
  svg.appendChild(defs);

  const makeStrokePath = (d: string) => {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "#ffffff");
    p.setAttribute("stroke-width", "2");
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
    return p;
  };

  const maskedGroup = document.createElementNS(SVG_NS, "g");
  maskedGroup.setAttribute("mask", `url(#${maskId})`);
  maskedGroup.appendChild(makeStrokePath(YT_SVGREPO_SCREEN_PATH));
  maskedGroup.appendChild(makeStrokePath(YT_SVGREPO_TRIANGLE_PATH));
  svg.appendChild(maskedGroup);

  svg.appendChild(makeStrokePath(YT_SVGREPO_PLUS_PATH));
  return svg;
}

function createIconFromNativeOrFallback(
  nativeBtn: Element | null,
  fallbackPath24: string,
): SVGSVGElement {
  const nativeSvg = nativeBtn?.querySelector("svg");
  if (nativeSvg) {
    return nativeSvg.cloneNode(true) as SVGSVGElement;
  }
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("height", "100%");
  svg.setAttribute("version", "1.1");
  svg.setAttribute("viewBox", "-6 -6 36 36");
  svg.setAttribute("width", "100%");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", fallbackPath24);
  path.setAttribute("fill", "#fff");
  svg.appendChild(path);
  return svg;
}

export class SettingsPanelUI {
  private subtitleManager: SubtitleManager;
  private playerEl: HTMLElement | null = null;
  private ccBtn: HTMLButtonElement | null = null;
  private menuBtn: HTMLButtonElement | null = null;
  private popoverEl: HTMLElement | null = null;
  private activeTab: TabId = "subtitle";
  private isOpen = false;
  private lastActiveMode: SubtitleMode = "bilingual";

  // Live UI references for reactive sync
  private modeButtons = new Map<SubtitleMode, HTMLButtonElement>();
  private fontSliderEl: HTMLInputElement | null = null;
  private fontValueEl: HTMLElement | null = null;
  private bottomSliderEl: HTMLInputElement | null = null;
  private bottomValueEl: HTMLElement | null = null;
  private backdropSliderEl: HTMLInputElement | null = null;
  private backdropValueEl: HTMLElement | null = null;
  private brandPillEl: HTMLElement | null = null;

  constructor(subtitleManager: SubtitleManager) {
    this.subtitleManager = subtitleManager;
    const initialMode = configStore.get().subtitleMode;
    if (initialMode !== "off") {
      this.lastActiveMode = initialMode;
    }
    this.injectStyles();
    this.bindGlobalDismissListeners();

    configStore.subscribe((cfg) => {
      if (cfg.subtitleMode !== "off") {
        this.lastActiveMode = cfg.subtitleMode;
      }
      this.syncControlButtons();
      this.syncLivePopoverControls();
    });
  }

  private bindGlobalDismissListeners(): void {
    document.addEventListener(
      "pointerdown",
      (e: PointerEvent) => {
        if (!this.isOpen || !this.popoverEl) return;
        const target = e.target as Node | null;
        if (!target) return;
        if (
          this.popoverEl.contains(target) ||
          this.menuBtn?.contains(target)
        ) {
          return;
        }
        this.closePopover();
      },
      { capture: true },
    );

    document.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape" && this.isOpen) {
        e.stopPropagation();
        this.closePopover();
      }
    });
  }

  private injectStyles(): void {
    upsertStyle(
      UI_STYLE_ID,
      `
      /* Hide original YouTube subtitle button (our .ytpp-cc-btn takes its place) */
      #movie_player .ytp-subtitles-button:not(.ytpp-cc-btn) {
        display: none !important;
      }

      #movie_player .ytpp-cc-btn,
      #movie_player .ytpp-menu-btn {
        position: relative !important;
      }

      /* Dim CC icon when subtitles are turned off */
      #movie_player .ytpp-cc-btn[aria-pressed="false"] svg {
        opacity: 0.55;
      }

      /* Classic YouTube red underline indicator when subtitles are active */
      #movie_player .ytpp-cc-btn[aria-pressed="true"]::after {
        content: "";
        position: absolute;
        bottom: 6px;
        left: 24%;
        right: 24%;
        height: 3px;
        background: #ff0033;
        border-radius: 2px;
        pointer-events: none;
      }

      /* Highlight menu button when popover is open */
      #movie_player .ytpp-menu-btn[aria-expanded="true"]::after {
        content: "";
        position: absolute;
        bottom: 6px;
        left: 26%;
        right: 26%;
        height: 3px;
        background: #f1f1f1;
        border-radius: 2px;
        pointer-events: none;
      }

      /* Keep bottom bar visible while YT+ popover is open */
      #movie_player.ytpp-popover-open .ytp-chrome-bottom,
      #movie_player.ytpp-popover-open .ytp-gradient-bottom {
        opacity: 1 !important;
        display: block !important;
      }

      /* Anchored glassmorphic popover inside #movie_player (works in Fullscreen & Theater mode) */
      .ytpp-popover {
        position: absolute;
        right: 12px;
        bottom: 62px;
        z-index: 2002;
        width: 368px;
        max-width: calc(100% - 24px);
        max-height: calc(100% - 76px);
        display: flex;
        flex-direction: column;
        background: rgba(18, 18, 22, 0.92);
        backdrop-filter: blur(24px) saturate(150%);
        -webkit-backdrop-filter: blur(24px) saturate(150%);
        border: 1px solid rgba(255, 255, 255, 0.11);
        border-radius: 16px;
        color: #f3f3f5;
        box-shadow: 0 16px 48px rgba(0, 0, 0, 0.68), 0 0 0 1px rgba(0, 0, 0, 0.4);
        font-family: "YouTube Sans", Roboto, "PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei UI", sans-serif;
        font-size: 13px;
        user-select: none;
        overflow: hidden;
        opacity: 0;
        transform: translateY(10px) scale(0.975);
        pointer-events: none;
        transition: opacity 0.16s cubic-bezier(0.22, 1, 0.36, 1), transform 0.16s cubic-bezier(0.22, 1, 0.36, 1);
        -webkit-font-smoothing: antialiased;
      }

      #movie_player.ytp-big-mode .ytpp-popover,
      #movie_player.ytp-fullscreen .ytpp-popover {
        bottom: 78px;
        right: 24px;
      }

      .ytpp-popover.ytpp-open {
        opacity: 1;
        transform: translateY(0) scale(1);
        pointer-events: auto;
      }

      .ytpp-popover-header {
        display: flex;
        flex-direction: column;
        padding: 12px 14px 8px;
        gap: 10px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.03) 0%, transparent 100%);
      }

      .ytpp-brand-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }

      .ytpp-brand-left {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        font-size: 13.5px;
        font-weight: 600;
        letter-spacing: 0.02em;
        color: #ffffff;
      }

      .ytpp-brand-left svg {
        width: 18px;
        height: 18px;
        flex-shrink: 0;
      }

      .ytpp-brand-pill {
        font-size: 11px;
        font-weight: 500;
        color: rgba(255, 255, 255, 0.72);
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.08);
        padding: 2px 8px;
        border-radius: 999px;
      }

      .ytpp-tabs {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        background: rgba(0, 0, 0, 0.35);
        border: 1px solid rgba(255, 255, 255, 0.06);
        border-radius: 10px;
        padding: 3px;
        gap: 3px;
      }

      .ytpp-tab-btn,
      .ytpp-seg-btn {
        height: 28px;
        border: none;
        border-radius: 7px;
        background: transparent;
        color: rgba(255, 255, 255, 0.62);
        font-size: 12px;
        font-weight: 500;
        font-family: inherit;
        cursor: pointer;
        transition: background 0.14s ease, color 0.14s ease, box-shadow 0.14s ease;
        padding: 0 6px;
        white-space: nowrap;
      }

      .ytpp-tab-btn:hover,
      .ytpp-seg-btn:hover {
        color: #ffffff;
      }

      .ytpp-tab-btn.ytpp-active,
      .ytpp-seg-btn.ytpp-active {
        background: rgba(255, 255, 255, 0.16);
        color: #ffffff;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.32), inset 0 1px 0 rgba(255, 255, 255, 0.12);
      }

      .ytpp-popover-body {
        padding: 10px 14px 14px;
        overflow-y: auto;
        scrollbar-width: thin;
        scrollbar-color: rgba(255, 255, 255, 0.22) transparent;
      }

      .ytpp-pane {
        display: none;
        flex-direction: column;
        gap: 10px;
      }

      .ytpp-pane.ytpp-active {
        display: flex;
      }

      .ytpp-card {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 10px 12px;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.065);
      }

      .ytpp-segmented-4 {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        background: rgba(0, 0, 0, 0.35);
        border: 1px solid rgba(255, 255, 255, 0.06);
        border-radius: 10px;
        padding: 3px;
        gap: 3px;
      }

      .ytpp-row {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .ytpp-row-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }

      .ytpp-label {
        font-size: 12.5px;
        font-weight: 500;
        color: #ededf0;
      }

      .ytpp-sublabel {
        font-size: 11.5px;
        font-weight: 500;
        color: rgba(255, 255, 255, 0.56);
      }

      .ytpp-value-badge {
        font-size: 11.5px;
        font-weight: 500;
        font-variant-numeric: tabular-nums;
        color: #e4e4e8;
        background: rgba(255, 255, 255, 0.09);
        border: 1px solid rgba(255, 255, 255, 0.08);
        padding: 1px 7px;
        border-radius: 999px;
        cursor: pointer;
        transition: background 0.12s ease, color 0.12s ease;
      }

      .ytpp-value-badge:hover {
        background: rgba(255, 255, 255, 0.18);
        color: #ffffff;
      }

      .ytpp-slider {
        -webkit-appearance: none;
        appearance: none;
        width: 100%;
        height: 5px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.18);
        outline: none;
        margin: 5px 0;
        cursor: pointer;
      }

      .ytpp-slider::-webkit-slider-thumb {
        -webkit-appearance: none;
        appearance: none;
        width: 15px;
        height: 15px;
        border-radius: 50%;
        background: #ffffff;
        box-shadow: 0 1px 5px rgba(0, 0, 0, 0.55);
        cursor: pointer;
        transition: transform 0.12s ease;
      }

      .ytpp-slider::-webkit-slider-thumb:hover {
        transform: scale(1.12);
      }

      .ytpp-input,
      .ytpp-select {
        width: 100%;
        box-sizing: border-box;
        height: 32px;
        padding: 0 10px;
        border-radius: 8px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(10, 10, 14, 0.65);
        color: #f3f3f5;
        font-size: 12.5px;
        font-family: inherit;
        outline: none;
        transition: border-color 0.14s ease, background 0.14s ease;
      }

      .ytpp-select option {
        background: #1a1a20;
        color: #f3f3f5;
      }

      .ytpp-input:focus,
      .ytpp-select:focus {
        border-color: rgba(255, 255, 255, 0.38);
        background: rgba(10, 10, 14, 0.85);
      }

      .ytpp-inline-group {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .ytpp-grid-2 {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 8px;
      }

      .ytpp-btn {
        padding: 0 12px;
        height: 32px;
        border-radius: 8px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(255, 255, 255, 0.1);
        color: #ffffff;
        font-size: 12px;
        font-weight: 500;
        font-family: inherit;
        cursor: pointer;
        white-space: nowrap;
        flex-shrink: 0;
        transition: background 0.14s ease, border-color 0.14s ease;
      }

      .ytpp-btn:hover {
        background: rgba(255, 255, 255, 0.18);
        border-color: rgba(255, 255, 255, 0.24);
      }

      /* Compact switch row */
      .ytpp-switch-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        min-height: 28px;
        gap: 10px;
        cursor: pointer;
      }

      .ytpp-switch-input {
        position: relative;
        width: 36px;
        height: 20px;
        -webkit-appearance: none;
        appearance: none;
        background: rgba(255, 255, 255, 0.18);
        border: 1px solid rgba(255, 255, 255, 0.08);
        outline: none;
        border-radius: 999px;
        cursor: pointer;
        transition: background 0.18s ease, border-color 0.18s ease;
        flex-shrink: 0;
        margin: 0;
      }

      .ytpp-switch-input::after {
        content: "";
        position: absolute;
        top: 2px;
        left: 2px;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: #ffffff;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
        transition: transform 0.18s cubic-bezier(0.22, 1, 0.36, 1);
      }

      .ytpp-switch-input:checked {
        background: #ff0033;
        border-color: #ff2a55;
      }

      .ytpp-switch-input:checked::after {
        transform: translateX(16px);
      }

      .ytpp-divider {
        height: 1px;
        background: rgba(255, 255, 255, 0.07);
        margin: 2px 0;
      }
      `,
    );
  }

  mountPlayerButtons(player: HTMLElement): void {
    this.playerEl = player;
    const rightControls = player.querySelector(".ytp-right-controls");
    if (!rightControls) return;

    if (rightControls.querySelector(".ytpp-cc-btn")) {
      this.syncControlButtons();
      return;
    }

    const nativeSubBtn = rightControls.querySelector<HTMLButtonElement>(
      ".ytp-subtitles-button:not(.ytpp-cc-btn)",
    );
    const nativeSettingsBtn = rightControls.querySelector<HTMLButtonElement>(
      ".ytp-settings-button",
    );

    if (nativeSubBtn) {
      this.ccBtn = nativeSubBtn.cloneNode(true) as HTMLButtonElement;
      this.ccBtn.removeAttribute("id");
      this.ccBtn.removeAttribute("data-title-no-tooltip");
      this.ccBtn.removeAttribute("data-tooltip-target-id");
      this.ccBtn.style.display = "";
      this.ccBtn.classList.add("ytpp-cc-btn");
    } else {
      this.ccBtn = el("button", {
        className: "ytp-button ytp-subtitles-button ytpp-cc-btn",
        attrs: { type: "button" },
      });
      this.ccBtn.appendChild(createIconFromNativeOrFallback(nativeSettingsBtn, YT_CC_PATH_24));
    }

    this.ccBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const curr = configStore.get().subtitleMode;
      if (curr === "off") {
        configStore.update({ subtitleMode: this.lastActiveMode || "bilingual" });
      } else {
        this.lastActiveMode = curr;
        configStore.update({ subtitleMode: "off" });
      }
    });

    this.ccBtn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const curr = configStore.get().subtitleMode;
      const idx = ACTIVE_MODES.indexOf(curr);
      const nextMode = ACTIVE_MODES[(idx + 1) % ACTIVE_MODES.length];
      configStore.update({ subtitleMode: nextMode });
    });

    // Clone native button wrapper so inner DOM structure, hover circle, and SVG viewBox match YouTube 1:1
    const templateBtn = nativeSubBtn || nativeSettingsBtn;
    if (templateBtn) {
      this.menuBtn = templateBtn.cloneNode(true) as HTMLButtonElement;
      this.menuBtn.removeAttribute("id");
      this.menuBtn.removeAttribute("data-title-no-tooltip");
      this.menuBtn.removeAttribute("data-tooltip-target-id");
      this.menuBtn.removeAttribute("aria-pressed");
      this.menuBtn.removeAttribute("aria-haspopup");
      this.menuBtn.removeAttribute("aria-controls");
      this.menuBtn.classList.remove("ytp-subtitles-button", "ytp-settings-button");
      this.menuBtn.style.display = "";
      this.menuBtn.classList.add("ytpp-menu-btn");
      const badge = this.menuBtn.querySelector(".ytp-settings-button-badge, sup");
      badge?.remove();

      const existingSvg = this.menuBtn.querySelector("svg");
      const newSvg = createYtPlusSvgIcon(templateBtn);
      if (existingSvg && existingSvg.parentElement) {
        existingSvg.parentElement.replaceChild(newSvg, existingSvg);
      } else {
        clearChildren(this.menuBtn);
        this.menuBtn.appendChild(newSvg);
      }
    } else {
      this.menuBtn = el("button", {
        className: "ytp-button ytpp-menu-btn",
        attrs: { type: "button" },
      });
      this.menuBtn.appendChild(createYtPlusSvgIcon(null));
    }

    this.menuBtn.setAttribute("aria-label", "YT+");
    this.menuBtn.setAttribute("aria-expanded", "false");
    this.menuBtn.setAttribute("title", "YT+");
    this.menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.togglePopover();
    });

    if (nativeSubBtn && nativeSubBtn.parentElement) {
      nativeSubBtn.parentElement.insertBefore(this.ccBtn, nativeSubBtn);
      nativeSubBtn.parentElement.insertBefore(this.menuBtn, nativeSubBtn);
    } else {
      const leftSlot = rightControls.querySelector(".ytp-right-controls-left");
      const container = leftSlot || rightControls;
      container.insertBefore(this.menuBtn, container.firstChild);
      container.insertBefore(this.ccBtn, this.menuBtn);
    }

    this.syncControlButtons();
  }

  private syncControlButtons(): void {
    const cfg = configStore.get();
    if (this.ccBtn) {
      const isOn = cfg.subtitleMode !== "off";
      this.ccBtn.setAttribute("aria-pressed", isOn ? "true" : "false");
      this.ccBtn.setAttribute(
        "title",
        `${getModeLabel(cfg.subtitleMode)} (${tr(
          "左键开关，右键切换双语/译文/原文",
          "Click to toggle, right-click to cycle mode",
        )})`,
      );
    }
    if (this.menuBtn) {
      this.menuBtn.setAttribute("aria-expanded", this.isOpen ? "true" : "false");
    }
  }

  private syncLivePopoverControls(): void {
    if (!this.isOpen) return;
    const cfg = configStore.get();

    for (const [mode, btn] of this.modeButtons.entries()) {
      btn.classList.toggle("ytpp-active", cfg.subtitleMode === mode);
    }

    if (this.brandPillEl) {
      this.brandPillEl.textContent = getModeLabel(cfg.subtitleMode);
    }

    if (this.fontSliderEl && document.activeElement !== this.fontSliderEl) {
      this.fontSliderEl.value = String(cfg.fontSizeScale);
    }
    if (this.fontValueEl) {
      this.fontValueEl.textContent = `${Math.round(cfg.fontSizeScale * 100)}%`;
    }

    if (this.bottomSliderEl && document.activeElement !== this.bottomSliderEl) {
      this.bottomSliderEl.value = String(cfg.subtitleBottomPercent);
    }
    if (this.bottomValueEl) {
      this.bottomValueEl.textContent = `${Math.round(cfg.subtitleBottomPercent)}%`;
    }

    const alpha = cfg.subtitleBackdropOpacity ?? 0.42;
    if (this.backdropSliderEl && document.activeElement !== this.backdropSliderEl) {
      this.backdropSliderEl.value = String(alpha);
    }
    if (this.backdropValueEl) {
      this.backdropValueEl.textContent = `${Math.round(alpha * 100)}%`;
    }
  }

  togglePopover(): void {
    if (this.isOpen) {
      this.closePopover();
    } else {
      this.openPopover();
    }
  }

  openPopover(): void {
    const player = this.playerEl || document.getElementById("movie_player");
    if (!player) return;
    this.playerEl = player;

    if (this.popoverEl) {
      this.popoverEl.remove();
      this.popoverEl = null;
    }

    const cfg = configStore.get();
    this.modeButtons.clear();

    const tabButtons = new Map<TabId, HTMLButtonElement>();
    const panes = new Map<TabId, HTMLElement>();

    const switchTab = (tabId: TabId) => {
      this.activeTab = tabId;
      for (const [id, btn] of tabButtons.entries()) {
        btn.classList.toggle("ytpp-active", id === tabId);
      }
      for (const [id, pane] of panes.entries()) {
        pane.classList.toggle("ytpp-active", id === tabId);
      }
    };

    const makeTabBtn = (id: TabId, label: string) => {
      const btn = el("button", {
        className: `ytpp-tab-btn${this.activeTab === id ? " ytpp-active" : ""}`,
        text: label,
        attrs: { type: "button" },
        on: { click: () => switchTab(id) },
      });
      tabButtons.set(id, btn);
      return btn;
    };

    const makeSwitchRow = (
      label: string,
      checked: boolean,
      onChange: (val: boolean) => void,
    ) => {
      const input = el("input", {
        className: "ytpp-switch-input",
        attrs: { type: "checkbox" },
        on: {
          change: () => onChange(input.checked),
        },
      });
      input.checked = checked;
      return el("label", { className: "ytpp-switch-row" }, [
        el("span", { className: "ytpp-label", text: label }),
        input,
      ]);
    };

    // --- Tab 1: Subtitle Pane ---
    const modeItems: Array<[SubtitleMode, string]> = [
      ["bilingual", getModeLabel("bilingual", true)],
      ["target", getModeLabel("target", true)],
      ["source", getModeLabel("source", true)],
      ["off", getModeLabel("off", true)],
    ];

    const modeControl = el(
      "div",
      { className: "ytpp-segmented-4" },
      modeItems.map(([mode, label]) => {
        const btn = el("button", {
          className: `ytpp-seg-btn${cfg.subtitleMode === mode ? " ytpp-active" : ""}`,
          text: label,
          attrs: { type: "button" },
          on: {
            click: () => configStore.update({ subtitleMode: mode }),
          },
        });
        this.modeButtons.set(mode, btn);
        return btn;
      }),
    );

    const tracks = this.subtitleManager.getAvailableTracks();
    const currentTrack = this.subtitleManager.getCurrentTrack();
    const trackSelect = el("select", {
      className: "ytpp-select",
      on: {
        change: () => {
          const chosen = tracks[Number.parseInt(trackSelect.value, 10)];
          if (chosen) {
            void this.subtitleManager.switchTrack(chosen);
          }
        },
      },
    });
    if (tracks.length === 0) {
      trackSelect.appendChild(
        el("option", {
          text: tr("当前无可用字幕轨", "No caption tracks available"),
          attrs: { value: "-1" },
        }),
      );
    } else {
      tracks.forEach((t, idx) => {
        const opt = el("option", {
          text: `${t.name} (${t.languageCode})`,
          attrs: { value: String(idx) },
        });
        if (currentTrack && currentTrack.vssId === t.vssId) {
          opt.selected = true;
        }
        trackSelect.appendChild(opt);
      });
    }

    this.fontValueEl = el("span", {
      className: "ytpp-value-badge",
      text: `${Math.round(cfg.fontSizeScale * 100)}%`,
      attrs: { title: tr("点击复位为 100%", "Click to reset to 100%") },
      on: {
        click: () => configStore.update({ fontSizeScale: 1.0 }),
      },
    });

    this.fontSliderEl = el("input", {
      className: "ytpp-slider",
      attrs: {
        type: "range",
        min: "0.65",
        max: "1.85",
        step: "0.05",
        value: String(cfg.fontSizeScale),
      },
      on: {
        input: () => {
          const val = Number.parseFloat(this.fontSliderEl!.value) || 1.0;
          configStore.update({ fontSizeScale: val });
        },
      },
    });

    this.bottomValueEl = el("span", {
      className: "ytpp-value-badge",
      text: `${Math.round(cfg.subtitleBottomPercent)}%`,
      attrs: { title: tr("点击复位为 6%", "Click to reset to 6%") },
      on: {
        click: () => configStore.update({ subtitleBottomPercent: 6 }),
      },
    });

    this.bottomSliderEl = el("input", {
      className: "ytpp-slider",
      attrs: {
        type: "range",
        min: "2",
        max: "65",
        step: "1",
        value: String(cfg.subtitleBottomPercent),
      },
      on: {
        input: () => {
          const val = Number.parseFloat(this.bottomSliderEl!.value) || 6;
          configStore.update({ subtitleBottomPercent: val });
        },
      },
    });

    const currOpacity = cfg.subtitleBackdropOpacity ?? 0.42;
    this.backdropValueEl = el("span", {
      className: "ytpp-value-badge",
      text: `${Math.round(currOpacity * 100)}%`,
      attrs: { title: tr("点击复位为 42%", "Click to reset to 42%") },
      on: {
        click: () => configStore.update({ subtitleBackdropOpacity: 0.42, subtitleBackdrop: true }),
      },
    });

    this.backdropSliderEl = el("input", {
      className: "ytpp-slider",
      attrs: {
        type: "range",
        min: "0",
        max: "0.95",
        step: "0.05",
        value: String(currOpacity),
      },
      on: {
        input: () => {
          const val = Number.parseFloat(this.backdropSliderEl!.value);
          const nextAlpha = Number.isFinite(val) ? val : 0.42;
          configStore.update({
            subtitleBackdropOpacity: nextAlpha,
            subtitleBackdrop: nextAlpha > 0.01,
          });
        },
      },
    });

    const subtitlePane = el(
      "div",
      { className: `ytpp-pane${this.activeTab === "subtitle" ? " ytpp-active" : ""}` },
      [
        el("div", { className: "ytpp-card" }, [
          el("div", { className: "ytpp-row" }, [
            el("span", { className: "ytpp-sublabel", text: tr("显示模式", "Display Mode") }),
            modeControl,
          ]),
          el("div", { className: "ytpp-row" }, [
            el("span", { className: "ytpp-sublabel", text: tr("字幕源轨", "Caption Track") }),
            el("div", { className: "ytpp-inline-group" }, [
              trackSelect,
              el("button", {
                className: "ytpp-btn",
                text: tr("重译", "Retranslate"),
                attrs: {
                  type: "button",
                  title: tr("清空当前译文并重新翻译", "Clear cache and retranslate"),
                },
                on: {
                  click: () => this.subtitleManager.retranslateAll(),
                },
              }),
            ]),
          ]),
        ]),
        el("div", { className: "ytpp-card" }, [
          el("div", { className: "ytpp-row" }, [
            el("div", { className: "ytpp-row-header" }, [
              el("span", { className: "ytpp-label", text: tr("字号缩放", "Font Size") }),
              this.fontValueEl,
            ]),
            this.fontSliderEl,
          ]),
          el("div", { className: "ytpp-row" }, [
            el("div", { className: "ytpp-row-header" }, [
              el("span", {
                className: "ytpp-label",
                text: tr("底部距离 (可直接拖拽字幕)", "Bottom Offset (Draggable)"),
              }),
              this.bottomValueEl,
            ]),
            this.bottomSliderEl,
          ]),
          el("div", { className: "ytpp-row" }, [
            el("div", { className: "ytpp-row-header" }, [
              el("span", {
                className: "ytpp-label",
                text: tr("背景不透明度", "Backdrop Opacity"),
              }),
              this.backdropValueEl,
            ]),
            this.backdropSliderEl,
          ]),
        ]),
        el("div", { className: "ytpp-card" }, [
          makeSwitchRow(
            tr("自动翻译视频标题与简介", "Translate Video Title & Description"),
            cfg.translateMetadata,
            (val) => configStore.update({ translateMetadata: val }),
          ),
          makeSwitchRow(
            tr("起播与跳转时等待首段译完", "Hold Playback for Initial Translation"),
            cfg.holdPlaybackForFastBatch,
            (val) => configStore.update({ holdPlaybackForFastBatch: val }),
          ),
        ]),
      ],
    );
    panes.set("subtitle", subtitlePane);

    // --- Tab 2: API & Model Pane ---
    const urlInput = el("input", {
      className: "ytpp-input",
      attrs: {
        type: "text",
        placeholder: "https://api.openai.com/v1",
        value: cfg.apiBaseUrl,
      },
      on: {
        change: () => configStore.update({ apiBaseUrl: urlInput.value.trim() }),
      },
    });

    const keyInput = el("input", {
      className: "ytpp-input",
      attrs: {
        type: "password",
        placeholder: tr("留空或填入密钥", "API Key (optional for local proxy)"),
        value: cfg.apiKey,
      },
      on: {
        change: () => configStore.update({ apiKey: keyInput.value.trim() }),
      },
    });

    const targetLangInput = el("input", {
      className: "ytpp-input",
      attrs: { type: "text", value: cfg.targetLang },
      on: {
        change: () =>
          configStore.update({
            targetLang: targetLangInput.value.trim() || "简体中文",
          }),
      },
    });

    const modelInput = el("input", {
      className: "ytpp-input",
      attrs: {
        type: "text",
        placeholder: tr("输入或选择模型 ID", "Enter or select Model ID"),
        value: cfg.model,
      },
      on: {
        change: () => {
          const nextModel = modelInput.value.trim();
          configStore.update({ model: nextModel });
          populateModelSelect(configStore.get().cachedModels, nextModel);
        },
      },
    });

    const modelSelect = el("select", {
      className: "ytpp-select",
      on: {
        change: () => {
          if (modelSelect.value) {
            modelInput.value = modelSelect.value;
            configStore.update({ model: modelSelect.value });
          }
        },
      },
    });

    const populateModelSelect = (models: string[], activeModel: string) => {
      clearChildren(modelSelect);
      const uniqueModels = Array.from(
        new Set(activeModel ? [activeModel, ...models] : models),
      );
      if (uniqueModels.length === 0) {
        modelSelect.style.display = "none";
        return;
      }
      modelSelect.style.display = "block";
      for (const m of uniqueModels) {
        const opt = el("option", { text: m, attrs: { value: m } });
        if (m === activeModel) opt.selected = true;
        modelSelect.appendChild(opt);
      }
    };

    populateModelSelect(cfg.cachedModels || [], cfg.model);

    const modelStatus = el("div", {
      className: "ytpp-sublabel",
      style: { display: "none" },
    });

    const fetchModelsBtn = el("button", {
      className: "ytpp-btn",
      text: tr("刷新模型", "Fetch Models"),
      attrs: { type: "button" },
      on: {
        click: async () => {
          configStore.update({
            apiBaseUrl: urlInput.value.trim(),
            apiKey: keyInput.value.trim(),
          });
          modelStatus.style.display = "block";
          modelStatus.textContent = tr("正在拉取模型列表...", "Fetching models...");
          try {
            const models = await fetchAvailableModels(urlInput.value, keyInput.value);
            if (models.length > 0) {
              const nextActive = modelInput.value.trim() || models[0];
              modelInput.value = nextActive;
              configStore.update({
                cachedModels: models,
                model: nextActive,
              });
              populateModelSelect(models, nextActive);
              modelStatus.textContent = tr(
                `已缓存 ${models.length} 个模型，可直接下拉切换`,
                `Cached ${models.length} models`,
              );
            } else {
              modelStatus.textContent = tr("接口未返回可用模型列表", "No models returned");
            }
          } catch (err) {
            modelStatus.textContent = err instanceof Error ? err.message : String(err);
          }
        },
      },
    });

    const customPromptInput = el("input", {
      className: "ytpp-input",
      attrs: {
        type: "text",
        placeholder: tr("可选术语表或译文风格要求", "Optional glossary or style instructions"),
        value: cfg.customPrompt,
      },
      on: {
        change: () => configStore.update({ customPrompt: customPromptInput.value.trim() }),
      },
    });

    const fastBatchInput = el("input", {
      className: "ytpp-input",
      attrs: { type: "number", min: "3", max: "30", value: String(cfg.fastBatchSize) },
      on: {
        change: () =>
          configStore.update({
            fastBatchSize: Math.max(3, Number.parseInt(fastBatchInput.value, 10) || 10),
          }),
      },
    });

    const batchSizeInput = el("input", {
      className: "ytpp-input",
      attrs: { type: "number", min: "10", max: "120", value: String(cfg.batchSize) },
      on: {
        change: () =>
          configStore.update({
            batchSize: Math.max(10, Number.parseInt(batchSizeInput.value, 10) || 50),
          }),
      },
    });

    const apiPane = el(
      "div",
      { className: `ytpp-pane${this.activeTab === "api" ? " ytpp-active" : ""}` },
      [
        el("div", { className: "ytpp-card" }, [
          el("div", { className: "ytpp-row" }, [
            el("span", {
              className: "ytpp-sublabel",
              text: tr("模型选择 (自动记忆列表)", "Model Selection (Auto-cached)"),
            }),
            modelSelect,
            el("div", { className: "ytpp-inline-group" }, [
              modelInput,
              fetchModelsBtn,
            ]),
            modelStatus,
          ]),
          el("div", { className: "ytpp-row" }, [
            el("span", {
              className: "ytpp-sublabel",
              text: tr("OpenAI 兼容接口地址", "OpenAI-Compatible Base URL"),
            }),
            urlInput,
          ]),
          el("div", { className: "ytpp-grid-2" }, [
            el("div", { className: "ytpp-row" }, [
              el("span", { className: "ytpp-sublabel", text: tr("接口密钥", "API Key") }),
              keyInput,
            ]),
            el("div", { className: "ytpp-row" }, [
              el("span", { className: "ytpp-sublabel", text: tr("目标语言", "Target Language") }),
              targetLangInput,
            ]),
          ]),
        ]),
        el("div", { className: "ytpp-card" }, [
          el("div", { className: "ytpp-grid-2" }, [
            el("div", { className: "ytpp-row" }, [
              el("span", {
                className: "ytpp-sublabel",
                text: tr("起播预翻句数", "Fast Batch Size"),
              }),
              fastBatchInput,
            ]),
            el("div", { className: "ytpp-row" }, [
              el("span", {
                className: "ytpp-sublabel",
                text: tr("后台单批句数", "Background Batch Size"),
              }),
              batchSizeInput,
            ]),
          ]),
          el("div", { className: "ytpp-row" }, [
            el("span", { className: "ytpp-sublabel", text: tr("附加提示词", "Custom Prompt") }),
            customPromptInput,
          ]),
        ]),
      ],
    );
    panes.set("api", apiPane);

    // --- Tab 3: SponsorBlock Pane ---
    const makeCategorySwitchRow = (cat: (typeof ALL_SPONSOR_CATEGORIES)[number]) => {
      const meta = SPONSOR_CATEGORY_META[cat];
      const currentList = configStore.get().sbCategories || [];
      const input = el("input", {
        className: "ytpp-switch-input",
        attrs: { type: "checkbox" },
        on: {
          change: () => {
            const existing = new Set(configStore.get().sbCategories || []);
            if (input.checked) {
              existing.add(cat);
            } else {
              existing.delete(cat);
            }
            configStore.update({ sbCategories: Array.from(existing) });
          },
        },
      });
      input.checked = currentList.includes(cat);

      const dot = el("span", {
        style: {
          display: "inline-block",
          width: "8px",
          height: "8px",
          borderRadius: "50%",
          backgroundColor: meta.color,
          marginRight: "8px",
          flexShrink: "0",
        },
      });

      const leftWrap = el(
        "span",
        {
          className: "ytpp-label",
          style: { display: "inline-flex", alignItems: "center" },
        },
        [dot, getSponsorCategoryLabel(cat)],
      );

      return el("label", { className: "ytpp-switch-row" }, [leftWrap, input]);
    };

    const sbPane = el(
      "div",
      { className: `ytpp-pane${this.activeTab === "sponsorblock" ? " ytpp-active" : ""}` },
      [
        el("div", { className: "ytpp-card" }, [
          makeSwitchRow(
            tr("启用 SponsorBlock 自动跳过", "Enable SponsorBlock Auto-Skip"),
            cfg.sbEnabled,
            (val) => configStore.update({ sbEnabled: val }),
          ),
        ]),
        el("div", { className: "ytpp-card" }, [
          el("span", {
            className: "ytpp-sublabel",
            text: tr("自动跳过的片段类型 (含进度条色标)", "Categories to Skip (with Timeline Markers)"),
          }),
          ...ALL_SPONSOR_CATEGORIES.map((cat) => makeCategorySwitchRow(cat)),
        ]),
      ],
    );
    panes.set("sponsorblock", sbPane);

    // --- Tab 4: Touch & Performance Pane ---
    const systemPane = el(
      "div",
      { className: `ytpp-pane${this.activeTab === "system" ? " ytpp-active" : ""}` },
      [
        el("div", { className: "ytpp-card" }, [
          el("span", {
            className: "ytpp-sublabel",
            text: tr("平板与触控手势", "Tablet & Touch Gestures"),
          }),
          makeSwitchRow(
            tr("启用触屏快进/音量/亮度/倍速手势", "Touch Swipe Seek / Volume / Brightness / 2x"),
            cfg.touchGesturesEnabled,
            (val) => configStore.update({ touchGesturesEnabled: val }),
          ),
          makeSwitchRow(
            tr("触屏单击画面仅开关控制栏", "Single Tap Video to Toggle Controls"),
            cfg.touchSingleTapToggleControls,
            (val) => configStore.update({ touchSingleTapToggleControls: val }),
          ),
          makeSwitchRow(
            tr("加宽进度条与操作按钮触控热区", "Enlarge Scrubber & Control Hitboxes"),
            cfg.touchEnlargeControls,
            (val) => configStore.update({ touchEnlargeControls: val }),
          ),
        ]),
        el("div", { className: "ytpp-card" }, [
          el("span", {
            className: "ytpp-sublabel",
            text: tr("渲染减负与界面净化", "Performance & Declutter"),
          }),
          makeSwitchRow(
            tr("禁用环境泛光画布 (省电降温)", "Disable Ambient Cinematics (Save GPU)"),
            cfg.perfDisableAmbient,
            (val) => configStore.update({ perfDisableAmbient: val }),
          ),
          makeSwitchRow(
            tr("禁用推荐流悬停预览播放", "Disable Feed Inline Hover Preview"),
            cfg.perfDisableInlinePreview,
            (val) => configStore.update({ perfDisableInlinePreview: val }),
          ),
          makeSwitchRow(
            tr("长列表离屏渲染隔离", "Offscreen Feed Rendering Isolation"),
            cfg.perfContentVisibility,
            (val) => configStore.update({ perfContentVisibility: val }),
          ),
          makeSwitchRow(
            tr("隐藏 Shorts 短视频栏", "Hide Shorts Shelves"),
            cfg.perfHideShorts,
            (val) => configStore.update({ perfHideShorts: val }),
          ),
          makeSwitchRow(
            tr("隐藏片尾推荐遮挡卡片", "Hide Endscreen Overlay Cards"),
            cfg.perfHideEndscreen,
            (val) => configStore.update({ perfHideEndscreen: val }),
          ),
        ]),
      ],
    );
    panes.set("system", systemPane);

    const brandIconSvg = createYtPlusSvgIcon(null);
    brandIconSvg.setAttribute("viewBox", "0 0 24 24");

    this.brandPillEl = el("span", {
      className: "ytpp-brand-pill",
      text: getModeLabel(cfg.subtitleMode),
    });

    const langToggleBtn = el("button", {
      className: "ytpp-value-badge",
      text: isEn() ? "中文" : "EN",
      attrs: {
        type: "button",
        title: tr("切换界面语言 (中文 / English)", "Switch UI Language (English / 中文)"),
      },
      on: {
        click: () => {
          const nextLang = isEn() ? "zh" : "en";
          configStore.update({ uiLang: nextLang });
          this.openPopover();
        },
      },
    });

    this.popoverEl = el(
      "div",
      {
        className: "ytpp-popover ytpp-open",
        on: {
          click: (e) => e.stopPropagation(),
          pointerdown: (e) => e.stopPropagation(),
        },
      },
      [
        el("div", { className: "ytpp-popover-header" }, [
          el("div", { className: "ytpp-brand-row" }, [
            el("span", { className: "ytpp-brand-left" }, [
              brandIconSvg,
              el("span", { text: "YT+" }),
            ]),
            el("div", { className: "ytpp-inline-group" }, [
              this.brandPillEl,
              langToggleBtn,
            ]),
          ]),
          el("div", { className: "ytpp-tabs" }, [
            makeTabBtn("subtitle", tr("字幕", "Subtitles")),
            makeTabBtn("api", tr("翻译接口", "API")),
            makeTabBtn("sponsorblock", tr("片段跳过", "SponsorBlock")),
            makeTabBtn("system", tr("触控与性能", "System")),
          ]),
        ]),
        el("div", { className: "ytpp-popover-body" }, [
          subtitlePane,
          apiPane,
          sbPane,
          systemPane,
        ]),
      ],
    );

    player.appendChild(this.popoverEl);
    player.classList.add("ytpp-popover-open");
    this.isOpen = true;
    this.syncControlButtons();
  }

  closePopover(): void {
    this.isOpen = false;
    if (this.popoverEl) {
      this.popoverEl.remove();
      this.popoverEl = null;
    }
    this.playerEl?.classList.remove("ytpp-popover-open");
    this.syncControlButtons();
  }
}
