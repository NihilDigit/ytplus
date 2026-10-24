package dev.nihildigit.ytplus.xposed

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CaptionDiscoveryTest {
    @Test fun extractsNestedResponseAndIgnoresBracesInsideStrings() {
        val response = CaptionDiscovery.playerResponse("<script>var ytInitialPlayerResponse = {\"videoDetails\":{\"title\":\"A } \\\"quoted\\\" title\",\"videoId\":\"abcdefghijk\"},\"other\":[{}]};</script>")
        assertEquals("abcdefghijk", response!!.getJSONObject("videoDetails").getString("videoId"))
        assertNull(CaptionDiscovery.playerResponse("ytInitialPlayerResponse = {\"broken\":"))
    }
    @Test fun prefersManualTrackThenEnglishAndRequestedLanguage() {
        val json = JSONObject("""{"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[
            {"baseUrl":"https://www.youtube.com/api/timedtext?a=1","languageCode":"en","kind":"asr"},
            {"baseUrl":"https://www.youtube.com/api/timedtext?a=2","languageCode":"de"},
            {"baseUrl":"https://www.youtube.com/api/timedtext?a=3","languageCode":"en"}
        ]}}}""")
        assertEquals("en", CaptionDiscovery.bestTrack(json)!!.getString("languageCode"))
        assertEquals("de", CaptionDiscovery.bestTrack(json, "de-DE")!!.getString("languageCode"))
        json.getJSONObject("captions").getJSONObject("playerCaptionsTracklistRenderer").getJSONArray("captionTracks").remove(2)
        assertEquals("de", CaptionDiscovery.bestTrack(json)!!.getString("languageCode"))
    }
    @Test fun rejectsResponsesWithoutCaptions() { assertNull(CaptionDiscovery.bestTrack(JSONObject())) }
}
