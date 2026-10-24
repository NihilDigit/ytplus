package dev.nihildigit.ytplus.core

import org.junit.Assert.*
import org.junit.Test

class CueBuilderTest {
    private fun event(text: String, start: Long = 0, duration: Long = 2000) = Json3Event(start, duration, segs = listOf(Json3Seg(text)))
    @Test fun emptyAndMissingEventsAreEmpty() {
        assertTrue(CueBuilder.parseJson3ToCues("{}").isEmpty())
        assertTrue(CueBuilder.parseJson3ToCues(Json3Payload(listOf(Json3Event(segs = listOf(Json3Seg("ignored")))))).isEmpty())
    }
    @Test fun manualDeduplicatesAndClampsOverlap() {
        val result = CueBuilder.parseJson3ToCues(Json3Payload(listOf(event("Hello", 0, 2000), event("Hello", 100, 3000), event("World", 2500, 2000))))
        assertEquals(2, result.size)
        assertEquals(2500L, result[0].endMs)
        assertEquals(4500L, result[1].endMs)
    }
    @Test fun humanClauseTimingAndHangingWordRepair() {
        val result = CueBuilder.parseJson3ToCues(Json3Payload(listOf(event("This is clearly the", 0, 2000), event("right answer", 2000, 1500))))
        assertEquals("This is clearly", result[0].sourceText)
        assertEquals("the right answer", result[1].sourceText)
        assertEquals(1820L, result[0].endMs)
        assertEquals(1820L, result[1].startMs)
        assertEquals(3500L, result[1].endMs)
    }
    @Test fun tagsAreRemovedAndSpeakerMarkersNotDisplayed() {
        val result = CueBuilder.parseJson3ToCues(Json3Payload(listOf(event("[Music]"), event(">> Hello\nworld ♪", 2500))))
        assertEquals(listOf("Hello world"), result.map { it.sourceText })
    }
    @Test fun jsonAndSrv3HaveEquivalentManualTiming() {
        val json = """{"events":[{"tStartMs":100,"dDurationMs":1400,"segs":[{"utf8":"Hello & welcome"}]}]}"""
        val xml = """<timedtext><body><p t="100" d="1400">Hello &amp; welcome</p></body></timedtext>"""
        assertEquals(CueBuilder.parseJson3ToCues(json), CueBuilder.parseSrv3ToCues(xml))
    }
    @Test(expected = Exception::class) fun srv3RejectsDoctype() {
        CueBuilder.parseSrv3ToCues("""<!DOCTYPE x [<!ENTITY e SYSTEM "file:///private">]><timedtext><p t="0">&e;</p></timedtext>""")
    }
    @Test fun asrInterpolationDoesNotPassNextSegmentOnset() {
        val tokens = CueBuilder.tokens(listOf(Json3Event(100, 2000, segs = listOf(Json3Seg("one two three", 0), Json3Seg("next", 120)))))
        assertTrue(tokens.take(3).all { it.start <= 220 && it.end <= 220 })
        assertEquals(220L, tokens.last().start)
    }
    @Test fun punctuationDetectionDisambiguatesTitlesAndInitials() {
        assertFalse(CueBuilder.hasAsrAutoPunctuation(listOf(event("Dr. John and Mr. Smith met James B. Duke"))))
        assertTrue(CueBuilder.hasAsrAutoPunctuation(listOf(event("Hello there! Welcome home."))))
    }
    @Test fun viterbiPreservesAllWordsAndProducesOrderedTimeline() {
        val words = "we walk down the road and we see the mountains in the distance now we turn around and head back home before it gets dark".split(' ')
        val events = words.mapIndexed { i, word -> event(word, i * 250L, 600) }
        val result = CueBuilder.parseJson3ToCues(Json3Payload(events), "asr")
        assertEquals(words.joinToString(" "), result.joinToString(" ") { it.sourceText })
        assertTrue(result.size >= 2)
        assertTimeline(result)
    }
    @Test fun breathDpPreservesPunctuatedSentenceWithoutTinyTails() {
        val text = "The scientific team carefully examined all of the available evidence, because the previous experiments had produced results that could not be explained by the existing theoretical models. They published their findings."
        val result = CueBuilder.parseJson3ToCues(Json3Payload(text.split(' ').mapIndexed { i, word -> event(word, i * 250L, 800) }), "asr")
        assertEquals(text, result.joinToString(" ") { it.sourceText })
        assertTrue(result.size >= 3)
        assertTrue(result.all { it.sourceText.split(' ').size >= 3 })
        assertTimeline(result)
    }
    @Test fun fixedWidthManualTranscriptIsResegmented() {
        val events = listOf(event("The doctor arrived. He examined the", 0, 3000), event("patient carefully. The tests showed a", 3000, 3000), event("clear problem that required treatment.", 6000, 3000))
        val result = CueBuilder.parseJson3ToCues(Json3Payload(events))
        assertEquals("The doctor arrived. He examined the patient carefully. The tests showed a clear problem that required treatment.", result.joinToString(" ") { it.sourceText })
        assertTrue(result.none { it.sourceText.endsWith(" the") || it.sourceText.endsWith(" a") })
        assertTimeline(result)
    }
    @Test fun readingHoldBridgesShortGapsButNotLongSilence() {
        val input = listOf(Cue(8, 0, 400, "hello"), Cue(9, 2000, 2300, "world"), Cue(10, 10000, 10400, "end"))
        val result = CueBuilder.normalizeCueTimings(input)
        assertEquals(2000L, result[0].endMs)
        assertTrue(result[1].endMs < 10000)
        assertEquals(listOf(0, 1, 2), result.map { it.index })
        assertEquals(400L, input[0].endMs)
    }
    @Test fun fingerprintTracksTimingAndUtf16Text() {
        val cue = Cue(0, 0, 1000, "字幕 😀")
        val hash = CueBuilder.computeCuesFingerprint(listOf(cue))
        assertEquals(hash, CueBuilder.computeCuesFingerprint(listOf(cue.copy(translatedText = "translation"))))
        assertNotEquals(hash, CueBuilder.computeCuesFingerprint(listOf(cue.copy(endMs = 1001))))
        assertNotEquals(hash, CueBuilder.computeCuesFingerprint(listOf(cue.copy(sourceText = "other"))))
    }
    @Test fun binarySearchHonorsGapsAndInclusiveEnd() {
        val cues = listOf(Cue(0, 100, 200, "a"), Cue(1, 400, 500, "b"))
        assertEquals(-1, CueBuilder.findActiveCueIndex(cues, 300))
        assertEquals(0, CueBuilder.findActiveCueIndex(cues, 200))
        assertEquals(1, CueBuilder.findCurrentOrNextCueIndex(cues, 300))
        assertEquals(1, CueBuilder.findCurrentOrNextCueIndex(cues, 600))
        assertEquals(-1, CueBuilder.findCurrentOrNextCueIndex(emptyList(), 0))
    }
    private fun assertTimeline(cues: List<Cue>) {
        cues.forEachIndexed { i, cue -> assertEquals(i, cue.index); assertTrue(cue.endMs >= cue.startMs) }
        cues.zipWithNext().forEach { (a, b) -> assertTrue(a.endMs <= b.startMs) }
    }
}
