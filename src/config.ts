import type { AppConfig } from "./types";

const STORAGE_KEY = "ytpp_config_v1";

export const DEFAULT_CONFIG: AppConfig = {
  apiBaseUrl: "",
  apiKey: "",
  model: "",
  targetLang: "简体中文",
  customPrompt: "",
  subtitleMode: "bilingual",
  fastBatchSize: 10,
  batchSize: 50,
  holdPlaybackForFastBatch: true,
  prefetchBatches: 0, // 0 means continue translating all subsequent 50-cue batches
  fontSizeScale: 1.0,
  subtitleBottomPercent: 6,
  subtitleBackdrop: true,

  perfDisableAmbient: true,
  perfDisableInlinePreview: true,
  perfContentVisibility: true,
  perfHideShorts: false,
  perfHideEndscreen: false,

  touchGesturesEnabled: true,
  touchEnlargeControls: true,
  touchSingleTapToggleControls: true,
  touchDoubleTapSeekSec: 10,
};

type ConfigListener = (config: AppConfig) => void;

declare function GM_getValue<T>(key: string, defaultValue: T): T;
declare function GM_setValue<T>(key: string, value: T): void;

class ConfigManager {
  private current: AppConfig;
  private listeners = new Set<ConfigListener>();

  constructor() {
    this.current = this.load();
  }

  private load(): AppConfig {
    try {
      let raw: string | Partial<AppConfig> | null = null;
      if (typeof GM_getValue === "function") {
        raw = GM_getValue<string | Partial<AppConfig> | null>(STORAGE_KEY, null);
      } else if (typeof localStorage !== "undefined") {
        raw = localStorage.getItem(STORAGE_KEY);
      }

      if (!raw) {
        return { ...DEFAULT_CONFIG };
      }

      const parsed: Partial<AppConfig> =
        typeof raw === "string" ? (JSON.parse(raw) as Partial<AppConfig>) : raw;

      return {
        ...DEFAULT_CONFIG,
        ...parsed,
      };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  get(): AppConfig {
    return this.current;
  }

  update(patch: Partial<AppConfig>): AppConfig {
    this.current = {
      ...this.current,
      ...patch,
    };
    this.save();
    for (const listener of this.listeners) {
      try {
        listener(this.current);
      } catch (err) {
        console.error("[YT+] Config listener error:", err);
      }
    }
    return this.current;
  }

  subscribe(listener: ConfigListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private save(): void {
    try {
      const serialized = JSON.stringify(this.current);
      if (typeof GM_setValue === "function") {
        GM_setValue(STORAGE_KEY, serialized);
      } else if (typeof localStorage !== "undefined") {
        localStorage.setItem(STORAGE_KEY, serialized);
      }
    } catch (err) {
      console.error("[YT+] Failed to save config:", err);
    }
  }
}

export const configStore = new ConfigManager();
