# YT+

针对桌面端、Windows 平板与 Android（LSPosed API 101）设计的 YouTube 增强工具，集成三级字幕源瀑布流、字幕组式分批 LLM 精翻、SponsorBlock 片段自动跳过、界面渲染减负与触控手势交互。

## 核心设计

### 1. 三级字幕源瀑布流与字幕组式分批翻译 (`src/subtitle/`)
- **三级字幕源优先级 (`manager.ts` / `lyrics.ts` / `cue-builder.ts`)**：
  1. **频道主提供人工字幕 (`track.kind !== "asr"`)**：优先选用人工字幕轨；自动区分「分句精校轨」（如 Kurzgesagt，保留原生动画时间轴并修复句尾悬挂虚词）与「定宽文稿折行轨」（如 Chubbyemu `.en`，按音节与标点停顿权重映射为词级时间轴后重新分句）。
  2. **外部歌词库检索与发音对齐 (`lyrics.ts` + `alignLyricsToAsrEvents`)**：当仅有 ASR 自动字幕且识别为无标点说唱/音乐视频（如 ERB）时，通过 `GM_xmlhttpRequest` 自动检索 Genius / LRCLIB 歌词，利用词级发音骨架动态规划（Phonetic Needleman-Wunsch DP）与锚点插值将精准歌词嫁接到 ASR 毫秒级时间戳上（通过锚点覆盖率门禁保障安全回退）。
  3. **ASR 两阶段断句 + LLM 语境纠错 (`cue-builder.ts` + `llm-client.ts`)**：先清洗 `[music]` 与 `>>` 标记并按句末标点与长静音切出完整自然句；对超长复合句采用**句内平衡动态规划（Balanced Intra-Sentence DP）**在从句连词、逗号与短语边界处均分气口，消除句尾 1~2 词孤儿碎片。
- **阅读时长保底与呼吸间隙桥接 (`normalizeCueTimings`)**：结合字符阅读速率与原生事件上界保障最短驻留时长，并对 `<= 1100ms` 的句间呼吸停顿做平滑桥接，消除字幕频繁闪烁。
- **跨气口中文重组与句末对齐 (`manager.ts` / `llm-client.ts`)**：
  - 预翻批次（默认 `10` 句）与后台批次（默认 `50` 句）自动顺延 1~4 个气口以对齐完整句号边界。
  - 支持将相邻 2~4 个气口的长句按中文母语语序整体重构后，按中文断句节奏均衡切分回填至对应 `[序号]` 槽位。
  - 译文按 `videoId + trackId + timelineFingerprint + targetLang + model` 缓存在 IndexedDB 中。
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

- **视频标题与简介本地化 (`metadata-translator.ts`)**：
  - 自动并行翻译当前视频的标题与简介（自适应浅色/深色主题字色，简介折叠态保持 2 行紧凑预览，展开后显示完整译文）。
- **SponsorBlock 自动跳过 (`src/sponsorblock/manager.ts`)**：
  - 支持 8 类片段（赞助广告、自我推广、互动提醒、片头、片尾、预告、非音乐片段、水时长片段）的进度条色标渲染与自动跳过，并提供右下角即时「撤回」浮层。
- **中英文双语界面 (`src/i18n.ts`)**：
  - 自动识别页面/浏览器语言，并支持在 `YT+` 控制中心顶栏一键切换 `中文 / EN`。

### 4. Android LSPosed (API 101) 原生模块 (`android/`)
- **包名与架构 (`dev.nihildigit.ytplus`)**：
  - 基于 `io.github.libxposed:api:101.0.1` + `io.github.libxposed:service:101.0.0` 与 `org.luckypray:dexkit:2.3.0`，全量通过 **16KB 页大小对齐 (`zipalign -c -P 16 -v 4`)**，支持 Android 15–17 (SDK 37)。
  - 复用桌面端同构的三级字幕源瀑布流、句内平衡 DP 断句与分批流式翻译调度器 (`core/`)。
  - 通过系统级 `android.media.session.MediaSession` 与 Cronet / Innertube 自动字幕轨拉取实现免混淆的毫秒级进度同步、起播预翻译等待控制与无感字幕加载（即使 YouTube 原生 CC 关闭亦可自动拉取字幕）。
  - 宿主设置页采用 Jetpack Compose **Material 3 Expressive** 设计，并在 YouTube 播放器右上角原生按钮栏 (`player_additional_view_container`) 内嵌 `YT+` 快捷设置入口。

## 构建与测试

### Web Userscript
```bash
bun test
bun run build
```
构建产物位于 `dist/ytplus.user.js`，可直接导入 Tampermonkey 或 Violentmonkey 使用。

### Android LSPosed 模块
```bash
cd android
./gradlew :app:testDebugUnitTest :app:assembleDebug
```
产物位于 `android/app/build/outputs/apk/debug/app-debug.apk`。
