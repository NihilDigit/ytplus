package dev.nihildigit.ytplus.core

import org.json.JSONObject
import java.io.StringReader
import javax.xml.parsers.DocumentBuilderFactory
import org.xml.sax.InputSource
import kotlin.math.*

data class Json3Seg(val utf8: String = "", val tOffsetMs: Long? = null, val isSpeakerChange: Int = 0)
data class Json3Event(val tStartMs: Long? = null, val dDurationMs: Long? = null, val aAppend: Int = 0, val segs: List<Json3Seg> = emptyList())
data class Json3Payload(val events: List<Json3Event> = emptyList())
internal data class TimedToken(val text: String, val start: Long, val end: Long, val bound: Long, val syllables: Int, val speaker: Boolean = false)

object CueBuilder {
    private fun words(s: String) = s.split(Regex("\\s+")).filter { it.isNotEmpty() }
    private fun set(s: String) = s.split(' ').toSet()
    private val det = set("a an the my your his her its our their this that these those some any no every each all both half many few several one two three four five six seven eight nine ten first second third fourth fifth sixth seventh eighth ninth tenth")
    private val hanging = set("a an the my your his her its our their every each to of for with by from as into like than without through between until till against and or nor yet because since unless although though while if when where how what who whom whose which i he she we they i'm you're we're they're he's she's it's that's there's who's what's i'll you'll we'll they'll i'd you'd i've you've we've not quite very too more most such")
    private val soft = set("in on at over under after before about am is are was were be been being have has had do does did will would shall should can could may might must don't doesn't didn't won't wouldn't can't couldn't shouldn't isn't aren't wasn't weren't some any no this that these those")
    private val continuers = set("for to with of from in on at by into like than without about through over under between after before until till against up down out off away back around along is are was were be been am has have had will would shall should can could may might must did does didn't doesn't won't wouldn't can't couldn't")
    private val nominative = set("i i'm i'll i'd i've we we're they they're he she you're you'll you've that's there's who's it's maybe")
    private val pure = nominative + set("now when if but look")
    private val gapStarters = set("you this who what where why how so take lose and from do don't")
    private val conjunctions = set("because although though unless while whereas since until till whether which where when whenever wherever but yet so if")
    private val prep = set("into from through between without against under over during including compared according despite towards toward within throughout across among beyond before after")
    private val intro = set("now however instead meanwhile therefore thus furthermore moreover nevertheless nonetheless otherwise today yesterday finally eventually fortunately unfortunately surprisingly interestingly basically essentially overall first second third next then so well plus also")
    private val strong = Regex("[.?!。？！…]+[\"')\\]）】》”’]*$")
    private val clause = Regex("[,;:—–，；：、]+[\"')\\]）】》”’]*$")
    private val cjk = Regex("[\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff66-\\uff9f]")
    private val tags = Regex("\\[(?:music|applause|laughter|laughing|cheering|sighs|sighing|gasps|groans|coughs|♪|[^\\]]*(?:music|applause|laughter|cheering|sound|sfx|noise|audio)[^\\]]*)\\]|\\((?:music|applause|laughter|laughing|cheering|sighs|gasps|♪)\\)|♪+", RegexOption.IGNORE_CASE)
    private fun norm(s: String) = s.lowercase().replace(Regex("[^a-z']"), "")
    private fun clean(s: String): String = s.replace(Regex("[\\r\\n\\u00a0]+"), " ").replace(tags, " ").replace(Regex("(?:^|\\s)>>+\\s*"), " ").replace(Regex("\\s+"), " ").trim().let { if (Regex("^\\[.*]$").matches(it)) "" else it }
    internal fun syllables(s: String): Int {
        val p = s.replace(Regex("[^a-zA-Z0-9']"), "")
        if (p.matches(Regex("\\d+"))) return max(2, p.length)
        val upper = p.count { it in 'A'..'Z' }
        if (upper >= 2 && p == p.uppercase()) return min(8, upper)
        val w = s.lowercase().replace(Regex("[^a-z]"), "")
        if (w.length <= 3) return 1
        return max(1, Regex("[aeiouy]{1,2}").findAll(w.replace(Regex("(?:[^laeiouy]es|ed|[^laeiouy]e)$"), "").replace(Regex("^y"), "")).count())
    }
    private fun sentence(s: String, next: String? = null, delta: Long = 2000): Boolean {
        if (!strong.containsMatchIn(s.trim())) return false
        val core = s.trim().replace(Regex("[\"')\\]）】》”’]+$"), "")
        if (Regex("[?!。？！…]$").containsMatchIn(core)) return true
        val last = words(core).lastOrNull() ?: core
        if (Regex("^(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Mt|vs|v|etc|e\\.g|i\\.e|Fig|No|Vol|Capt|Gen|Gov|Sen|Rep|Rev|Hon|Pres|Bros)\\.$", RegexOption.IGNORE_CASE).matches(last)) return delta >= 1500
        if (Regex("^[A-Z]\\.$").matches(last)) return delta >= 1400
        val lower = next?.replace(Regex("^[\"'(（【《“‘]+"), "")?.firstOrNull()?.let { it in 'a'..'z' } == true
        if (Regex("^(?:Inc|Ltd|Co|Corp|Ph\\.D|M\\.D|B\\.A|M\\.A|U\\.S|U\\.K|E\\.U|U\\.N)\\.$", RegexOption.IGNORE_CASE).matches(last)) return !lower
        return !(lower && delta < 400)
    }
    internal fun join(tokens: List<TimedToken>): String {
        var out = ""
        for (t in tokens) {
            val s = t.text.replace(Regex("\\s+"), " ").trim()
            if (s.isEmpty()) continue
            val noAfter = out.isNotEmpty() && Regex("[\\u3000-\\u303f\\u3040-\\u9fff\\uff00-\\uffef(\\[{\"'“‘—-]").matches(out.last().toString())
            val noBefore = Regex("[\\u3000-\\u303f\\u3040-\\u9fff\\uff00-\\uffef.,!?;:%)\\]}\"'”’—-]").matches(s.first().toString()) || Regex("^'(?:s|t|re|ve|m|ll|d)\\b", RegexOption.IGNORE_CASE).containsMatchIn(s)
            out += (if (out.isEmpty() || noAfter || noBefore) "" else " ") + s
        }
        return out.trim()
    }
    fun parsePayload(raw: String): Json3Payload {
        val a = JSONObject(raw).optJSONArray("events") ?: return Json3Payload()
        return Json3Payload((0 until a.length()).mapNotNull { i ->
            val e = a.optJSONObject(i) ?: return@mapNotNull null
            val segs = e.optJSONArray("segs")
            Json3Event(if (e.has("tStartMs")) e.optLong("tStartMs") else null, if (e.has("dDurationMs")) e.optLong("dDurationMs") else null, e.optInt("aAppend"), (0 until (segs?.length() ?: 0)).mapNotNull { j ->
                segs?.optJSONObject(j)?.let { Json3Seg(it.optString("utf8"), if (it.has("tOffsetMs")) it.optLong("tOffsetMs") else null, it.optInt("isSpeakerChange")) }
            })
        })
    }
    fun parseJson3ToCues(raw: String, trackKind: String? = null) = parseJson3ToCues(parsePayload(raw), trackKind)
    fun parseJson3ToCues(payload: Json3Payload, trackKind: String? = null): List<Cue> {
        val e = payload.events
        val asr = trackKind == "asr" || e.count { it.aAppend == 1 } >= 3 || e.sumOf { it.segs.count { s -> (s.tOffsetMs ?: 0) > 0 } } >= 5
        if (!asr) return manual(e)
        val t = tokens(e)
        return if (hasAsrAutoPunctuation(e)) punctuated(t) else unpunctuated(t)
    }
    fun parseSrv3ToCues(raw: String, trackKind: String? = null): List<Cue> {
        // Android's Harmony parser does not implement every Xerces feature. Reject
        // declarations before parsing so security does not depend on those features.
        require(!Regex("<!\\s*(?:DOCTYPE|ENTITY)\\b", RegexOption.IGNORE_CASE).containsMatchIn(raw)) { "XML declarations are not allowed" }
        val factory = DocumentBuilderFactory.newInstance()
        runCatching { factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true) }
        runCatching { factory.setFeature("http://xml.org/sax/features/external-general-entities", false) }
        runCatching { factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false) }
        val doc = factory.newDocumentBuilder().parse(InputSource(StringReader(raw)))
        val paragraphs = doc.getElementsByTagName("p")
        val events = (0 until paragraphs.length).map { i ->
            val p = paragraphs.item(i) as org.w3c.dom.Element
            val s = p.getElementsByTagName("s")
            Json3Event(p.getAttribute("t").toLongOrNull(), p.getAttribute("d").toLongOrNull(), p.getAttribute("a").toIntOrNull() ?: 0,
                if (s.length == 0) listOf(Json3Seg(p.textContent)) else (0 until s.length).map { j -> val el = s.item(j) as org.w3c.dom.Element; Json3Seg(el.textContent, el.getAttribute("t").toLongOrNull()) })
        }
        return parseJson3ToCues(Json3Payload(events), trackKind)
    }
    internal fun tokens(events: List<Json3Event>): List<TimedToken> {
        val result = mutableListOf<TimedToken>(); var carry = false
        for (e in events) {
            val base = e.tStartMs ?: continue
            if (e.aAppend == 1 && e.segs.size == 1 && e.segs[0].utf8 == "\n") continue
            val bound = base + (e.dDurationMs?.takeIf { it > 0 } ?: 3200)
            for ((i, s) in e.segs.withIndex()) {
                val speaker = s.isSpeakerChange == 1 || Regex("(?:^|\\s)>>+\\s*").containsMatchIn(s.utf8)
                val text = clean(s.utf8)
                if (text.isEmpty()) { carry = carry || speaker; continue }
                val start = base + (s.tOffsetMs ?: 0)
                val next = e.segs.drop(i + 1).firstOrNull { it.tOffsetMs != null }?.tOffsetMs?.plus(base) ?: bound
                val ws = words(text); val sy = ws.map(::syllables)
                if (ws.size == 1) result += TimedToken(text, start, start + (sy[0] * 115L).coerceIn(130, 540), bound, sy[0], speaker || carry)
                else {
                    val total = sy.sum(); val span = min(if (next > start) next - start else total * 150L, max(ws.size * 40L, total * 150L)); var cursor = start
                    val cap = if (next > start) next else start + span
                    for (j in ws.indices) {
                        val duration = (span.toDouble() * sy[j] / total).roundToLong()
                        result += TimedToken(ws[j], cursor, min(cap, cursor + duration.coerceIn(80, 540)), bound, sy[j], j == 0 && (speaker || carry))
                        cursor = min(cap, cursor + max(1, duration))
                    }
                }
                carry = false
            }
        }
        return result
    }
    fun hasAsrAutoPunctuation(events: List<Json3Event>): Boolean {
        val t = tokens(events)
        return t.take(160).indices.count { i -> sentence(t[i].text, t.getOrNull(i + 1)?.text, t.getOrNull(i + 1)?.let { it.start - t[i].start } ?: 2000) } >= 2
    }
    fun normalizeCueTimings(cues: List<Cue>, bounds: List<Long> = emptyList()): List<Cue> {
        val out = cues.toMutableList()
        for (i in out.indices) {
            val c = out[i]; val next = out.getOrNull(i + 1)
            val reading = (c.sourceText.length * if (cjk.containsMatchIn(c.sourceText)) 105L else 52L).coerceIn(1250, 4200)
            val bound = bounds.getOrNull(i)
            val cap = if (bound != null && bound > c.endMs) min(bound, c.endMs + 2200) else c.endMs + 1600
            var end = min(cap, max(c.startMs + reading, c.endMs + 650))
            if (next != null) {
                val start = max(c.startMs, next.startMs)
                out[i + 1] = next.copy(startMs = start)
                end = min(start, end)
                if (start - end in 1..1100) end = start
                end = min(start, max(c.startMs, end))
            } else end = max(c.startMs + 200, end)
            out[i] = c.copy(index = i, endMs = end)
        }
        return out
    }
    private fun partition(t: List<TimedToken>, maxSpan: Int, cost: (Int, Int) -> Double): List<List<TimedToken>> {
        val n = t.size; val dp = DoubleArray(n + 1) { Double.POSITIVE_INFINITY }; val prev = IntArray(n + 1); dp[0] = 0.0
        for (i in 0 until n) for (j in i until min(n, i + maxSpan)) {
            val candidate = dp[i] + cost(i, j)
            if (candidate < dp[j + 1]) { dp[j + 1] = candidate; prev[j + 1] = i }
        }
        val parts = mutableListOf<List<TimedToken>>(); var end = n
        while (end > 0) { val start = prev[end]; parts += t.subList(start, end); end = start }
        return parts.reversed()
    }
    private fun unpunctuated(t: List<TimedToken>): List<Cue> {
        if (t.isEmpty()) return emptyList()
        val boundary = DoubleArray(t.size)
        boundary[t.lastIndex] = -200.0
        for (j in 0 until t.lastIndex) {
            val curr = t[j]; val next = t[j + 1]; val onset = next.start - curr.start; val silence = onset - curr.syllables * 115
            if (onset >= 1400) { boundary[j] = -600.0; continue }
            val p = norm(t.getOrNull(j - 1)?.text ?: ""); val c = norm(curr.text); val n = norm(next.text); val a = norm(t.getOrNull(j + 2)?.text ?: "")
            val nothingBut = c in set("nothing anything none") && n == "but"
            val np = n in pure && !nothingBut; val ng = n in gapStarters
            val prepDet = (c in continuers && p !in det) || c in det || c in hanging || p in set("which what whose whatever")
            val you = n == "you" && !prepDet && onset >= 160 && a.isNotEmpty() && a !in pure && a !in gapStarters && a !in continuers && a !in det
            val modifier = p in det && !np && !ng && !you && n !in continuers && silence < 180
            var cost = when { silence >= 320 -> -min(340.0, silence * .65); silence >= 160 -> -silence * .48; silence >= 60 -> -silence * .2; else -> 95.0 }
            if (n in nominative || you) { if (onset >= 150) cost -= 240 }
            else if (np) { if (onset >= 160) cost -= 220 }
            else if (ng) { if (silence >= 140 && onset >= 340) cost -= 140 }
            else if (n in set("my your") && silence >= 160 && onset >= 380) cost -= 150
            else if (n in set("my your") && silence < 130 && onset < 300) cost += 240
            cost += when { c in hanging || nothingBut -> 2400; modifier -> 520; c in soft && !np && !you && !(ng && silence >= 160) -> 460; else -> 0 }
            if ((n in continuers || (n == "a" && a in set("day week month year hour minute second time"))) && !np && onset < 850) cost += 220
            boundary[j] = cost
        }
        val parts = partition(t, 18) { i, j ->
            val count = j - i + 1; val duration = t[j].end - t[i].start; val next = t.getOrNull(j + 1); val onset = next?.let { it.start - t[j].start } ?: 2000
            var cost = 115.0 + when { count <= 2 && onset < 1100 -> (3 - count) * 320.0; count == 3 && onset < 650 -> 80.0; count in 4..10 -> -15.0; count > 11 -> (count - 11).toDouble().pow(2) * 28; else -> 0.0 }
            if (duration > 4200) cost += (duration - 4200) / 250.0 * 30 else if (duration < 900 && onset < 900) cost += 140
            if (norm(t[i].text) in set("when if") && count <= 6 && norm(next?.text ?: "") in set("that's it's")) cost += 320
            if (count <= 5 && norm(next?.text ?: "") in continuers) cost += 320
            cost + boundary[j]
        }
        val raw = parts.mapIndexed { i, s -> Cue(i, s.first().start, min(parts.getOrNull(i + 1)?.first()?.start ?: Long.MAX_VALUE, max(s.first().start + 450, s.last().end + 250)), join(s)) }.toMutableList()
        val counts = parts.map { it.size }.toMutableList(); val merged = mutableListOf<Cue>()
        for (i in raw.indices) {
            val c = raw[i]; val prev = merged.lastOrNull(); val next = raw.getOrNull(i + 1)
            if (counts[i] <= 2 && c.sourceText.length <= 10) {
                val gp = prev?.let { c.startMs - it.endMs } ?: Long.MAX_VALUE; val gn = next?.let { it.startMs - c.endMs } ?: Long.MAX_VALUE
                if (next != null && gn <= 900 && gn <= gp) { raw[i + 1] = next.copy(startMs = c.startMs, sourceText = c.sourceText + " " + next.sourceText); counts[i + 1] += counts[i]; continue }
                if (prev != null && gp <= 750) { merged[merged.lastIndex] = prev.copy(endMs = c.endMs, sourceText = prev.sourceText + " " + c.sourceText); continue }
            }
            merged += c
        }
        return normalizeCueTimings(merged)
    }
    private fun breath(t: List<TimedToken>): List<List<TimedToken>> {
        if (t.isEmpty()) return emptyList()
        val text = join(t); val isCjk = cjk.containsMatchIn(text); val comma = t.drop(1).dropLast(2).any { clause.containsMatchIn(it.text) }
        if (t.size <= (if (isCjk) 20 else if (comma) 14 else 16) && text.length <= (if (isCjk) 32 else if (comma) 74 else 90) && t.last().end - t.first().start <= 5000) return listOf(t)
        val target = text.length.toDouble() / max(2, (text.length.toDouble() / if (isCjk) 22 else 54).roundToInt())
        val maxWords = if (isCjk) 22 else 17; val maxChars = if (isCjk) 38 else 88
        val boundary = DoubleArray(t.size)
        for (b in 0 until t.lastIndex) {
            val curr = t[b]; val p = norm(t.getOrNull(b - 1)?.text ?: ""); val c = norm(curr.text); val n = norm(t[b + 1].text); val a = norm(t.getOrNull(b + 2)?.text ?: "")
            val punctuation = clause.containsMatchIn(curr.text); val silence = t[b + 1].start - curr.start - curr.syllables * 110
            val compound = (c == "so" && n == "that") || (c == "and" && n in set("then so yet also still")) || (p == "and" && c in set("then so yet also still")) || (c in set("more less rather other") && n == "than") || (c == "up" && n == "to") || (c == "such" && n == "as") || (c == "as" && n == "well") || (c == "in" && n == "order") || (c == "even" && n in set("though if"))
            var cost = when { (!isCjk && c in hanging && !punctuation) || compound || (c in det && !punctuation) -> 3600.0; !isCjk && c in soft && !punctuation -> 1600.0; !isCjk && p in det && !punctuation && n !in conjunctions && n !in prep && n !in continuers -> 650.0; else -> 0.0 }
            if (!isCjk && b <= 3 && n in set("is are was were has have had will would can could") && !punctuation) cost += 750
            if (punctuation) cost += if (b == 0 || (b == 1 && c in intro)) 220 else -320
            else if (n in conjunctions) cost -= 230
            else if (n in set("and or")) cost -= if (a in nominative || a in continuers || a in det || a in set("it they this that then just also even once when if")) 210 else if (t.size - 1 - b >= 4) 115 else 30
            else if (n in prep || (n == "to" && a.isNotEmpty() && a !in det)) cost -= 110
            if (silence >= 80) cost -= min(180.0, silence * .45)
            boundary[b] = cost
        }
        return partition(t, maxWords + 4) { a, b ->
            val count = b - a + 1; val chars = join(t.subList(a, b + 1)).length; val duration = t[b].end - t[a].start
            var cost = 155.0
            if (count <= 2 || chars < if (isCjk) 5 else 13) cost += 4800 + (3 - min(3, count)) * 1500
            else if (count == 3 && chars < if (isCjk) 8 else 18) cost += 420
            cost += ((chars - target) / 7.5).pow(2) * 16
            if (chars > maxChars) cost += 600 + (chars - maxChars).toDouble().pow(2) * 12
            if (count > maxWords) cost += 450 + (count - maxWords).toDouble().pow(2) * 90
            if (duration > 5400) cost += (duration - 5400) / 200.0 * 45
            cost + boundary[b]
        }
    }
    private fun punctuated(t: List<TimedToken>): List<Cue> {
        val sentences = mutableListOf<List<TimedToken>>(); var start = 0
        for (i in t.indices) {
            val c = t[i]; val next = t.getOrNull(i + 1); val onset = next?.let { it.start - c.start } ?: 2000; val n = norm(c.text)
            val pause = onset - c.syllables * 115 >= if (i - start + 1 <= 2 && !strong.containsMatchIn(c.text)) 1700 else 1150
            if (next == null || (pause && n !in hanging) || sentence(c.text, next.text, onset) || (next.speaker && n !in hanging && n !in soft && (onset >= 550 || Regex("^[A-Z\"“'‘]").containsMatchIn(next.text)))) { sentences += t.subList(start, i + 1); start = i + 1 }
        }
        val slices = sentences.flatMap(::breath).toMutableList(); val merged = mutableListOf<List<TimedToken>>()
        for (i in slices.indices) {
            val s = slices[i]; val next = slices.getOrNull(i + 1)
            if (next != null && s.size <= 2 && next.first().start - s.first().start < 700 && join(s + next).length <= 84) { slices[i + 1] = s + next; continue }
            merged += s
        }
        return normalizeCueTimings(merged.mapIndexed { i, s -> Cue(i, s.first().start, s.last().end, join(s)) }, merged.map { it.last().bound })
    }
    private fun manual(events: List<Json3Event>): List<Cue> {
        val raw = mutableListOf<Cue>()
        for (e in events) {
            val start = e.tStartMs ?: continue; val text = clean(e.segs.joinToString("") { it.utf8 }); if (text.isEmpty()) continue
            val end = start + (e.dDurationMs?.takeIf { it > 0 } ?: 2500); val prev = raw.lastOrNull()
            if (prev != null && prev.sourceText == text && abs(prev.startMs - start) < 200) raw[raw.lastIndex] = prev.copy(endMs = max(prev.endMs, end)) else raw += Cue(raw.size, start, end, text)
        }
        if (raw.isEmpty()) return raw
        for (i in 0 until raw.lastIndex) if (raw[i].endMs > raw[i + 1].startMs) raw[i] = raw[i].copy(endMs = raw[i + 1].startMs)
        val mid = raw.count { c -> val w = words(c.sourceText); (0 until w.lastIndex).any { sentence(w[it], w[it + 1], 600) } }
        val hang = raw.count { norm(words(it.sourceText).last()) in hanging }
        if ((mid >= 2 && mid.toDouble() / raw.size >= .15) || (hang >= 3 && hang.toDouble() / raw.size >= .18)) {
            val tokens = raw.flatMap { c ->
                val w = words(c.sourceText); val weights = w.map { syllables(it) + if (strong.containsMatchIn(it)) 2.2 else if (clause.containsMatchIn(it)) 1.2 else 0.0 }; val total = weights.sum(); val span = max(w.size * 120L, c.endMs - c.startMs); var cursor = c.startMs
                w.mapIndexed { i, word -> val sy = syllables(word); val share = max(90L, (span * weights[i] / total).roundToLong()); val end = if (i == w.lastIndex) c.endMs else min(c.endMs, cursor + share); val token = TimedToken(word, cursor, min(end, cursor + max(140, sy * 125)), c.endMs, sy); cursor = end; token }
            }
            return punctuated(tokens)
        }
        for (i in 0 until raw.lastIndex) {
            val c = raw[i]; val next = raw[i + 1]; val w = words(c.sourceText)
            if (next.startMs - c.endMs > 300 || w.size < 4) continue
            val last = w.last()
            if (norm(last) in hanging && !strong.containsMatchIn(last) && !clause.containsMatchIn(last)) {
                val shift = min(180, floor((c.endMs - c.startMs) * .1).toLong())
                raw[i] = c.copy(endMs = c.endMs - shift, sourceText = w.dropLast(1).joinToString(" "))
                raw[i + 1] = next.copy(startMs = next.startMs - shift, sourceText = "$last ${next.sourceText}")
            }
        }
        return raw
    }
    fun computeCuesFingerprint(cues: List<Cue>): String {
        var hash = 2166136261L.toInt()
        for (c in cues) { hash = (hash xor c.startMs.toInt()) * 16777619; hash = (hash xor c.endMs.toInt()) * 16777619; for (ch in c.sourceText) hash = (hash xor ch.code) * 16777619 }
        return "v2_c${cues.size}_${java.lang.Integer.toUnsignedString(hash, 36)}"
    }
    fun findActiveCueIndex(cues: List<Cue>, timeMs: Long): Int {
        var low = 0; var high = cues.lastIndex
        while (low <= high) { val mid = (low + high) ushr 1; val c = cues[mid]; if (timeMs < c.startMs) high = mid - 1 else if (timeMs > c.endMs) low = mid + 1 else return mid }
        return -1
    }
    fun findCurrentOrNextCueIndex(cues: List<Cue>, timeMs: Long): Int {
        var low = 0; var high = cues.lastIndex; var result = cues.lastIndex
        while (low <= high) { val mid = (low + high) ushr 1; if (cues[mid].endMs >= timeMs) { result = mid; high = mid - 1 } else low = mid + 1 }
        return result
    }
}
