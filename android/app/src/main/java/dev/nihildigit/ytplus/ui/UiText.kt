package dev.nihildigit.ytplus.ui

import java.util.Locale

/** Follow the system language in both the module and the injected player UI. */
internal fun uiText(chinese: String, english: String): String =
    if (Locale.getDefault().language == "zh") chinese else english
