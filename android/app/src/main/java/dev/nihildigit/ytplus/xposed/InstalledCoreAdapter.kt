package dev.nihildigit.ytplus.xposed

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import dev.nihildigit.ytplus.core.Cue
import dev.nihildigit.ytplus.core.CaptionTrackInfo
import dev.nihildigit.ytplus.core.LyricsClient
import dev.nihildigit.ytplus.core.SubtitleSourceResolver
import dev.nihildigit.ytplus.ui.uiText
import dev.nihildigit.ytplus.core.VideoMetadata
import dev.nihildigit.ytplus.core.CueBuilder
import dev.nihildigit.ytplus.core.ScheduleOptions
import dev.nihildigit.ytplus.core.SubtitleCache
import dev.nihildigit.ytplus.core.TranslationScheduler
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import java.io.File
import java.util.concurrent.TimeUnit
import kotlin.math.abs

/** Network parsing and cache reads run off-main; player ownership stays on main. */
class InstalledCoreAdapter(context: Context) : CoreAdapter {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val scheduler = TranslationScheduler(CoroutineScope(SupervisorJob() + Dispatchers.IO),
        SubtitleCache(File(context.filesDir, "ytpp_subtitles")))
    private val client = OkHttpClient.Builder().callTimeout(20, TimeUnit.SECONDS)
        .followRedirects(false).followSslRedirects(false).build()
    private val lock = Any()
    private val frames = MutableStateFlow(SubtitleFrame())
    override val subtitles: StateFlow<SubtitleFrame> = frames
    private var config = AppConfig()
    private var video = ""
    private var authoritativeVideo = false
    private var track = ""
    private var cues = emptyList<Cue>()
    private var generation = 0L
    private var position = 0L
    private var pausedPlayer: PlayerAdapter? = null
    private var segments = emptyList<SponsorSegment>()
    private var durationMs = 0L
    private var sponsorJob: Job? = null
    private var sponsorGeneration = 0L
    private var attempted = mutableSetOf<String>()
    private var notice = ""
    private var noticeUntil = 0L
    private var captionJob: Job? = null
    private var captionEpoch = 0L
    private var metadataTitle = ""
    private var metadataArtist = ""
    private var metadataKeywords = emptyList<String>()
    private val sourceResolver = SubtitleSourceResolver()
    private var externalLookupGeneration: Long? = null

    private fun applyDetails(details: org.json.JSONObject?) {
        if (details == null) return
        metadataTitle = details.optString("title", metadataTitle)
        metadataArtist = details.optString("author", metadataArtist)
        val keywords = details.optJSONArray("keywords")
        metadataKeywords = if (keywords == null) emptyList() else (0 until keywords.length()).map { keywords.optString(it) }
        val duration = details.optLong("lengthSeconds", 0) * 1000
        if (duration > 0) durationMs = duration
    }

    override fun onMetadata(title: String, artist: String, durationMs: Long) {
        scope.launch { synchronized(lock) {
            val changed = metadataTitle.isNotBlank() && title != metadataTitle
            metadataTitle = title; metadataArtist = artist
            if (durationMs > 0) this@InstalledCoreAdapter.durationMs = durationMs
            if (changed && video.isNotBlank() && cues.isEmpty()) scheduleCaptions()
        } }
    }

    override fun onPlayerResponse(videoId: String, response: org.json.JSONObject) {
        scope.launch { synchronized(lock) {
            authoritativeVideo = true
            changeVideo(videoId)
            applyDetails(response.optJSONObject("videoDetails"))
            if (cues.isEmpty()) scheduleCaptions(response)
        } }
    }

    private fun scheduleCaptions(response: org.json.JSONObject? = null) {
        captionJob?.cancel()
        val id = video
        val epoch = ++captionEpoch
        if (id.isBlank() || !config.enabled) return
        captionJob = scope.launch {
            delay(600)
            if (video != id || cues.isNotEmpty()) return@launch
            try {
                val result = withContext(Dispatchers.IO) {
                    fun download(url: String, maxBytes: Long): String {
                        client.newCall(Request.Builder().url(url).header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36").build()).execute().use { http ->
                            check(http.isSuccessful) { "Caption discovery HTTP ${http.code}" }
                            val source = http.body?.source() ?: error("Empty caption discovery body")
                            check(!source.request(maxBytes + 1)) { "Caption discovery response exceeds limit" }
                            return source.readUtf8()
                        }
                    }
                    val player = response ?: CaptionDiscovery.playerResponse(download("https://www.youtube.com/watch?v=$id", 8L * 1024 * 1024)) ?: error("Missing player response")
                    val details = player.optJSONObject("videoDetails")
                    check(details?.optString("videoId", id) == id) { "Mismatched video response" }
                    val selected = CaptionDiscovery.bestTrack(player, config.preferredSourceLanguage) ?: error("No caption tracks available")
                    val url = selected.getString("baseUrl").toHttpUrl().newBuilder().setQueryParameter("fmt", "json3").setQueryParameter("v", id).build().toString()
                    check(TimedTextTap().accepts(url)) { "Unexpected caption host" }
                    Triple(url, download(url, TimedTextTap.MAX_BYTES.toLong()).toByteArray(Charsets.UTF_8), details)
                }
                synchronized(lock) {
                    if (video != id || epoch != captionEpoch || cues.isNotEmpty()) return@synchronized
                    applyDetails(result.third)
                    onTimedText(TimedTextRequest(result.first, id, Uri.parse(result.first).getQueryParameter("lang")), result.second)
                }
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) { RuntimeBridge.log("Automatic caption fetch failed for $id", error) }
        }
    }

    init {
        scope.launch {
            scheduler.state.collect {
                synchronized(lock) {
                    if (!scheduler.state.value.buffering) releasePause()
                }
            }
        }
    }

    override fun onConfigChanged(config: AppConfig) {
        scope.launch {
            synchronized(lock) {
                val previous = this@InstalledCoreAdapter.config
                this@InstalledCoreAdapter.config = config
                if (previous.enabled != config.enabled || previous.translation != config.translation || previous.prefetchWait != config.prefetchWait) {
                    generation++
                    releasePause()
                    reload()
                }
                if (!config.enabled) { captionEpoch++; captionJob?.cancel() }
                if (previous.preferredSourceLanguage != config.preferredSourceLanguage) {
                    generation++; track = ""; cues = emptyList(); scheduler.reset(); releasePause()
                    scheduleCaptions()
                } else if (!previous.enabled && config.enabled && cues.isEmpty()) scheduleCaptions()
                if (previous.sponsorBlockEnabled != config.sponsorBlockEnabled || previous.sponsorBlockCategories != config.sponsorBlockCategories) fetchSegments()
            }
        }
    }

    override fun onVideoChanged(videoId: String) {
        scope.launch { synchronized(lock) { authoritativeVideo = true; changeVideo(videoId) } }
    }

    private fun changeVideo(id: String) {
        if (id == video) return
        generation++; video = id; track = ""; cues = emptyList(); position = 0
        metadataTitle = ""; metadataArtist = ""; metadataKeywords = emptyList(); durationMs = 0
        releasePause(); scheduler.reset(); frames.value = SubtitleFrame()
        fetchSegments()
        scheduleCaptions()
    }

    override fun onTimedText(request: TimedTextRequest, json3: ByteArray) {
        scope.launch {
            val token = synchronized(lock) {
                val id = request.videoId ?: video.takeIf { it.isNotEmpty() } ?: return@launch
                if (authoritativeVideo && video.isNotEmpty() && id != video) return@launch
                changeVideo(id)
                ++generation
            }
            val metadata = synchronized(lock) { VideoMetadata(video, metadataTitle, metadataArtist, metadataKeywords) }
            val parsed = try {
                withContext(Dispatchers.Default) {
                    val raw = String(json3, Charsets.UTF_8).trimStart()
                    val uri = Uri.parse(request.url)
                    val kind = uri.getQueryParameter("kind")
                    if (raw.startsWith("<")) CueBuilder.parseSrv3ToCues(raw, kind)
                    else {
                        val payload = CueBuilder.parsePayload(raw)
                        val info = CaptionTrackInfo(kind = kind, languageCode = request.language ?: uri.getQueryParameter("lang").orEmpty())
                        if (LyricsClient.shouldAttemptLyricsLookup(info, metadata, payload)) {
                            synchronized(lock) { if (token == generation) externalLookupGeneration = token }
                        }
                        sourceResolver.resolve(payload, info, metadata)
                    }
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                RuntimeBridge.log("Subtitle parsing failed", error)
                return@launch
            } finally {
                synchronized(lock) { if (externalLookupGeneration == token) externalLookupGeneration = null }
            }
            synchronized(lock) {
                if (token != generation) return@synchronized
                val uri = Uri.parse(request.url)
                val newTrack = listOf(request.language.orEmpty(), uri.getQueryParameter("kind").orEmpty(), uri.getQueryParameter("name").orEmpty()).joinToString(":")
                track = newTrack
                if (parsed.isEmpty()) return@synchronized
                captionEpoch++; captionJob?.cancel()
                cues = parsed
                reload()
            }
        }
    }

    private fun reload() {
        scheduler.reset()
        if (!config.enabled || cues.isEmpty()) return
        val token = generation
        scope.launch(Dispatchers.IO) {
            synchronized(lock) {
                if (token == generation && config.enabled) scheduler.load(video, track, cues, config.translation,
                    metadata = VideoMetadata(video, metadataTitle, metadataArtist, metadataKeywords), options = ScheduleOptions(holdPlayback = config.prefetchWait), timeMs = position)
            }
        }
    }

    override fun onPosition(positionMs: Long) = synchronized(lock) {
        if (!config.enabled) { releasePause(); return@synchronized }
        if (abs(positionMs - position) > 1500) scheduler.seek(positionMs)
        position = positionMs
        scheduler.updatePlaybackTime(positionMs)
        val state = scheduler.state.value
        val player = RuntimeBridge.player
        if (state.buffering && pausedPlayer == null && player?.isPlaying() == true) {
            if (player.setPlaying(false)) pausedPlayer = player
        } else if (!state.buffering) releasePause()
        val active = state.cues.getOrNull(CueBuilder.findActiveCueIndex(state.cues, positionMs))
        val segment = segments.firstOrNull { positionMs >= it.startMs && positionMs < it.endMs }
        if (config.sponsorBlockEnabled && segment != null && attempted.add(segment.id)) {
            if (player?.seekTo(segment.endMs) == true) {
                notice = "已跳过${segment.label}"; noticeUntil = SystemClock.elapsedRealtime() + 3500
            } else attempted.remove(segment.id)
        }
        // Allow a deliberate rewind to trigger the segment again, but not stale post-seek samples.
        segments.filter { positionMs < it.startMs - 1000 }.forEach { attempted.remove(it.id) }
        frames.value = SubtitleFrame(active?.sourceText.orEmpty(), active?.translatedText.orEmpty(), state.buffering,
            if (externalLookupGeneration == generation) uiText("正在检索外部轴与文稿...", "Checking external transcript...")
            else if (SystemClock.elapsedRealtime() < noticeUntil) notice else "", segments, durationMs, positionMs)
    }

    private fun releasePause() {
        val owned = pausedPlayer ?: return
        pausedPlayer = null
        if (RuntimeBridge.player === owned && owned.isPlaying() == false) owned.setPlaying(true)
    }

    override fun skipWaiting() { synchronized(lock) { scheduler.skipBufferingWait(); releasePause() } }
    override fun openSettings(context: Context) {
        runCatching { context.startActivity(Intent().setClassName("dev.nihildigit.ytplus", "dev.nihildigit.ytplus.ui.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            .onFailure { RuntimeBridge.log("Cannot open module settings", it) }
    }

    private fun fetchSegments() {
        sponsorJob?.cancel(); segments = emptyList(); attempted.clear(); notice = ""
        val token = ++sponsorGeneration
        if (!config.sponsorBlockEnabled || video.isBlank() || config.sponsorBlockCategories.isEmpty()) return
        val id = video
        val categories = config.sponsorBlockCategories.toSet()
        sponsorJob = scope.launch {
            try {
                val result = withContext(Dispatchers.IO) {
                    val url = "https://sponsor.ajay.app/api/skipSegments".toHttpUrl().newBuilder()
                        .addQueryParameter("videoID", id).addQueryParameter("categories", JSONArray(categories.toList()).toString()).build()
                    client.newCall(Request.Builder().url(url).build()).execute().use { response ->
                        if (response.code == 404) return@use emptyList<SponsorSegment>() to 0L
                        check(response.isSuccessful) { "SponsorBlock HTTP ${response.code}" }
                        val source = response.body?.source() ?: error("Empty SponsorBlock body")
                        check(!source.request(1024L * 1024 + 1)) { "SponsorBlock response exceeds limit" }
                        val rows = JSONArray(source.readUtf8())
                        var duration = 0L
                        val found = (0 until rows.length()).mapNotNull { index ->
                            val row = rows.getJSONObject(index)
                            val category = row.optString("category")
                            val range = row.optJSONArray("segment") ?: return@mapNotNull null
                            val start = range.optDouble(0); val end = range.optDouble(1)
                            if (category !in categories || row.optString("actionType", "skip") != "skip" || !start.isFinite() || !end.isFinite() || start < 0 || end <= start) return@mapNotNull null
                            val seconds = row.optDouble("videoDuration", 0.0)
                            if (seconds.isFinite() && seconds > 0) duration = maxOf(duration, (seconds * 1000).toLong())
                            SponsorSegment(row.optString("UUID", "$start:$end:$category"), (start * 1000).toLong(), (end * 1000).toLong(), category)
                        }.sortedBy { it.startMs }
                        found to duration
                    }
                }
                synchronized(lock) { if (token == sponsorGeneration && id == video) { segments = result.first; if (result.second > 0) durationMs = result.second } }
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) { RuntimeBridge.log("SponsorBlock fetch failed", error) }
        }
    }
}

data class SponsorSegment(val id: String, val startMs: Long, val endMs: Long, val category: String) {
    val label: String get() = when (category) {
        "sponsor" -> "赞助片段"
        "selfpromo" -> "自我推广"
        "interaction" -> "互动提醒"
        "intro" -> "片头"
        "outro" -> "片尾"
        "preview" -> "预告"
        "music_offtopic" -> "非音乐片段"
        "filler" -> "水时长片段"
        else -> "标记片段"
    }
}
