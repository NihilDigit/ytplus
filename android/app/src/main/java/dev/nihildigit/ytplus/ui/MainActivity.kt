package dev.nihildigit.ytplus.ui

import android.content.SharedPreferences
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.nihildigit.ytplus.R
import io.github.libxposed.service.XposedService
import io.github.libxposed.service.XposedServiceHelper
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.lang.ref.WeakReference
import java.util.concurrent.TimeUnit
import kotlin.math.roundToInt

/** The cache keeps the settings screen usable before the framework service connects. */
class MainActivity : ComponentActivity() {
    private lateinit var cache: SharedPreferences
    private lateinit var pending: SharedPreferences
    private var remote: SharedPreferences? = null
    private var service: XposedService? = null
    private var destroyed = false
    private var modelCall: Call? = null
    private var requestGeneration = 0

    private var serviceConnected by mutableStateOf(false)
    private var serviceApiVersion by mutableIntStateOf(0)
    private var serviceStatusText by mutableStateOf(uiText("等待模块服务连接，请在 Xposed 管理器中启用模块并勾选 YouTube", "Waiting for the module service. Enable the module and select YouTube in your Xposed manager."))

    private var enabledState by mutableStateOf(true)
    private var displayModeState by mutableStateOf("bilingual")
    private var fontSizeState by mutableFloatStateOf(20f)
    private var bottomOffsetState by mutableFloatStateOf(72f)
    private var backgroundEnabledState by mutableStateOf(true)
    private var backgroundOpacityState by mutableFloatStateOf(0.42f)
    private var prefetchWaitState by mutableStateOf(true)

    private var apiUrlState by mutableStateOf("https://api.openai.com/v1")
    private var apiKeyState by mutableStateOf("")
    private var modelState by mutableStateOf("")
    private var targetLanguageState by mutableStateOf("Chinese")
    private var extraPromptState by mutableStateOf("")

    private var sponsorBlockEnabledState by mutableStateOf(true)
    private var sponsorBlockCategoriesState by mutableStateOf(DEFAULT_SPONSORBLOCK_CATEGORIES)

    private var modelIdsState by mutableStateOf(emptyList<String>())
    private var modelsStatusState by mutableStateOf(uiText("尚无缓存，可手动输入模型 ID", "No cached models. Enter a model ID manually."))
    private var fetchingModelsState by mutableStateOf(false)

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .callTimeout(45, TimeUnit.SECONDS)
        .followSslRedirects(false)
        .build()

    private val preferenceListener = SharedPreferences.OnSharedPreferenceChangeListener { _, _ ->
        runOnUiThread {
            if (!destroyed) {
                copyRemoteToCache()
                refreshForm()
            }
        }
    }
    private val serviceListener = ServiceListener(this)

    private class ServiceListener(activity: MainActivity) : XposedServiceHelper.OnServiceListener {
        private val owner = WeakReference(activity)
        override fun onServiceBind(service: XposedService) {
            owner.get()?.bindService(service)
        }
        override fun onServiceDied(service: XposedService) {
            owner.get()?.serviceDied(service)
        }
    }

    private fun bindService(service: XposedService) {
        runOnUiThread {
            if (destroyed) return@runOnUiThread
            this.service = service
            try {
                remote?.unregisterOnSharedPreferenceChangeListener(preferenceListener)
                val preferences = service.getRemotePreferences(SETTINGS_GROUP)
                remote = preferences
                val editor = preferences.edit()
                DEFAULTS.forEach { (key, default) ->
                    if (!preferences.contains(key) || pending.getBoolean(key, false)) {
                        put(editor, key, cache.all[key] ?: default)
                    }
                }
                editor.apply()
                pending.edit().clear().apply()
                preferences.registerOnSharedPreferenceChangeListener(preferenceListener)
                copyRemoteToCache()
                if (remote != null) {
                    serviceConnected = true
                    serviceApiVersion = service.apiVersion
                    serviceStatusText = uiText("模块服务已连接，设置变更将实时同步至 YouTube 宿主", "Module service connected. Changes sync to YouTube immediately.")
                }
                refreshForm()
            } catch (_: Exception) {
                disconnect(uiText("模块服务已连接，但远程配置不可用，请检查框架授权后重新打开", "Remote settings unavailable. Check framework permissions and reopen settings."))
            }
        }
    }

    private fun serviceDied(service: XposedService) {
        runOnUiThread {
            if (!destroyed && this.service === service) {
                disconnect(uiText("模块服务已断开，修改保存在本机并在重连后自动同步", "Service disconnected. Changes are saved locally and sync on reconnection."))
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        cache = getSharedPreferences("settings_cache", MODE_PRIVATE)
        pending = getSharedPreferences("settings_pending", MODE_PRIVATE)
        val defaults = cache.edit()
        DEFAULTS.forEach { (key, value) -> if (!cache.contains(key)) put(defaults, key, value) }
        defaults.apply()
        refreshForm()
        showCachedModels()
        XposedServiceHelper.registerListener(serviceListener)

        setContent {
            YtppExpressiveTheme {
                SettingsScreen()
            }
        }
    }

    private fun save(key: String, value: Any) {
        put(cache.edit(), key, value).apply()
        pending.edit().putBoolean(key, true).apply()
        try {
            remote?.let {
                put(it.edit(), key, value).apply()
                pending.edit().remove(key).apply()
            }
        } catch (_: Exception) {
            disconnect(uiText("设置同步失败，修改已保存在本机并在重连后同步", "Sync failed. Changes are saved locally and sync on reconnection."))
        }
        refreshForm()
        if (key == "api_url" || key == "api_key") {
            requestGeneration++
            modelCall?.cancel()
            modelCall = null
            fetchingModelsState = false
            showCachedModels()
        }
    }

    private fun copyRemoteToCache() {
        try {
            val values = remote?.all ?: return
            val endpointChanged = listOf("api_url", "api_key").any { key ->
                !pending.getBoolean(key, false) && values[key] != null && values[key] != cache.all[key]
            }
            if (endpointChanged) {
                requestGeneration++
                modelCall?.cancel()
                modelCall = null
                fetchingModelsState = false
            }
            val editor = cache.edit()
            DEFAULTS.forEach { (key, default) ->
                val value = values[key] ?: default
                val sameType = if (default is Set<*>) value is Set<*> && value.all { it is String }
                else value.javaClass == default.javaClass
                if (!pending.getBoolean(key, false) && sameType) put(editor, key, value)
            }
            editor.apply()
            if (endpointChanged) showCachedModels()
        } catch (_: Exception) {
            disconnect(uiText("模块远程设置暂时不可用，修改将保存在本机", "Remote settings unavailable. Changes are saved locally."))
        }
    }

    private fun refreshForm() {
        enabledState = cache.getBoolean("enabled", DEFAULTS["enabled"] as Boolean)
        displayModeState = cache.getString("display_mode", DEFAULTS["display_mode"] as String).orEmpty().ifBlank { "bilingual" }
        fontSizeState = cache.getFloat("font_size", DEFAULTS["font_size"] as Float).coerceIn(12f, 40f)
        bottomOffsetState = cache.getFloat("bottom_offset", DEFAULTS["bottom_offset"] as Float).coerceIn(0f, 240f)
        backgroundEnabledState = cache.getBoolean("background_enabled", DEFAULTS["background_enabled"] as Boolean)
        backgroundOpacityState = cache.getFloat("background_opacity", 0.42f).takeIf { it.isFinite() }?.coerceIn(0f, 1f) ?: 0.42f
        prefetchWaitState = cache.getBoolean("prefetch_wait", DEFAULTS["prefetch_wait"] as Boolean)

        apiUrlState = cache.getString("api_url", DEFAULTS["api_url"] as String).orEmpty()
        apiKeyState = cache.getString("api_key", DEFAULTS["api_key"] as String).orEmpty()
        modelState = cache.getString("model", DEFAULTS["model"] as String).orEmpty()
        targetLanguageState = cache.getString("target_language", DEFAULTS["target_language"] as String).orEmpty()
        extraPromptState = cache.getString("extra_prompt", DEFAULTS["extra_prompt"] as String).orEmpty()

        sponsorBlockEnabledState = cache.getBoolean("sponsorblock_enabled", DEFAULTS["sponsorblock_enabled"] as Boolean)
        sponsorBlockCategoriesState = cache.getStringSet("sponsorblock_categories", DEFAULT_SPONSORBLOCK_CATEGORIES)
            ?.toSet() ?: DEFAULT_SPONSORBLOCK_CATEGORIES
    }

    private fun disconnect(message: String) {
        try {
            remote?.unregisterOnSharedPreferenceChangeListener(preferenceListener)
        } catch (_: Exception) {
        }
        remote = null
        service = null
        serviceConnected = false
        serviceApiVersion = 0
        serviceStatusText = message
    }

    private fun fetchModels() {
        val base = cache.getString("api_url", "").orEmpty().trim().trimEnd('/')
        val url = "$base/models".toHttpUrlOrNull()
        if (url == null || url.scheme != "https" || url.username.isNotEmpty() || url.password.isNotEmpty() ||
            url.query != null || url.fragment != null
        ) {
            modelsStatusState = uiText("请输入有效的 HTTPS API 地址，不包含查询参数或账号密码", "Enter a valid HTTPS API URL without query parameters or credentials.")
            return
        }
        val key = cache.getString("api_key", "").orEmpty().trim()
        val request = try {
            Request.Builder().url(url).apply {
                if (key.isNotEmpty()) header("Authorization", "Bearer $key")
            }.get().build()
        } catch (_: IllegalArgumentException) {
            modelsStatusState = uiText("密钥格式无效，请检查是否包含换行或非法字符", "Invalid API key. Check for line breaks or invalid characters.")
            return
        }
        modelCall?.cancel()
        val generation = ++requestGeneration
        val call = client.newCall(request)
        modelCall = call
        fetchingModelsState = true
        modelsStatusState = uiText("正在拉取模型列表…", "Fetching models…")
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                completeModels(generation, null, uiText("连接失败，请检查网络、API 地址与密钥", "Connection failed. Check your network, API URL and key."))
            }

            override fun onResponse(call: Call, response: okhttp3.Response) {
                response.use {
                    if (!it.isSuccessful) {
                        completeModels(generation, null, uiText("拉取失败（HTTP ${it.code}），请检查接口权限与密钥", "Request failed (HTTP ${it.code}). Check API permissions and key."))
                        return
                    }
                    try {
                        val body = it.body ?: throw IOException("Empty body")
                        val source = body.source()
                        if (source.request(MAX_MODEL_BYTES + 1)) throw IOException("Response too large")
                        val data = JSONObject(source.readUtf8()).getJSONArray("data")
                        val ids = (0 until data.length()).mapNotNull { index ->
                            data.optJSONObject(index)?.optString("id")?.takeIf { id -> id.isNotBlank() }
                        }.distinct().sorted()
                        completeModels(
                            generation,
                            ids,
                            if (ids.isEmpty()) uiText("接口返回了空模型列表", "The API returned an empty model list.") else uiText("已拉取并缓存 ${ids.size} 个可用模型", "Fetched and cached ${ids.size} models.")
                        )
                    } catch (_: Exception) {
                        completeModels(generation, null, uiText("模型列表格式无效或响应过大，需要 OpenAI 兼容的 /models 接口", "Invalid or oversized model list. An OpenAI-compatible /models endpoint is required."))
                    }
                }
            }
        })
    }

    private fun completeModels(generation: Int, ids: List<String>?, message: String) {
        runOnUiThread {
            if (destroyed || generation != requestGeneration) return@runOnUiThread
            modelCall = null
            fetchingModelsState = false
            if (ids != null) {
                cache.edit()
                    .putString("cached_models", JSONArray(ids).toString())
                    .putString("cached_models_url", cache.getString("api_url", ""))
                    .apply()
                showCachedModels()
            }
            modelsStatusState = message
        }
    }

    private fun showCachedModels() {
        val loaded = try {
            if (cache.getString("cached_models_url", null) != cache.getString("api_url", "")) emptyList()
            else {
                val data = JSONArray(cache.getString("cached_models", "[]"))
                (0 until data.length()).map { data.getString(it) }
            }
        } catch (_: Exception) {
            emptyList()
        }
        modelIdsState = loaded
        modelsStatusState = if (loaded.isEmpty()) {
            uiText("尚无缓存，可手动输入模型 ID 或点击拉取", "No cached models. Enter a model ID or fetch the list.")
        } else {
            uiText("本机已缓存 ${loaded.size} 个模型，可展开下拉列表直接选用", "${loaded.size} models cached. Select one from the list.")
        }
    }

    override fun onDestroy() {
        destroyed = true
        requestGeneration++
        modelCall?.cancel()
        try {
            remote?.unregisterOnSharedPreferenceChangeListener(preferenceListener)
        } catch (_: Exception) {
        }
        super.onDestroy()
    }

    @OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
    @Composable
    private fun SettingsScreen() {
        var activeSection by remember { mutableIntStateOf(0) }
        var showApiKey by remember { mutableStateOf(false) }
        var modelDropdownExpanded by remember { mutableStateOf(false) }
        val scrollState = rememberScrollState()

        Scaffold(
            modifier = Modifier.fillMaxSize(),
            containerColor = MaterialTheme.colorScheme.surfaceContainerLowest,
            contentWindowInsets = WindowInsets(0, 0, 0, 0)
        ) { innerPadding ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(innerPadding)
                    .verticalScroll(scrollState)
                    .statusBarsPadding()
                    .navigationBarsPadding()
                    .imePadding()
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                ExpressiveHeaderAndStatusCard()

                SectionSelectorPillBar(
                    selectedIndex = activeSection,
                    onSelect = { activeSection = it }
                )

                if (activeSection == 0 || activeSection == 1) {
                    SubtitleSectionGroup()
                }
                if (activeSection == 0 || activeSection == 2) {
                    TranslationApiSectionGroup(
                        showApiKey = showApiKey,
                        onToggleShowApiKey = { showApiKey = !showApiKey },
                        modelDropdownExpanded = modelDropdownExpanded,
                        onExpandModels = { modelDropdownExpanded = it }
                    )
                }
                if (activeSection == 0 || activeSection == 3) {
                    SponsorBlockSectionGroup()
                }

                Spacer(modifier = Modifier.height(12.dp))
            }
        }
    }

    @Composable
    private fun ExpressiveHeaderAndStatusCard() {
        val containerColor by animateColorAsState(
            targetValue = if (serviceConnected) {
                MaterialTheme.colorScheme.primaryContainer
            } else {
                MaterialTheme.colorScheme.secondaryContainer
            },
            animationSpec = spring(stiffness = Spring.StiffnessMediumLow),
            label = "statusContainer"
        )
        val contentColor = if (serviceConnected) {
            MaterialTheme.colorScheme.onPrimaryContainer
        } else {
            MaterialTheme.colorScheme.onSecondaryContainer
        }

        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(28.dp),
            color = containerColor,
            tonalElevation = 2.dp
        ) {
            Column(
                modifier = Modifier.padding(22.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp)
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(14.dp)
                ) {
                    Surface(
                        shape = RoundedCornerShape(18.dp),
                        color = MaterialTheme.colorScheme.surface,
                        modifier = Modifier.size(56.dp)
                    ) {
                        Box(contentAlignment = Alignment.Center) {
                            Icon(
                                painter = painterResource(id = R.drawable.ic_ytplus),
                                contentDescription = "YT+",
                                tint = Color.Unspecified,
                                modifier = Modifier.size(34.dp)
                            )
                        }
                    }
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = "YT+",
                            style = MaterialTheme.typography.headlineSmall.copy(
                                fontWeight = FontWeight.ExtraBold
                            ),
                            color = contentColor
                        )
                        Text(
                            text = uiText("YouTube 双语流式字幕与片段跳过模块", "Bilingual streaming subtitles and segment skipping for YouTube"),
                            style = MaterialTheme.typography.bodyMedium,
                            color = contentColor.copy(alpha = 0.82f)
                        )
                    }
                }

                Surface(
                    shape = RoundedCornerShape(18.dp),
                    color = MaterialTheme.colorScheme.surface.copy(alpha = 0.72f),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Row(
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        Box(
                            modifier = Modifier
                                .size(10.dp)
                                .clip(CircleShape)
                                .background(
                                    if (serviceConnected) Color(0xFF00C853)
                                    else MaterialTheme.colorScheme.outline
                                )
                        )
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = if (serviceConnected) {
                                    uiText("LSPosed 服务在线（Xposed API $serviceApiVersion）", "LSPosed connected (Xposed API $serviceApiVersion)")
                                } else {
                                    uiText("模块服务未连接（离线编辑模式）", "Module service disconnected (offline editing)")
                                },
                                style = MaterialTheme.typography.titleSmall.copy(
                                    fontWeight = FontWeight.Bold
                                ),
                                color = MaterialTheme.colorScheme.onSurface
                            )
                            Text(
                                text = serviceStatusText,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                }
            }
        }
    }

    @Composable
    private fun SectionSelectorPillBar(
        selectedIndex: Int,
        onSelect: (Int) -> Unit
    ) {
        val tabs = listOf(uiText("全部配置", "All"), uiText("字幕显示", "Subtitles"), uiText("翻译接口", "Translation"), uiText("片段跳过", "Skipping"))
        Surface(
            shape = RoundedCornerShape(24.dp),
            color = MaterialTheme.colorScheme.surfaceContainerHigh,
            modifier = Modifier.fillMaxWidth()
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(4.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                tabs.forEachIndexed { index, title ->
                    val selected = selectedIndex == index
                    val bg by animateColorAsState(
                        targetValue = if (selected) {
                            MaterialTheme.colorScheme.primary
                        } else {
                            Color.Transparent
                        },
                        animationSpec = spring(stiffness = Spring.StiffnessMediumLow),
                        label = "tabBg"
                    )
                    val fg = if (selected) {
                        MaterialTheme.colorScheme.onPrimary
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    }
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .clip(RoundedCornerShape(20.dp))
                            .background(bg)
                            .clickable { onSelect(index) }
                            .padding(vertical = 10.dp, horizontal = 4.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            text = title,
                            style = MaterialTheme.typography.labelLarge.copy(
                                fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium
                            ),
                            color = fg,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                    }
                }
            }
        }
    }

    @Composable
    private fun SubtitleSectionGroup() {
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            GroupHeader(uiText("字幕显示", "Subtitles"))

            // Item 1 of 6 (Top)
            ExpressiveGroupCard(index = 0, total = 7) {
                SwitchRow(
                    title = uiText("启用字幕翻译与挂载", "Enable translated subtitles"),
                    subtitle = uiText("在 YouTube 播放器内接管字幕轨道并显示实时译文", "Display live translations of caption tracks in the YouTube player"),
                    checked = enabledState,
                    onCheckedChange = { save("enabled", it) }
                )
            }

            // Item 2 of 6 (Middle)
            ExpressiveGroupCard(index = 1, total = 7) {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(
                        text = uiText("字幕显示模式", "Subtitle display mode"),
                        style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold),
                        color = MaterialTheme.colorScheme.onSurface
                    )
                    val modes = listOf(
                        "bilingual" to uiText("双语", "Bilingual"),
                        "translation" to uiText("仅译文", "Translation"),
                        "original" to uiText("仅原文", "Original"),
                        "off" to uiText("关闭", "Off")
                    )
                    Surface(
                        shape = RoundedCornerShape(18.dp),
                        color = MaterialTheme.colorScheme.surfaceContainerHighest,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(4.dp),
                            horizontalArrangement = Arrangement.spacedBy(4.dp)
                        ) {
                            modes.forEach { (modeKey, modeLabel) ->
                                val selected = displayModeState == modeKey
                                val pillBg by animateColorAsState(
                                    targetValue = if (selected) {
                                        MaterialTheme.colorScheme.secondaryContainer
                                    } else {
                                        Color.Transparent
                                    },
                                    label = "modePill"
                                )
                                val pillFg = if (selected) {
                                    MaterialTheme.colorScheme.onSecondaryContainer
                                } else {
                                    MaterialTheme.colorScheme.onSurfaceVariant
                                }
                                Box(
                                    modifier = Modifier
                                        .weight(1f)
                                        .clip(RoundedCornerShape(14.dp))
                                        .background(pillBg)
                                        .clickable {
                                            if (displayModeState != modeKey) {
                                                save("display_mode", modeKey)
                                            }
                                        }
                                        .padding(vertical = 10.dp),
                                    contentAlignment = Alignment.Center
                                ) {
                                    Text(
                                        text = modeLabel,
                                        style = MaterialTheme.typography.labelLarge.copy(
                                            fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium
                                        ),
                                        color = pillFg,
                                        textAlign = TextAlign.Center
                                    )
                                }
                            }
                        }
                    }
                }
            }

            // Item 3 of 6 (Middle)
            ExpressiveGroupCard(index = 2, total = 7) {
                SliderRow(
                    title = uiText("字幕字号大小", "Subtitle font size"),
                    valueText = "${fontSizeState.roundToInt()} sp",
                    value = fontSizeState,
                    valueRange = 12f..40f,
                    onValueChange = {
                        val rounded = it.roundToInt().toFloat()
                        fontSizeState = rounded
                        save("font_size", rounded)
                    }
                )
            }

            // Item 4 of 6 (Middle)
            ExpressiveGroupCard(index = 3, total = 7) {
                SliderRow(
                    title = uiText("字幕底部距离", "Subtitle bottom offset"),
                    valueText = "${bottomOffsetState.roundToInt()} dp",
                    value = bottomOffsetState,
                    valueRange = 0f..240f,
                    onValueChange = {
                        val rounded = it.roundToInt().toFloat()
                        bottomOffsetState = rounded
                        save("bottom_offset", rounded)
                    }
                )
            }

            // Item 5 of 6 (Middle)
            ExpressiveGroupCard(index = 4, total = 7) {
                SwitchRow(
                    title = uiText("字幕半透明底衬", "Subtitle backdrop"),
                    subtitle = uiText("在字幕文字后方绘制深色圆角底衬以增强对比度", "Draw a rounded dark backdrop behind subtitles for contrast"),
                    checked = backgroundEnabledState,
                    onCheckedChange = { save("background_enabled", it) }
                )
            }

            ExpressiveGroupCard(index = 5, total = 7) {
                SliderRow(
                    title = uiText("底衬不透明度", "Backdrop opacity"),
                    valueText = "${(backgroundOpacityState * 100).roundToInt()}%",
                    value = backgroundOpacityState,
                    valueRange = 0f..1f,
                    onValueChange = { save("background_opacity", it) }
                )
            }

            ExpressiveGroupCard(index = 6, total = 7) {
                SwitchRow(
                    title = uiText("等待预翻译完成后起播", "Wait for initial translation"),
                    subtitle = uiText("首屏批次字幕翻译未就绪时短暂挂起播放器，支持手动跳过", "Briefly pause until the first batch is translated. You can skip the wait."),
                    checked = prefetchWaitState,
                    onCheckedChange = { save("prefetch_wait", it) }
                )
            }
        }
    }

    @Composable
    private fun TranslationApiSectionGroup(
        showApiKey: Boolean,
        onToggleShowApiKey: () -> Unit,
        modelDropdownExpanded: Boolean,
        onExpandModels: (Boolean) -> Unit
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            GroupHeader(uiText("翻译接口与提示词", "Translation API and prompts"))

            // Item 1 of 4 (Top): API URL & Key
            ExpressiveGroupCard(index = 0, total = 4) {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(
                        text = uiText("OpenAI 兼容接口地址与凭证", "OpenAI-compatible endpoint and credentials"),
                        style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold),
                        color = MaterialTheme.colorScheme.onSurface
                    )
                    OutlinedTextField(
                        value = apiUrlState,
                        onValueChange = {
                            apiUrlState = it
                            save("api_url", it)
                        },
                        label = { Text(uiText("API 地址（含 /v1，不含 /chat/completions）", "API URL (include /v1, not /chat/completions)")) },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                        shape = RoundedCornerShape(16.dp),
                        modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = apiKeyState,
                        onValueChange = {
                            apiKeyState = it
                            save("api_key", it)
                        },
                        label = { Text(uiText("API 密钥（Bearer Token）", "API key (Bearer token)")) },
                        singleLine = true,
                        visualTransformation = if (showApiKey) {
                            VisualTransformation.None
                        } else {
                            PasswordVisualTransformation()
                        },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                        trailingIcon = {
                            TextButton(onClick = onToggleShowApiKey) {
                                Text(if (showApiKey) uiText("隐藏", "Hide") else uiText("显示", "Show"))
                            }
                        },
                        shape = RoundedCornerShape(16.dp),
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            }

            // Item 2 of 4 (Middle): Model selection & fetch
            ExpressiveGroupCard(index = 1, total = 4) {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(
                        text = uiText("翻译模型选择", "Translation model"),
                        style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold),
                        color = MaterialTheme.colorScheme.onSurface
                    )
                    OutlinedTextField(
                        value = modelState,
                        onValueChange = {
                            modelState = it
                            save("model", it)
                        },
                        label = { Text(uiText("模型 ID", "Model ID")) },
                        singleLine = true,
                        shape = RoundedCornerShape(16.dp),
                        modifier = Modifier.fillMaxWidth()
                    )
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Button(
                            onClick = { fetchModels() },
                            enabled = !fetchingModelsState,
                            shape = RoundedCornerShape(16.dp),
                            contentPadding = PaddingValues(horizontal = 18.dp, vertical = 12.dp)
                        ) {
                            Text(if (fetchingModelsState) uiText("正在拉取…", "Fetching…") else uiText("拉取模型列表", "Fetch models"))
                        }

                        Box(modifier = Modifier.weight(1f)) {
                            OutlinedButton(
                                onClick = { if (modelIdsState.isNotEmpty()) onExpandModels(true) },
                                enabled = modelIdsState.isNotEmpty(),
                                shape = RoundedCornerShape(16.dp),
                                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                Text(
                                    text = if (modelIdsState.isEmpty()) uiText("无缓存模型", "No cached models") else uiText("从已缓存列表选择（${modelIdsState.size}）", "Choose cached model (${modelIdsState.size})"),
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis
                                )
                            }
                            DropdownMenu(
                                expanded = modelDropdownExpanded,
                                onDismissRequest = { onExpandModels(false) },
                                modifier = Modifier.height(320.dp)
                            ) {
                                modelIdsState.forEach { candidate ->
                                    DropdownMenuItem(
                                        text = {
                                            Text(
                                                text = candidate,
                                                fontWeight = if (candidate == modelState) FontWeight.Bold else FontWeight.Normal
                                            )
                                        },
                                        onClick = {
                                            modelState = candidate
                                            save("model", candidate)
                                            onExpandModels(false)
                                        }
                                    )
                                }
                            }
                        }
                    }
                    Text(
                        text = modelsStatusState,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            // Item 3 of 4 (Middle): Target language
            ExpressiveGroupCard(index = 2, total = 4) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        text = uiText("目标语言", "Target language"),
                        style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold),
                        color = MaterialTheme.colorScheme.onSurface
                    )
                    OutlinedTextField(
                        value = targetLanguageState,
                        onValueChange = {
                            targetLanguageState = it
                            save("target_language", it)
                        },
                        label = { Text(uiText("译文目标语言（例如 Chinese、简体中文、English）", "Translation language (e.g. Chinese or English)")) },
                        singleLine = true,
                        shape = RoundedCornerShape(16.dp),
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            }

            // Item 4 of 4 (Bottom): Extra prompt
            ExpressiveGroupCard(index = 3, total = 4) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        text = uiText("附加提示词", "Additional prompt"),
                        style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold),
                        color = MaterialTheme.colorScheme.onSurface
                    )
                    OutlinedTextField(
                        value = extraPromptState,
                        onValueChange = {
                            extraPromptState = it
                            save("extra_prompt", it)
                        },
                        label = { Text(uiText("术语表、专有名词保留规则或文风要求（选填）", "Glossary, names to preserve or style instructions (optional)")) },
                        minLines = 3,
                        maxLines = 6,
                        shape = RoundedCornerShape(16.dp),
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            }
        }
    }

    @OptIn(ExperimentalLayoutApi::class)
    @Composable
    private fun SponsorBlockSectionGroup() {
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            GroupHeader(uiText("SponsorBlock 片段跳过", "SponsorBlock segment skipping"))

            // Item 1 of 2 (Top)
            ExpressiveGroupCard(index = 0, total = 2) {
                SwitchRow(
                    title = uiText("启用 SponsorBlock 自动跳过", "Enable SponsorBlock auto-skip"),
                    subtitle = uiText("根据社区标记自动跳过视频内的广告、推广与冗余片段并在进度条绘制色标", "Skip community-marked ads, promotions and filler, with colored timeline markers"),
                    checked = sponsorBlockEnabledState,
                    onCheckedChange = { save("sponsorblock_enabled", it) }
                )
            }

            // Item 2 of 2 (Bottom)
            ExpressiveGroupCard(index = 1, total = 2) {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(
                        text = uiText("选择自动跳过的片段类别", "Categories to skip automatically"),
                        style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold),
                        color = MaterialTheme.colorScheme.onSurface
                    )
                    FlowRow(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        SPONSORBLOCK_CATEGORIES.forEach { spec ->
                            val selected = spec.key in sponsorBlockCategoriesState
                            FilterChip(
                                selected = selected,
                                enabled = sponsorBlockEnabledState,
                                onClick = {
                                    val updated = sponsorBlockCategoriesState.toMutableSet()
                                    if (selected) updated.remove(spec.key) else updated.add(spec.key)
                                    sponsorBlockCategoriesState = updated
                                    save("sponsorblock_categories", updated)
                                },
                                label = {
                                    Text(
                                        text = spec.title,
                                        style = MaterialTheme.typography.labelLarge.copy(
                                            fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium
                                        )
                                    )
                                },
                                leadingIcon = {
                                    Box(
                                        modifier = Modifier
                                            .size(10.dp)
                                            .clip(CircleShape)
                                            .background(Color(spec.colorArgb))
                                    )
                                },
                                shape = RoundedCornerShape(14.dp),
                                colors = FilterChipDefaults.filterChipColors(
                                    selectedContainerColor = MaterialTheme.colorScheme.secondaryContainer,
                                    selectedLabelColor = MaterialTheme.colorScheme.onSecondaryContainer
                                )
                            )
                        }
                    }
                }
            }
        }
    }

    @Composable
    private fun GroupHeader(title: String) {
        Text(
            text = title,
            style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold),
            color = MaterialTheme.colorScheme.primary,
            modifier = Modifier.padding(start = 12.dp, top = 6.dp, bottom = 6.dp)
        )
    }

    @Composable
    private fun ExpressiveGroupCard(
        index: Int,
        total: Int,
        content: @Composable () -> Unit
    ) {
        val topCorner = if (index == 0) 24.dp else 6.dp
        val bottomCorner = if (index == total - 1) 24.dp else 6.dp
        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(
                topStart = topCorner,
                topEnd = topCorner,
                bottomStart = bottomCorner,
                bottomEnd = bottomCorner
            ),
            color = MaterialTheme.colorScheme.surfaceContainer,
            tonalElevation = 1.dp
        ) {
            Box(modifier = Modifier.padding(horizontal = 18.dp, vertical = 16.dp)) {
                content()
            }
        }
    }

    @Composable
    private fun SwitchRow(
        title: String,
        subtitle: String,
        checked: Boolean,
        onCheckedChange: (Boolean) -> Unit
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable { onCheckedChange(!checked) },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Column(
                modifier = Modifier
                    .weight(1f)
                    .padding(end = 16.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold),
                    color = MaterialTheme.colorScheme.onSurface
                )
                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Switch(
                checked = checked,
                onCheckedChange = onCheckedChange
            )
        }
    }

    @Composable
    private fun SliderRow(
        title: String,
        valueText: String,
        value: Float,
        valueRange: ClosedFloatingPointRange<Float>,
        onValueChange: (Float) -> Unit
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold),
                    color = MaterialTheme.colorScheme.onSurface
                )
                Surface(
                    shape = RoundedCornerShape(10.dp),
                    color = MaterialTheme.colorScheme.secondaryContainer
                ) {
                    Text(
                        text = valueText,
                        style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.Bold),
                        color = MaterialTheme.colorScheme.onSecondaryContainer,
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp)
                    )
                }
            }
            Slider(
                value = value,
                onValueChange = onValueChange,
                valueRange = valueRange
            )
        }
    }

    @Composable
    private fun YtppExpressiveTheme(content: @Composable () -> Unit) {
        val context = LocalContext.current
        val darkTheme = isSystemInDarkTheme()
        val colorScheme = when {
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
                if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
            }
            darkTheme -> darkColorScheme()
            else -> lightColorScheme()
        }
        MaterialTheme(
            colorScheme = colorScheme,
            content = content
        )
    }

    private data class SponsorCategorySpec(
        val key: String,
        val title: String,
        val colorArgb: Long
    )

    companion object {
        private const val SETTINGS_GROUP = "ytpp_settings"
        private const val MAX_MODEL_BYTES = 2L * 1024 * 1024
        private val DEFAULT_SPONSORBLOCK_CATEGORIES = setOf("sponsor", "selfpromo", "interaction")
        private val SPONSORBLOCK_CATEGORIES = listOf(
            SponsorCategorySpec("sponsor", uiText("赞助广告", "Sponsor"), 0xFF00D400),
            SponsorCategorySpec("selfpromo", uiText("自我推广", "Self-promotion"), 0xFFFFFF00),
            SponsorCategorySpec("interaction", uiText("互动提醒", "Interaction"), 0xFFCC00FF),
            SponsorCategorySpec("intro", uiText("片头", "Intro"), 0xFF00FFFF),
            SponsorCategorySpec("outro", uiText("片尾", "Outro"), 0xFF0202ED),
            SponsorCategorySpec("preview", uiText("预告", "Preview"), 0xFF008FD6),
            SponsorCategorySpec("music_offtopic", uiText("非音乐", "Non-music"), 0xFFFF9900),
            SponsorCategorySpec("filler", uiText("水时长", "Filler"), 0xFF7300FF)
        )
        private val DEFAULTS: Map<String, Any> = linkedMapOf(
            "enabled" to true,
            "sponsorblock_enabled" to true,
            "sponsorblock_categories" to DEFAULT_SPONSORBLOCK_CATEGORIES,
            "display_mode" to "bilingual",
            "font_size" to 20f,
            "bottom_offset" to 72f,
            "background_enabled" to true,
            "background_opacity" to 0.42f,
            "prefetch_wait" to true,
            "api_url" to "https://api.openai.com/v1",
            "api_key" to "",
            "model" to "",
            "target_language" to "Chinese",
            "extra_prompt" to ""
        )

        private fun put(editor: SharedPreferences.Editor, key: String, value: Any): SharedPreferences.Editor =
            when (value) {
                is Boolean -> editor.putBoolean(key, value)
                is Float -> editor.putFloat(key, value)
                is String -> editor.putString(key, value)
                is Set<*> -> {
                    require(value.all { it is String }) { "Unsupported setting set type" }
                    editor.putStringSet(key, value.map { it as String }.toSet())
                }
                else -> error("Unsupported setting type")
            }
    }
}
