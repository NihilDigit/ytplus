package dev.nihildigit.ytplus.xposed

import android.content.SharedPreferences
import dev.nihildigit.ytplus.core.TranslationConfig

/** One copied preference snapshot, shared by rendering and the runtime. */
data class AppConfig(
    val enabled: Boolean = true,
    val preferredSourceLanguage: String = "en",
    val displayMode: String = "bilingual",
    val fontSize: Float = 20f,
    val bottomOffset: Float = 72f,
    val backgroundEnabled: Boolean = true,
    val backgroundOpacity: Float = 0.42f,
    val prefetchWait: Boolean = true,
    val translation: TranslationConfig = TranslationConfig("https://api.openai.com/v1", model = "", targetLang = "Chinese"),
    val sponsorBlockEnabled: Boolean = true,
    val sponsorBlockCategories: Set<String> = setOf("sponsor", "selfpromo", "interaction"),
) {
    companion object {
        fun read(preferences: SharedPreferences?, localOverrides: SharedPreferences? = null): AppConfig {
            val remoteMap = preferences?.all.orEmpty()
            val localMap = localOverrides?.all.orEmpty()
            val values = remoteMap + localMap
            val defaults = AppConfig()
            fun text(key: String, default: String) = values[key] as? String ?: default
            fun flag(key: String, default: Boolean) = values[key] as? Boolean ?: default
            fun number(key: String, default: Float) = (values[key] as? Number)?.toFloat()?.takeIf { it.isFinite() } ?: default
            return AppConfig(
                enabled = flag("enabled", true),
                preferredSourceLanguage = text("source_language", "en"),
                displayMode = text("display_mode", "bilingual"),
                fontSize = number("font_size", 20f).coerceIn(12f, 40f),
                bottomOffset = number("bottom_offset", 72f).coerceIn(0f, 240f),
                backgroundEnabled = flag("background_enabled", true),
                backgroundOpacity = number("background_opacity", 0.42f).coerceIn(0f, 1f),
                prefetchWait = flag("prefetch_wait", true),
                translation = TranslationConfig(text("api_url", defaults.translation.apiBaseUrl), text("api_key", ""), text("model", ""), text("target_language", "Chinese"), text("extra_prompt", "")),
                sponsorBlockEnabled = flag("sponsorblock_enabled", true),
                sponsorBlockCategories = (values["sponsorblock_categories"] as? Set<*>)?.filterIsInstance<String>()?.toSet() ?: defaults.sponsorBlockCategories,
            )
        }
    }
}
