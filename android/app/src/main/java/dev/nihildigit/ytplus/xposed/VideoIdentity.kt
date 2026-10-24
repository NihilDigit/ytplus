package dev.nihildigit.ytplus.xposed

import java.net.URI
import java.net.URLDecoder

internal object VideoIdentity {
    private val id = Regex("[A-Za-z0-9_-]{11}")
    fun fromUrl(url: String): String? = runCatching {
        val uri = URI(url)
        val host = uri.host.orEmpty().lowercase()
        if (host != "youtu.be" && host != "youtube.com" && !host.endsWith(".youtube.com")) return null
        val queryId = uri.rawQuery.orEmpty().split('&').firstOrNull { it.startsWith("v=") }
            ?.substringAfter('=')?.let { URLDecoder.decode(it, "UTF-8") }
        val pathId = when {
            host == "youtu.be" -> uri.path.trim('/').substringBefore('/')
            uri.path.startsWith("/shorts/") -> uri.path.removePrefix("/shorts/").substringBefore('/')
            else -> null
        }
        (queryId ?: pathId)?.takeIf { id.matches(it) }
    }.getOrNull()
    fun observe(url: String) { fromUrl(url)?.let { RuntimeBridge.core?.onVideoChanged(it) } }
}
