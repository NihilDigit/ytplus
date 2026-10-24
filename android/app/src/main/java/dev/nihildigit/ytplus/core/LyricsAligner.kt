package dev.nihildigit.ytplus.core

import kotlin.math.*

/** Needleman-Wunsch alignment: rolling score rows plus compact backtrace storage. */
object LyricsAligner {
    private fun normalized(s: String) = s.lowercase().replace(Regex("[^a-z0-9]"), "")
    private fun skeleton(s: String) = s.replace("ph", "f").replace("ck", "k").replace("qu", "kw").replace("sh", "s").replace("ch", "c").replace("th", "t").replace(Regex("[aeiouy]+"), "a")
    internal fun similarity(a: String, b: String): Double {
        val x = normalized(a); val y = normalized(b)
        if (x.isEmpty() || y.isEmpty()) return 0.0
        if (x == y) return 1.0
        if (x.length >= 3 && y.length >= 3 && (x.startsWith(y) || y.startsWith(x))) return .82
        val p = skeleton(x)
        if (p == skeleton(y) && p.length >= 2) return .78
        if (x.zip(y).count { it.first == it.second }.toDouble() / max(x.length, y.length) >= .6) return .55
        return -.25
    }
    fun alignLyricsToAsrEvents(rawLyrics: String, events: List<Json3Event>): List<Cue>? {
        val asr = CueBuilder.tokens(events)
        if (asr.size < 10 || asr.size > 6000) return null
        val lines = cleanLyricLines(rawLyrics)
        if (lines.size < 4) return null
        val words = lines.flatMapIndexed { i, line -> line.split(Regex("\\s+")).map { it to i } }
        val m = words.size; val n = asr.size
        if (m < 10 || m > 4500) return null
        val stride = n + 1; val back = ByteArray((m + 1) * stride)
        var previous = FloatArray(stride); var current = FloatArray(stride)
        for (j in 1..n) { previous[j] = previous[j - 1] - .15f; back[j] = 3 }
        for (i in 1..m) {
            current[0] = previous[0] - .05f; back[i * stride] = 2
            for (j in 1..n) {
                val match = previous[j - 1] + similarity(words[i - 1].first, asr[j - 1].text)
                val skipL = previous[j] - if (j == n) .05 else .18
                val skipA = current[j - 1] - .18
                val action: Byte; val score: Double
                if (match >= skipL && match >= skipA) { action = 1; score = match }
                else if (skipL >= skipA) { action = 2; score = skipL }
                else { action = 3; score = skipA }
                current[j] = score.toFloat(); back[i * stride + j] = action
            }
            val swap = previous; previous = current; current = swap
        }
        val anchors = mutableListOf<Pair<Int, Int>>(); var i = m; var j = n
        while (i > 0 || j > 0) {
            when (back[i * stride + j].toInt()) {
                1 -> { if (similarity(words[i - 1].first, asr[j - 1].text) >= .5) anchors += (i - 1) to (j - 1); i--; j-- }
                2 -> i--
                else -> j--
            }
        }
        anchors.reverse()
        if (anchors.size < 12 || anchors.size.toDouble() / min(m, n) < .28) return null
        val starts = LongArray(m) { -1 }; val ends = LongArray(m) { -1 }; val bounds = LongArray(m) { -1 }
        for ((li, aj) in anchors) { starts[li] = asr[aj].start; ends[li] = asr[aj].end; bounds[li] = asr[aj].bound }
        for (a in 0 until anchors.lastIndex) {
            val (l1, a1) = anchors[a]; val (l2, a2) = anchors[a + 1]; val count = l2 - l1 - 1
            if (count <= 0) continue
            val t1 = asr[a1].end; val t2 = max(t1 + 40, asr[a2].start)
            for (k in 1..count) {
                starts[l1 + k] = (t1 + (t2 - t1).toDouble() * (k - 1) / count).roundToLong()
                ends[l1 + k] = (t1 + (t2 - t1).toDouble() * k / count).roundToLong(); bounds[l1 + k] = asr[a2].bound
            }
        }
        val (firstL, firstA) = anchors.first(); val (lastL, lastA) = anchors.last()
        var lead = 0
        for (li in firstL - 1 downTo 0) {
            if (words[li].second != words[firstL].second) break
            lead++; starts[li] = max(asr.first().start, asr[firstA].start - lead * 220); ends[li] = starts[li] + 200; bounds[li] = asr[firstA].bound
        }
        var trail = 0
        for (li in lastL + 1 until m) {
            if (words[li].second != words[lastL].second) break
            starts[li] = asr[lastA].end + trail * 220; ends[li] = starts[li] + 220; bounds[li] = asr[lastA].bound; trail++
        }
        val anchorCounts = IntArray(lines.size); val wordCounts = IntArray(lines.size)
        words.forEach { wordCounts[it.second]++ }; anchors.forEach { anchorCounts[words[it.first].second]++ }
        var firstLine = 0; var lastLine = lines.lastIndex
        while (firstLine < lines.size && anchorCounts[firstLine] < min(2, wordCounts[firstLine])) firstLine++
        while (lastLine >= firstLine && anchorCounts[lastLine] < min(2, wordCounts[lastLine])) lastLine--
        if (firstLine > lastLine) return null
        val cues = mutableListOf<Cue>(); val eventBounds = mutableListOf<Long>()
        for (line in firstLine..lastLine) {
            val indices = words.indices.filter { words[it].second == line && starts[it] >= 0 }
            if (indices.isEmpty()) continue
            val start = starts[indices.first()]; val end = indices.maxOf { ends[it] }; val bound = indices.maxOf { bounds[it] }
            cues += Cue(cues.size, start, max(start + 400, end), lines[line]); eventBounds += if (bound > 0) bound else end + 1200
        }
        return cues.takeIf { it.isNotEmpty() }?.let { CueBuilder.normalizeCueTimings(it, eventBounds) }
    }
}

internal fun cleanLyricLines(raw: String): List<String> = raw.lineSequence().map { it.replace(Regex("\\s+"), " ").trim() }.filter { it.isNotEmpty() && !Regex("^\\[.*]$").matches(it) && !Regex("^\\d+\\s*Contributors|Lyrics$", RegexOption.IGNORE_CASE).containsMatchIn(it) }.toList()
