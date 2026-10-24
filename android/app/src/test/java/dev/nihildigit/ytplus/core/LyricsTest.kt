package dev.nihildigit.ytplus.core

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class LyricsTest {
    @Test fun extractsBalancedNestedGeniusContainersAndEntities() {
        val html = """<div data-lyrics-container="true">[Verse 1]<br/>First &amp; second<div>nested line<br>next &#x1F600;</div><br>Last line</div><div data-lyrics-container="true">Another line<br>Final line</div>"""
        assertEquals("First & secondnested line\nnext 😀\nLast line\nAnother line\nFinal line", LyricsClient.extractGeniusLyricsFromHtml(html))
    }
    @Test fun malformedContainerTerminates() {
        assertEquals("", LyricsClient.extractGeniusLyricsFromHtml("<div data-lyrics-container=\"true\">missing close"))
    }
    @Test fun manualTrackNeverTriggersLyricsLookup() {
        assertFalse(LyricsClient.shouldAttemptLyricsLookup(CaptionTrackInfo(), VideoMetadata(title = "Official music video"), Json3Payload()))
        assertTrue(LyricsClient.shouldAttemptLyricsLookup(CaptionTrackInfo(kind = "asr"), VideoMetadata(title = "Lecture"), Json3Payload()))
    }
    private fun lookup(durationMs: Long, title: String = "Lecture", language: String = "en", punctuated: Boolean = false): Boolean {
        val events = listOf(
            Json3Event(0, 1000, segs = listOf(Json3Seg(if (punctuated) "First sentence." else "first sentence"))),
            Json3Event(2000, 1000, segs = listOf(Json3Seg(if (punctuated) "Second sentence." else "second sentence"))),
            Json3Event(durationMs - 1000, 1000, segs = listOf(Json3Seg("end"))),
        )
        return LyricsClient.shouldAttemptLyricsLookup(CaptionTrackInfo(kind = "asr", languageCode = language), VideoMetadata(title = title), Json3Payload(events))
    }
    @Test fun unsupportedLanguagePrefixesAlwaysSkipLookup() {
        for (language in listOf("ja", "zh", "ko", "ar", "he", "th", "hi", "ru", "uk")) {
            assertFalse(language, lookup(120_000, "Official music video", "$language-Latn"))
            assertFalse(language, lookup(120_000, language = language.uppercase()))
        }
        assertTrue(lookup(120_000, language = "en-US"))
    }
    @Test fun noMusicHintRequiresUnpunctuatedAsrAtMostSixAndAHalfMinutes() {
        assertTrue(lookup(390_000))
        assertFalse(lookup(390_001))
        assertFalse(lookup(120_000, punctuated = true))
        assertTrue(lookup(120_000, "Official music video", punctuated = true))
    }
    @Test fun explicitMusicHintStillHasTenMinuteLimit() {
        assertTrue(lookup(600_000, "Official music video"))
        assertFalse(lookup(600_001, "Official music video"))
    }
    @Test fun durationUsesMaximumEndNotTheLastEventAndCannotOverflow() {
        val track = CaptionTrackInfo(vssId = "a.en", languageCode = "en")
        val metadata = VideoMetadata(title = "Official music video")
        assertFalse(LyricsClient.shouldAttemptLyricsLookup(track, metadata, Json3Payload(listOf(Json3Event(599_000, 1001), Json3Event(0, 1000)))))
        assertFalse(LyricsClient.shouldAttemptLyricsLookup(track, metadata, Json3Payload(listOf(Json3Event(Long.MAX_VALUE, 1000)))))
    }
    @Test fun searchRemovesTitleNoiseAndRequiresCandidateOverlap() {
        val metadata = VideoMetadata(title = "Mountain River (Official Video)", author = "Singer")
        assertEquals(listOf("Mountain River", "Mountain River Singer"), LyricsClient.buildSearchQueries(metadata))
        assertTrue(LyricsClient.isGeniusHitMatchingVideo(JSONObject().put("title", "Mountain River").put("url", "https://genius.com/singer-mountain-river-lyrics"), metadata))
        assertFalse(LyricsClient.isGeniusHitMatchingVideo(JSONObject().put("title", "Mountain River").put("url", "https://elsewhere.test/mountain-river-lyrics"), metadata))
    }
    @Test fun alignsFourExactLyricLinesAndRejectsUnrelatedText() {
        val lyrics = "we walk into the morning\nyou see the mountain river\nthey sing beneath the starlight\nwe dance until tomorrow comes"
        val events = lyrics.split(Regex("\\s+")).mapIndexed { i, word -> Json3Event(i * 300L, 500, segs = listOf(Json3Seg(word))) }
        val cues = LyricsAligner.alignLyricsToAsrEvents(lyrics, events)
        assertNotNull(cues)
        assertEquals(lyrics.lines(), cues!!.map { it.sourceText })
        assertEquals(0L, cues.first().startMs)
        cues.zipWithNext().forEach { (a, b) -> assertTrue(a.endMs <= b.startMs) }
        assertNull(LyricsAligner.alignLyricsToAsrEvents("zzz xxx qqq vvv\nzzz xxx qqq vvv\nzzz xxx qqq vvv\nzzz xxx qqq vvv", events))
    }
    @Test fun alignmentRejectsOversizedAndInsufficientInputs() {
        assertNull(LyricsAligner.alignLyricsToAsrEvents("a\nb\nc\nd", emptyList()))
        assertNull(LyricsAligner.alignLyricsToAsrEvents("one two three\nfour five six\nseven eight nine\nten eleven twelve", List(6001) { Json3Event(it.toLong(), 1, segs = listOf(Json3Seg("word"))) }))
    }
    @Test fun phoneticSimilarityUsesPrefixAndSkeleton() {
        assertEquals(1.0, LyricsAligner.similarity("HELLO!", "hello"), 0.0)
        assertEquals(.82, LyricsAligner.similarity("walking", "walk"), 0.0)
        assertEquals(.78, LyricsAligner.similarity("phone", "fone"), 0.0)
    }
}
