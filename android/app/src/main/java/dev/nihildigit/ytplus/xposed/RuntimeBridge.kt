package dev.nihildigit.ytplus.xposed

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** The core owns translation, waiting decisions and subtitle persistence. */
interface CoreAdapter {
    val subtitles: StateFlow<SubtitleFrame>
    fun onConfigChanged(config: AppConfig) {}
    fun onTimedText(request: TimedTextRequest, json3: ByteArray)
    fun onVideoChanged(videoId: String)
    fun onMetadata(title: String, artist: String, durationMs: Long) {}
    fun onPlayerResponse(videoId: String, response: org.json.JSONObject) {}
    fun onPosition(positionMs: Long)
    fun skipWaiting()
    fun openSettings(context: Context)
}

data class SubtitleFrame(
    val source: String = "",
    val translation: String = "",
    val waiting: Boolean = false,
    val notice: String = "",
    val sponsorSegments: List<SponsorSegment> = emptyList(),
    val durationMs: Long = 0,
    val positionMs: Long = 0,
)

data class TimedTextRequest(val url: String, val videoId: String?, val language: String?)

interface PlayerAdapter {
    fun playbackSpeed(): Float = 1f
    fun positionMs(): Long?
    fun isPlaying(): Boolean?
    fun seekTo(positionMs: Long): Boolean
    fun setPlaying(playing: Boolean): Boolean
}

/** Install once from the module integration before starting playback. */
object RuntimeBridge {
    @Volatile var core: CoreAdapter? = null
    @Volatile var player: PlayerAdapter? = null
    @Volatile var fingerprints = PlayerFingerprints()
    val config = MutableStateFlow(AppConfig())
    val enabled = MutableStateFlow(true)
    val bilingual = MutableStateFlow(true)
    @Volatile var log: (String, Throwable?) -> Unit = { _, _ -> }
}
