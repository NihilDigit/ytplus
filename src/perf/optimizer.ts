import { configStore } from "../config";
import { removeStyle, upsertStyle } from "../utils/dom";

const PERF_STYLE_ID = "ytpp-perf-optimizer-style";

export class PerformanceOptimizer {
  private observer: MutationObserver | null = null;

  init(): void {
    this.apply();
    configStore.subscribe(() => this.apply());
    this.startDomCleaner();
  }

  apply(): void {
    const cfg = configStore.get();
    const rules: string[] = [];

    if (cfg.perfDisableAmbient) {
      rules.push(`
        /* Kill YouTube Ambient Mode (Cinematics GPU blur canvas) */
        #cinematics,
        #cinematics-container,
        .ytp-cinematics-container,
        ytd-watch-flexy #cinematics {
          display: none !important;
          visibility: hidden !important;
          opacity: 0 !important;
          pointer-events: none !important;
        }
      `);
      this.purgeCinematicsCanvas();
    }

    if (cfg.perfDisableInlinePreview) {
      rules.push(`
        /* Disable inline video hover/scroll preview player */
        ytd-video-preview,
        #video-preview-container,
        ytd-moving-thumbnail-renderer {
          display: none !important;
          pointer-events: none !important;
        }
      `);
      this.stopInlinePreviewVideo();
    }

    if (cfg.perfContentVisibility) {
      rules.push(`
        /* Polymer long-list offscreen rendering isolation */
        ytd-rich-item-renderer {
          content-visibility: auto;
          contain-intrinsic-size: auto 320px;
        }
        ytd-compact-video-renderer,
        yt-lockup-view-model,
        ytd-playlist-panel-video-renderer {
          content-visibility: auto;
          contain-intrinsic-size: auto 104px;
        }
        ytd-comment-thread-renderer {
          content-visibility: auto;
          contain-intrinsic-size: auto 130px;
        }
        ytd-video-renderer {
          content-visibility: auto;
          contain-intrinsic-size: auto 210px;
        }
      `);
    }

    if (cfg.perfHideShorts) {
      rules.push(`
        ytd-rich-shelf-renderer[is-shorts],
        ytd-reel-shelf-renderer,
        ytd-mini-guide-entry-renderer[aria-label="Shorts"],
        ytd-guide-entry-renderer a[title="Shorts"] {
          display: none !important;
        }
      `);
    }

    if (cfg.perfHideEndscreen) {
      rules.push(`
        .ytp-ce-element,
        .ytp-cards-teaser {
          display: none !important;
        }
      `);
    }

    if (rules.length > 0) {
      upsertStyle(PERF_STYLE_ID, rules.join("\n"));
    } else {
      removeStyle(PERF_STYLE_ID);
    }
  }

  private purgeCinematicsCanvas(): void {
    const cinematics = document.getElementById("cinematics");
    if (!cinematics) return;
    const canvases = cinematics.querySelectorAll("canvas");
    for (const c of Array.from(canvases)) {
      c.width = 0;
      c.height = 0;
      c.remove();
    }
  }

  private stopInlinePreviewVideo(): void {
    const previewVideos = document.querySelectorAll<HTMLVideoElement>(
      "ytd-video-preview video, #video-preview-container video",
    );
    for (const v of Array.from(previewVideos)) {
      if (!v.paused) {
        v.pause();
      }
      v.removeAttribute("src");
    }
  }

  private startDomCleaner(): void {
    if (this.observer) return;
    const attach = () => {
      if (!document.body) {
        requestAnimationFrame(attach);
        return;
      }
      this.observer = new MutationObserver(() => {
        const cfg = configStore.get();
        if (cfg.perfDisableAmbient) {
          this.purgeCinematicsCanvas();
        }
        if (cfg.perfDisableInlinePreview) {
          this.stopInlinePreviewVideo();
        }
      });
      this.observer.observe(document.body, {
        childList: true,
        subtree: true,
      });
    };
    attach();
  }
}
