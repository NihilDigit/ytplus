package dev.nihildigit.ytplus.xposed

import android.content.Context
import android.os.Handler
import android.os.Looper
import java.lang.ref.WeakReference
import java.lang.reflect.Method
import java.lang.reflect.Modifier
import org.json.JSONObject

/** Fingerprints must be refreshed when YouTube changes its player implementation. */
class PlayerFingerprints(
    val markers: Map<String, List<String>> = mapOf(
        "videoId" to listOf("getVideoId"),
        "position" to listOf("getCurrentPosition"),
        "playing" to listOf("isPlaying"),
        "seek" to listOf("seekTo"),
        "play" to listOf("playVideo"),
        "pause" to listOf("pauseVideo"),
    ),
)

internal class PlayerDiscovery(private val context: Context, private val loader: ClassLoader, private val hooks: HookInstaller) {
    private val prefs = context.getSharedPreferences("ytpp_dexkit", Context.MODE_PRIVATE)
    private val main = Handler(Looper.getMainLooper())
    private val owners = java.util.concurrent.ConcurrentHashMap<Method, WeakReference<Any>>()
    private var videoId: String? = null
    @Volatile private var mediaActive = false
    @Volatile private var playback: android.media.session.PlaybackState? = null
    private var mediaSession: WeakReference<android.media.session.MediaSession>? = null
    private var callback: WeakReference<android.media.session.MediaSession.Callback>? = null
    private var callbackHandler: Handler? = null

    private fun installMediaSession() {
        val type = android.media.session.MediaSession::class.java
        val adapter = object : PlayerAdapter {
            override fun positionMs(): Long? = playback?.let { state ->
                if (state.position < 0) null else (state.position + if (state.state == android.media.session.PlaybackState.STATE_PLAYING)
                    ((android.os.SystemClock.elapsedRealtime() - state.lastPositionUpdateTime).coerceAtLeast(0) * state.playbackSpeed).toLong() else 0).coerceAtLeast(0)
            }
            override fun playbackSpeed(): Float = playback?.playbackSpeed ?: 1f
            override fun isPlaying(): Boolean? = playback?.let { it.state == android.media.session.PlaybackState.STATE_PLAYING }
            private fun command(action: (android.media.session.MediaSession.Callback) -> Unit): Boolean {
                val target = callback?.get() ?: return false
                // Player operations are dispatched on main, never from a network interceptor.
                return main.post { if (callback?.get() === target) runCatching { action(target) }.onFailure { RuntimeBridge.log("MediaSession command failed", it) } }
            }
            override fun seekTo(positionMs: Long) = command { it.onSeekTo(positionMs.coerceAtLeast(0)) }
            override fun setPlaying(playing: Boolean) = command { if (playing) it.onPlay() else it.onPause() }
        }
        hooks.after(type.getDeclaredMethod("setPlaybackState", android.media.session.PlaybackState::class.java)) { receiver, args, _ ->
            val session = receiver as? android.media.session.MediaSession ?: return@after
            val state = args.firstOrNull() as? android.media.session.PlaybackState ?: return@after
            // Ignore unrelated sessions once the active YouTube session has been selected.
            if (mediaSession?.get()?.let { it !== session } == true) return@after
            mediaSession = WeakReference(session)
            playback = state; mediaActive = true; RuntimeBridge.player = adapter
        }
        hooks.after(type.getDeclaredMethod("setMetadata", android.media.MediaMetadata::class.java)) { receiver, args, _ ->
            if (mediaSession?.get()?.let { it !== receiver } == true) return@after
            val metadata = args.firstOrNull() as? android.media.MediaMetadata ?: return@after
            metadata.getString(android.media.MediaMetadata.METADATA_KEY_MEDIA_URI)?.let(VideoIdentity::observe)
            metadata.getString(android.media.MediaMetadata.METADATA_KEY_MEDIA_ID)?.let { value ->
                if (value.matches(Regex("[A-Za-z0-9_-]{11}"))) RuntimeBridge.core?.onVideoChanged(value) else VideoIdentity.observe(value)
            }
            RuntimeBridge.core?.onMetadata(metadata.getString(android.media.MediaMetadata.METADATA_KEY_TITLE).orEmpty(),
                metadata.getString(android.media.MediaMetadata.METADATA_KEY_ARTIST) ?: metadata.getString(android.media.MediaMetadata.METADATA_KEY_ALBUM_ARTIST).orEmpty(),
                metadata.getLong(android.media.MediaMetadata.METADATA_KEY_DURATION))
        }
        hooks.after(type.getDeclaredMethod("setCallback", android.media.session.MediaSession.Callback::class.java, Handler::class.java)) { receiver, args, _ ->
            if (mediaSession?.get()?.let { it !== receiver } == true) return@after
            callback = (args.firstOrNull() as? android.media.session.MediaSession.Callback)?.let(::WeakReference)
            callbackHandler = args.getOrNull(1) as? Handler
        }
        hooks.after(type.getDeclaredMethod("release")) { receiver, _, _ ->
            if (mediaSession?.get() === receiver) { mediaActive = false; playback = null; callback = null; mediaSession = null }
        }
    }

    fun install(fingerprints: PlayerFingerprints = PlayerFingerprints()) {
        installMediaSession()
        Thread({
            try {
                val info = context.packageManager.getPackageInfo(context.packageName, 0)
                val version = if (android.os.Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()
                val key = "v2:$version:${info.lastUpdateTime}:${fingerprints.markers.hashCode()}"
                val cached = prefs.getString(key, null)?.let { runCatching { decode(JSONObject(it)) }.getOrNull() }
                val bindings = cached?.takeIf { it.isNotEmpty() } ?: discover(fingerprints).also { found ->
                    // Incomplete discoveries are retried rather than persisting a permanent miss.
                    if (found.size == fingerprints.markers.size) prefs.edit().putString(key, encode(found).toString()).apply()
                }
                main.post { bind(bindings) }
            } catch (error: Throwable) { RuntimeBridge.log("Player discovery failed", error) }
        }, "ytpp-dexkit").start()
    }

    private fun discover(fingerprints: PlayerFingerprints): Map<String, Method> {
        System.loadLibrary("dexkit")
        val bridgeClass = Class.forName("org.luckypray.dexkit.DexKitBridge")
        val create = bridgeClass.methods.first { it.name == "create" && it.parameterTypes.contentEquals(arrayOf(String::class.java)) }
        val paths = listOf(context.applicationInfo.sourceDir) + context.applicationInfo.splitSourceDirs.orEmpty()
        val candidates = mutableMapOf<String, MutableSet<Method>>()
        paths.forEach { path ->
            val bridge = HookInstaller.invoke(create, null, path) ?: return@forEach
            try {
                fingerprints.markers.forEach { (role, strings) ->
                    val matcherClass = Class.forName("org.luckypray.dexkit.query.matchers.MethodMatcher")
                    val matcher = matcherClass.getMethod("create").invoke(null)
                    val using = matcherClass.methods.first { it.name == "usingStrings" && it.parameterCount == 1 &&
                        (it.parameterTypes[0].isArray || Collection::class.java.isAssignableFrom(it.parameterTypes[0])) }
                    using.invoke(matcher, if (using.parameterTypes[0].isArray) strings.toTypedArray() else strings)
                    val queryClass = Class.forName("org.luckypray.dexkit.query.FindMethod")
                    val query = queryClass.getMethod("create").invoke(null)
                    queryClass.getMethod("matcher", matcherClass).invoke(query, matcher)
                    val results = bridgeClass.getMethod("findMethod", queryClass).invoke(bridge, query) as? Iterable<*> ?: return@forEach
                    results.filterNotNull().forEach { data ->
                        val method = runCatching { data.javaClass.getMethod("getMethodInstance", ClassLoader::class.java).invoke(data, loader) as Method }.getOrNull()
                        if (method != null && matches(role, method)) candidates.getOrPut(role) { mutableSetOf() }.add(method)
                    }
                }
            } finally { bridgeClass.getMethod("close").invoke(bridge) }
        }
        return candidates.mapNotNull { (role, methods) ->
            if (methods.size == 1) role to methods.single()
            else { RuntimeBridge.log("Ambiguous player role $role: ${methods.size} candidates", null); null }
        }.toMap()
    }

    private fun matches(role: String, method: Method): Boolean {
        if (Modifier.isAbstract(method.modifiers)) return false
        return when (role) {
            "videoId" -> method.parameterCount == 0 && method.returnType == String::class.java
            "position" -> method.parameterCount == 0 && method.returnType == Long::class.javaPrimitiveType
            "playing" -> method.parameterCount == 0 && method.returnType == Boolean::class.javaPrimitiveType
            "seek" -> method.parameterTypes.contentEquals(arrayOf(Long::class.javaPrimitiveType)) && method.returnType == Void.TYPE
            "play", "pause" -> method.parameterCount == 0 && method.returnType == Void.TYPE
            else -> false
        }
    }

    private fun bind(bindings: Map<String, Method>) {
        if (bindings.isEmpty()) { RuntimeBridge.log("No verified player fingerprints matched this YouTube version", null); return }
        bindings.forEach { (role, method) ->
            hooks.after(method) { receiver, _, result ->
                if (receiver != null) {
                    // A controller often owns several methods. Capture once for every compatible role.
                    bindings.values.filter { it.declaringClass.isInstance(receiver) }.forEach { owners[it] = WeakReference(receiver) }
                }
                if (role == "videoId" && result is String && result.matches(Regex("[A-Za-z0-9_-]{11}")) && result != videoId) {
                    videoId = result; RuntimeBridge.core?.onVideoChanged(result)
                }
            }
        }
        if (mediaActive) return
        RuntimeBridge.player = object : PlayerAdapter {
            private fun invoke(role: String, vararg args: Any?): Any? {
                check(Looper.myLooper() == Looper.getMainLooper()) { "Player calls must run on main thread" }
                val method = bindings[role] ?: return null
                val receiver = if (Modifier.isStatic(method.modifiers)) null else owners[method]?.get() ?: return null
                return HookInstaller.invoke(method, receiver, *args)
            }
            private fun command(role: String, vararg args: Any?): Boolean {
                val method = bindings[role] ?: return false
                if (!Modifier.isStatic(method.modifiers) && owners[method]?.get() == null) return false
                main.post { runCatching { invoke(role, *args) }.onFailure { RuntimeBridge.log("Player command failed: $role", it) } }
                return true // Accepted for dispatch, not an acknowledgement from the player.
            }
            override fun positionMs(): Long? = invoke("position") as? Long
            override fun isPlaying(): Boolean? = invoke("playing") as? Boolean
            override fun seekTo(positionMs: Long): Boolean = command("seek", positionMs.coerceAtLeast(0))
            override fun setPlaying(playing: Boolean): Boolean = command(if (playing) "play" else "pause")
        }
    }

    private fun encode(bindings: Map<String, Method>) = JSONObject().apply {
        bindings.forEach { (role, method) -> put(role, JSONObject().put("owner", method.declaringClass.name).put("name", method.name)) }
    }
    private fun decode(json: JSONObject): Map<String, Method> = json.keys().asSequence().associateWith { role ->
        val entry = json.getJSONObject(role)
        val type = loader.loadClass(entry.getString("owner"))
        type.declaredMethods.single { it.name == entry.getString("name") && matches(role, it) }
    }
}
