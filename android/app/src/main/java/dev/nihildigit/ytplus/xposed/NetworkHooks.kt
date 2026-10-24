package dev.nihildigit.ytplus.xposed

import java.io.ByteArrayOutputStream
import java.io.FilterInputStream
import java.io.InputStream
import java.net.URL
import java.net.URLConnection
import java.nio.ByteBuffer
import java.util.Collections
import java.util.WeakHashMap

internal class NetworkHooks(private val hooks: HookInstaller, private val tap: TimedTextTap) {
    private data class Capture(val url: String, val output: ByteArrayOutputStream = ByteArrayOutputStream(), var overflow: Boolean = false)
    private val requests = Collections.synchronizedMap(WeakHashMap<Any, Capture>())
    private val builders = Collections.synchronizedMap(WeakHashMap<Any, String>())
    private val positions = Collections.synchronizedMap(WeakHashMap<Any, Int>())
    private val inspecting = ThreadLocal<Boolean>()

    fun install(loader: ClassLoader) {
        URL::class.java.declaredMethods.filter { it.name == "openConnection" }.forEach { method ->
            hooks.after(method) { receiver, _, result ->
                val url = (receiver as? URL)?.toString() ?: return@after
                VideoIdentity.observe(url)
                if (tap.accepts(url) && result is URLConnection) {
                    tap.observed(url)
                    hookConnection(result.javaClass)
                }
            }
        }
        ClassLoader::class.java.getDeclaredMethod("loadClass", String::class.java, Boolean::class.javaPrimitiveType!!).let { method ->
            hooks.after(method) { _, args, result ->
                val name = args.firstOrNull() as? String ?: return@after
                if (inspecting.get() == true || !name.startsWith("org.chromium.net.")) return@after
                if (result is Class<*>) {
                    inspecting.set(true)
                    try { inspectCronet(result) } finally { inspecting.remove() }
                }
            }
        }
        listOf("org.chromium.net.impl.CronetUrlRequestContext", "org.chromium.net.impl.JavaCronetEngine",
            "org.chromium.net.impl.CronetUrlRequest", "org.chromium.net.impl.UrlRequestBuilderImpl").forEach {
            runCatching { inspectCronet(loader.loadClass(it)) }
        }
    }

    private fun hookConnection(type: Class<*>) {
        val method = runCatching { type.getMethod("getInputStream") }.getOrNull() ?: return
        hooks.around(method) { receiver, _, proceed ->
            val input = proceed()
            val url = (receiver as? URLConnection)?.url?.toString()
            if (input !is InputStream || url == null || !tap.accepts(url)) input
            else object : FilterInputStream(input) {
                private val output = ByteArrayOutputStream()
                private var overflow = false
                private var done = false
                private fun append(bytes: ByteArray, offset: Int, size: Int) {
                    if (size < 0) {
                        if (!done && !overflow) { done = true; tap.received(url, output.toByteArray()) }
                    } else if (!overflow) {
                        if (output.size() + size > TimedTextTap.MAX_BYTES) { overflow = true; output.reset() }
                        else output.write(bytes, offset, size)
                    }
                }
                override fun read(): Int {
                    val value = `in`.read()
                    append(if (value < 0) byteArrayOf() else byteArrayOf(value.toByte()), 0, if (value < 0) -1 else 1)
                    return value
                }
                override fun read(bytes: ByteArray, offset: Int, length: Int): Int {
                    val count = `in`.read(bytes, offset, length)
                    append(bytes, offset, count)
                    return count
                }
                // Reset/skip break the copied document, but never change upstream stream semantics.
                override fun reset() { `in`.reset(); overflow = true; output.reset() }
                override fun skip(count: Long): Long = `in`.skip(count).also { if (it > 0) { overflow = true; output.reset() } }
            }
        }
    }

    private fun inspectCronet(type: Class<*>) {
        type.declaredMethods.filter { !java.lang.reflect.Modifier.isAbstract(it.modifiers) }.forEach { method ->
            when (method.name) {
                "newUrlRequestBuilder" -> hooks.after(method) { _, args, result ->
                    val url = args.firstOrNull() as? String ?: return@after
                    VideoIdentity.observe(url)
                    if (!tap.accepts(url)) return@after
                    tap.observed(url)
                    if (result != null) builders[result] = url
                    args.firstOrNull { hasCallback(it) }?.let { hookCallback(it.javaClass) }
                    result?.javaClass?.methods?.filter { it.name == "build" && it.parameterCount == 0 }?.forEach { build ->
                        hooks.after(build) { builder, _, request ->
                            val acceptedUrl = builders.remove(builder) ?: return@after
                            request?.let { requests[it] = Capture(acceptedUrl); inspectCronet(it.javaClass) }
                        }
                    }
                }
                "read" -> if (method.parameterTypes.contentEquals(arrayOf(ByteBuffer::class.java))) {
                    hooks.around(method) { receiver, args, proceed ->
                        if (receiver != null && requests.containsKey(receiver)) (args.firstOrNull() as? ByteBuffer)?.let { positions[receiver] = it.position() }
                        proceed()
                    }
                }
            }
        }
    }

    private fun hasCallback(value: Any?): Boolean = value != null && value.javaClass.methods.any { it.name == "onReadCompleted" }

    private fun hookCallback(type: Class<*>) {
        type.methods.filter { it.name in setOf("onResponseStarted", "onReadCompleted", "onSucceeded", "onFailed", "onCanceled") }.forEach { method ->
            // Copy before the callback consumes/clears its ByteBuffer or starts the next read.
            hooks.around(method) { _, args, proceed ->
                try {
                    val request = args.getOrNull(0)
                    val capture = requests[request]
                    if (request != null && capture != null) {
                        when (method.name) {
                            "onResponseStarted" -> Unit
                            "onReadCompleted" -> {
                                val buffer = args.getOrNull(2) as? ByteBuffer
                                val start = positions.remove(request)
                                if (buffer != null && start != null && !capture.overflow) {
                                    val bytes = tap.copyCronetBytes(buffer, start)
                                    if (capture.output.size() + bytes.size > TimedTextTap.MAX_BYTES) {
                                        capture.overflow = true; capture.output.reset()
                                    } else capture.output.write(bytes)
                                }
                            }
                            "onSucceeded" -> {
                                requests.remove(request)?.let { if (!it.overflow) tap.received(it.url, it.output.toByteArray()) }
                                positions.remove(request)
                            }
                            else -> { requests.remove(request); positions.remove(request) }
                        }
                    }
                } catch (error: Throwable) { RuntimeBridge.log("Cronet copy failed", error) }
                proceed()
            }
        }
    }
}
