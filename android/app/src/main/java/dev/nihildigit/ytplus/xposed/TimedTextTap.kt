package dev.nihildigit.ytplus.xposed

import android.net.Uri
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.util.LinkedHashMap
import java.util.concurrent.TimeUnit

/** Never consumes/replaces the player response. Only copied bytes enter the core. */
class TimedTextTap {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS)
        .followRedirects(false).followSslRedirects(false).build()
    private val pending = HashSet<String>()
    private val completed = object : LinkedHashMap<String, Long>(32, .75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Long>?): Boolean = size > 64
    }

    fun accepts(url: String): Boolean = runCatching {
        val uri = Uri.parse(url)
        val host = uri.host.orEmpty().lowercase()
        uri.scheme == "https" && (host == "youtube.com" || host.endsWith(".youtube.com") ||
            host == "googlevideo.com" || host.endsWith(".googlevideo.com")) && uri.path in setOf("/api/timedtext", "/youtubei/v1/player")
    }.getOrDefault(false)

    /** Captures only newly written Cronet bytes, including non-array-backed buffers. */
    fun copyCronetBytes(buffer: ByteBuffer, previousPosition: Int): ByteArray {
        val end = buffer.position()
        if (previousPosition !in 0..end || end - previousPosition > MAX_BYTES) return byteArrayOf()
        return buffer.asReadOnlyBuffer().apply { position(previousPosition); limit(end) }
            .let { copy -> ByteArray(copy.remaining()).also { copy.get(it) } }
    }

    fun received(url: String, bytes: ByteArray) {
        if (!accepts(url)) return
        if (Uri.parse(url).path == "/youtubei/v1/player") {
            if (bytes.size <= MAX_BYTES) scope.launch {
                runCatching {
                    val json = org.json.JSONObject(String(bytes, Charsets.UTF_8))
                    val id = json.optJSONObject("videoDetails")?.optString("videoId").orEmpty()
                    if (id.matches(Regex("[A-Za-z0-9_-]{11}"))) RuntimeBridge.core?.onPlayerResponse(id, json)
                }.onFailure { RuntimeBridge.log("Player response parsing failed", it) }
            }
            return
        }
        if (bytes.size <= MAX_BYTES) deliver(url, bytes.copyOf())
        if (Uri.parse(url).getQueryParameter("fmt") != "json3") observed(url)
    }

    /** Runs an independent JSON3 request without forwarding cookies or authorization. */
    fun observed(url: String) {
        VideoIdentity.observe(url)
        if (!accepts(url) || Uri.parse(url).path != "/api/timedtext" || RuntimeBridge.core == null || !RuntimeBridge.enabled.value) return
        val parsed = Uri.parse(url)
        val target = parsed.buildUpon().clearQuery().apply {
            parsed.queryParameterNames.filter { it != "fmt" }.forEach { key ->
                parsed.getQueryParameters(key).forEach { appendQueryParameter(key, it) }
            }
            appendQueryParameter("fmt", "json3")
        }.build().toString()
        synchronized(this) {
            val now = android.os.SystemClock.elapsedRealtime()
            if (pending.contains(target) || completed[target]?.let { now - it < 60_000 } == true) return
            pending.add(target)
        }
        scope.launch {
            try {
                client.newCall(Request.Builder().url(target).get().build()).execute().use { response ->
                    if (!response.isSuccessful) return@use
                    val body = response.body ?: return@use
                    if (body.contentLength() > MAX_BYTES) return@use
                    val output = ByteArrayOutputStream()
                    body.byteStream().use { stream ->
                        val buffer = ByteArray(8192)
                        while (true) {
                            val count = stream.read(buffer)
                            if (count < 0) break
                            if (output.size() + count > MAX_BYTES) throw java.io.IOException("Timed text exceeds capture limit")
                            output.write(buffer, 0, count)
                        }
                    }
                    // A truncated document is rejected by deliver rather than reaching core.
                    if (deliver(target, output.toByteArray())) synchronized(this@TimedTextTap) {
                        completed[target] = android.os.SystemClock.elapsedRealtime()
                    }
                }
            } catch (error: Exception) {
                RuntimeBridge.log("JSON3 side request failed", error)
            } finally { synchronized(this@TimedTextTap) { pending.remove(target) } }
        }
    }

    private fun deliver(url: String, bytes: ByteArray): Boolean {
        if (bytes.isEmpty() || !RuntimeBridge.enabled.value) return false
        return runCatching {
            val text = String(bytes, Charsets.UTF_8).trimStart()
            if (text.startsWith("<")) {
                if (!text.contains("<timedtext")) return false
            } else if (!org.json.JSONObject(text).has("events")) return false
            val core = RuntimeBridge.core ?: return false
            val uri = Uri.parse(url)
            core.onTimedText(TimedTextRequest(url, uri.getQueryParameter("v"), uri.getQueryParameter("lang")), bytes)
            true
        }.getOrElse { RuntimeBridge.log("Invalid timed text response", it); false }
    }

    companion object { const val MAX_BYTES = 4 * 1024 * 1024 }
}
