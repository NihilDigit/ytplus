package dev.nihildigit.ytplus.xposed

import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import dev.nihildigit.ytplus.overlay.SubtitleOverlay
import io.github.libxposed.api.XposedModule
import io.github.libxposed.api.XposedModuleInterface.ModuleLoadedParam
import io.github.libxposed.api.XposedModuleInterface.PackageReadyParam
import java.util.concurrent.atomic.AtomicBoolean

class YtPlusModule : XposedModule() {
    private val initialized = AtomicBoolean()
    private val registered = AtomicBoolean()
    private var preferences: SharedPreferences? = null
    private var localOverrides: SharedPreferences? = null
    private val preferenceListener = SharedPreferences.OnSharedPreferenceChangeListener { _, _ ->
        // When the host app updates RemotePreferences, clear stale local overrides so host changes take effect
        localOverrides?.edit()?.clear()?.apply()
        refreshPreferences()
    }

    override fun onModuleLoaded(param: ModuleLoadedParam) {
        RuntimeBridge.log = { message, error ->
            if (error == null) Log.i("YtPremiumPlus", message) else Log.w("YtPremiumPlus", message, error)
        }
    }

    override fun onPackageReady(param: PackageReadyParam) {
        val packageName = param.packageName
        if (packageName != "com.google.android.youtube" || !registered.compareAndSet(false, true)) return
        val loader = param.classLoader
        val hooks = HookInstaller(this)
        hooks.after(Application::class.java.getDeclaredMethod("attach", Context::class.java)) { application, args, _ ->
            val context = args.firstOrNull() as? Context ?: return@after
            if (context.packageName != packageName || !initialized.compareAndSet(false, true)) return@after
            initialize(context, loader, hooks, application as? Application)
        }
        // Package-ready can be delivered after Application.attach on some host paths.
        runCatching {
            val activityThread = Class.forName("android.app.ActivityThread")
            val application = activityThread.getMethod("currentApplication").invoke(null) as? Application
            if (application?.packageName == packageName && initialized.compareAndSet(false, true)) {
                initialize(application, loader, hooks, application)
            }
        }.onFailure { RuntimeBridge.log("Application not available at package-ready", it) }
    }

    private fun initialize(context: Context, loader: ClassLoader, hooks: HookInstaller, application: Application?) {
        val appContext = context.applicationContext ?: context
        localOverrides = appContext.getSharedPreferences("ytpp_local_overrides", Context.MODE_PRIVATE)
        RuntimeBridge.core = InstalledCoreAdapter(appContext)
        runCatching {
            preferences = getRemotePreferences("ytpp_settings")
            preferences?.registerOnSharedPreferenceChangeListener(preferenceListener)
            refreshPreferences()
        }.onFailure { RuntimeBridge.log("Remote preferences unavailable", it) }
        hooks.after(Activity::class.java.getDeclaredMethod("onNewIntent", android.content.Intent::class.java)) { _, args, _ ->
            (args.firstOrNull() as? android.content.Intent)?.dataString?.let(VideoIdentity::observe)
        }
        NetworkHooks(hooks, TimedTextTap()).install(loader)
        PlayerDiscovery(context, loader, hooks).install(RuntimeBridge.fingerprints)
        val app = application ?: context.applicationContext as? Application ?: return
        app.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            override fun onActivityResumed(activity: Activity) {
                refreshPreferences()
                activity.intent?.dataString?.let(VideoIdentity::observe)
                SubtitleOverlay.attach(activity)?.start()
            }
            override fun onActivityPaused(activity: Activity) { SubtitleOverlay.find(activity)?.stop() }
            override fun onActivityDestroyed(activity: Activity) { SubtitleOverlay.find(activity)?.stop() }
            override fun onActivityCreated(activity: Activity, state: android.os.Bundle?) = Unit
            override fun onActivityStarted(activity: Activity) = Unit
            override fun onActivityStopped(activity: Activity) = Unit
            override fun onActivitySaveInstanceState(activity: Activity, state: android.os.Bundle) = Unit
        })
    }

    private fun refreshPreferences() {
        runCatching {
            val config = AppConfig.read(preferences, localOverrides)
            RuntimeBridge.config.value = config
            RuntimeBridge.enabled.value = config.enabled
            RuntimeBridge.bilingual.value = config.displayMode == "bilingual"
            RuntimeBridge.core?.onConfigChanged(config)
        }.onFailure { RuntimeBridge.log("Cannot refresh module configuration", it) }
    }
}
