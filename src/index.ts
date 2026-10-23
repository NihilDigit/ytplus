import { PerformanceOptimizer } from "./perf/optimizer";
import { getCurrentVideoId, installTimedTextInterceptor } from "./subtitle/extractor";
import { SubtitleManager } from "./subtitle/manager";
import { TouchGestureController } from "./touch/gestures";
import { SettingsPanelUI } from "./ui/panel";

function bootstrap(): void {
  if ((window as unknown as { __YTPP_INITIALIZED__?: boolean }).__YTPP_INITIALIZED__) {
    return;
  }
  (window as unknown as { __YTPP_INITIALIZED__?: boolean }).__YTPP_INITIALIZED__ = true;

  // 1. Install network observer early to capture signed /api/timedtext URLs
  installTimedTextInterceptor();

  // 2. Initialize performance optimizer, subtitle pipeline, touch gestures, and UI
  const perfOptimizer = new PerformanceOptimizer();
  const subtitleManager = new SubtitleManager();
  const touchController = new TouchGestureController(subtitleManager);
  const settingsUI = new SettingsPanelUI(subtitleManager);

  const onReady = () => {
    perfOptimizer.init();
    touchController.init();
    syncWatchPage();
  };

  let syncTimer: ReturnType<typeof setTimeout> | null = null;
  const syncWatchPage = () => {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      const videoId = getCurrentVideoId();
      if (!videoId) {
        subtitleManager.reset();
        return;
      }

      const player = document.getElementById("movie_player");
      if (!player) {
        // Player still mounting in Polymer SPA; retry shortly
        setTimeout(syncWatchPage, 300);
        return;
      }

      touchController.attachToPlayer(player);
      settingsUI.mountPlayerButtons(player);
      void subtitleManager.attachToVideo(videoId);
    }, 100);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", onReady, { once: true });
  } else {
    onReady();
  }

  // Handle YouTube Polymer SPA navigation & player updates
  window.addEventListener("yt-navigate-finish", syncWatchPage);
  window.addEventListener("yt-page-data-updated", syncWatchPage);
  window.addEventListener("popstate", syncWatchPage);
}

bootstrap();
