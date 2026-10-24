package dev.nihildigit.ytplus.xposed

import org.junit.Assert.*
import org.junit.Test

class VideoIdentityTest {
    @Test fun detectsWatchTimedTextShortLinksAndShorts() {
        listOf("https://www.youtube.com/watch?v=abcDEF12_-3", "https://www.youtube.com/api/timedtext?lang=en&v=abcDEF12_-3", "https://youtu.be/abcDEF12_-3?t=30", "https://m.youtube.com/shorts/abcDEF12_-3").forEach {
            assertEquals(it, "abcDEF12_-3", VideoIdentity.fromUrl(it))
        }
    }
    @Test fun rejectsUntrustedHostsMalformedAndInvalidIds() {
        listOf("https://youtube.com.evil.test/watch?v=abcDEF12_-3", "https://www.youtube.com/watch?v=short", "not a URL", "https://youtu.be/abcDEF12_-34").forEach { assertNull(it, VideoIdentity.fromUrl(it)) }
    }
}
