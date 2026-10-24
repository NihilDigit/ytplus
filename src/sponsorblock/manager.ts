import { configStore } from "../config";
import { isEn, tr } from "../i18n";
import { clearChildren, el, formatTimeMs, upsertStyle } from "../utils/dom";

const SB_STYLE_ID = "ytpp-sponsorblock-style";

export type SponsorCategory =
  | "sponsor"
  | "selfpromo"
  | "interaction"
  | "intro"
  | "outro"
  | "preview"
  | "music_offtopic"
  | "filler";

export interface SponsorSegment {
  UUID: string;
  category: SponsorCategory;
  segment: [number, number];
  actionType?: string;
}

export const SPONSOR_CATEGORY_META: Record<
  SponsorCategory,
  { label: string; labelEn: string; color: string }
> = {
  sponsor: { label: "赞助广告", labelEn: "Sponsor", color: "#00d400" },
  selfpromo: { label: "自我推广", labelEn: "Unpaid / Self Promotion", color: "#ffff00" },
  interaction: { label: "互动提醒 (三连/订阅)", labelEn: "Interaction Reminder", color: "#cc00ff" },
  intro: { label: "片头动画", labelEn: "Intermission / Intro", color: "#00ffff" },
  outro: { label: "片尾鸣谢", labelEn: "Endcards / Credits", color: "#0202ed" },
  preview: { label: "回顾与预告", labelEn: "Preview / Recap", color: "#008fd6" },
  music_offtopic: { label: "非音乐片段", labelEn: "Non-Music Section", color: "#ff9900" },
  filler: { label: "水时长片段", labelEn: "Filler Tangent", color: "#7300ff" },
};

export function getSponsorCategoryLabel(cat: SponsorCategory): string {
  const meta = SPONSOR_CATEGORY_META[cat];
  if (!meta) return cat;
  return isEn() ? meta.labelEn : meta.label;
}

export const ALL_SPONSOR_CATEGORIES: SponsorCategory[] = [
  "sponsor",
  "selfpromo",
  "interaction",
  "intro",
  "outro",
  "preview",
  "music_offtopic",
  "filler",
];

interface GmResponse {
  status: number;
  statusText: string;
  responseText: string;
}

interface GmRequestDetails {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  timeout?: number;
  onload?: (res: GmResponse) => void;
  onerror?: (err: unknown) => void;
  ontimeout?: () => void;
}

declare function GM_xmlhttpRequest(details: GmRequestDetails): { abort?: () => void };

export async function fetchSponsorSegments(
  videoId: string,
  categories: string[] = ALL_SPONSOR_CATEGORIES,
): Promise<SponsorSegment[]> {
  if (!videoId || categories.length === 0) return [];
  const url = `https://sponsor.ajay.app/api/skipSegments?videoID=${encodeURIComponent(
    videoId,
  )}&categories=${encodeURIComponent(JSON.stringify(categories))}`;

  const rawText = await new Promise<string | null>((resolve) => {
    const headers = { Accept: "application/json" };
    if (typeof GM_xmlhttpRequest === "function") {
      try {
        GM_xmlhttpRequest({
          method: "GET",
          url,
          headers,
          timeout: 6000,
          onload: (res) => {
            if (res.status >= 200 && res.status < 300 && res.responseText) {
              resolve(res.responseText);
            } else {
              resolve(null);
            }
          },
          onerror: () => resolve(null),
          ontimeout: () => resolve(null),
        });
        return;
      } catch {
        // Fallback to fetch
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    fetch(url, { headers, signal: controller.signal })
      .then(async (res) => {
        clearTimeout(timer);
        if (!res.ok) return null;
        return await res.text();
      })
      .then(resolve)
      .catch(() => {
        clearTimeout(timer);
        resolve(null);
      });
  });

  if (!rawText) return [];

  try {
    const parsed = JSON.parse(rawText);
    if (!Array.isArray(parsed)) return [];
    const out: SponsorSegment[] = [];
    for (const item of parsed) {
      if (
        item &&
        Array.isArray(item.segment) &&
        item.segment.length === 2 &&
        typeof item.segment[0] === "number" &&
        typeof item.segment[1] === "number" &&
        item.segment[1] > item.segment[0] &&
        typeof item.category === "string"
      ) {
        out.push({
          UUID: String(item.UUID || `${item.category}_${item.segment[0]}`),
          category: item.category as SponsorCategory,
          segment: [item.segment[0], item.segment[1]],
          actionType: item.actionType,
        });
      }
    }
    return out.sort((a, b) => a.segment[0] - b.segment[0]);
  } catch {
    return [];
  }
}

export class SponsorBlockManager {
  private currentVideoId: string | null = null;
  private segments: SponsorSegment[] = [];
  private segmentCache = new Map<string, SponsorSegment[]>();
  private unskippedUuids = new Set<string>();
  private lastSkippedUuid: string | null = null;
  private lastSkipFromSec = 0;
  private lastSkipTimeMs = 0;

  private playerEl: HTMLElement | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private markerBarEl: HTMLElement | null = null;
  private toastEl: HTMLElement | null = null;
  private toastLabelEl: HTMLElement | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.injectStyles();
    configStore.subscribe(() => {
      this.renderMarkers();
    });
  }

  private injectStyles(): void {
    upsertStyle(
      SB_STYLE_ID,
      `
      .ytpp-sb-markers {
        position: absolute;
        left: 0;
        right: 0;
        top: 0;
        bottom: 0;
        pointer-events: none;
        z-index: 35;
        overflow: hidden;
      }

      .ytpp-sb-marker {
        position: absolute;
        top: 0;
        bottom: 0;
        min-width: 2px;
        opacity: 0.82;
        pointer-events: none;
      }

      .ytpp-sb-toast {
        position: absolute;
        right: 16px;
        bottom: 76px;
        z-index: 85;
        display: none;
        align-items: center;
        gap: 10px;
        padding: 6px 12px;
        border-radius: 8px;
        background: rgba(24, 24, 24, 0.9);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid rgba(255, 255, 255, 0.12);
        color: #f1f1f1;
        font-family: "YouTube Noto", Roboto, Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
        font-size: 12.5px;
        line-height: 1.3;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
        user-select: none;
      }

      #movie_player.ytp-big-mode .ytpp-sb-toast,
      #movie_player.ytp-fullscreen .ytpp-sb-toast {
        bottom: 96px;
        right: 24px;
      }

      .ytpp-sb-toast.ytpp-visible {
        display: inline-flex;
      }

      .ytpp-sb-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .ytpp-sb-undo-btn {
        border: none;
        border-radius: 5px;
        background: rgba(255, 255, 255, 0.14);
        color: #ffffff;
        font-size: 11.5px;
        font-weight: 500;
        font-family: inherit;
        padding: 3px 8px;
        cursor: pointer;
        transition: background 0.12s ease;
      }

      .ytpp-sb-undo-btn:hover {
        background: rgba(255, 255, 255, 0.25);
      }
      `,
    );
  }

  async attachToVideo(videoId: string, player: HTMLElement): Promise<void> {
    this.playerEl = player;
    const video = player.querySelector<HTMLVideoElement>(
      "video.html5-main-video, video",
    );
    if (!video) return;

    this.bindVideo(video);
    this.mountToast(player);

    if (this.currentVideoId === videoId && this.segments.length > 0) {
      this.renderMarkers();
      return;
    }

    this.currentVideoId = videoId;
    this.segments = [];
    this.unskippedUuids.clear();
    this.lastSkippedUuid = null;
    this.renderMarkers();

    let fetched = this.segmentCache.get(videoId);
    if (!fetched) {
      fetched = await fetchSponsorSegments(videoId, ALL_SPONSOR_CATEGORIES);
      if (fetched.length > 0) {
        this.segmentCache.set(videoId, fetched);
      }
    }

    if (this.currentVideoId !== videoId) return;
    this.segments = fetched;
    this.renderMarkers();
    this.checkSkipAtTime(video.currentTime);
  }

  private bindVideo(video: HTMLVideoElement): void {
    if (this.videoEl === video) return;
    if (this.videoEl) {
      this.videoEl.removeEventListener("timeupdate", this.onTimeUpdate);
      this.videoEl.removeEventListener("loadedmetadata", this.onLoadedMetadata);
      this.videoEl.removeEventListener("durationchange", this.onLoadedMetadata);
    }
    this.videoEl = video;
    video.addEventListener("timeupdate", this.onTimeUpdate);
    video.addEventListener("loadedmetadata", this.onLoadedMetadata);
    video.addEventListener("durationchange", this.onLoadedMetadata);
  }

  private mountToast(player: HTMLElement): void {
    if (this.toastEl && player.contains(this.toastEl)) return;

    const dotEl = el("span", { className: "ytpp-sb-dot" });
    this.toastLabelEl = el("span");
    const undoBtn = el("button", {
      className: "ytpp-sb-undo-btn",
      text: tr("撤回", "Undo"),
      attrs: { type: "button" },
      on: {
        click: (e) => {
          e.stopPropagation();
          this.undoLastSkip();
        },
      },
    });

    this.toastEl = el("div", { className: "ytpp-sb-toast" }, [
      dotEl,
      this.toastLabelEl,
      undoBtn,
    ]);
    player.appendChild(this.toastEl);
  }

  private onLoadedMetadata = (): void => {
    this.renderMarkers();
  };

  private onTimeUpdate = (): void => {
    if (!this.videoEl) return;
    this.checkSkipAtTime(this.videoEl.currentTime);
  };

  private checkSkipAtTime(currentTimeSec: number): void {
    const cfg = configStore.get();
    if (!cfg.sbEnabled || !this.videoEl || this.segments.length === 0) return;

    const enabledSet = new Set(cfg.sbCategories || []);
    if (enabledSet.size === 0) return;

    for (const seg of this.segments) {
      if (!enabledSet.has(seg.category)) continue;
      if (this.unskippedUuids.has(seg.UUID)) continue;
      if (seg.actionType && seg.actionType !== "skip" && seg.actionType !== "mute") {
        continue;
      }

      const [startSec, endSec] = seg.segment;
      // Trigger skip when cursor enters [startSec, endSec - 0.35]
      if (currentTimeSec >= startSec && currentTimeSec < endSec - 0.35) {
        const now = performance.now();
        if (this.lastSkippedUuid === seg.UUID && now - this.lastSkipTimeMs < 1500) {
          continue;
        }
        this.lastSkippedUuid = seg.UUID;
        this.lastSkipFromSec = currentTimeSec;
        this.lastSkipTimeMs = now;

        const dur = Number.isFinite(this.videoEl.duration)
          ? this.videoEl.duration
          : endSec + 1;
        this.videoEl.currentTime = Math.min(dur - 0.1, endSec);

        const meta = SPONSOR_CATEGORY_META[seg.category] || {
          label: seg.category,
          labelEn: seg.category,
          color: "#00d400",
        };
        const catLabel = getSponsorCategoryLabel(seg.category);
        const skippedSec = Math.max(1, Math.round(endSec - startSec));
        this.showSkipToast(
          `${tr("已跳过", "Skipped")} ${catLabel} (${skippedSec}s)`,
          meta.color,
        );
        break;
      }
    }
  }

  private showSkipToast(text: string, color: string): void {
    if (!this.toastEl || !this.toastLabelEl) return;
    const dot = this.toastEl.querySelector<HTMLElement>(".ytpp-sb-dot");
    if (dot) {
      dot.style.backgroundColor = color;
    }
    const undoBtn = this.toastEl.querySelector<HTMLElement>(".ytpp-sb-undo-btn");
    if (undoBtn) {
      undoBtn.textContent = tr("撤回", "Undo");
    }
    this.toastLabelEl.textContent = text;
    this.toastEl.classList.add("ytpp-visible");

    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
    }
    this.toastTimer = setTimeout(() => {
      this.toastEl?.classList.remove("ytpp-visible");
    }, 3800);
  }

  private undoLastSkip(): void {
    if (!this.lastSkippedUuid || !this.videoEl) return;
    this.unskippedUuids.add(this.lastSkippedUuid);
    this.videoEl.currentTime = Math.max(0, this.lastSkipFromSec);
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
    this.toastEl?.classList.remove("ytpp-visible");
  }

  private renderMarkers(): void {
    if (!this.playerEl) return;
    const progressBar = this.playerEl.querySelector<HTMLElement>(
      ".ytp-progress-list, .ytp-progress-bar",
    );
    if (!progressBar) return;

    if (!this.markerBarEl || !progressBar.contains(this.markerBarEl)) {
      this.markerBarEl = el("div", { className: "ytpp-sb-markers" });
      progressBar.appendChild(this.markerBarEl);
    }

    clearChildren(this.markerBarEl);

    const cfg = configStore.get();
    if (!cfg.sbEnabled || this.segments.length === 0 || !this.videoEl) {
      return;
    }

    const duration = this.videoEl.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      return;
    }

    const enabledSet = new Set(cfg.sbCategories || []);
    for (const seg of this.segments) {
      if (!enabledSet.has(seg.category)) continue;
      const [startSec, endSec] = seg.segment;
      if (startSec >= duration) continue;

      const leftPct = Math.max(0, Math.min(100, (startSec / duration) * 100));
      const widthPct = Math.max(
        0.25,
        Math.min(100 - leftPct, ((endSec - startSec) / duration) * 100),
      );
      const meta = SPONSOR_CATEGORY_META[seg.category] || {
        label: seg.category,
        color: "#00d400",
      };

      const marker = el("div", {
        className: "ytpp-sb-marker",
        style: {
          left: `${leftPct.toFixed(3)}%`,
          width: `${widthPct.toFixed(3)}%`,
          backgroundColor: meta.color,
        },
        attrs: {
          title: `${getSponsorCategoryLabel(seg.category)} (${formatTimeMs(startSec * 1000)} - ${formatTimeMs(endSec * 1000)})`,
        },
      });
      this.markerBarEl.appendChild(marker);
    }
  }

  reset(): void {
    this.currentVideoId = null;
    this.segments = [];
    this.unskippedUuids.clear();
    this.lastSkippedUuid = null;
    if (this.markerBarEl) {
      clearChildren(this.markerBarEl);
    }
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
    this.toastEl?.classList.remove("ytpp-visible");
  }
}
