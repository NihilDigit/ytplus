package dev.nihildigit.ytplus.core

import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.URI
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

data class TranslationConfig(val apiBaseUrl: String, val apiKey: String = "", val model: String, val targetLang: String = "简体中文", val customPrompt: String = "")
data class ResponseContent(val fullContent: String, val isSse: Boolean)

/** Consumes responses on OkHttp's dispatcher; coroutine cancellation closes the socket. */
internal suspend fun Call.awaitText(onLine: ((String) -> Unit)? = null): String = suspendCancellableCoroutine { continuation ->
    continuation.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) { if (continuation.isActive) continuation.resumeWithException(e) }
        override fun onResponse(call: Call, response: Response) {
            try {
                val result = response.use { r ->
                    if (!r.isSuccessful) throw IOException("HTTP ${r.code}")
                    val source = r.body?.source() ?: throw IOException("响应内容为空")
                    val out = StringBuilder()
                    while (!source.exhausted()) {
                        if (!continuation.isActive) throw IOException("请求已取消")
                        val line = source.readUtf8Line() ?: break
                        out.append(line).append('\n'); onLine?.invoke(line)
                    }
                    out.toString()
                }
                if (continuation.isActive) continuation.resume(result)
            } catch (e: Exception) { if (continuation.isActive) continuation.resumeWithException(e) }
        }
    })
}

class LlmClient(private val client: OkHttpClient = OkHttpClient()) {
    suspend fun fetchAvailableModels(apiBaseUrl: String, apiKey: String = ""): List<String> {
        val base = normalizeBaseUrl(apiBaseUrl); require(base.isNotEmpty()) { "请先填写 API Base URL" }
        val builder = Request.Builder().url("$base/models").header("Accept", "application/json")
        if (apiKey.isNotBlank()) builder.header("Authorization", "Bearer ${apiKey.trim()}")
        val call = client.newCall(builder.build()); call.timeout().timeout(15, TimeUnit.SECONDS)
        val parsed = JSONObject(call.awaitText()); val list = parsed.optJSONArray("data") ?: parsed.optJSONArray("models") ?: JSONArray()
        return (0 until list.length()).mapNotNull { i -> when (val value = list.opt(i)) { is String -> value; is JSONObject -> value.optString("id").takeIf { it.isNotEmpty() }; else -> null } }
    }
    /** onCueTranslated executes on the network dispatcher, never on the UI thread. */
    suspend fun translateCueBatch(config: TranslationConfig, cues: List<Cue>, contextCues: List<Cue> = emptyList(), metadata: VideoMetadata = VideoMetadata(), followingCues: List<Cue> = emptyList(), onCueTranslated: (Int, String) -> Unit = { _, _ -> }): Map<Int, String> {
        val base = normalizeBaseUrl(config.apiBaseUrl); require(base.isNotEmpty()) { "未配置 API Base URL" }; require(config.model.isNotBlank()) { "未配置模型名称" }
        if (cues.isEmpty()) return emptyMap()
        val emitted = linkedMapOf<Int, String>()
        suspend fun execute(target: List<Cue>) {
            val valid = target.map { it.index }.toSet()
            val decoder = TranslationStreamDecoder(valid) { index, text -> if (emitted[index] != text) { emitted[index] = text; onCueTranslated(index, text) } }
            val messages = JSONArray().put(JSONObject().put("role", "system").put("content", buildSystemPrompt(config.targetLang, config.customPrompt))).put(JSONObject().put("role", "user").put("content", buildUserPrompt(target, contextCues, metadata, followingCues)))
            val body = JSONObject().put("model", config.model.trim()).put("messages", messages).put("temperature", .2).put("stream", true).toString()
            val builder = Request.Builder().url("$base/chat/completions").header("Accept", "text/event-stream, application/json").post(body.toRequestBody("application/json".toMediaType()))
            if (config.apiKey.isNotBlank()) builder.header("Authorization", "Bearer ${config.apiKey.trim()}")
            val call = client.newCall(builder.build()); call.timeout().timeout(90, TimeUnit.SECONDS)
            val raw = call.awaitText(decoder::acceptLine)
            decoder.finish(raw)
        }
        execute(cues)
        val missing = cues.filter { it.index !in emitted }
        if (missing.isNotEmpty() && missing.size < cues.size) execute(missing)
        return emitted.toMap()
    }
    companion object {
        fun normalizeBaseUrl(rawUrl: String): String {
            val trimmed = rawUrl.trim().trimEnd('/')
            if (trimmed.endsWith("/chat/completions")) return trimmed.removeSuffix("/chat/completions")
            return try { val uri = URI(trimmed); if (uri.host != null && (uri.path.isNullOrEmpty() || uri.path == "/")) "$trimmed/v1" else trimmed } catch (_: Exception) { trimmed }
        }
        fun buildSystemPrompt(targetLang: String, customPrompt: String = ""): String = listOfNotNull(
            "你是一位专业视频字幕译者，负责将输入字幕翻译为自然、地道、适合屏幕阅读的${targetLang}。",
            "翻译要求：",
            "1. 气口对齐与跨句重组：输入的每一行 `[序号] 原文` 代表视频时间轴上的一个语音气口槽位。输出必须严格保留全部 `[序号]`（格式为 `[序号] 译文`），绝不漏号、跳号或合并行号。当相邻 2~4 个气口属于同一句话或紧密相连的意群（如英文后置定语、状语从句、被动结构或跨行断句）时，请按符合${targetLang}母语阅读习惯的语序对这 2~4 句进行整体重构，再按自然的${targetLang}断句节奏切分并塞回对应的 `[序号]` 气口槽位中。切分时保持相邻槽位字数大体均衡，避免前一行塞满二十多字而后一行只剩两三个动词的头重脚轻拆法。",
            "2. 语音识别容错：若源字幕来自自动语音识别（ASR），可能存在同音误识别、吞音、断词或专有名词听错。请结合 `<video_metadata>` 与上下文逻辑推断真实语义后再翻译，避免按明显不通的错别字硬译。",
            "3. 表达自然凝练：贴合视频主题与说话人口吻，译文简洁有力，不输出任何解释、代码块标记或额外文本。",
            customPrompt.trim().takeIf { it.isNotEmpty() }?.let { "4. 附加要求：$it" }
        ).joinToString("\n")
        fun buildUserPrompt(cues: List<Cue>, context: List<Cue>, metadata: VideoMetadata, following: List<Cue> = emptyList()): String {
            val sections = mutableListOf<String>(); val meta = mutableListOf<String>()
            if (metadata.title.isNotEmpty()) meta += "标题: ${metadata.title}"
            if (metadata.author.isNotEmpty()) meta += "频道: ${metadata.author}"
            if (metadata.keywords.isNotEmpty()) meta += "标签: ${metadata.keywords.take(12).joinToString(", ")}"
            val desc = metadata.description.replace(Regex("\\s+"), " ").trim().take(600)
            if (desc.isNotEmpty()) meta += "简介摘录: $desc"
            fun section(tag: String, lines: List<String>) { sections += "<$tag>\n${lines.joinToString("\n")}\n</$tag>" }
            if (meta.isNotEmpty()) section("video_metadata", meta)
            if (context.isNotEmpty()) section("preceding_context_do_not_translate", context.map { "[${it.index}] ${it.sourceText}" + (it.translatedText?.let { text -> " => $text" } ?: "") })
            section("source_cues_to_translate", cues.map { "[${it.index}] ${it.sourceText}" })
            if (following.isNotEmpty()) section("following_context_do_not_translate", following.map { "[${it.index}] ${it.sourceText}" })
            return sections.joinToString("\n\n")
        }
        fun parseTranslatedLines(text: String, validIndices: Set<Int>? = null): Map<Int, String> {
            val out = linkedMapOf<Int, String>()
            for (line in text.lines()) {
                val match = Regex("^\\s*\\[(\\d+)]\\s*(.+?)\\s*$").matchEntire(line) ?: continue
                val index = match.groupValues[1].toIntOrNull() ?: continue; val content = match.groupValues[2].trim()
                if (content.isNotEmpty() && (validIndices == null || index in validIndices)) out[index] = content
            }
            return out
        }
        internal fun content(payload: String): String = runCatching {
            val choice = JSONObject(payload).optJSONArray("choices")?.optJSONObject(0)
            val delta = choice?.optJSONObject("delta")?.opt("content")
            if (delta is String) delta else (choice?.optJSONObject("message")?.opt("content") as? String ?: "")
        }.getOrDefault("")
        fun extractContentFromResponseText(rawText: String): ResponseContent {
            val sse = rawText.lineSequence().any { it.trimStart().startsWith("data:") }
            return if (sse) ResponseContent(rawText.lineSequence().filter { it.trimStart().startsWith("data:") }.joinToString("") { content(it.trimStart().removePrefix("data:").trim()) }, true) else ResponseContent(content(rawText), false)
        }
    }
}

/** Incremental SSE parser: only completed translated lines are published until EOF. */
class TranslationStreamDecoder(private val validIndices: Set<Int>, private val emit: (Int, String) -> Unit) {
    private val content = StringBuilder()
    private val emitted = mutableMapOf<Int, String>()
    private var sse = false
    fun acceptLine(line: String) {
        val trimmed = line.trimStart()
        if (!trimmed.startsWith("data:")) return
        sse = true
        content.append(LlmClient.content(trimmed.removePrefix("data:").trim()))
        publish(false)
    }
    private fun publish(includeTail: Boolean) {
        val text = content.toString()
        val complete = if (includeTail) text else text.substring(0, (text.lastIndexOf('\n') + 1).coerceAtLeast(0))
        for ((i, translated) in LlmClient.parseTranslatedLines(complete, validIndices)) if (emitted[i] != translated) { emitted[i] = translated; emit(i, translated) }
    }
    fun finish(rawText: String = "") {
        if (!sse) content.append(LlmClient.extractContentFromResponseText(rawText).fullContent)
        publish(true)
    }
}
