package dev.nihildigit.ytplus.xposed

import org.json.JSONObject

internal object CaptionDiscovery {
    /** Scan a balanced JSON object rather than matching nested braces with a regex. */
    fun playerResponse(html: String): JSONObject? {
        val marker = Regex("(?:var\\s+)?ytInitialPlayerResponse\\s*=\\s*").find(html) ?: return null
        val start = html.indexOf('{', marker.range.last + 1)
        if (start < 0) return null
        var depth = 0
        var quoted = false
        var escaped = false
        for (index in start until html.length) {
            val char = html[index]
            if (quoted) {
                if (escaped) escaped = false else if (char == '\\') escaped = true else if (char == '"') quoted = false
            } else when (char) {
                '"' -> quoted = true
                '{' -> depth++
                '}' -> if (--depth == 0) return JSONObject(html.substring(start, index + 1))
            }
        }
        return null
    }
    fun bestTrack(response: JSONObject, preferredLanguage: String = "en"): JSONObject? {
        val rows = response.optJSONObject("captions")?.optJSONObject("playerCaptionsTracklistRenderer")?.optJSONArray("captionTracks") ?: return null
        return (0 until rows.length()).map { rows.getJSONObject(it) }.filter { it.optString("baseUrl").isNotBlank() }
            .minByOrNull { row ->
                (if (row.optString("kind") == "asr") 10 else 0) + when (row.optString("languageCode").substringBefore('-')) {
                    preferredLanguage.substringBefore('-') -> 0
                    "en" -> 1
                    else -> 2
                }
            }
    }
}
