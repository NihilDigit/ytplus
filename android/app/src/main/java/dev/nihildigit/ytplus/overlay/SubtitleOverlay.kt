package dev.nihildigit.ytplus.overlay

import dev.nihildigit.ytplus.ui.uiText
import android.app.Activity
import android.graphics.Color
import android.graphics.Rect
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.SystemClock
import android.view.Choreographer
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import dev.nihildigit.ytplus.xposed.RuntimeBridge
import dev.nihildigit.ytplus.xposed.SubtitleFrame

/** An in-process view, not a system overlay; no draw-over-apps permission is needed. */
class SubtitleOverlay private constructor(private val activity: Activity) : FrameLayout(activity), Choreographer.FrameCallback {
    private val panel = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER
        setPadding(dp(12), dp(6), dp(12), dp(6))
        background = GradientDrawable().apply {
            setColor(Color.argb((RuntimeBridge.config.value.backgroundOpacity.coerceIn(0f, 1f) * 255).toInt(), 34, 34, 34))
            cornerRadius = dp(16).toFloat()
        }
    }
    private val original = caption(14.5f).apply { setTextColor(0xD9FFFFFF.toInt()) }
    private val translated = caption(17.5f).apply { setTypeface(typeface, Typeface.BOLD) }
    private val notice = caption(13.5f)
    private val skip = pill(uiText("跳过等待", "Skip")).apply {
        text = uiText("跳过等待", "Skip")
        visibility = GONE
        setOnClickListener { RuntimeBridge.core?.skipWaiting() }
    }
    private var playerBounds = Rect()
    private var playerVisible = false
    private var controls = Rect()
    private var explicitControlBounds = false
    private var running = false
    private var lastFrameNs = 0L
    private var lastSampleNs = 0L
    private var anchorNs = 0L
    private var anchorMs = 0L
    private var playing = false
    private var playbackSpeed = 1f
    private var lastState: SubtitleFrame? = null
    private var lastBilingual: Boolean? = null
    private var lastConfig: dev.nihildigit.ytplus.xposed.AppConfig? = null
    private var dragged = false
    private var downX = 0f
    private var downY = 0f
    private var startX = 0f
    private var startY = 0f

    init {
        clipChildren = false
        isClickable = false
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
        addView(panel, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
        panel.addView(translated)
        panel.addView(original)
        panel.addView(notice)
        panel.addView(skip, LinearLayout.LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { topMargin = dp(4) })
        panel.setOnTouchListener { view, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = event.rawX; downY = event.rawY; startX = panel.x; startY = panel.y
                    dragged = false
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = event.rawX - downX; val dy = event.rawY - downY
                    if (!dragged && dx * dx + dy * dy >= dp(5) * dp(5)) {
                        dragged = true; parent?.requestDisallowInterceptTouchEvent(true)
                    }
                    if (dragged) place(startX + dx, startY + dy)
                    true
                }
                MotionEvent.ACTION_UP -> {
                    parent?.requestDisallowInterceptTouchEvent(false)
                    if (!dragged) view.performClick()
                    true
                }
                MotionEvent.ACTION_CANCEL -> { parent?.requestDisallowInterceptTouchEvent(false); true }
                else -> false
            }
        }
        addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
            if (!dragged) placeDefault()
            else place(panel.x, panel.y)
        }
    }

    /** Player integration supplies visible control bounds in overlay-local coordinates. */
    fun setControlBounds(bounds: Rect?) {
        explicitControlBounds = bounds != null
        controls = bounds?.let(::Rect) ?: Rect()
        place(panel.x, panel.y)
    }

    private fun createYtPlusIconDrawable(): android.graphics.drawable.Drawable {
        val screenPath = androidx.core.graphics.PathParser.createPathFromPathData(YT_SCREEN_OPEN_PATH)
        val trianglePath = androidx.core.graphics.PathParser.createPathFromPathData(YT_TRIANGLE_PATH)
        val plusPath = androidx.core.graphics.PathParser.createPathFromPathData(YT_PLUS_PATH)
        val sizePx = dp(24)
        return object : android.graphics.drawable.Drawable() {
            private val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
                color = Color.WHITE
                style = android.graphics.Paint.Style.STROKE
                strokeWidth = 2f
                strokeCap = android.graphics.Paint.Cap.ROUND
                strokeJoin = android.graphics.Paint.Join.ROUND
            }
            override fun getIntrinsicWidth(): Int = sizePx
            override fun getIntrinsicHeight(): Int = sizePx
            override fun draw(canvas: android.graphics.Canvas) {
                val b = bounds
                if (b.isEmpty) return
                val save = canvas.save()
                canvas.translate(b.left.toFloat(), b.top.toFloat())
                canvas.scale(b.width() / 24f, b.height() / 24f)
                canvas.drawPath(screenPath, paint)
                canvas.drawPath(trianglePath, paint)
                canvas.drawPath(plusPath, paint)
                canvas.restoreToCount(save)
            }
            override fun setAlpha(alpha: Int) { paint.alpha = alpha }
            override fun setColorFilter(colorFilter: android.graphics.ColorFilter?) { paint.colorFilter = colorFilter }
            @Deprecated("Deprecated in Java")
            override fun getOpacity(): Int = android.graphics.PixelFormat.TRANSLUCENT
        }
    }

    private fun mountNativeHeaderButton(container: ViewGroup, referenceBtn: View?) {
        val existing = container.findViewWithTag<android.widget.ImageView>(NATIVE_BTN_TAG)
        if (existing != null) {
            if (existing.drawable == null) existing.setImageDrawable(createYtPlusIconDrawable())
            return
        }
        val iconBtn = android.widget.ImageView(context).apply {
            tag = NATIVE_BTN_TAG
            contentDescription = "YT+"
            isClickable = true
            isFocusable = true
            scaleType = android.widget.ImageView.ScaleType.CENTER_INSIDE
            if (referenceBtn != null && referenceBtn.paddingLeft > 0) {
                setPadding(
                    referenceBtn.paddingLeft,
                    referenceBtn.paddingTop,
                    referenceBtn.paddingRight,
                    referenceBtn.paddingBottom,
                )
            } else {
                setPadding(dp(12), dp(12), dp(12), dp(12))
            }
            val outVal = android.util.TypedValue()
            if (context.theme.resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, outVal, true)) {
                setBackgroundResource(outVal.resourceId)
            }
            setImageDrawable(createYtPlusIconDrawable())
            setOnClickListener { showInPlayerSettingsDialog() }
        }
        val size = dp(48)
        val lp = if (container is LinearLayout) {
            LinearLayout.LayoutParams(
                referenceBtn?.layoutParams?.width?.takeIf { it > 0 } ?: size,
                referenceBtn?.layoutParams?.height?.takeIf { it > 0 } ?: size,
            )
        } else {
            ViewGroup.LayoutParams(size, size)
        }
        container.addView(iconBtn, lp)
    }

    private fun refreshControlBounds() {
        val root = activity.window.decorView as? ViewGroup ?: return
        val combined = Rect()
        val players = mutableMapOf<String, Rect>()
        val overlayLocation = IntArray(2).also { getLocationOnScreen(it) }
        var headerContainer: ViewGroup? = null
        var subtitleButton: View? = null
        fun visit(view: View) {
            if (view === this) return
            val name = if (view.id == View.NO_ID) "" else runCatching {
                resources.getResourceEntryName(view.id)
            }.getOrDefault("")
            if (name == "player_additional_view_container" && view is ViewGroup) {
                headerContainer = view
            } else if (name == "player_subtitle_button") {
                subtitleButton = view
            } else if (name == "subtitles" || name == "subtitle_window_identifier") {
                view.alpha = if (RuntimeBridge.enabled.value) 0f else 1f
            }
            if (!view.isShown) return
            if (name in PLAYER_IDS) {
                val bounds = Rect()
                if (view.getGlobalVisibleRect(bounds) && bounds.width() > dp(160) && bounds.height() > dp(120)) {
                    bounds.offset(-overlayLocation[0], -overlayLocation[1]); players.putIfAbsent(name, bounds)
                }
            }
            if (name in CONTROL_IDS && view.alpha > 0.1f) {
                val bounds = Rect()
                if (view.getGlobalVisibleRect(bounds)) {
                    bounds.offset(-overlayLocation[0], -overlayLocation[1])
                    combined.union(bounds)
                }
            } else if (view is ViewGroup) {
                for (index in 0 until view.childCount) visit(view.getChildAt(index))
            }
        }
        visit(root)
        headerContainer?.let { mountNativeHeaderButton(it, subtitleButton) }
        if (!explicitControlBounds) controls = combined
        val foundBounds = PLAYER_IDS.firstNotNullOfOrNull { players[it] }
        playerVisible = foundBounds != null
        val bounds = foundBounds ?: return
        if (bounds != playerBounds) {
            playerBounds = bounds
            val maxCaptionWidth = (bounds.width() - dp(32)).coerceAtLeast(dp(80))
            original.maxWidth = maxCaptionWidth; translated.maxWidth = maxCaptionWidth; notice.maxWidth = maxCaptionWidth
            panel.layoutParams = (panel.layoutParams as LayoutParams).apply { width = LayoutParams.WRAP_CONTENT }
            dragged = false
        }
        if (!dragged) placeDefault() else place(panel.x, panel.y)
    }

    private fun placeDefault() {
        val bounds = playerBounds.takeUnless { it.isEmpty } ?: Rect(0, 0, width, height)
        place(bounds.left + (bounds.width() - panel.width) / 2f,
            bounds.bottom - panel.height - dp(RuntimeBridge.config.value.bottomOffset.toInt()).toFloat())
    }

    private fun place(x: Float, y: Float) {
        if (width == 0 || height == 0) return
        val bounds = playerBounds.takeUnless { it.isEmpty } ?: Rect(0, 0, width, height)
        val minX = bounds.left.toFloat(); val minY = bounds.top.toFloat()
        val maxX = (bounds.right - panel.width).coerceAtLeast(bounds.left).toFloat()
        val maxY = (bounds.bottom - panel.height).coerceAtLeast(bounds.top).toFloat()
        panel.x = x.coerceIn(minX, maxX)
        var safeY = y.coerceIn(minY, maxY)
        val candidate = Rect(panel.x.toInt(), safeY.toInt(), panel.x.toInt() + panel.width, safeY.toInt() + panel.height)
        if (!controls.isEmpty && Rect.intersects(candidate, controls)) {
            safeY = (controls.top - panel.height - dp(8)).toFloat().coerceIn(minY, maxY)
        }
        panel.y = safeY
    }

    override fun onAttachedToWindow() { super.onAttachedToWindow(); start() }
    override fun onDetachedFromWindow() { stop(); super.onDetachedFromWindow() }
    fun start() {
        if (running || !isAttachedToWindow) return
        running = true; lastSampleNs = 0; lastFrameNs = 0
        Choreographer.getInstance().postFrameCallback(this)
    }
    fun stop() { running = false; Choreographer.getInstance().removeFrameCallback(this) }

    override fun doFrame(frameTimeNanos: Long) {
        if (!running) return
        Choreographer.getInstance().postFrameCallback(this)
        // Choreographer may run at 120 Hz; cap work at 60 Hz without a wall-clock timer.
        if (lastFrameNs != 0L && frameTimeNanos - lastFrameNs < 16_000_000L) return
        lastFrameNs = frameTimeNanos
        val core = RuntimeBridge.core
        visibility = if (core != null) VISIBLE else GONE
        panel.visibility = if (RuntimeBridge.enabled.value) VISIBLE else GONE
        if (visibility != VISIBLE) return
        val now = SystemClock.elapsedRealtimeNanos()
        try {
            val player = RuntimeBridge.player
            if (lastSampleNs == 0L || now - lastSampleNs >= 250_000_000L) {
                player?.positionMs()?.let { position ->
                    anchorMs = position.coerceAtLeast(0); anchorNs = now
                    playing = player.isPlaying() == true
                    playbackSpeed = player.playbackSpeed()
                } ?: run { playing = false; anchorNs = 0 }
                lastSampleNs = now
                refreshControlBounds()
            }
            if (anchorNs != 0L) core?.onPosition(anchorMs + if (playing) ((now - anchorNs) / 1_000_000 * playbackSpeed).toLong() else 0)
            val state = core?.subtitles?.value ?: SubtitleFrame()
            panel.visibility = if (playerVisible && RuntimeBridge.enabled.value && (state.source.isNotBlank() || state.translation.isNotBlank() || state.notice.isNotBlank() || state.waiting)) VISIBLE else GONE
            val bilingual = RuntimeBridge.bilingual.value
            val config = RuntimeBridge.config.value
            if (state != lastState || bilingual != lastBilingual || config != lastConfig) {
                if (config != lastConfig) {
                    original.textSize = (config.fontSize * 0.82f).coerceAtLeast(11f)
                    translated.textSize = config.fontSize
                    panel.background = if (config.backgroundEnabled && config.backgroundOpacity > 0.01f) GradientDrawable().apply {
                        setColor(Color.argb((config.backgroundOpacity.coerceIn(0f, 1f) * 255).toInt(), 12, 12, 16)); cornerRadius = dp(10).toFloat()
                    } else null
                    if (!dragged) placeDefault()
                }
                lastState = state; lastBilingual = bilingual; lastConfig = config
                original.text = state.source
                original.visibility = if (config.displayMode in setOf("bilingual", "original") && state.source.isNotBlank()) VISIBLE else GONE
                translated.text = state.translation
                translated.visibility = if (config.displayMode in setOf("bilingual", "translation") && state.translation.isNotBlank()) VISIBLE else GONE
                notice.text = state.notice
                notice.visibility = if (state.notice.isBlank()) GONE else VISIBLE
                skip.visibility = if (state.waiting) VISIBLE else GONE
                panel.post { if (!dragged) placeDefault() else place(panel.x, panel.y) }
            }
        } catch (error: Exception) { RuntimeBridge.log("Subtitle frame failed", error) }
    }

    private fun applyInPlayerUpdate(
        mutatePrefs: android.content.SharedPreferences.Editor.() -> Unit,
        mutateConfig: (dev.nihildigit.ytplus.xposed.AppConfig) -> dev.nihildigit.ytplus.xposed.AppConfig,
    ) {
        val localPrefs = context.applicationContext.getSharedPreferences("ytpp_local_overrides", android.content.Context.MODE_PRIVATE)
        localPrefs.edit().apply(mutatePrefs).apply()
        val updated = mutateConfig(RuntimeBridge.config.value)
        RuntimeBridge.config.value = updated
        RuntimeBridge.enabled.value = updated.enabled
        RuntimeBridge.bilingual.value = updated.displayMode == "bilingual"
        RuntimeBridge.core?.onConfigChanged(updated)
    }

    private fun showInPlayerSettingsDialog() {
        val current = RuntimeBridge.config.value
        val rootLayout = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(16), dp(20), dp(12))
            background = GradientDrawable().apply {
                setColor(0xF21E1E1E.toInt())
                cornerRadius = dp(28).toFloat()
                setStroke(dp(1), 0x26FFFFFF)
            }
        }

        val titleView = TextView(activity).apply {
            text = uiText("YT+ 播放器快捷设置", "YT+ player quick settings")
            textSize = 20f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.WHITE)
            setPadding(0, 0, 0, dp(12))
        }
        rootLayout.addView(titleView)

        // 4-way mode selector row
        val modeRow = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, 0, 0, dp(12))
        }
        val modeItems = listOf(
            "bilingual" to uiText("双语", "Bilingual"),
            "translation" to uiText("仅译文", "Translation"),
            "original" to uiText("仅原文", "Original"),
            "off" to uiText("关闭", "Off"),
        )
        val modeButtons = mutableMapOf<String, TextView>()
        fun styleModeButtons(activeMode: String, isEnabled: Boolean) {
            val effective = if (!isEnabled) "off" else activeMode
            modeButtons.forEach { (modeKey, btn) ->
                val active = modeKey == effective
                btn.setTextColor(if (active) Color.BLACK else Color.WHITE)
                btn.background = GradientDrawable().apply {
                    setColor(if (active) Color.WHITE else 0x33FFFFFF)
                    cornerRadius = dp(10).toFloat()
                }
            }
        }

        modeItems.forEach { (modeKey, label) ->
            val btn = pill(label).apply {
                text = label
                textSize = 12.5f
                isAllCaps = false
                setPadding(dp(6), dp(4), dp(6), dp(4))
                setOnClickListener {
                    if (modeKey == "off") {
                        applyInPlayerUpdate(
                            { putBoolean("enabled", false); putString("display_mode", "off") },
                            { it.copy(enabled = false, displayMode = "off") },
                        )
                        styleModeButtons("off", false)
                    } else {
                        applyInPlayerUpdate(
                            { putBoolean("enabled", true); putString("display_mode", modeKey) },
                            { it.copy(enabled = true, displayMode = modeKey) },
                        )
                        styleModeButtons(modeKey, true)
                    }
                }
            }
            modeButtons[modeKey] = btn
            modeRow.addView(btn, LinearLayout.LayoutParams(0, dp(38), 1f).apply {
                marginEnd = dp(4)
            })
        }
        styleModeButtons(current.displayMode, current.enabled)
        rootLayout.addView(modeRow)

        // Font size slider
        val fontLabel = TextView(activity).apply {
            text = uiText("字幕字号: ${current.fontSize.toInt()} sp", "Font size: ${current.fontSize.toInt()} sp")
            textSize = 13.5f
            setTextColor(0xFFE0E0E0.toInt())
        }
        val fontSeek = android.widget.SeekBar(activity).apply {
            max = 28
            progress = (current.fontSize.toInt() - 12).coerceIn(0, 28)
            setOnSeekBarChangeListener(object : android.widget.SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(seekBar: android.widget.SeekBar?, progress: Int, fromUser: Boolean) {
                    val nextSize = (progress + 12).toFloat()
                    fontLabel.text = uiText("字幕字号: ${nextSize.toInt()} sp", "Font size: ${nextSize.toInt()} sp")
                    if (fromUser) {
                        applyInPlayerUpdate(
                            { putFloat("font_size", nextSize) },
                            { it.copy(fontSize = nextSize) },
                        )
                    }
                }
                override fun onStartTrackingTouch(seekBar: android.widget.SeekBar?) = Unit
                override fun onStopTrackingTouch(seekBar: android.widget.SeekBar?) = Unit
            })
        }
        rootLayout.addView(fontLabel)
        rootLayout.addView(fontSeek)

        val opacityLabel = TextView(activity).apply {
            text = uiText("底衬不透明度", "Backdrop opacity") + ": ${(current.backgroundOpacity * 100).toInt()}%"
            textSize = 13.5f
            setTextColor(0xFFE0E0E0.toInt())
        }
        rootLayout.addView(opacityLabel)
        rootLayout.addView(android.widget.SeekBar(activity).apply {
            max = 100
            progress = (current.backgroundOpacity * 100).toInt().coerceIn(0, 100)
            setOnSeekBarChangeListener(object : android.widget.SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(seekBar: android.widget.SeekBar?, progress: Int, fromUser: Boolean) {
                    opacityLabel.text = uiText("底衬不透明度", "Backdrop opacity") + ": $progress%"
                    if (fromUser) applyInPlayerUpdate(
                        { putFloat("background_opacity", progress / 100f) },
                        { it.copy(backgroundOpacity = progress / 100f) },
                    )
                }
                override fun onStartTrackingTouch(seekBar: android.widget.SeekBar?) = Unit
                override fun onStopTrackingTouch(seekBar: android.widget.SeekBar?) = Unit
            })
        })

        // Bottom offset slider
        val offsetLabel = TextView(activity).apply {
            text = uiText("底部距离: ${current.bottomOffset.toInt()} dp", "Bottom offset: ${current.bottomOffset.toInt()} dp")
            textSize = 13.5f
            setTextColor(0xFFE0E0E0.toInt())
            setPadding(0, dp(8), 0, 0)
        }
        val offsetSeek = android.widget.SeekBar(activity).apply {
            max = 240
            progress = current.bottomOffset.toInt().coerceIn(0, 240)
            setOnSeekBarChangeListener(object : android.widget.SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(seekBar: android.widget.SeekBar?, progress: Int, fromUser: Boolean) {
                    val nextOffset = progress.toFloat()
                    offsetLabel.text = uiText("底部距离: ${nextOffset.toInt()} dp", "Bottom offset: ${nextOffset.toInt()} dp")
                    if (fromUser) {
                        dragged = false
                        applyInPlayerUpdate(
                            { putFloat("bottom_offset", nextOffset) },
                            { it.copy(bottomOffset = nextOffset) },
                        )
                    }
                }
                override fun onStartTrackingTouch(seekBar: android.widget.SeekBar?) = Unit
                override fun onStopTrackingTouch(seekBar: android.widget.SeekBar?) = Unit
            })
        }
        rootLayout.addView(offsetLabel)
        rootLayout.addView(offsetSeek)

        fun makeSwitch(title: String, initial: Boolean, onToggle: (Boolean) -> Unit): android.widget.Switch {
            return android.widget.Switch(activity).apply {
                text = title
                textSize = 14f
                setTextColor(Color.WHITE)
                isChecked = initial
                setPadding(0, dp(8), 0, dp(8))
                setOnCheckedChangeListener { _, checked -> onToggle(checked) }
            }
        }

        rootLayout.addView(makeSwitch(uiText("字幕半透明底衬", "Subtitle backdrop"), current.backgroundEnabled) { checked ->
            applyInPlayerUpdate(
                { putBoolean("background_enabled", checked) },
                { it.copy(backgroundEnabled = checked) },
            )
        })
        rootLayout.addView(makeSwitch(uiText("等待首段预翻译完成", "Wait for initial translation"), current.prefetchWait) { checked ->
            applyInPlayerUpdate(
                { putBoolean("prefetch_wait", checked) },
                { it.copy(prefetchWait = checked) },
            )
        })
        rootLayout.addView(makeSwitch(uiText("SponsorBlock 自动跳过", "SponsorBlock auto-skip"), current.sponsorBlockEnabled) { checked ->
            applyInPlayerUpdate(
                { putBoolean("sponsorblock_enabled", checked) },
                { it.copy(sponsorBlockEnabled = checked) },
            )
        })

        val dialog = android.app.AlertDialog.Builder(activity)
            .setView(android.widget.ScrollView(activity).apply { addView(rootLayout); isFillViewport = true })
            .create()

        val bottomRow = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END
            setPadding(0, dp(10), 0, 0)
        }
        bottomRow.addView(pill(uiText("完整设置", "All settings")).apply {
            text = uiText("完整设置", "All settings")
            textSize = 12.5f
            isAllCaps = false
            setOnClickListener {
                dialog.dismiss()
                RuntimeBridge.core?.openSettings(activity)
            }
        })
        bottomRow.addView(pill(uiText("完成", "Done")).apply {
            text = uiText("完成", "Done")
            textSize = 12.5f
            isAllCaps = false
            setOnClickListener { dialog.dismiss() }
        })
        rootLayout.addView(bottomRow)

        dialog.show()
        dialog.window?.apply {
            setBackgroundDrawableResource(android.R.color.transparent)
            setLayout(minOf(resources.displayMetrics.widthPixels - dp(32), dp(460)), ViewGroup.LayoutParams.WRAP_CONTENT)
        }
    }

    private fun pill(label: String) = TextView(context).apply {
        text = label; textSize = 13f; gravity = Gravity.CENTER
        setTextColor(Color.WHITE); setTypeface(typeface, Typeface.BOLD)
        setPadding(dp(16), dp(10), dp(16), dp(10))
        minHeight = dp(40); isClickable = true; isFocusable = true
        background = android.graphics.drawable.RippleDrawable(android.content.res.ColorStateList.valueOf(0x33FFFFFF),
            GradientDrawable().apply { setColor(0xEE292A30.toInt()); cornerRadius = dp(24).toFloat(); setStroke(dp(1), 0x33FFFFFF) }, null)
    }

    private fun caption(size: Float) = TextView(context).apply {
        textSize = size; setTextColor(Color.WHITE); gravity = Gravity.CENTER
        maxWidth = resources.displayMetrics.widthPixels - dp(32)
        setShadowLayer(dp(2).toFloat(), 0f, 0f, Color.BLACK)
    }
    private fun dp(value: Int): Int = (value * resources.displayMetrics.density + .5f).toInt()

    companion object {
        private const val TAG = "ytpp.subtitle.overlay"
        private const val NATIVE_BTN_TAG = "ytpp.native.header.btn"
        private const val YT_SCREEN_OPEN_PATH =
            "M13.5 17.97C13.01 17.99 12.5 18 12 18C10.1134 18 8.2145 17.9389 6.72664 17.8146C5.98609 17.7527 5.32337 17.6733 4.80667 17.572C4.55045 17.5218 4.30223 17.461 4.08755 17.3836C3.92217 17.324 3.58757 17.1925 3.35221 16.9023C3.09841 16.5895 2.97306 16.1603 2.89786 15.8453C2.81086 15.4809 2.74378 15.047 2.69218 14.5835C2.58859 13.6529 2.53846 12.5198 2.53846 11.409C2.53846 10.299 2.58852 9.18195 2.69272 8.28448C2.74448 7.83867 2.81255 7.42043 2.90314 7.07448C2.94831 6.90201 3.00507 6.724 3.07941 6.55976C3.14612 6.41237 3.26514 6.18846 3.47552 6.00694C3.69746 5.81544 3.96667 5.70603 4.16403 5.63863C4.38443 5.56337 4.63628 5.50147 4.9011 5.44891C5.43231 5.34348 6.09632 5.26005 6.83246 5.1949C8.30956 5.06419 10.1608 5 12 5C13.8392 5 15.6904 5.06419 17.1675 5.19491C17.9037 5.26005 18.5677 5.34348 19.0989 5.44892C19.3637 5.50148 19.6156 5.56337 19.836 5.63863C20.0333 5.70603 20.3025 5.81544 20.5245 6.00694C20.7349 6.18846 20.8539 6.41236 20.9206 6.55976C20.9949 6.72401 21.0517 6.90201 21.0969 7.07448C21.1874 7.42043 21.2555 7.83868 21.3073 8.28448C21.4115 9.18195 21.4615 10.299 21.4615 11.409"
        private const val YT_TRIANGLE_PATH =
            "M14.5385 11.5L10.0962 14.3578L10.0962 8.64207L14.5385 11.5Z"
        private const val YT_PLUS_PATH = "M19.2 14V19M16.7 16.5H21.7"
        private val PLAYER_IDS = listOf("player_overlays_custom_views_container", "player_view_container", "player_fragment_container", "player_view", "watch_player")
        private val CONTROL_IDS = setOf("player_control_bar", "player_controls_bottom", "bottom_controls", "time_bar", "seek_bar")
        fun attach(activity: Activity): SubtitleOverlay? {
            val root = activity.window?.decorView as? ViewGroup ?: return null
            return root.findViewWithTag<SubtitleOverlay>(TAG) ?: SubtitleOverlay(activity).also {
                it.tag = TAG
                root.addView(it, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            }
        }
        fun find(activity: Activity): SubtitleOverlay? = activity.window?.decorView?.findViewWithTag(TAG)
    }
}
