package dev.nihildigit.ytplus.core

import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.first
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.Rule
import org.junit.rules.TemporaryFolder

class TranslationTest {
    @get:Rule val temporaryFolder = TemporaryFolder()
    @Test fun cachePersistsAndReloadsAcrossInstances() {
        val directory = temporaryFolder.newFolder("translations")
        SubtitleCache(directory).merge("video::track", mapOf(0 to "译文"))
        val reopened = SubtitleCache(directory)
        assertEquals(mapOf(0 to "译文"), reopened.get("video::track"))
        reopened.merge("video::track", mapOf(1 to "第二行"))
        assertEquals(mapOf(0 to "译文", 1 to "第二行"), SubtitleCache(directory).get("video::track"))
    }
    @Test fun normalizesRootAndCompletionEndpoints() {
        assertEquals("https://example.com/v1", LlmClient.normalizeBaseUrl(" https://example.com/ "))
        assertEquals("https://example.com/custom", LlmClient.normalizeBaseUrl("https://example.com/custom/chat/completions/"))
        assertEquals("", LlmClient.normalizeBaseUrl(" "))
    }
    @Test fun translatedLineParserFiltersAndOverwrites() {
        assertEquals(mapOf(2 to "最终译文"), LlmClient.parseTranslatedLines("[2] 初稿\n[99] 不要\n[2] 最终译文\n解释", setOf(2)))
    }
    private fun delta(s: String) = "data: " + JSONObject().put("choices", JSONArray().put(JSONObject().put("delta", JSONObject().put("content", s)))).toString()
    @Test fun streamingDoesNotPublishIncompleteTranslatedLine() {
        val seen = mutableListOf<Pair<Int, String>>()
        val parser = TranslationStreamDecoder(setOf(1, 2)) { i, s -> seen += i to s }
        parser.acceptLine(": keepalive")
        parser.acceptLine(delta("[1] 第")); assertTrue(seen.isEmpty())
        parser.acceptLine(delta("一句\n[2] 第二")); assertEquals(listOf(1 to "第一句"), seen)
        parser.acceptLine(delta("句")); assertEquals(1, seen.size)
        parser.acceptLine("data: [DONE]"); parser.finish()
        assertEquals(listOf(1 to "第一句", 2 to "第二句"), seen)
    }
    @Test fun responseExtractionSupportsSseAndStandardJson() {
        val sse = ": comment\n${delta("[1] hello")}\ndata: [DONE]\n"
        assertEquals(ResponseContent("[1] hello", true), LlmClient.extractContentFromResponseText(sse))
        val json = """{"choices":[{"message":{"content":"[1] hello"}}]}"""
        assertEquals(ResponseContent("[1] hello", false), LlmClient.extractContentFromResponseText(json))
        val seen = mutableMapOf<Int, String>(); val parser = TranslationStreamDecoder(setOf(1)) { i, s -> seen[i] = s }; parser.finish(json)
        assertEquals(mapOf(1 to "hello"), seen)
    }
    @Test fun promptKeepsPrecedingAndFollowingOutsideTranslationSlots() {
        val prompt = LlmClient.buildUserPrompt(listOf(Cue(1, 0, 1, "source")), listOf(Cue(0, 0, 1, "before", "译文")), VideoMetadata(title = "Title", description = "d".repeat(1000)), listOf(Cue(2, 0, 1, "after")))
        assertTrue(prompt.contains("[0] before => 译文"))
        assertTrue(prompt.contains("<source_cues_to_translate>\n[1] source\n</source_cues_to_translate>"))
        assertTrue(prompt.contains("<following_context_do_not_translate>"))
        assertFalse(prompt.contains("d".repeat(601)))
    }
    @Test fun cacheKeysIncludeTimelineEndpointAndPrompt() {
        val cues = listOf(Cue(0, 0, 1, "a")); val cfg = TranslationConfig("https://example.com", model = "model")
        val key = SubtitleCache.makeKey("v", "en", cues, cfg)
        assertNotEquals(key, SubtitleCache.makeKey("v", "en", cues, cfg.copy(customPrompt = "new")))
        assertNotEquals(key, SubtitleCache.makeKey("v", "en", cues, cfg.copy(apiBaseUrl = "https://other.test")))
        assertEquals(key, SubtitleCache.makeKey("v", "en", cues, cfg.copy(apiKey = "secret")))
        val cache = SubtitleCache(maxEntries = 2)
        cache.merge("a", mapOf(1 to "one")); cache.merge("a", mapOf(2 to "two"))
        assertEquals(mapOf(1 to "one", 2 to "two"), cache.get("a"))
        cache.merge("b", mapOf(1 to "b")); cache.merge("c", mapOf(1 to "c")); assertNull(cache.get("a"))
    }
    @Test fun batchSnapFindsNearbySentenceEnd() {
        val cues = List(10) { Cue(it, it * 1000L, it * 1000L + 500, if (it == 4) "end." else "fragment") }
        assertEquals(5, TranslationScheduler.snapBatchEndIndex(cues, 0, 3, 3))
        assertEquals(3, TranslationScheduler.snapBatchEndIndex(cues, 0, 3, 1))
    }
    @Test fun schedulerFastThenBackgroundAndContext() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val requests = Channel<TranslationBatch>(Channel.UNLIMITED)
            val translator = BatchTranslator { batch, emit -> requests.send(batch); batch.cues.associate { emit(it.index, "t${it.index}"); it.index to "t${it.index}" } }
            val scheduler = TranslationScheduler(scope, translator = translator)
            val cues = List(15) { Cue(it, it * 1000L, it * 1000L + 900, "word") }
            scheduler.load("video", "en", cues, TranslationConfig("https://example.test", model = "m"), options = ScheduleOptions(fastBatchSize = 2, batchSize = 10))
            val done = withTimeout(5000) { scheduler.state.first { !it.running && it.cues.isNotEmpty() } }
            assertTrue(done.cues.all { it.translatedText != null })
            assertEquals(2, done.completedFast)
            assertFalse(done.buffering)
            val fast = requests.receive(); val background = requests.receive()
            assertEquals(listOf(0, 1), fast.cues.map { it.index })
            assertEquals(listOf(0, 1), background.preceding.map { it.index })
            assertEquals(10, background.cues.size)
        } finally { scope.cancel() }
    }
    @Test fun staleStreamCannotMutateNewGeneration() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val callbacks = Channel<(Int, String) -> Unit>(Channel.UNLIMITED)
            val translator = BatchTranslator { _, emit -> callbacks.send(emit); awaitCancellation() }
            val scheduler = TranslationScheduler(scope, translator = translator)
            val config = TranslationConfig("https://example.test", model = "m")
            scheduler.load("first", "en", listOf(Cue(0, 0, 1000, "first")), config)
            val old = withTimeout(5000) { callbacks.receive() }
            scheduler.load("second", "en", listOf(Cue(0, 0, 1000, "second")), config)
            val current = withTimeout(5000) { callbacks.receive() }
            old(0, "stale")
            assertNull(scheduler.state.value.cues[0].translatedText)
            current(0, "current")
            assertEquals("current", scheduler.state.value.cues[0].translatedText)
            assertFalse(scheduler.state.value.buffering)
            scheduler.cancel()
        } finally { scope.cancel() }
    }
}
