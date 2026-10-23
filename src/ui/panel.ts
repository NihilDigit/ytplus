import { configStore } from "../config";
import { fetchAvailableModels } from "../subtitle/llm-client";
import type { SubtitleManager } from "../subtitle/manager";
import type { SubtitleMode } from "../types";
import { clearChildren, el, upsertStyle } from "../utils/dom";

const UI_STYLE_ID = "ytpp-ui-panel-style";
const SVG_NS = "http://www.w3.org/2000/svg";

// Fallback 24x24 YouTube CC and Gear paths (used only if native buttons haven't rendered yet)
const YT_CC_PATH_24 =
  "M5,5 C3.9,5 3,5.9 3,7 L3,17 C3,18.1 3.9,19 5,19 L19,19 C20.1,19 21,18.1 21,17 L21,7 C21,5.9 20.1,5 19,5 L5,5 Z M11,11 L9.5,11 L9.5,10.5 L7.5,10.5 L7.5,13.5 L9.5,13.5 L9.5,13 L11,13 L11,14 C11,14.55 10.55,15 10,15 L7,15 C6.45,15 6,14.55 6,14 L6,10 C6,9.45 6.45,9 7,9 L10,9 C10.55,9 11,9.45 11,10 L11,11 Z M18,11 L16.5,11 L16.5,10.5 L14.5,10.5 L14.5,13.5 L16.5,13.5 L16.5,13 L18,13 L18,14 C18,14.55 17.55,15 17,15 L14,15 C13.45,15 13,14.55 13,14 L13,10 C13,9.45 13.45,9 14,9 L17,9 C17.55,9 18,9.45 18,10 L18,11 Z";

const YT_GEAR_PATH_24 =
  "M19.43,12.98 C19.47,12.66 19.5,12.34 19.5,12 C19.5,11.66 19.47,11.34 19.43,11.02 L21.54,9.37 C21.73,9.22 21.78,8.95 21.66,8.73 L19.66,5.27 C19.54,5.05 19.27,4.97 19.05,5.05 L16.56,6.05 C16.04,5.65 15.48,5.32 14.87,5.07 L14.49,2.42 C14.46,2.18 14.25,2 14,2 L10,2 C9.75,2 9.54,2.18 9.51,2.42 L9.13,5.07 C8.52,5.32 7.96,5.65 7.44,6.05 L4.95,5.05 C4.73,4.96 4.46,5.05 4.34,5.27 L2.34,8.73 C2.21,8.95 2.27,9.22 2.46,9.37 L4.57,11.02 C4.53,11.34 4.5,11.66 4.5,12 C4.5,12.34 4.53,12.66 4.57,12.98 L2.46,14.63 C2.27,14.78 2.22,15.05 2.34,15.27 L4.34,18.73 C4.46,18.95 4.73,19.03 4.95,18.95 L7.44,17.95 C7.96,18.35 8.52,18.68 9.13,18.93 L9.51,21.58 C9.54,21.82 9.75,22 10,22 L14,22 C14.25,22 14.46,21.82 14.49,21.58 L14.87,18.93 C15.48,18.68 16.04,18.35 16.56,17.95 L19.05,18.95 C19.27,19.04 19.54,18.95 19.66,18.73 L21.66,15.27 C21.78,15.05 21.73,14.78 21.54,14.63 L19.43,12.98 Z M12,15.5 C10.07,15.5 8.5,13.93 8.5,12 C8.5,10.07 10.07,8.5 12,8.5 C13.93,8.5 15.5,10.07 15.5,12 C15.5,13.93 13.93,15.5 12,15.5 Z";

const MODE_LABELS: Record<SubtitleMode, string> = {
  bilingual: "双语字幕",
  target: "仅译文",
  source: "仅原文",
  off: "关闭字幕",
};

const ACTIVE_MODES: SubtitleMode[] = ["bilingual", "target", "source"];

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
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "100%");

  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", fallbackPath24);
  path.setAttribute("fill", "#fff");
  svg.appendChild(path);
  return svg;
}

export class SettingsPanelUI {
  private subtitleManager: SubtitleManager;
  private ccBtn: HTMLButtonElement | null = null;
  private openBtn: HTMLButtonElement | null = null;
  private modalBackdrop: HTMLElement | null = null;
  private lastActiveMode: SubtitleMode = "bilingual";

  constructor(subtitleManager: SubtitleManager) {
    this.subtitleManager = subtitleManager;
    const initialMode = configStore.get().subtitleMode;
    if (initialMode !== "off") {
      this.lastActiveMode = initialMode;
    }
    this.injectStyles();
    configStore.subscribe((cfg) => {
      if (cfg.subtitleMode !== "off") {
        this.lastActiveMode = cfg.subtitleMode;
      }
      this.syncControlButtons();
    });
  }

  private injectStyles(): void {
    upsertStyle(
      UI_STYLE_ID,
      `
      /* Hide original YouTube subtitle button (our cloned .ytpp-cc-btn takes its place) */
      #movie_player .ytp-subtitles-button:not(.ytpp-cc-btn) {
        display: none !important;
      }

      /* Dim CC icon when subtitles are turned off */
      #movie_player .ytpp-cc-btn[aria-pressed="false"] svg {
        opacity: 0.55;
      }

      /* Subtle dashed underline under the subtitle gear so it pairs visually with the CC button
         and is immediately distinguishable from YouTube's plain player settings gear */
      #movie_player .ytpp-gear-btn {
        position: relative !important;
      }
      #movie_player .ytpp-gear-btn::after {
        content: "";
        position: absolute;
        bottom: 7px;
        left: 28%;
        right: 28%;
        height: 2px;
        background: linear-gradient(
          90deg,
          rgba(255, 255, 255, 0.85) 0%,
          rgba(255, 255, 255, 0.85) 42%,
          transparent 42%,
          transparent 58%,
          rgba(255, 255, 255, 0.85) 58%,
          rgba(255, 255, 255, 0.85) 100%
        );
        border-radius: 1px;
        pointer-events: none;
      }

      /* Native YouTube dark menu style (matches .ytp-settings-menu / yt-spec) */
      .ytpp-panel-backdrop {
        position: fixed;
        inset: 0;
        z-index: 99999;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
        font-family: Roboto, Arial, sans-serif;
      }
      .ytpp-panel-modal {
        width: 100%;
        max-width: 480px;
        max-height: 84vh;
        overflow-y: auto;
        background: rgba(28, 28, 28, 0.98);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 12px;
        color: #f1f1f1;
        box-shadow: 0 4px 32px rgba(0, 0, 0, 0.55);
        padding: 16px 20px;
        scrollbar-width: thin;
        scrollbar-color: rgba(255, 255, 255, 0.25) transparent;
      }
      .ytpp-panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding-bottom: 12px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        margin-bottom: 12px;
      }
      .ytpp-panel-title {
        font-size: 15px;
        font-weight: 500;
        color: #f1f1f1;
      }
      .ytpp-panel-section {
        margin-bottom: 14px;
        padding-bottom: 12px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      }
      .ytpp-panel-section-title {
        font-size: 12px;
        font-weight: 500;
        color: #aaaaaa;
        margin-bottom: 8px;
      }
      .ytpp-field-row {
        display: flex;
        flex-direction: column;
        gap: 4px;
        margin-bottom: 10px;
      }
      .ytpp-field-inline {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 10px;
        margin-bottom: 8px;
      }
      .ytpp-field-inline-2 {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 10px;
        margin-bottom: 8px;
      }
      .ytpp-label {
        font-size: 13px;
        color: #f1f1f1;
      }
      .ytpp-sublabel {
        font-size: 12px;
        color: #aaaaaa;
      }
      .ytpp-input,
      .ytpp-select {
        width: 100%;
        box-sizing: border-box;
        padding: 7px 10px;
        border-radius: 8px;
        border: 1px solid rgba(255, 255, 255, 0.16);
        background: #121212;
        color: #f1f1f1;
        font-size: 13px;
        font-family: inherit;
        outline: none;
      }
      .ytpp-input:focus,
      .ytpp-select:focus {
        border-color: #f1f1f1;
      }
      .ytpp-check-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        min-height: 34px;
        padding: 2px 0;
        gap: 12px;
        cursor: pointer;
        user-select: none;
      }
      .ytpp-check-row input[type="checkbox"] {
        width: 16px;
        height: 16px;
        accent-color: #f1f1f1;
        cursor: pointer;
        margin: 0;
      }
      .ytpp-btn {
        padding: 0 14px;
        height: 34px;
        border-radius: 17px;
        border: none;
        background: rgba(255, 255, 255, 0.1);
        color: #f1f1f1;
        font-size: 13px;
        font-weight: 500;
        font-family: inherit;
        cursor: pointer;
        white-space: nowrap;
        flex-shrink: 0;
      }
      .ytpp-btn:hover {
        background: rgba(255, 255, 255, 0.2);
      }
      .ytpp-btn-primary {
        background: #f1f1f1;
        color: #0f0f0f;
      }
      .ytpp-btn-primary:hover {
        background: #d9d9d9;
      }
      `,
    );
  }

  mountPlayerButtons(player: HTMLElement): void {
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

    // Clone native buttons directly so all YouTube classes, inner wrappers, viewBox, and alignments match 1:1
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
      this.ccBtn.appendChild(createIconFromNativeOrFallback(null, YT_CC_PATH_24));
    }

    this.ccBtn.setAttribute("aria-label", "字幕 (左键开关，右键切换模式)");
    this.ccBtn.setAttribute("title", "字幕 (左键开关，右键切换双语/译文/原文)");
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

    if (nativeSettingsBtn) {
      this.openBtn = nativeSettingsBtn.cloneNode(true) as HTMLButtonElement;
      this.openBtn.removeAttribute("id");
      this.openBtn.removeAttribute("data-title-no-tooltip");
      this.openBtn.removeAttribute("data-tooltip-target-id");
      this.openBtn.removeAttribute("aria-expanded");
      this.openBtn.removeAttribute("aria-haspopup");
      this.openBtn.removeAttribute("aria-controls");
      this.openBtn.classList.remove("ytp-settings-button");
      this.openBtn.style.display = "";
      this.openBtn.classList.add("ytpp-gear-btn");
      // Remove any HD/4K quality badge cloned from the native settings button
      const badge = this.openBtn.querySelector(".ytp-settings-button-badge, sup");
      badge?.remove();
    } else {
      this.openBtn = el("button", {
        className: "ytp-button ytpp-gear-btn",
        attrs: { type: "button" },
      });
      this.openBtn.appendChild(createIconFromNativeOrFallback(null, YT_GEAR_PATH_24));
    }

    this.openBtn.setAttribute("aria-label", "字幕与触屏设置");
    this.openBtn.setAttribute("title", "字幕与触屏设置");
    this.openBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.openModal();
    });

    if (nativeSubBtn && nativeSubBtn.parentElement) {
      nativeSubBtn.parentElement.insertBefore(this.ccBtn, nativeSubBtn);
      nativeSubBtn.parentElement.insertBefore(this.openBtn, nativeSubBtn);
    } else {
      const leftSlot = rightControls.querySelector(".ytp-right-controls-left");
      const container = leftSlot || rightControls;
      container.insertBefore(this.openBtn, container.firstChild);
      container.insertBefore(this.ccBtn, this.openBtn);
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
        `${MODE_LABELS[cfg.subtitleMode]} (左键开关，右键切换模式)`,
      );
    }
  }

  openModal(): void {
    if (this.modalBackdrop) {
      this.modalBackdrop.remove();
      this.modalBackdrop = null;
    }

    const cfg = configStore.get();

    const modeSelect = el("select", { className: "ytpp-select" }, [
      el("option", { text: "双语对照", attrs: { value: "bilingual" } }),
      el("option", { text: "仅译文", attrs: { value: "target" } }),
      el("option", { text: "仅原文", attrs: { value: "source" } }),
      el("option", { text: "关闭字幕", attrs: { value: "off" } }),
    ]);
    modeSelect.value = cfg.subtitleMode;

    const urlInput = el("input", {
      className: "ytpp-input",
      attrs: {
        type: "text",
        placeholder: "https://api.openai.com/v1",
        value: cfg.apiBaseUrl,
      },
    });

    const keyInput = el("input", {
      className: "ytpp-input",
      attrs: {
        type: "password",
        placeholder: "留空或填入密钥",
        value: cfg.apiKey,
      },
    });

    const modelInput = el("input", {
      className: "ytpp-input",
      attrs: {
        type: "text",
        placeholder: "模型 ID",
        value: cfg.model,
      },
    });

    const modelSelect = el("select", {
      className: "ytpp-select",
      style: { display: "none", marginTop: "6px" },
      on: {
        change: () => {
          if (modelSelect.value) {
            modelInput.value = modelSelect.value;
          }
        },
      },
    });

    const modelStatus = el("div", {
      className: "ytpp-sublabel",
      style: { marginTop: "4px" },
    });

    const fetchModelsBtn = el("button", {
      className: "ytpp-btn",
      text: "获取列表",
      attrs: { type: "button" },
      on: {
        click: async () => {
          modelStatus.textContent = "正在加载...";
          try {
            const models = await fetchAvailableModels(urlInput.value, keyInput.value);
            clearChildren(modelSelect);
            modelSelect.appendChild(
              el("option", { text: `选择模型 (${models.length})`, attrs: { value: "" } }),
            );
            for (const m of models) {
              modelSelect.appendChild(el("option", { text: m, attrs: { value: m } }));
            }
            if (models.length > 0) {
              modelSelect.style.display = "block";
              if (!modelInput.value.trim()) {
                modelInput.value = models[0];
              }
              modelStatus.textContent = "";
            } else {
              modelStatus.textContent = "未返回模型列表";
            }
          } catch (err) {
            modelStatus.textContent = err instanceof Error ? err.message : String(err);
          }
        },
      },
    });

    const targetLangInput = el("input", {
      className: "ytpp-input",
      attrs: { type: "text", value: cfg.targetLang },
    });

    const customPromptInput = el("input", {
      className: "ytpp-input",
      attrs: {
        type: "text",
        placeholder: "可选术语或风格说明",
        value: cfg.customPrompt,
      },
    });

    const fastBatchInput = el("input", {
      className: "ytpp-input",
      attrs: { type: "number", min: "3", max: "30", value: String(cfg.fastBatchSize) },
    });

    const batchSizeInput = el("input", {
      className: "ytpp-input",
      attrs: { type: "number", min: "10", max: "120", value: String(cfg.batchSize) },
    });

    const fontScaleInput = el("input", {
      className: "ytpp-input",
      attrs: {
        type: "number",
        step: "0.05",
        min: "0.6",
        max: "2.0",
        value: String(cfg.fontSizeScale),
      },
    });

    const makeCheckboxRow = (label: string, initial: boolean) => {
      const checkbox = el("input", {
        attrs: { type: "checkbox" },
      });
      checkbox.checked = initial;
      const row = el("label", { className: "ytpp-check-row" }, [
        el("span", { className: "ytpp-label", text: label }),
        checkbox,
      ]);
      return { row, checkbox };
    };

    const holdPlaybackCheck = makeCheckboxRow("等待预翻完成后播放", cfg.holdPlaybackForFastBatch);
    const backdropCheck = makeCheckboxRow("字幕背景底衬", cfg.subtitleBackdrop);

    const perfAmbientCheck = makeCheckboxRow("禁用环境光效", cfg.perfDisableAmbient);
    const perfPreviewCheck = makeCheckboxRow("禁用悬浮预览", cfg.perfDisableInlinePreview);
    const perfContentVisCheck = makeCheckboxRow("列表延迟渲染", cfg.perfContentVisibility);
    const perfShortsCheck = makeCheckboxRow("隐藏 Shorts", cfg.perfHideShorts);
    const perfEndscreenCheck = makeCheckboxRow("隐藏片尾卡片", cfg.perfHideEndscreen);

    const touchGesturesCheck = makeCheckboxRow("触屏手势", cfg.touchGesturesEnabled);
    const touchSingleTapCheck = makeCheckboxRow(
      "单击画面仅开关控制栏",
      cfg.touchSingleTapToggleControls,
    );
    const touchEnlargeCheck = makeCheckboxRow("加宽进度条热区", cfg.touchEnlargeControls);

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
      trackSelect.appendChild(el("option", { text: "无字幕轨", attrs: { value: "-1" } }));
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

    const saveAndClose = () => {
      configStore.update({
        subtitleMode: (modeSelect.value as SubtitleMode) || "bilingual",
        apiBaseUrl: urlInput.value.trim(),
        apiKey: keyInput.value.trim(),
        model: modelInput.value.trim(),
        targetLang: targetLangInput.value.trim() || "简体中文",
        customPrompt: customPromptInput.value.trim(),
        fastBatchSize: Math.max(3, Number.parseInt(fastBatchInput.value, 10) || 10),
        batchSize: Math.max(10, Number.parseInt(batchSizeInput.value, 10) || 50),
        fontSizeScale: Math.max(
          0.6,
          Math.min(2.0, Number.parseFloat(fontScaleInput.value) || 1.0),
        ),
        holdPlaybackForFastBatch: holdPlaybackCheck.checkbox.checked,
        subtitleBackdrop: backdropCheck.checkbox.checked,
        perfDisableAmbient: perfAmbientCheck.checkbox.checked,
        perfDisableInlinePreview: perfPreviewCheck.checkbox.checked,
        perfContentVisibility: perfContentVisCheck.checkbox.checked,
        perfHideShorts: perfShortsCheck.checkbox.checked,
        perfHideEndscreen: perfEndscreenCheck.checkbox.checked,
        touchGesturesEnabled: touchGesturesCheck.checkbox.checked,
        touchSingleTapToggleControls: touchSingleTapCheck.checkbox.checked,
        touchEnlargeControls: touchEnlargeCheck.checkbox.checked,
      });
      this.closeModal();
    };

    const modal = el(
      "div",
      {
        className: "ytpp-panel-modal",
        on: {
          click: (e) => e.stopPropagation(),
        },
      },
      [
        el("div", { className: "ytpp-panel-header" }, [
          el("div", { className: "ytpp-panel-title", text: "设置" }),
          el("button", {
            className: "ytpp-btn",
            text: "关闭",
            attrs: { type: "button" },
            on: { click: () => this.closeModal() },
          }),
        ]),

        el("div", { className: "ytpp-panel-section" }, [
          el("div", { className: "ytpp-panel-section-title", text: "字幕" }),
          el("div", { className: "ytpp-field-inline-2" }, [
            el("div", { className: "ytpp-field-row" }, [
              el("label", { className: "ytpp-sublabel", text: "显示模式" }),
              modeSelect,
            ]),
            el("div", { className: "ytpp-field-row" }, [
              el("label", { className: "ytpp-sublabel", text: "字幕轨" }),
              el("div", { style: { display: "flex", gap: "8px" } }, [
                trackSelect,
                el("button", {
                  className: "ytpp-btn",
                  text: "重译",
                  attrs: { type: "button" },
                  on: {
                    click: () => {
                      saveAndClose();
                      this.subtitleManager.retranslateAll();
                    },
                  },
                }),
              ]),
            ]),
          ]),
          el("div", { className: "ytpp-field-inline" }, [
            el("div", { className: "ytpp-field-row" }, [
              el("label", { className: "ytpp-sublabel", text: "预翻句数" }),
              fastBatchInput,
            ]),
            el("div", { className: "ytpp-field-row" }, [
              el("label", { className: "ytpp-sublabel", text: "单批句数" }),
              batchSizeInput,
            ]),
            el("div", { className: "ytpp-field-row" }, [
              el("label", { className: "ytpp-sublabel", text: "字号比例" }),
              fontScaleInput,
            ]),
          ]),
          holdPlaybackCheck.row,
          backdropCheck.row,
        ]),

        el("div", { className: "ytpp-panel-section" }, [
          el("div", { className: "ytpp-panel-section-title", text: "翻译接口" }),
          el("div", { className: "ytpp-field-row" }, [
            el("label", { className: "ytpp-sublabel", text: "接口地址" }),
            urlInput,
          ]),
          el("div", { className: "ytpp-field-inline-2" }, [
            el("div", { className: "ytpp-field-row" }, [
              el("label", { className: "ytpp-sublabel", text: "密钥" }),
              keyInput,
            ]),
            el("div", { className: "ytpp-field-row" }, [
              el("label", { className: "ytpp-sublabel", text: "目标语言" }),
              targetLangInput,
            ]),
          ]),
          el("div", { className: "ytpp-field-row" }, [
            el("label", { className: "ytpp-sublabel", text: "模型" }),
            el("div", { style: { display: "flex", gap: "8px" } }, [
              modelInput,
              fetchModelsBtn,
            ]),
            modelSelect,
            modelStatus,
          ]),
          el("div", { className: "ytpp-field-row" }, [
            el("label", { className: "ytpp-sublabel", text: "附加提示词" }),
            customPromptInput,
          ]),
        ]),

        el("div", { className: "ytpp-panel-section" }, [
          el("div", { className: "ytpp-panel-section-title", text: "性能" }),
          perfAmbientCheck.row,
          perfPreviewCheck.row,
          perfContentVisCheck.row,
          perfShortsCheck.row,
          perfEndscreenCheck.row,
        ]),

        el(
          "div",
          {
            className: "ytpp-panel-section",
            style: { borderBottom: "none", marginBottom: "4px" },
          },
          [
            el("div", { className: "ytpp-panel-section-title", text: "触屏" }),
            touchGesturesCheck.row,
            touchSingleTapCheck.row,
            touchEnlargeCheck.row,
          ],
        ),

        el(
          "div",
          {
            style: {
              display: "flex",
              justifyContent: "flex-end",
              gap: "8px",
              marginTop: "8px",
            },
          },
          [
            el("button", {
              className: "ytpp-btn",
              text: "取消",
              attrs: { type: "button" },
              on: { click: () => this.closeModal() },
            }),
            el("button", {
              className: "ytpp-btn ytpp-btn-primary",
              text: "保存",
              attrs: { type: "button" },
              on: { click: saveAndClose },
            }),
          ],
        ),
      ],
    );

    this.modalBackdrop = el(
      "div",
      {
        className: "ytpp-panel-backdrop",
        on: { click: () => this.closeModal() },
      },
      [modal],
    );

    document.body.appendChild(this.modalBackdrop);
  }

  closeModal(): void {
    if (this.modalBackdrop) {
      this.modalBackdrop.remove();
      this.modalBackdrop = null;
    }
  }
}
