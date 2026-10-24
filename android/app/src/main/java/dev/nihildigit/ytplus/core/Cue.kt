package dev.nihildigit.ytplus.core

/** A subtitle interval in video time, expressed in milliseconds. */
data class Cue(
    val index: Int,
    val startMs: Long,
    val endMs: Long,
    val sourceText: String,
    val translatedText: String? = null,
)
