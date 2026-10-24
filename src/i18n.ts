import { configStore } from "./config";
import type { SubtitleMode, UiLang } from "./types";

export function resolveUiLang(langSetting?: UiLang): "zh" | "en" {
  const pref = langSetting ?? configStore.get().uiLang ?? "auto";
  if (pref === "zh" || pref === "en") {
    return pref;
  }
  if (typeof document !== "undefined") {
    const docLang = (document.documentElement.lang || "").toLowerCase();
    if (docLang.startsWith("zh")) return "zh";
    if (docLang) return "en";
  }
  if (typeof navigator !== "undefined") {
    const navLang = (navigator.language || "").toLowerCase();
    if (navLang.startsWith("zh")) return "zh";
  }
  return "zh";
}

export function isEn(): boolean {
  return resolveUiLang() === "en";
}

export function tr(zh: string, en: string): string {
  return resolveUiLang() === "en" ? en : zh;
}

export function getModeLabel(mode: SubtitleMode, short = false): string {
  if (resolveUiLang() === "en") {
    if (short) {
      switch (mode) {
        case "bilingual":
          return "Bilingual";
        case "target":
          return "Translated";
        case "source":
          return "Original";
        case "off":
          return "Off";
      }
    }
    switch (mode) {
      case "bilingual":
        return "Bilingual Subtitles";
      case "target":
        return "Translated Only";
      case "source":
        return "Original Only";
      case "off":
        return "Subtitles Off";
    }
  }

  if (short) {
    switch (mode) {
      case "bilingual":
        return "双语";
      case "target":
        return "仅译文";
      case "source":
        return "仅原文";
      case "off":
        return "关闭";
    }
  }
  switch (mode) {
    case "bilingual":
      return "双语字幕";
    case "target":
      return "仅译文";
    case "source":
      return "仅原文";
    case "off":
      return "关闭字幕";
  }
}
