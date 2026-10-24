package dev.nihildigit.ytplus.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

data class VideoMetadata(val videoId: String = "", val title: String = "", val author: String = "", val keywords: List<String> = emptyList(), val description: String = "")
data class CaptionTrackInfo(val kind: String? = null, val vssId: String? = null, val languageCode: String = "", val baseUrl: String = "")

class LyricsClient(private val client: OkHttpClient = OkHttpClient()) {
    private val cache = LinkedHashMap<String, String?>()
    private val mutex = Mutex()
    suspend fun fetchExternalLyricsForVideo(metadata: VideoMetadata): String? = mutex.withLock {
        if (metadata.videoId.isBlank() || metadata.title.isBlank()) return@withLock null
        if (cache.containsKey(metadata.videoId)) return@withLock cache[metadata.videoId]
        val lyrics = lookup(metadata)
        cache[metadata.videoId] = lyrics
        while (cache.size > 128) cache.remove(cache.keys.first())
        lyrics
    }
    private suspend fun get(url: String, timeout: Long): String? {
        return try {
            val request = Request.Builder().url(url).header("Accept", "application/json, text/html, */*").build()
            val call = client.newCall(request); call.timeout().timeout(timeout, TimeUnit.MILLISECONDS)
            call.awaitText()
        } catch (e: CancellationException) { throw e } catch (_: Exception) { null }
    }
    private suspend fun lookup(metadata: VideoMetadata): String? {
        val queries = buildSearchQueries(metadata)
        for (q in queries) {
            val raw = get("https://genius.com/api/search?q=${encode(q)}", 4500) ?: continue
            val hits = runCatching { JSONObject(raw).optJSONObject("response")?.optJSONArray("hits") }.getOrNull() ?: continue
            for (i in 0 until minOf(4, hits.length())) {
                val hit = hits.optJSONObject(i)?.optJSONObject("result") ?: continue
                if (!isGeniusHitMatchingVideo(hit, metadata)) continue
                val page = get(hit.optString("url"), 5500) ?: continue
                val lyrics = extractGeniusLyricsFromHtml(page)
                if (lyrics.lines().size >= 6) return lyrics
            }
        }
        for (q in queries.take(2)) {
            val raw = get("https://lrclib.net/api/search?q=${encode(q)}", 3500) ?: continue
            val plain = runCatching { JSONArray(raw).optJSONObject(0)?.optString("plainLyrics") }.getOrNull()?.trim()
            if (!plain.isNullOrBlank() && plain.lines().size >= 6) return plain
        }
        return null
    }
    companion object {
        private val noise = Regex("\\s*(?:\\(|\\[)(?:official\\s*(?:music\\s*)?video|official\\s*audio|lyric\\s*video|lyrics?|hd|4k|hq|visualizer|explicit|clean|mv)(?:\\)|])\\s*", RegexOption.IGNORE_CASE)
        private val hints = Regex("\\b(?:erb|epic\\s+rap\\s+battles|rap\\s+battle|lyrics?|official\\s+(?:music\\s+)?video|music\\s+video|mv|song|feat\\.?|ft\\.?|versus|vs\\.?|cypher|diss\\s+track|freestyle|remix|soundtrack|ost)\\b", RegexOption.IGNORE_CASE)
        private val stopwords = "the and for with from that this official video music lyrics lyric audio part episode".split(' ').toSet()
        private fun encode(s: String) = URLEncoder.encode(s, "UTF-8")
        fun shouldAttemptLyricsLookup(track: CaptionTrackInfo, metadata: VideoMetadata, payload: Json3Payload): Boolean {
            if (track.kind != "asr" && track.vssId?.startsWith("a.") != true) return false
            if (listOf("ja", "zh", "ko", "ar", "he", "th", "hi", "ru", "uk").any {
                    track.languageCode.startsWith(it, ignoreCase = true)
                }) return false
            val durationMs = payload.events.maxOfOrNull {
                val start = (it.tStartMs ?: 0L).coerceAtLeast(0L)
                val duration = (it.dDurationMs ?: 0L).coerceAtLeast(0L)
                if (duration > Long.MAX_VALUE - start) Long.MAX_VALUE else start + duration
            } ?: 0L
            if (durationMs > 10 * 60 * 1000L) return false
            val musicHint = hints.containsMatchIn("${metadata.title} ${metadata.author} ${metadata.keywords.joinToString(" ")}")
            return musicHint || (durationMs <= 390_000L && !CueBuilder.hasAsrAutoPunctuation(payload.events))
        }
        fun buildSearchQueries(metadata: VideoMetadata): List<String> {
            val title = metadata.title.replace(noise, " ").replace(Regex("\\s+"), " ").trim()
            if (title.isEmpty()) return emptyList()
            val out = mutableListOf(title); val parts = title.split(Regex("\\s*(?:\\.|\\||—|-)\\s*")).filter { it.isNotEmpty() }
            if (parts.size >= 2 && parts[0].length >= 6) {
                if (metadata.author.isNotEmpty() && !parts[0].contains(metadata.author, true)) out += "${parts[0]} ${metadata.author}"
                out += parts[0]
            } else if (metadata.author.isNotEmpty() && !title.contains(metadata.author, true)) out += "$title ${metadata.author}"
            return out.distinct()
        }
        private fun significant(s: String) = s.lowercase().replace(Regex("[^a-z0-9\\s]"), " ").split(Regex("\\s+")).filter { it.length >= 3 && it !in stopwords }
        fun isGeniusHitMatchingVideo(hit: JSONObject, metadata: VideoMetadata): Boolean {
            val url = hit.optString("url")
            // Only fetch pages from the provider, never arbitrary URLs from a search response.
            if (!url.startsWith("https://genius.com/") || !url.endsWith("-lyrics") || Regex("annotated|guide|chapter|book", RegexOption.IGNORE_CASE).containsMatchIn(url)) return false
            val candidate = significant("${hit.optString("full_title")} ${hit.optString("title")} ${hit.optString("artist_names")}").toSet()
            val title = significant(metadata.title.replace(noise, " ").split(Regex("\\s*(?:\\.|\\||—)\\s*")).first())
            return title.isNotEmpty() && title.count { it in candidate }.toDouble() / title.size >= .6
        }
        fun extractGeniusLyricsFromHtml(html: String): String {
            val blocks = mutableListOf<String>(); var pos = 0
            while (pos < html.length) {
                val marker = html.indexOf("data-lyrics-container=\"true\"", pos); if (marker < 0) break
                val start = html.indexOf('>', marker); if (start < 0) break
                var depth = 1; var cursor = start + 1
                while (depth > 0 && cursor < html.length) {
                    val open = html.indexOf("<div", cursor); val close = html.indexOf("</div", cursor)
                    if (close < 0) { cursor = html.length; break }
                    if (open >= 0 && open < close) { depth++; cursor = open + 4 }
                    else { depth--; if (depth == 0) blocks += html.substring(start + 1, close); cursor = close + 5 }
                }
                pos = cursor
            }
            val text = blocks.joinToString("\n") { block -> decodeHtmlEntities(block.replace(Regex("<div[^>]*data-exclude-from-selection=\"true\"[^>]*>[\\s\\S]*?</div>", RegexOption.IGNORE_CASE), "").replace(Regex("<br\\s*/?>", RegexOption.IGNORE_CASE), "\n").replace(Regex("<[^>]+>"), "")) }
            return cleanLyricLines(text).joinToString("\n")
        }
        fun decodeHtmlEntities(input: String): String {
            var out = Regex("&#(x[0-9a-f]+|[0-9]+);", RegexOption.IGNORE_CASE).replace(input) {
                val s = it.groupValues[1]; val code = if (s.startsWith("x", true)) s.drop(1).toIntOrNull(16) else s.toIntOrNull()
                if (code != null && Character.isValidCodePoint(code)) String(Character.toChars(code)) else ""
            }
            for ((entity, value) in listOf("&quot;" to "\"", "&apos;" to "'", "&amp;" to "&", "&lt;" to "<", "&gt;" to ">", "&nbsp;" to " ")) out = out.replace(entity, value)
            return out
        }
    }
}
