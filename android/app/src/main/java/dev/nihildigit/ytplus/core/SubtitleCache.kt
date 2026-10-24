package dev.nihildigit.ytplus.core

import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest

/** Thread-safe bounded cache. Pass an app-private directory for persistence. */
class SubtitleCache(private val directory: File? = null, private val maxEntries: Int = 120) {
    private val memory = LinkedHashMap<String, Map<Int, String>>(16, .75f, true)
    init { require(maxEntries > 0) }
    @Synchronized fun get(key: String): Map<Int, String>? {
        memory[key]?.let { return it.toMap() }
        val file = file(key) ?: return null
        val loaded = runCatching {
            if (!file.isFile) return null
            val record = JSONObject(file.readText())
            if (record.optString("key") != key) return null
            val entries = record.getJSONObject("translations"); val result = linkedMapOf<Int, String>()
            for (name in entries.keys()) { val index = name.toIntOrNull() ?: continue; val text = entries.opt(name) as? String ?: continue; if (text.isNotBlank()) result[index] = text }
            result.toMap()
        }.getOrNull() ?: return null
        memory[key] = loaded; pruneMemory(); return loaded.toMap()
    }
    @Synchronized fun merge(key: String, partial: Map<Int, String>) {
        val merged = (get(key).orEmpty() + partial.filter { it.key >= 0 && it.value.isNotBlank() }).toMap()
        memory[key] = merged; pruneMemory()
        val file = file(key) ?: return
        // Persistence failure must not discard successfully translated in-memory cues.
        runCatching {
            directory?.mkdirs()
            val entries = JSONObject(); merged.forEach { (i, text) -> entries.put(i.toString(), text) }
            val raw = JSONObject().put("key", key).put("updatedAt", System.currentTimeMillis()).put("translations", entries).toString()
            val temp = File(file.parentFile, file.name + ".tmp")
            FileOutputStream(temp).use { it.write(raw.toByteArray(Charsets.UTF_8)); it.fd.sync() }
            check(temp.renameTo(file)) { "Cannot replace subtitle cache" }
            directory?.listFiles { f -> f.extension == "json" }?.sortedByDescending { it.lastModified() }?.drop(maxEntries)?.forEach { it.delete() }
        }
    }
    private fun pruneMemory() { while (memory.size > maxEntries) memory.remove(memory.keys.first()) }
    private fun file(key: String): File? = directory?.let { File(it, digest(key) + ".json") }
    companion object {
        fun makeKey(videoId: String, trackId: String, fingerprint: String, targetLang: String, model: String): String = "$videoId::$trackId::$fingerprint::$targetLang::$model"
        /** Endpoint and prompt changes must not silently reuse translations from another setup. */
        fun makeKey(videoId: String, trackId: String, cues: List<Cue>, config: TranslationConfig): String = makeKey(videoId, trackId, CueBuilder.computeCuesFingerprint(cues), config.targetLang, config.model.trim()) + "::" + digest(LlmClient.normalizeBaseUrl(config.apiBaseUrl) + "\n" + config.customPrompt)
        private fun digest(s: String) = MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it.toInt() and 255) }
    }
}
