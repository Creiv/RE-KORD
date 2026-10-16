package app.rekord.client

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject

/**
 * Playback diagnostics, under one tag so a logcat from a phone tells the story:
 * `adb logcat -s RekordMedia`. Only transitions, stalls, retries and failures are
 * logged, never the 5 s position refreshes.
 */
object RekordLog {
    private const val TAG = "RekordMedia"

    fun i(message: String) {
        Log.i(TAG, message)
    }

    fun w(message: String) {
        Log.w(TAG, message)
    }
}

/**
 * The track now playing, as reported by the player in the WebView.
 *
 * The audio plays inside the page: nothing is played here, we just tell the
 * system what is playing so it can draw the notification and the lock
 * screen.
 */
data class NowPlaying(
    val title: String,
    val artist: String,
    val album: String,
    val artworkUrl: String?,
    val playing: Boolean,
    val durationMs: Long,
    val positionMs: Long,
    /**
     * The player means to play even if no sound comes out yet: a track loading,
     * a `play()` being retried, a stream reconnecting, the hub coming back.
     * Keeps the service in the foreground and the CPU and Wi-Fi awake.
     */
    val wantsPlay: Boolean = playing,
    /** Why it is paused: `external` (another app took the audio), `user`, … */
    val pauseReason: String = "",
) {
    companion object {
        fun fromJson(raw: String): NowPlaying? {
            return try {
                val o = JSONObject(raw)
                val title = o.optString("title").trim()
                if (title.isEmpty()) return null
                NowPlaying(
                    title = title,
                    artist = o.optString("artist").trim(),
                    album = o.optString("album").trim(),
                    artworkUrl = o.optString("artworkUrl").trim().ifEmpty { null },
                    playing = o.optBoolean("playing", false),
                    durationMs = o.optLong("durationMs", 0L).coerceAtLeast(0L),
                    positionMs = o.optLong("positionMs", 0L).coerceAtLeast(0L),
                    wantsPlay = o.optBoolean("wantsPlay", false) || o.optBoolean("playing", false),
                    pauseReason = o.optString("pauseReason").trim(),
                )
            } catch (e: Exception) {
                RekordLog.w("unreadable state: ${e.message}")
                null
            }
        }
    }
}

/**
 * Notification commands travel back to the player along the path the client
 * already has for native shells: a DOM event, with the same action names as the
 * Media Session (see `src/lib/mediaSession.ts`).
 *
 * With the screen off, delivery is not guaranteed: the WebView may be suspended,
 * the CPU may fall back asleep before the script runs, the process may have been
 * frozen until a moment ago, the page may still be loading (or, after the
 * activity was started for a car PLAY, not exist yet). So: a wake lock for the
 * whole delivery window, the WebView woken up before every attempt, and a script
 * that answers `true` only if the player is there (`window.__rekordNativeMediaReady`,
 * set by `nativeMedia.ts` on the first state sent). It retries every
 * [RETRY_MS] until the window ends ([DEFAULT_WINDOW_MS], longer for a play the
 * service is waiting on), then gives up and tells [onDropped].
 */
object RekordMediaBridge {
    @Volatile
    var webView: WebView? = null
        set(value) {
            field = value
            pageSeen = false
        }

    /**
     * The page in [webView] has sent a state at least once: its player is up. A
     * WebView that has just been created is still loading the app and restoring
     * the queue, which takes longer than a page that only slept.
     */
    @Volatile
    var pageSeen = false

    /** Delivery window of a command (5.1 gave up after 3 s). */
    const val DEFAULT_WINDOW_MS = 15_000L
    private const val RETRY_MS = 250L

    private val main = Handler(Looper.getMainLooper())
    private var wakeLock: PowerManager.WakeLock? = null

    /** Only one command in flight: a "play" followed by "pause" counts as "pause". */
    private var pending: Pair<String, Double?>? = null
    private var attempts = 0
    private var startedAt = 0L
    private var deadline = 0L
    /** Last reason an attempt failed, logged once per reason. */
    private var lastMiss = ""
    private val retry = Runnable { deliver() }

    /** Main thread: a command was dropped without reaching the page. */
    var onDropped: ((action: String) -> Unit)? = null

    fun attach(context: Context) {
        if (wakeLock != null) return
        val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Rekord:MediaCommand").apply {
            setReferenceCounted(false)
        }
    }

    /** True while a command waits for the page. */
    val busy: Boolean
        get() = pending != null

    fun send(
        action: String,
        value: Double? = null,
        source: String = "",
        windowMs: Long = DEFAULT_WINDOW_MS,
    ) {
        main.post {
            if (source.isNotEmpty()) RekordLog.i("command $action ($source)")
            pending = action to value
            attempts = 0
            lastMiss = ""
            startedAt = SystemClock.elapsedRealtime()
            deadline = startedAt + windowMs
            main.removeCallbacks(retry)
            try {
                wakeLock?.acquire(windowMs + 1_000L)
            } catch (e: Exception) {
                RekordLog.w("command wake lock unavailable: ${e.message}")
            }
            deliver()
        }
    }

    private fun deliver() {
        val command = pending ?: return
        val view = webView
        if (view == null) {
            miss("no WebView yet (activity not created)")
            return
        }
        val (action, value) = command
        val detail = if (value == null) {
            "{action:'$action'}"
        } else {
            "{action:'$action',value:$value}"
        }
        val script = "(function(){if(!window.__rekordNativeMediaReady)return false;" +
            "window.dispatchEvent(new CustomEvent('rekord:media-action',{detail:$detail}));" +
            "return true})()"
        // With the app in the background and the music paused, the WebView is suspended:
        // a play from the notification would talk to a sleeping player. Wake it up
        // first, then tell it what to do.
        view.onResume()
        view.resumeTimers()
        view.evaluateJavascript(script) { result ->
            if (pending !== command) return@evaluateJavascript
            if (result == "true") {
                val ms = SystemClock.elapsedRealtime() - startedAt
                if (attempts > 0) RekordLog.i("command $action delivered after ${attempts + 1} attempts (${ms} ms)")
                done()
            } else {
                miss("page not ready (player not mounted yet)")
            }
        }
    }

    /**
     * Fire-and-forget event for the page (watchdog heartbeat, network change).
     * No retry and no wake lock of its own (the playback wake lock is held while
     * these are sent), and it never replaces a pending command.
     */
    fun signal(event: String, detailJson: String = "{}") {
        main.post {
            val view = webView ?: return@post
            // Same as for commands: a WebView paused by the activity would leave the
            // player asleep. While these are sent the page means to play.
            view.onResume()
            view.resumeTimers()
            view.evaluateJavascript(
                "(function(){if(!window.__rekordNativeMediaReady)return false;" +
                    "window.dispatchEvent(new CustomEvent('$event',{detail:$detailJson}));" +
                    "return true})()",
                null,
            )
        }
    }

    /**
     * The page has nothing left to do in the background (paused for a while,
     * Cast over): pause the WebView as WryActivity would have, unless the
     * activity is in front or a Cast session needs the page.
     */
    fun sleepIfHidden() {
        main.post {
            if (MainActivity.inFront || RekordCast.isConnected) return@post
            if (RekordMediaService.keepWebViewAwake) return@post
            val view = webView ?: return@post
            view.onPause()
            RekordLog.i("WebView paused: nothing to do in the background")
        }
    }

    private fun miss(reason: String) {
        if (reason != lastMiss) {
            lastMiss = reason
            RekordLog.i("command ${pending?.first}: $reason, retrying")
        }
        attempts += 1
        if (SystemClock.elapsedRealtime() >= deadline) {
            val action = pending?.first
            RekordLog.w("command $action not delivered after ${attempts} attempts: $reason")
            done()
            if (action != null) onDropped?.invoke(action)
            return
        }
        main.removeCallbacks(retry)
        main.postDelayed(retry, RETRY_MS)
    }

    private fun done() {
        pending = null
        attempts = 0
        main.removeCallbacks(retry)
        try {
            if (wakeLock?.isHeld == true) wakeLock?.release()
        } catch (e: Exception) {
            RekordLog.w("command wake lock not released: ${e.message}")
        }
    }
}

/**
 * Surface exposed to the page as `window.RekordMediaNative`. The WebView
 * loads only our local bundle, so no third-party page can
 * call it.
 */
class RekordMedia(private val activity: MainActivity) {
    @JavascriptInterface
    fun update(json: String) {
        val state = NowPlaying.fromJson(json) ?: return
        activity.runOnUiThread {
            RekordMediaBridge.pageSeen = true
            // The permission is requested on the first track, not at startup: first
            // there is something to show, then we ask to be allowed to show it.
            if (state.playing) activity.ensureNotificationPermission()
            // A track that starts (or is being loaded) while the activity is in the
            // background: the WebView may have been paused when the activity was,
            // and a paused WebView is a silent one.
            if (state.wantsPlay) activity.keepWebViewAwake()
            RekordMediaService.publish(activity, state)
        }
    }

    /** Diagnostics from the page (`nativeMedia.ts` `nativeLog`), into the same logcat tag. */
    @JavascriptInterface
    fun log(message: String) {
        RekordLog.i("page: ${message.take(400)}")
    }

    /** The queue emptied: end the session and forget the last track. */
    @JavascriptInterface
    fun stop() {
        activity.runOnUiThread { RekordMediaService.stop(activity, forget = true) }
    }
}
