package dev.nihildigit.ytplus.xposed

import org.junit.Assert.*
import org.junit.Test
import java.nio.ByteBuffer

class TimedTextTapTest {
    @Test fun copiesOnlyNewCronetBytesWithoutChangingHostBuffer() {
        val buffer = ByteBuffer.allocateDirect(32)
        buffer.put(byteArrayOf(9, 9, 1, 2, 3))
        buffer.limit(20)
        val beforePosition = buffer.position()
        val beforeLimit = buffer.limit()
        assertArrayEquals(byteArrayOf(1, 2, 3), TimedTextTap().copyCronetBytes(buffer, 2))
        assertEquals(beforePosition, buffer.position())
        assertEquals(beforeLimit, buffer.limit())
    }

    @Test fun rejectsInvalidReadOffsets() {
        val buffer = ByteBuffer.allocate(8).apply { position(4) }
        assertTrue(TimedTextTap().copyCronetBytes(buffer, 5).isEmpty())
        assertTrue(TimedTextTap().copyCronetBytes(buffer, -1).isEmpty())
        assertEquals(4, buffer.position())
    }
}
