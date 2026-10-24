package dev.nihildigit.ytplus.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlin.coroutines.coroutineContext

data class TranslationBatch(val config: TranslationConfig, val cues: List<Cue>, val preceding: List<Cue>, val following: List<Cue>, val metadata: VideoMetadata)
fun interface BatchTranslator {
    suspend fun translate(batch: TranslationBatch, onCue: (Int, String) -> Unit): Map<Int, String>
}
data class ScheduleOptions(val fastBatchSize: Int = 10, val batchSize: Int = 50, val prefetchBatches: Int = 0, val holdPlayback: Boolean = true)
data class TranslationState(val generation: Long = 0, val cues: List<Cue> = emptyList(), val running: Boolean = false, val buffering: Boolean = false, val completedFast: Int = 0, val totalFast: Int = 0, val error: String? = null)

/** Owns no player. The host observes buffering and decides whether a user-paused player may resume. */
class TranslationScheduler(
    private val scope: CoroutineScope,
    private val cache: SubtitleCache = SubtitleCache(),
    private val translator: BatchTranslator = BatchTranslator { batch, emit -> LlmClient().translateCueBatch(batch.config, batch.cues, batch.preceding, batch.metadata, batch.following, emit) },
) {
    private val lock = Any()
    private val mutableState = MutableStateFlow(TranslationState())
    val state: StateFlow<TranslationState> = mutableState.asStateFlow()
    private var job: Job? = null
    private var generation = 0L
    private var bypassedGeneration = -1L
    private var cursorMs = 0L
    private var holdPlayback = true
    private var cacheKey = ""
    private var config: TranslationConfig? = null
    private var metadata = VideoMetadata()
    private var options = ScheduleOptions()

    fun load(videoId: String, trackId: String, cues: List<Cue>, config: TranslationConfig, metadata: VideoMetadata = VideoMetadata(), options: ScheduleOptions = ScheduleOptions(), timeMs: Long = 0) {
        require(cues.withIndex().all { it.index == it.value.index }) { "Cue indices must be contiguous" }
        synchronized(lock) {
            cancelLocked(); this.config = config; this.metadata = metadata; this.options = options; this.cursorMs = timeMs; holdPlayback = options.holdPlayback
            cacheKey = SubtitleCache.makeKey(videoId, trackId, cues, config)
            val cached = cache.get(cacheKey).orEmpty()
            mutableState.value = TranslationState(generation, cues.map { it.copy(translatedText = cached[it.index] ?: it.translatedText) })
            scheduleLocked(0)
        }
    }
    fun seek(timeMs: Long) = synchronized(lock) { cursorMs = timeMs; scheduleLocked(120) }
    fun updatePlaybackTime(timeMs: Long) = synchronized(lock) {
        cursorMs = timeMs
        val s = mutableState.value
        val active = CueBuilder.findActiveCueIndex(s.cues, timeMs)
        val needs = active >= 0 && s.cues[active].translatedText.isNullOrBlank()
        val ready = readyAtCursor(s.cues)
        mutableState.value = s.copy(buffering = holdPlayback && s.running && bypassedGeneration != generation && (if (s.buffering) !ready else needs))
    }
    fun skipBufferingWait() = synchronized(lock) { bypassedGeneration = generation; mutableState.value = mutableState.value.copy(buffering = false) }
    fun cancel() = synchronized(lock) { cancelLocked(); mutableState.value = mutableState.value.copy(generation = generation, running = false, buffering = false) }
    fun reset() = synchronized(lock) { cancelLocked(); config = null; mutableState.value = TranslationState(generation) }
    fun retranslateAll() = synchronized(lock) {
        cancelLocked(); mutableState.value = mutableState.value.copy(cues = mutableState.value.cues.map { it.copy(translatedText = null) }); scheduleLocked(0)
    }
    private fun cancelLocked() { generation++; job?.cancel(); job = null }
    private fun readyAtCursor(cues: List<Cue>): Boolean {
        val start = CueBuilder.findCurrentOrNextCueIndex(cues, cursorMs)
        return start < 0 || cues.drop(start).take(2).all { !it.translatedText.isNullOrBlank() }
    }
    private fun scheduleLocked(debounce: Long) {
        val cfg = config ?: return
        cancelLocked()
        val gen = generation; val snapshot = mutableState.value.cues
        val start = CueBuilder.findCurrentOrNextCueIndex(snapshot, cursorMs)
        if (start < 0 || cfg.apiBaseUrl.isBlank() || cfg.model.isBlank()) { mutableState.value = mutableState.value.copy(generation = gen, running = false, buffering = false); return }
        val fastEnd = snapBatchEndIndex(snapshot, start, options.fastBatchSize.coerceAtLeast(1), 3)
        val fast = snapshot.subList(start, fastEnd).filter { it.translatedText.isNullOrBlank() }
        mutableState.value = mutableState.value.copy(generation = gen, running = true, buffering = holdPlayback && fast.isNotEmpty() && !readyAtCursor(snapshot), completedFast = 0, totalFast = fast.size, error = null)
        val key = cacheKey; val meta = metadata; val opts = options
        job = scope.launch(start = CoroutineStart.LAZY) {
            try {
                if (debounce > 0) delay(debounce)
                if (fast.isNotEmpty()) runBatch(gen, key, cfg, meta, fast, true)
                synchronized(lock) { if (generation == gen) mutableState.value = mutableState.value.copy(buffering = false) }
                var scan = start; var batches = 0
                while (opts.prefetchBatches <= 0 || batches < opts.prefetchBatches) {
                    coroutineContext.ensureActive()
                    val current = synchronized(lock) { if (generation == gen) mutableState.value.cues else emptyList() }
                    val first = (scan until current.size).firstOrNull { current[it].translatedText.isNullOrBlank() } ?: break
                    val end = snapBatchEndIndex(current, first, opts.batchSize.coerceAtLeast(10), 4)
                    val batch = current.subList(first, end).takeWhile { it.translatedText.isNullOrBlank() }
                    if (batch.isEmpty()) break
                    runBatch(gen, key, cfg, meta, batch, false)
                    scan = batch.last().index + 1; batches++
                }
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { synchronized(lock) { if (generation == gen) mutableState.value = mutableState.value.copy(error = e.message ?: "翻译失败") } }
            finally { synchronized(lock) { if (generation == gen) { mutableState.value = mutableState.value.copy(running = false, buffering = false); job = null } } }
        }.also { it.start() }
    }
    private suspend fun runBatch(gen: Long, key: String, cfg: TranslationConfig, meta: VideoMetadata, batch: List<Cue>, fast: Boolean) {
        val partial = linkedMapOf<Int, String>(); val valid = batch.map { it.index }.toSet()
        val current = synchronized(lock) { if (generation != gen) return; mutableState.value.cues }
        val first = batch.first().index; val last = batch.last().index
        fun emit(index: Int, text: String) = synchronized(lock) {
            if (generation != gen || index !in valid || text.isBlank()) return@synchronized
            val wasNew = index !in partial; partial[index] = text
            val s = mutableState.value; val updated = s.cues.toMutableList(); updated[index] = updated[index].copy(translatedText = text)
            mutableState.value = s.copy(cues = updated, completedFast = s.completedFast + if (fast && wasNew) 1 else 0, buffering = s.buffering && !readyAtCursor(updated))
        }
        try {
            val result = translator.translate(TranslationBatch(cfg, batch, current.subList((first - 4).coerceAtLeast(0), first), current.subList(last + 1, (last + 4).coerceAtMost(current.size)), meta), ::emit)
            result.forEach { (i, text) -> emit(i, text) }
        } finally {
            // An obsolete request must never overwrite newer translations for the same key.
            synchronized(lock) {
                if (partial.isNotEmpty() && (generation == gen || cacheKey != key)) {
                    cache.merge(key, partial.toMap())
                }
            }
        }
    }
    companion object {
        fun snapBatchEndIndex(cues: List<Cue>, startIdx: Int, baseCount: Int, maxExtra: Int): Int {
            if (cues.isEmpty()) return 0
            val raw = (startIdx + baseCount.coerceAtLeast(1) - 1).coerceAtMost(cues.lastIndex)
            if (raw == cues.lastIndex) return cues.size
            val pattern = Regex("[.?!。？！…]+[\"')\\]）】》”’]*$")
            for (i in raw..(raw + maxExtra.coerceAtLeast(0)).coerceAtMost(cues.lastIndex)) if (pattern.containsMatchIn(cues[i].sourceText.trim())) return i + 1
            return raw + 1
        }
    }
}

/** Manual captions win; external lyrics are only attempted on ASR tracks. */
class SubtitleSourceResolver(private val lyricsClient: LyricsClient = LyricsClient()) {
    suspend fun resolve(payload: Json3Payload, track: CaptionTrackInfo, metadata: VideoMetadata): List<Cue> {
        if (LyricsClient.shouldAttemptLyricsLookup(track, metadata, payload)) {
            val lyrics = lyricsClient.fetchExternalLyricsForVideo(metadata)
            if (lyrics != null) LyricsAligner.alignLyricsToAsrEvents(lyrics, payload.events)?.let { return it }
        }
        return CueBuilder.parseJson3ToCues(payload, if (track.kind == "asr" || track.vssId?.startsWith("a.") == true) "asr" else track.kind)
    }
}
