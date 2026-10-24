package dev.nihildigit.ytplus.xposed

import android.content.SharedPreferences
import java.lang.reflect.Proxy
import org.junit.Assert.assertEquals
import org.junit.Test

class AppConfigTest {
    private fun prefs(values: Map<String, Any>): SharedPreferences = Proxy.newProxyInstance(
        SharedPreferences::class.java.classLoader, arrayOf(SharedPreferences::class.java)
    ) { _, method, _ ->
        check(method.name == "getAll")
        values
    } as SharedPreferences

    @Test fun opacityDefaultsToFortyTwoPercent() {
        assertEquals(0.42f, AppConfig.read(null).backgroundOpacity, 0f)
    }

    @Test fun opacityReadsRemoteAndLocalOverrides() {
        val remote = prefs(mapOf("background_opacity" to 0.6f))
        assertEquals(0.6f, AppConfig.read(remote).backgroundOpacity, 0f)
        assertEquals(0.2f, AppConfig.read(remote, prefs(mapOf("background_opacity" to 0.2f))).backgroundOpacity, 0f)
    }

    @Test fun opacityClampsAndRejectsNonFiniteValues() {
        for ((value, expected) in listOf(-1f to 0f, 2f to 1f, Float.NaN to 0.42f, Float.POSITIVE_INFINITY to 0.42f)) {
            assertEquals(expected, AppConfig.read(prefs(mapOf("background_opacity" to value))).backgroundOpacity, 0f)
        }
    }
}
