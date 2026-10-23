# YT Premium Plus

针对桌面端与 Windows 平板双模环境设计的 YouTube 优化油猴脚本（Userscript），集成字幕组式分批精翻、界面性能减负与触控手势交互。

## 核心设计

### 1. 字幕组式时间轴重组与两级分批翻译 (`src/subtitle/`)
- **词级时间轴重组 (`cue-builder.ts`)**：拉取 `fmt=json3` 字幕轨道，针对 YouTube ASR 自动生成字幕的滚屏碎词（`tStartMs + tOffsetMs`），优先依据句末标点、从句边界与长静音间隔合并为完整的自然句时间轴 `Cue[]`。
- **起播与 Seek 10 句极速预翻 (`manager.ts`)**：
  - 视频加载或拖动进度条（Seek）到未翻译位置时，优先切出当前游标起的 `10` 句（可在设置中调整 `fastBatchSize`）。
  - 默认挂起播放直至这 10 句流式翻译完成再自动开播，实现从第一帧起的完整双语字幕。
- **后台 50 句批量精翻**：
  - 前 10 句就绪开播后，后台按每批 `50` 句（`batchSize`）顺次推进，并在每次请求中注入视频元信息（标题、频道名、简介摘录、标签）及前 4 句双语上下文，确保术语与指代前后一致。
  - 译文按 `videoId + trackId + targetLang + model` 缓存在 IndexedDB 中。
- **OpenAI 兼容接口 (`llm-client.ts`)**：
  - 默认不内置任何特定地址或模型名称；在播放器右下角点击 `YT+` 即可填写任意 OpenAI 兼容的 `API Base URL`、`API Key` 并一键拉取 `/models` 列表。

### 2. 界面性能优化 (`src/perf/optimizer.ts`)
- 禁用并清理 `#cinematics` 环境泛光 Canvas，消除后台高频高斯模糊采样导致的核显占用与平板发热。
- 禁用首页与推荐流悬停/滑动视频预览（`ytd-video-preview`、`ytd-moving-thumbnail-renderer`）。
- 对 `ytd-rich-item-renderer`、`yt-lockup-view-model`、`ytd-comment-thread-renderer` 等长列表容器开启 `content-visibility: auto` 渲染隔离。
- 支持可选隐藏 Shorts 栏与片尾遮挡卡片。

### 3. 桌面键鼠 + Windows 平板触屏双模适配 (`src/touch/gestures.ts`)
- 基于 `PointerEvent.pointerType` 严格区分输入源：鼠标操作完全保留原生逻辑，仅在 `touch` / `pen` 触控时接管手势：
  - **单击画面**：切换控制栏与中央大播放键显隐（避免触屏误触暂停）。
  - **左右双击**：快退 / 快进 10 秒；中央双击切换播放/暂停。
  - **长按画面**：临时 `2.0x` 倍速播放，松手恢复原速。
  - **水平滑动**：全屏或播放器内滑动直接预览目标时间点与对应台词并跳转进度。
  - **垂直滑动**：左半屏上下滑调节视频亮度，右半屏上下滑调节音量。
  - **双指捏合**：在原始比例与裁切铺满（`object-fit: cover`）之间切换。
- 针对粗指针设备自动加高 `.ytp-progress-bar-padding` 拖拽热区，并在新版 `yt-lockup-view-model` 卡片上常驻显示更多操作按钮。

## 构建与测试

```bash
bun test
bun run build
```

构建产物位于 `dist/ytpremiumplus.user.js`，可直接导入 Tampermonkey 或 Violentmonkey 使用。
