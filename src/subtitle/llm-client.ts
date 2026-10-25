import type { AppConfig, Cue, VideoMetadata } from "../types";

interface GmResponse {
  status: number;
  statusText: string;
  responseText: string;
}

interface GmRequestDetails {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  data?: string;
  timeout?: number;
  onprogress?: (res: GmResponse) => void;
  onreadystatechange?: (res: GmResponse) => void;
  onload?: (res: GmResponse) => void;
  onerror?: (err: unknown) => void;
  ontimeout?: () => void;
}

declare function GM_xmlhttpRequest(details: GmRequestDetails): { abort?: () => void };

export function normalizeBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (trimmed.endsWith("/chat/completions")) {
    return trimmed.slice(0, -"/chat/completions".length);
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.pathname === "" || parsed.pathname === "/") {
      return `${trimmed}/v1`;
    }
  } catch {
    // Keep as-is if URL constructor fails
  }
  return trimmed;
}

export function buildSystemPrompt(targetLang: string, customPrompt?: string): string {
  const base = [
    `你是一位专业视频字幕译者，负责将输入字幕翻译为自然、地道、适合屏幕阅读的${targetLang}。`,
    "翻译要求：",
    `1. 气口对齐与跨句重组：输入的每一行 \`[序号] 原文\` 代表视频时间轴上的一个语音气口槽位。输出必须严格保留全部 \`[序号]\`（格式为 \`[序号] 译文\`），绝不漏号、跳号或合并行号。当相邻 2~4 个气口属于同一句话或紧密相连的意群（如英文后置定语、状语从句、被动结构或跨行断句）时，请按符合${targetLang}母语阅读习惯的语序对这 2~4 句进行整体重构，再按自然的${targetLang}断句节奏切分并塞回对应的 \`[序号]\` 气口槽位中。切分时保持相邻槽位字数大体均衡，避免前一行塞满二十多字而后一行只剩两三个动词的头重脚轻拆法。`,
    "2. 语音识别容错：若源字幕来自自动语音识别（ASR），可能存在同音误识别、吞音、断词或专有名词听错。请结合 `<video_metadata>` 与上下文逻辑推断真实语义后再翻译，避免按明显不通的错别字硬译。",
    "3. 表达自然凝练：贴合视频主题与说话人口吻，译文简洁有力，不输出任何解释、代码块标记或额外文本。",
  ];
  if (customPrompt && customPrompt.trim()) {
    base.push(`4. 附加要求：${customPrompt.trim()}`);
  }
  return base.join("\n");
}

export function buildUserPrompt(
  cuesToTranslate: Cue[],
  contextCues: Cue[],
  metadata: VideoMetadata,
  followingCues: Cue[] = [],
): string {
  const sections: string[] = [];

  const metaLines: string[] = [];
  if (metadata.title) metaLines.push(`标题: ${metadata.title}`);
  if (metadata.author) metaLines.push(`频道: ${metadata.author}`);
  if (metadata.keywords && metadata.keywords.length > 0) {
    metaLines.push(`标签: ${metadata.keywords.slice(0, 12).join(", ")}`);
  }
  if (metadata.description) {
    const descExcerpt = metadata.description
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 600);
    if (descExcerpt) {
      metaLines.push(`简介摘录: ${descExcerpt}`);
    }
  }

  if (metaLines.length > 0) {
    sections.push(`<video_metadata>\n${metaLines.join("\n")}\n</video_metadata>`);
  }

  if (contextCues.length > 0) {
    const ctxLines = contextCues.map((c) =>
      c.targetText
        ? `[${c.index}] ${c.sourceText} => ${c.targetText}`
        : `[${c.index}] ${c.sourceText}`,
    );
    sections.push(
      `<preceding_context_do_not_translate>\n${ctxLines.join("\n")}\n</preceding_context_do_not_translate>`,
    );
  }

  const sourceLines = cuesToTranslate.map((c) => `[${c.index}] ${c.sourceText}`);
  sections.push(
    `<source_cues_to_translate>\n${sourceLines.join("\n")}\n</source_cues_to_translate>`,
  );

  if (followingCues.length > 0) {
    const nextLines = followingCues.map((c) => `[${c.index}] ${c.sourceText}`);
    sections.push(
      `<following_context_do_not_translate>\n${nextLines.join("\n")}\n</following_context_do_not_translate>`,
    );
  }

  return sections.join("\n\n");
}

const LINE_MATCH_REGEX = /^\s*\[(\d+)\]\s*(.+?)\s*$/;

/**
 * Parses numbered lines `[index] translatedText` from model output text.
 */
export function parseTranslatedLines(
  text: string,
  validIndices?: Set<number>,
): Map<number, string> {
  const result = new Map<number, string>();
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const match = LINE_MATCH_REGEX.exec(line);
    if (!match) continue;
    const idx = Number.parseInt(match[1], 10);
    const content = match[2].trim();
    if (!content) continue;
    if (validIndices && !validIndices.has(idx)) continue;
    result.set(idx, content);
  }

  return result;
}

/**
 * Extracts accumulated assistant content from an SSE stream buffer or standard JSON response.
 */
export function extractContentFromResponseText(rawText: string): {
  fullContent: string;
  isSse: boolean;
} {
  const trimmed = rawText.trimStart();
  if (trimmed.startsWith("data:")) {
    let accumulated = "";
    const lines = rawText.split(/\r?\n/);
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const payload = s.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload);
        const delta = parsed?.choices?.[0]?.delta?.content;
        if (typeof delta === "string") {
          accumulated += delta;
        } else if (typeof parsed?.choices?.[0]?.message?.content === "string") {
          accumulated += parsed.choices[0].message.content;
        }
      } catch {
        // Ignore incomplete SSE line at tail of buffer
      }
    }
    return { fullContent: accumulated, isSse: true };
  }

  try {
    const parsed = JSON.parse(rawText);
    const content = parsed?.choices?.[0]?.message?.content;
    if (typeof content === "string") {
      return { fullContent: content, isSse: false };
    }
  } catch {
    // Not complete JSON yet
  }

  return { fullContent: "", isSse: false };
}

export async function fetchAvailableModels(
  apiBaseUrl: string,
  apiKey: string,
): Promise<string[]> {
  const base = normalizeBaseUrl(apiBaseUrl);
  if (!base) {
    throw new Error("请先填写 API Base URL");
  }
  const url = `${base}/models`;
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }

  const rawText = await new Promise<string>((resolve, reject) => {
    if (typeof GM_xmlhttpRequest === "function") {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        headers,
        timeout: 15000,
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            resolve(res.responseText);
          } else {
            reject(new Error(`HTTP ${res.status}: ${res.responseText.slice(0, 200)}`));
          }
        },
        onerror: () => reject(new Error("网络请求失败，请检查地址与服务状态")),
        ontimeout: () => reject(new Error("请求超时")),
      });
    } else {
      fetch(url, { headers })
        .then(async (res) => {
          const text = await res.text();
          if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
          return text;
        })
        .then(resolve)
        .catch(reject);
    }
  });

  const parsed = JSON.parse(rawText);
  const list: unknown[] = Array.isArray(parsed?.data)
    ? parsed.data
    : Array.isArray(parsed?.models)
      ? parsed.models
      : [];

  const models: string[] = [];
  for (const item of list) {
    if (typeof item === "string") {
      models.push(item);
    } else if (item && typeof item === "object" && "id" in item && typeof item.id === "string") {
      models.push(item.id);
    }
  }
  return models;
}

export interface TranslateBatchOptions {
  config: AppConfig;
  cues: Cue[];
  contextCues: Cue[];
  followingCues?: Cue[];
  metadata: VideoMetadata;
  signal?: AbortSignal;
  onCueTranslated?: (cueIndex: number, translatedText: string) => void;
}

export async function translateCueBatch(
  options: TranslateBatchOptions,
): Promise<Map<number, string>> {
  const {
    config,
    cues,
    contextCues,
    followingCues = [],
    metadata,
    signal,
    onCueTranslated,
  } = options;
  const base = normalizeBaseUrl(config.apiBaseUrl);
  if (!base) {
    throw new Error("未配置 API Base URL");
  }
  if (!config.model.trim()) {
    throw new Error("未配置模型名称");
  }
  if (cues.length === 0) {
    return new Map();
  }

  const url = `${base}/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream, application/json",
  };
  if (config.apiKey.trim()) {
    headers.Authorization = `Bearer ${config.apiKey.trim()}`;
  }

  const validIndices = new Set(cues.map((c) => c.index));
  const emitted = new Map<number, string>();

  const emitFromContent = (content: string, includeLastLine: boolean) => {
    const lines = content.split(/\r?\n/);
    const limit = includeLastLine ? lines.length : Math.max(0, lines.length - 1);
    for (let i = 0; i < limit; i++) {
      const match = LINE_MATCH_REGEX.exec(lines[i]);
      if (!match) continue;
      const idx = Number.parseInt(match[1], 10);
      const text = match[2].trim();
      if (!text || !validIndices.has(idx)) continue;
      if (emitted.get(idx) !== text) {
        emitted.set(idx, text);
        onCueTranslated?.(idx, text);
      }
    }
  };

  const executeRequest = async (targetCues: Cue[], ctxCues: Cue[], nextCues: Cue[]) => {
    const requestBody = JSON.stringify({
      model: config.model.trim(),
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(config.targetLang, config.customPrompt),
        },
        {
          role: "user",
          content: buildUserPrompt(targetCues, ctxCues, metadata, nextCues),
        },
      ],
      temperature: 0.2,
      stream: true,
    });

    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }

      if (typeof GM_xmlhttpRequest === "function") {
        const handle = GM_xmlhttpRequest({
          method: "POST",
          url,
          headers,
          data: requestBody,
          timeout: 90000,
          onprogress: (res) => {
            if (!res.responseText) return;
            const { fullContent } = extractContentFromResponseText(res.responseText);
            if (fullContent) {
              emitFromContent(fullContent, false);
            }
          },
          onload: (res) => {
            if (res.status < 200 || res.status >= 300) {
              reject(
                new Error(`翻译请求失败 (HTTP ${res.status}): ${res.responseText.slice(0, 240)}`),
              );
              return;
            }
            const { fullContent } = extractContentFromResponseText(res.responseText);
            emitFromContent(fullContent, true);
            resolve();
          },
          onerror: () => reject(new Error("翻译网络请求出错")),
          ontimeout: () => reject(new Error("翻译请求超时")),
        });

        if (signal) {
          signal.addEventListener(
            "abort",
            () => {
              handle.abort?.();
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        }
        return;
      }

      fetch(url, {
        method: "POST",
        headers,
        body: requestBody,
        signal,
      })
        .then(async (res) => {
          const text = await res.text();
          if (!res.ok) {
            throw new Error(`翻译请求失败 (HTTP ${res.status}): ${text.slice(0, 240)}`);
          }
          const { fullContent } = extractContentFromResponseText(text);
          emitFromContent(fullContent, true);
          resolve();
        })
        .catch(reject);
    });
  };

  await executeRequest(cues, contextCues, followingCues);

  // If the LLM accidentally skipped any cue indices in the batch, do a quick repair pass
  const missingCues = cues.filter((c) => !emitted.has(c.index));
  if (missingCues.length > 0 && missingCues.length < cues.length && !signal?.aborted) {
    await executeRequest(missingCues, contextCues, followingCues);
  }

  return emitted;
}

export interface TranslatedMetadataResult {
  title: string;
  description: string;
}

export async function translateVideoMetadata(
  config: AppConfig,
  metadata: VideoMetadata,
  signal?: AbortSignal,
): Promise<TranslatedMetadataResult | null> {
  const base = normalizeBaseUrl(config.apiBaseUrl);
  if (!base || !config.model.trim() || (!metadata.title.trim() && !metadata.description.trim())) {
    return null;
  }

  const url = `${base}/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (config.apiKey.trim()) {
    headers.Authorization = `Bearer ${config.apiKey.trim()}`;
  }

  const descTrimmed = (metadata.description || "").trim().slice(0, 2600);
  const sysPrompt = [
    `你是一位资深视频编辑与本地化译者。请将输入的 YouTube 视频标题和简介翻译为自然、准确、符合母语习惯的${config.targetLang}。`,
    "请严格按以下 XML 标签格式输出，不要输出任何额外说明或代码块标记：",
    "<title>翻译后的标题</title>",
    "<description>翻译后的简介（保留原有段落结构、网址链接、时间轴锚点与核心信息）</description>",
  ].join("\n");

  const userPrompt = [
    `<channel>${metadata.author || ""}</channel>`,
    `<title>${metadata.title || ""}</title>`,
    `<description>\n${descTrimmed}\n</description>`,
  ].join("\n");

  const requestBody = JSON.stringify({
    model: config.model.trim(),
    messages: [
      { role: "system", content: sysPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.2,
    stream: false,
  });

  const rawText = await new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    if (typeof GM_xmlhttpRequest === "function") {
      const handle = GM_xmlhttpRequest({
        method: "POST",
        url,
        headers,
        data: requestBody,
        timeout: 45000,
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            resolve(res.responseText);
          } else {
            reject(new Error(`HTTP ${res.status}`));
          }
        },
        onerror: () => reject(new Error("Network error")),
        ontimeout: () => reject(new Error("Timeout")),
      });

      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            handle.abort?.();
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      }
      return;
    }

    fetch(url, { method: "POST", headers, body: requestBody, signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
      })
      .then(resolve)
      .catch(reject);
  });

  const { fullContent } = extractContentFromResponseText(rawText);
  if (!fullContent) return null;

  const extractTag = (tag: string): string => {
    const closed = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i").exec(fullContent);
    if (closed) return closed[1].trim();
    const openOnly = new RegExp(`<${tag}>([\\s\\S]*)$`, "i").exec(fullContent);
    if (openOnly) {
      return openOnly[1].replace(/<\/?[a-z_]+>[\s\S]*$/i, "").trim();
    }
    return "";
  };

  const translatedTitle = extractTag("title");
  let translatedDesc = extractTag("description");
  if (!translatedTitle && !translatedDesc && !fullContent.includes("<")) {
    translatedDesc = fullContent.trim();
  }
  if (!translatedTitle && !translatedDesc) {
    return null;
  }

  return {
    title: translatedTitle,
    description: translatedDesc,
  };
}

export async function translateCommentText(
  config: AppConfig,
  commentText: string,
  metadata?: VideoMetadata | null,
  signal?: AbortSignal,
): Promise<string> {
  const base = normalizeBaseUrl(config.apiBaseUrl);
  if (!base) {
    throw new Error("请先在 YT+ 中配置 API Base URL");
  }
  if (!config.model.trim()) {
    throw new Error("请先在 YT+ 中选择翻译模型");
  }
  const trimmed = commentText.trim();
  if (!trimmed) return "";

  const url = `${base}/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (config.apiKey.trim()) {
    headers.Authorization = `Bearer ${config.apiKey.trim()}`;
  }

  const sysPrompt = [
    `你是一位熟悉互联网与 YouTube 社区文化的资深译者。请将输入的网友评论翻译为自然、传神、符合母语口语习惯的${config.targetLang}。`,
    "保留原有的分段、时间轴锚点、Emoji 与玩梗语气，直接输出翻译后的正文，不要输出任何额外说明或包裹标签。",
  ].join("\n");

  const userParts: string[] = [];
  if (metadata?.title) {
    userParts.push(`<video_title>${metadata.title}</video_title>`);
  }
  userParts.push(trimmed.slice(0, 3000));

  const requestBody = JSON.stringify({
    model: config.model.trim(),
    messages: [
      { role: "system", content: sysPrompt },
      { role: "user", content: userParts.join("\n\n") },
    ],
    temperature: 0.25,
    stream: false,
  });

  const rawText = await new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    if (typeof GM_xmlhttpRequest === "function") {
      const handle = GM_xmlhttpRequest({
        method: "POST",
        url,
        headers,
        data: requestBody,
        timeout: 35000,
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            resolve(res.responseText);
          } else {
            reject(new Error(`HTTP ${res.status}`));
          }
        },
        onerror: () => reject(new Error("网络请求出错")),
        ontimeout: () => reject(new Error("请求超时")),
      });

      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            handle.abort?.();
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      }
      return;
    }

    fetch(url, { method: "POST", headers, body: requestBody, signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
      })
      .then(resolve)
      .catch(reject);
  });

  const { fullContent } = extractContentFromResponseText(rawText);
  return fullContent.trim();
}
