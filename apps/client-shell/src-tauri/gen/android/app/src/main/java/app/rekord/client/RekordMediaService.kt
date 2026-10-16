package app.rekord.client

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.AudioPlaybackConfiguration
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.support.v4.media.MediaBrowserCompat
import android.support.v4.media.MediaDescriptionCompat
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.media.MediaBrowserServiceCompat
import androidx.media.VolumeProviderCompat
import androidx.media.session.MediaButtonReceiver
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Keeps playback alive when the app goes to the background and draws the
 * system media notification.
 *
 * The sound stays in the WebView: this service has no player. It does two things
 * the page cannot do. First, it is a foreground service, so Android doesn't
 * freeze the process with the screen off. Second, it holds a MediaSession: the
 * notification, the lock screen controls and the headphone button come from it,
 * and then travel back to the page via [RekordMediaBridge].
 *
 * MediaSessionCompat is deprecated in favour of Media3, but Media3 requires
 * implementing a `Player`: here the player is an <audio> tag on the other side of
 * a JavaScript bridge, so a hand-made session remains the shortest path.
 *
 * Reliability with the screen off (see docs/ANDROID.md, "Screen off, network, car"):
 * - it stays in the foreground while the page plays or means to play (loading,
 *   retrying, reconnecting), and for [PAUSE_GRACE_MS] after a pause. Leaving the
 *   foreground at every pause made the next play re-enter it from the background,
 *   which Android 12+ refuses (ForegroundServiceStartNotAllowedException) after a
 *   call or another app's audio paused the track;
 * - while the page means to play it holds a partial wake lock and a Wi-Fi lock:
 *   between two tracks no audio comes out, nothing else keeps the CPU awake, and
 *   the radio's power save stalled the stream "after a while";
 * - a watchdog sends the page a heartbeat every [WATCHDOG_MS] (its own timers are
 *   throttled while hidden), so the player can notice a stalled stream and reload it;
 * - network changes (Wi-Fi to mobile data in the car) are passed to the page;
 * - after another app's audio ends, [InterruptionPolicy] decides whether to resume;
 * - a play from outside (car, Bluetooth, media button, Android Auto, the system's
 *   media controls) enters the foreground and takes the locks at once, inside the
 *   window Android grants for it, then hands the command to the page
 *   ([RemotePlayRequest], [requestPlay]).
 *
 * It is also a media browser service (Android Auto, car head units that browse,
 * the system's media resumption): a single playable "Resume" item for the last
 * track, kept in the app's preferences ([NowPlayingStore]) so it survives the
 * service and the process.
 */
@Suppress("DEPRECATION")
class RekordMediaService : MediaBrowserServiceCompat() {
    private lateinit var session: MediaSessionCompat
    private val artLoader = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())

    @Volatile
    private var artUrl: String? = null
    private var art: Bitmap? = null
    /** 128 px copy of [art] for the media browser item (binder-friendly). */
    private var thumb: Bitmap? = null
    private var inForeground = false
    private var sessionOpensToResume = false
    /** Started (not only bound by a media browser): may show the notification. */
    private var started = false

    /** A play from outside that the page has not taken over yet. */
    private val remotePlay = RemotePlayRequest()
    private var saved: NowPlaying? = null

    private lateinit var audioManager: AudioManager
    private var noisyRegistered = false

    private val policy = InterruptionPolicy()
    private var wakeLock: PowerManager.WakeLock? = null
    private var resumeWakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var locksHeld = false
    private var connectivity: ConnectivityManager? = null
    private var networkCallbackRegistered = false
    private var modeListener: Any? = null

    /** Last time (elapsedRealtime) the page played or meant to play. */
    private var lastActiveAt = 0L
    /** Since when the page means to play without sound coming out (0 = not). */
    private var silentIntentSince = 0L
    private var lastPositionMs = -1L
    private var lastProgressAt = 0L
    private var stallReported = false
    private var lastTransition = ""
    private var lastTitle = ""
    private var currentNetwork: Network? = null
    private var networkSeen = false

    /*
     * Audio focus is left to the WebView: Chromium requests it as soon as the
     * <audio> element starts and pauses/resumes the element itself on losses
     * (calls, other music apps). Requesting it here too made the two steal it
     * from each other, and the loss handler paused the track right after it
     * started. The legacy app ignored focus changes for the same reason.
     */

    /**
     * Headphones unplugged / Bluetooth off: pause right away, before it plays through
     * the speaker. Also registered while an interruption may still resume: a car that
     * disconnects during a call must not get the music back on the phone's speaker.
     */
    private val noisyReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != AudioManager.ACTION_AUDIO_BECOMING_NOISY) return
            policy.onNoisy()?.let { RekordLog.i("interruption: $it") }
            if (isPlaying) {
                RekordMediaBridge.send("pause", source = "audio output disconnected")
            }
            latest?.let { render(it) }
        }
    }

    /** Heartbeat for the page while it means to play (see the class comment). */
    private val watchdog = object : Runnable {
        override fun run() {
            val state = latest ?: return
            if (!locksHeld) return
            val now = SystemClock.elapsedRealtime()
            // Re-armed on every beat: a timeout keeps a lost release from draining the battery.
            acquireWakeLock()
            val stalledMs = if (state.playing) now - lastProgressAt else 0L
            if (state.playing && stalledMs >= STALL_REPORT_MS && !stallReported) {
                stallReported = true
                RekordLog.w("watchdog: page says playing, no progress for ${stalledMs / 1000}s")
            }
            // Silent and someone else has the audio (a call, another app): the page
            // must not answer with play() / reload, that would fight for the focus.
            val otherAudio = !state.playing && (inCall() || otherAudioActive())
            RekordMediaBridge.signal(
                "rekord:playback-watchdog",
                "{stalledMs:$stalledMs,otherAudio:$otherAudio}",
            )
            applyLocks(state)
            if (locksHeld) main.postDelayed(this, WATCHDOG_MS)
        }
    }

    /** The page did not take a play from outside over in time. */
    private val remotePlayCheck = Runnable { checkRemotePlay() }

    /** Re-evaluates the foreground state when the pause grace runs out. */
    private val graceCheck = Runnable { latest?.let { render(it) } }

    /** Re-evaluates a pending interruption (quiet window, call end, expiry). */
    private val interruptionCheck = Runnable { checkInterruption("timer") }

    /** Other apps' audio starting and stopping (no focus request of our own). */
    private val playbackCallback = object : AudioManager.AudioPlaybackCallback() {
        override fun onPlaybackConfigChanged(configs: MutableList<AudioPlaybackConfiguration>?) {
            if (policy.armed) checkInterruption("audio change")
        }
    }

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            main.post { onNetwork(network, available = true) }
        }

        override fun onLost(network: Network) {
            main.post { onNetwork(network, available = false) }
        }
    }

    override fun onCreate() {
        super.onCreate()
        createChannel()
        audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        session = MediaSessionCompat(this, "RE-KORD").apply {
            // Notification, lock screen, headset, Bluetooth / car controls.
            setCallback(object : MediaSessionCompat.Callback() {
                override fun onPlay() = requestPlay("media session")

                override fun onPlayFromMediaId(mediaId: String?, extras: Bundle?) =
                    requestPlay("media browser item ${mediaId ?: ""}")

                // "Play RE-KORD" from the Assistant or the car: there is no search
                // here, the closest thing is resuming the last track.
                override fun onPlayFromSearch(query: String?, extras: Bundle?) =
                    requestPlay("play from search")

                override fun onPause() {
                    policy.onUserPause()?.let { RekordLog.i("interruption: $it") }
                    cancelRemotePlay("pause")
                    RekordMediaBridge.send("pause", source = "media session")
                }

                override fun onSkipToNext() =
                    RekordMediaBridge.send("nexttrack", source = "media session")

                override fun onSkipToPrevious() =
                    RekordMediaBridge.send("previoustrack", source = "media session")

                override fun onSeekTo(pos: Long) =
                    RekordMediaBridge.send("seekto", pos / 1000.0)

                override fun onStop() {
                    policy.onUserPause()
                    cancelRemotePlay("stop")
                    RekordMediaBridge.send("pause", source = "media session stop")
                    stop(this@RekordMediaService)
                }
            })
            setSessionActivity(openAppIntent(resume = false))
            isActive = true
        }
        // Media browser clients (Android Auto, the system's media controls) get the
        // session from the service.
        sessionToken = session.sessionToken
        running = this
        createLocks()
        watchSystem()
        RekordMediaBridge.onDropped = { action -> if (action == "play") checkRemotePlay(dropped = true) }
        applyCastTarget(rerender = false)
        // Recreated with no page state (media button, media browser after the system
        // stopped the service or the process): rebuild the session with the last track,
        // paused, so the car shows it and can press play. Session only: onStartCommand
        // decides about the notification.
        val state = latest ?: restoreSaved()
        if (state != null) render(state)
    }

    private fun createLocks() {
        val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
        wakeLock = pm?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Rekord:Playback")?.apply {
            setReferenceCounted(false)
        }
        resumeWakeLock = pm?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Rekord:Resume")?.apply {
            setReferenceCounted(false)
        }
        val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        // HIGH_PERF is what keeps the radio out of power save with the screen off
        // (LOW_LATENCY only applies while the app is in front with the screen on).
        @Suppress("DEPRECATION")
        wifiLock = wifi?.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "Rekord:Playback")?.apply {
            setReferenceCounted(false)
        }
    }

    /** Other apps' audio, calls and the network: observed, never requested. */
    private fun watchSystem() {
        try {
            audioManager.registerAudioPlaybackCallback(playbackCallback, main)
        } catch (e: Exception) {
            RekordLog.w("audio playback callback unavailable: ${e.message}")
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                val listener = AudioManager.OnModeChangedListener {
                    if (policy.armed) checkInterruption("audio mode $it")
                }
                audioManager.addOnModeChangedListener(mainExecutor, listener)
                modeListener = listener
            } catch (e: Exception) {
                RekordLog.w("audio mode listener unavailable: ${e.message}")
            }
        }
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        connectivity = cm
        try {
            cm?.registerDefaultNetworkCallback(networkCallback, main)
            networkCallbackRegistered = cm != null
        } catch (e: Exception) {
            RekordLog.w("network callback unavailable: ${e.message}")
        }
    }

    private fun unwatchSystem() {
        try {
            audioManager.unregisterAudioPlaybackCallback(playbackCallback)
        } catch (e: Exception) {
            RekordLog.w("audio playback callback not removed: ${e.message}")
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (modeListener as? AudioManager.OnModeChangedListener)?.let {
                try {
                    audioManager.removeOnModeChangedListener(it)
                } catch (e: Exception) {
                    RekordLog.w("audio mode listener not removed: ${e.message}")
                }
            }
            modeListener = null
        }
        if (networkCallbackRegistered) {
            networkCallbackRegistered = false
            try {
                connectivity?.unregisterNetworkCallback(networkCallback)
            } catch (e: Exception) {
                RekordLog.w("network callback not removed: ${e.message}")
            }
        }
    }

    private fun transportOf(network: Network): String {
        val caps = try {
            connectivity?.getNetworkCapabilities(network)
        } catch (e: Exception) {
            null
        } ?: return "unknown"
        return when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_BLUETOOTH) -> "bluetooth"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "vpn"
            else -> "other"
        }
    }

    /**
     * The default network changed. The stream's connection belonged to the old
     * one: the page checks its decks and reconnects at once instead of waiting for
     * its (throttled) stall timers.
     */
    private fun onNetwork(network: Network, available: Boolean) {
        if (available) {
            if (network == currentNetwork) return
            currentNetwork = network
            val transport = transportOf(network)
            // Registering the callback reports the current network: not a change.
            val first = !networkSeen
            networkSeen = true
            if (first) {
                RekordLog.i("network: $transport")
                return
            }
            RekordLog.i("network changed: now $transport")
            if (latest?.wantsPlay == true) {
                RekordMediaBridge.signal("rekord:network", "{available:true,transport:'$transport'}")
            }
        } else {
            if (network != currentNetwork) return
            currentNetwork = null
            RekordLog.i("network lost")
            if (latest?.wantsPlay == true) {
                RekordMediaBridge.signal("rekord:network", "{available:false}")
            }
        }
    }

    /** Is some other app (or a call) producing sound right now? */
    private fun otherAudioActive(): Boolean {
        // Only called while our page is paused: whatever plays is someone else.
        // Apps get the anonymized list of *active* players.
        val configs = try {
            audioManager.activePlaybackConfigurations
        } catch (e: Exception) {
            return false
        }
        return configs.any {
            when (it.audioAttributes.usage) {
                // Key clicks and accessibility hints are not an interruption.
                AudioAttributes.USAGE_ASSISTANCE_SONIFICATION,
                AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY -> false
                else -> true
            }
        }
    }

    private fun inCall(): Boolean = audioManager.mode != AudioManager.MODE_NORMAL

    private fun checkInterruption(trigger: String) {
        main.removeCallbacks(interruptionCheck)
        val now = SystemClock.elapsedRealtime()
        val other = otherAudioActive()
        val call = inCall()
        when (val d = policy.decide(now, other, call)) {
            InterruptionPolicy.Decision.None -> Unit
            is InterruptionPolicy.Decision.Wait -> {
                val delay = d.recheckMs ?: ARMED_RECHECK_MS
                // A short wait (the quiet window) must not be stretched by deep sleep.
                if (d.recheckMs != null) holdResumeWake(delay + 1_000L)
                main.postDelayed(interruptionCheck, delay)
            }
            InterruptionPolicy.Decision.Resume -> {
                RekordLog.i("interruption over ($trigger): resuming")
                holdResumeWake(RESUME_WAKE_MS)
                RekordMediaBridge.send("play", source = "resume after interruption")
                main.postDelayed(interruptionCheck, RESUME_RECHECK_MS)
            }
            is InterruptionPolicy.Decision.Expired -> {
                RekordLog.i("interruption: not resuming, ${d.reason}")
                latest?.let { render(it) }
            }
        }
    }

    private fun holdResumeWake(ms: Long) {
        try {
            resumeWakeLock?.acquire(ms)
        } catch (e: Exception) {
            RekordLog.w("resume wake lock unavailable: ${e.message}")
        }
    }

    /** A new state from the page (as opposed to a redraw for the cover art). */
    private fun accept(state: NowPlaying) {
        val now = SystemClock.elapsedRealtime()
        if (state.title != lastTitle) {
            lastTitle = state.title
            lastPositionMs = -1L
            RekordLog.i("track: ${state.title.take(80)}")
            notifyChildrenChanged(ROOT_ID)
        }
        if (remotePlay.onPageState(state.playing, state.wantsPlay)) {
            main.removeCallbacks(remotePlayCheck)
            RekordLog.i("play: the page took it over (${if (state.playing) "playing" else "loading"})")
        }
        save(state)
        if (!state.playing || state.positionMs != lastPositionMs) {
            lastPositionMs = state.positionMs
            lastProgressAt = now
            if (stallReported && state.playing) RekordLog.i("watchdog: progress again")
            stallReported = false
        }
        if (state.playing || state.wantsPlay) lastActiveAt = now
        silentIntentSince = when {
            state.playing || !state.wantsPlay -> 0L
            silentIntentSince == 0L -> now
            else -> silentIntentSince
        }
        val transition = when {
            state.playing -> "playing"
            state.wantsPlay -> "waiting to play (loading, retrying or reconnecting)"
            state.pauseReason.isNotEmpty() -> "paused (${state.pauseReason})"
            else -> "paused"
        }
        if (transition != lastTransition) {
            lastTransition = transition
            RekordLog.i("page: $transition")
        }
        policy.onPageState(state.playing, state.pauseReason, now)?.let {
            RekordLog.i("interruption: $it")
        }
        render(state)
        if (policy.armed) checkInterruption("page state")
    }

    /**
     * While casting, the music comes out of the Chromecast: no pause when
     * headphones are unplugged, and the volume keys with the screen off go
     * to the Cast device. The notification stays, showing the device name.
     */
    private fun applyCastTarget(rerender: Boolean = true) {
        if (castTarget != null) {
            unregisterNoisy()
            session.setPlaybackToRemote(castVolume())
        } else {
            session.setPlaybackToLocal(AudioManager.STREAM_MUSIC)
        }
        if (rerender) {
            latest?.let { render(it) }
            // Cast ended with the app in the background and nothing playing here.
            if (castTarget == null && !inForeground) RekordMediaBridge.sleepIfHidden()
        }
    }

    private fun castVolume(): VolumeProviderCompat {
        val steps = 20
        val current = (RekordCast.volume() * steps).toInt().coerceIn(0, steps)
        return object : VolumeProviderCompat(VOLUME_CONTROL_ABSOLUTE, steps, current) {
            override fun onSetVolumeTo(volume: Int) {
                val level = volume.coerceIn(0, steps)
                RekordCast.setVolume(level / steps.toDouble())
                currentVolume = level
            }

            override fun onAdjustVolume(direction: Int) {
                val level = (currentVolume + direction).coerceIn(0, steps)
                RekordCast.setVolume(level / steps.toDouble())
                currentVolume = level
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        started = true
        val mediaButton = intent?.action == Intent.ACTION_MEDIA_BUTTON
        val resume = intent?.action == ACTION_RESUME
        if (latest == null && (mediaButton || resume)) {
            // The service (or the whole process) was gone: a car or headset button
            // restarted it. Resume the last track rather than ignoring the press.
            latest = restoreSaved()?.also {
                RekordLog.i("media button with no page state: last track restored (${it.title.take(80)})")
            }
        }
        val state = latest
        if (state == null) {
            // The music ended in the meantime (queue cleared right before play), or a
            // media button woke us with nothing ever played (nothing to resume).
            // A service started with startForegroundService must still go into the
            // foreground, otherwise Android kills it with an exception: enter and
            // leave immediately.
            RekordLog.i(if (mediaButton) "media button: nothing to resume" else "service: started with nothing to show")
            enterForeground(buildNotification(idle()))
            stop(this)
            return START_NOT_STICKY
        }
        if (resume) {
            if (!inForeground) enterForeground(buildNotification(state))
            requestPlay("notification: open and resume")
            return START_NOT_STICKY
        }
        if (mediaButton) {
            // We are inside the window Android grants for a media button: enter the
            // foreground first, then let the command through (the session delivers
            // it asynchronously, onPlay comes after this returns). A button is user
            // activity: the pause grace starts again, so the render below does not
            // leave the foreground under the incoming play.
            lastActiveAt = SystemClock.elapsedRealtime()
            if (!inForeground) enterForeground(buildNotification(state))
            MediaButtonReceiver.handleIntent(session, intent)
            render(state)
            return START_NOT_STICKY
        }
        // Started with startForegroundService: startForeground is owed in any case.
        if (!inForeground) enterForeground(buildNotification(state))
        accept(state)
        return START_NOT_STICKY
    }

    /**
     * Play from outside the app: car, Bluetooth, headset, lock screen, Android
     * Auto, the system's media controls. Runs inside the short window in which
     * Android lets a service enter the foreground from the background, so it does
     * that first, with the CPU and Wi-Fi locks, and only then talks to the page,
     * which may be paused, just unfrozen, or not there at all.
     */
    private fun requestPlay(source: String) {
        val state = latest ?: restoreSaved()?.also {
            latest = it
            RekordLog.i("play ($source): no page state, last track restored")
        }
        if (state == null) {
            RekordLog.i("play ($source): nothing to resume")
            return
        }
        if (state.playing) {
            RekordMediaBridge.send("play", source = source)
            return
        }
        val now = SystemClock.elapsedRealtime()
        val pageAlive = RekordMediaBridge.webView != null && RekordMediaBridge.pageSeen
        val window = remotePlay.begin(now, pageAlive)
        lastActiveAt = now
        RekordLog.i(
            "play ($source): foreground and locks first, page has ${window / 1000}s to start" +
                when {
                    pageAlive -> ""
                    RekordMediaBridge.webView != null || MainActivity.alive -> " (page still loading)"
                    else -> " (no page: starting the app)"
                },
        )
        ensureStarted()
        if (!inForeground) enterForeground(buildNotification(state))
        applyLocks(state)
        main.removeCallbacks(remotePlayCheck)
        main.postDelayed(remotePlayCheck, window + 500L)
        RekordMediaBridge.send("play", source = source, windowMs = window)
        // Opened from the notification, or still starting: the activity is there.
        if (RekordMediaBridge.webView == null && !MainActivity.alive) launchApp()
        render(state)
    }

    private fun cancelRemotePlay(reason: String) {
        if (!remotePlay.cancel()) return
        main.removeCallbacks(remotePlayCheck)
        RekordLog.i("play: cancelled by $reason")
    }

    /** The window of a play from outside ran out (or the bridge gave up). */
    private fun checkRemotePlay(dropped: Boolean = false) {
        if (!remotePlay.pending) return
        val left = if (dropped) 0L.also { remotePlay.cancel() } else remotePlay.remaining(SystemClock.elapsedRealtime())
        if (left > 0) {
            main.removeCallbacks(remotePlayCheck)
            main.postDelayed(remotePlayCheck, left + 500L)
            return
        }
        main.removeCallbacks(remotePlayCheck)
        val pageAlive = RekordMediaBridge.webView != null
        if (pageAlive) {
            RekordLog.w("play: the page did not start (paused grace from here)")
        } else {
            // No page to keep alive: no reason to hold the foreground. The
            // notification stays, and tapping it opens the app and resumes.
            RekordLog.w("play: no page, the app could not be started from the background; tap the notification to resume")
            lastActiveAt = 0L
        }
        latest?.let { render(it) }
    }

    /**
     * The WebView, and the audio, live in MainActivity: with the activity gone
     * there is nothing to play with. Android 10+ blocks activity starts from the
     * background (a foreground service or a media button is not an exemption), so
     * this works only where the system allows it (Android 9 and older, "display
     * over other apps" granted, some OEM builds). When it is blocked the system logs
     * "Background activity launch blocked" under ActivityTaskManager.
     */
    private fun launchApp() {
        try {
            startActivity(
                Intent(this, MainActivity::class.java)
                    .setAction(MainActivity.ACTION_RESUME_IN_BACKGROUND)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION),
            )
            RekordLog.i("no page: asked Android to start the app in the background")
        } catch (e: Exception) {
            RekordLog.w("no page: app not started: ${e.javaClass.simpleName}: ${e.message}")
        }
    }

    /** Bound only (media browser): become a started service before the foreground. */
    private fun ensureStarted() {
        if (started) return
        try {
            ContextCompat.startForegroundService(this, Intent(this, RekordMediaService::class.java))
            started = true
        } catch (e: Exception) {
            RekordLog.w("service not started: ${e.javaClass.simpleName}: ${e.message}")
        }
    }

    private fun prefs() = getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun restoreSaved(): NowPlaying? {
        val p = prefs()
        return NowPlayingStore.decode { p.getString(it, null) }.also { saved = it }
    }

    /** Keeps the last track for a resume after the service or the process died. */
    private fun save(state: NowPlaying) {
        if (!NowPlayingStore.worthSaving(saved, state)) return
        saved = state
        val editor = prefs().edit()
        for ((k, v) in NowPlayingStore.encode(state, System.currentTimeMillis())) editor.putString(k, v)
        editor.apply()
    }

    private fun forgetSaved() {
        saved = null
        val editor = prefs().edit()
        for (k in NowPlayingStore.KEYS) editor.remove(k)
        editor.apply()
    }

    override fun onGetRoot(clientPackageName: String, clientUid: Int, rootHints: Bundle?): BrowserRoot {
        // Any caller: Android Auto (com.google.android.projection.gearhead), the
        // system UI's media controls, car head units through Bluetooth. What they
        // see is the title of the last track, what the notification shows anyway.
        val recent = rootHints?.getBoolean(BrowserRoot.EXTRA_RECENT) == true
        RekordLog.i("media browser: $clientPackageName connected${if (recent) " (recent)" else ""}")
        return if (recent) {
            BrowserRoot(ROOT_RECENT, Bundle().apply { putBoolean(BrowserRoot.EXTRA_RECENT, true) })
        } else {
            BrowserRoot(ROOT_ID, null)
        }
    }

    override fun onLoadChildren(parentId: String, result: Result<MutableList<MediaBrowserCompat.MediaItem>>) {
        val state = latest ?: saved ?: restoreSaved()
        if (state == null || (parentId != ROOT_ID && parentId != ROOT_RECENT)) {
            result.sendResult(mutableListOf())
            return
        }
        val details = listOf(state.artist, state.album).filter { it.isNotEmpty() }.joinToString(" · ")
        // The system's media resumption shows the item as the player: the track is
        // the title. In a browsing UI (Android Auto) the action is.
        val description = MediaDescriptionCompat.Builder()
            .setMediaId(RESUME_ID)
            .apply {
                if (parentId == ROOT_RECENT) {
                    setTitle(state.title)
                    setSubtitle(details)
                } else {
                    setTitle(getString(R.string.media_resume))
                    setSubtitle(listOf(state.title, state.artist).filter { it.isNotEmpty() }.joinToString(" · "))
                }
            }
            .setIconBitmap(thumb)
            .build()
        result.sendResult(
            mutableListOf(MediaBrowserCompat.MediaItem(description, MediaBrowserCompat.MediaItem.FLAG_PLAYABLE)),
        )
    }

    /** Rewrites the session and notification with the state just received from the page. */
    private fun render(state: NowPlaying) {
        requestArt(state.artworkUrl)
        session.setMetadata(
            MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, state.title)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, state.artist)
                .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, state.album)
                .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, state.durationMs)
                .apply { art?.let { putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, it) } }
                .build(),
        )
        session.setPlaybackState(
            PlaybackStateCompat.Builder()
                .setState(
                    if (state.playing) PlaybackStateCompat.STATE_PLAYING
                    else PlaybackStateCompat.STATE_PAUSED,
                    state.positionMs,
                    if (state.playing) 1f else 0f,
                )
                .setActions(
                    PlaybackStateCompat.ACTION_PLAY or
                        PlaybackStateCompat.ACTION_PLAY_FROM_MEDIA_ID or
                        PlaybackStateCompat.ACTION_PLAY_FROM_SEARCH or
                        PlaybackStateCompat.ACTION_PAUSE or
                        PlaybackStateCompat.ACTION_PLAY_PAUSE or
                        PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
                        PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
                        PlaybackStateCompat.ACTION_SEEK_TO or
                        PlaybackStateCompat.ACTION_STOP,
                )
                .build(),
        )
        val now = SystemClock.elapsedRealtime()
        val graceLeft = ForegroundPolicy.graceLeft(now, lastActiveAt, PAUSE_GRACE_MS)
        val hold = ForegroundPolicy.holdForeground(
            playing = state.playing,
            wantsPlay = state.wantsPlay,
            interruptionArmed = policy.armed,
            remotePlayPending = remotePlay.pending,
            graceLeft = graceLeft,
        )
        if (!started && !inForeground) {
            // Bound by a media browser only (system media controls, Android Auto) and
            // nothing to play: the session is enough, no notification, no locks.
            if (!hold) return
            ensureStarted()
        }
        if ((state.playing || policy.armed) && castTarget == null) {
            registerNoisy()
        } else {
            unregisterNoisy()
        }
        applyLocks(state)
        val notification = buildNotification(state)
        main.removeCallbacks(graceCheck)
        if (hold) {
            if (inForeground) {
                NotificationManagerCompat.from(this).notify(NOTIFICATION_ID, notification)
            } else {
                enterForeground(notification)
            }
            if (!state.playing && !state.wantsPlay && !policy.armed && !remotePlay.pending && graceLeft > 0) {
                main.postDelayed(graceCheck, graceLeft + 1_000L)
            }
        } else {
            // Paused for a while: leave the foreground but keep the notification,
            // so playback can be resumed from it and it can be swiped away.
            // DETACH keeps it up after leaving. Until now the service stayed in the
            // foreground: a pause from a call or from another app ends with a play
            // that comes from the background, and from the background Android 12+
            // no longer lets a service back into the foreground.
            if (inForeground) {
                ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_DETACH)
                inForeground = false
                RekordLog.i(
                    if (lastActiveAt > 0L) "service: out of the foreground (paused for ${PAUSE_GRACE_MS / 60_000} min)"
                    else "service: out of the foreground",
                )
                // MainActivity kept the WebView running for a possible resume: with
                // the app still in the background, let it sleep now. Every command
                // from the notification wakes it first.
                RekordMediaBridge.sleepIfHidden()
            }
            NotificationManagerCompat.from(this).notify(NOTIFICATION_ID, notification)
        }
    }

    /**
     * CPU and Wi-Fi stay awake while the page plays or means to play. A page that
     * keeps failing to start (hub gone for good) lets go after [SILENT_INTENT_MAX_MS].
     */
    private fun applyLocks(state: NowPlaying) {
        val now = SystemClock.elapsedRealtime()
        val silentTooLong = silentIntentSince != 0L && now - silentIntentSince > SILENT_INTENT_MAX_MS
        // While casting the sound comes out of the Chromecast: no stream through
        // the phone, nothing to keep awake for a whole session (RekordCast wakes
        // the CPU briefly on the events the page must answer).
        // A play from outside holds them before the page answers: the page needs
        // the CPU and the network to load the track it is about to play.
        val want = ForegroundPolicy.holdLocks(
            casting = castTarget != null,
            playing = state.playing,
            wantsPlay = state.wantsPlay,
            silentTooLong = silentTooLong,
            remotePlayPending = remotePlay.pending,
        )
        if (want == locksHeld) return
        locksHeld = want
        if (want) {
            acquireWakeLock()
            try {
                wifiLock?.acquire()
            } catch (e: Exception) {
                RekordLog.w("wifi lock unavailable: ${e.message}")
            }
            main.removeCallbacks(watchdog)
            main.postDelayed(watchdog, WATCHDOG_MS)
            RekordLog.i("locks: CPU and Wi-Fi held")
        } else {
            releaseLocks()
            RekordLog.i(
                if (silentTooLong) "locks: released, nothing has played for ${SILENT_INTENT_MAX_MS / 60_000} min"
                else "locks: released",
            )
        }
    }

    private fun acquireWakeLock() {
        try {
            wakeLock?.acquire(WAKE_LOCK_TIMEOUT_MS)
        } catch (e: Exception) {
            RekordLog.w("wake lock unavailable: ${e.message}")
        }
    }

    private fun releaseLocks() {
        main.removeCallbacks(watchdog)
        try {
            if (wakeLock?.isHeld == true) wakeLock?.release()
            if (wifiLock?.isHeld == true) wifiLock?.release()
        } catch (e: Exception) {
            RekordLog.w("locks not released: ${e.message}")
        }
    }

    private fun registerNoisy() {
        if (noisyRegistered) return
        ContextCompat.registerReceiver(
            this,
            noisyReceiver,
            IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        noisyRegistered = true
    }

    private fun unregisterNoisy() {
        if (!noisyRegistered) return
        noisyRegistered = false
        try {
            unregisterReceiver(noisyReceiver)
        } catch (e: IllegalArgumentException) {
            RekordLog.w("receiver already removed: ${e.message}")
        }
    }

    private fun enterForeground(notification: Notification) {
        try {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                notification,
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                } else {
                    0
                },
            )
            inForeground = true
            RekordLog.i("service: in the foreground")
        } catch (e: Exception) {
            // Android 12+ refuses the foreground from the background
            // (ForegroundServiceStartNotAllowedException, an IllegalStateException).
            // Uncaught it closed the app; now the music goes on without the
            // protection, and the notification is still drawn.
            inForeground = false
            RekordLog.w("service: foreground refused: ${e.javaClass.simpleName}: ${e.message}")
            NotificationManagerCompat.from(this).notify(NOTIFICATION_ID, notification)
        }
    }

    private fun idle() = NowPlaying(
        title = getString(R.string.app_name),
        artist = "",
        album = "",
        artworkUrl = null,
        playing = false,
        durationMs = 0L,
        positionMs = 0L,
    )

    /**
     * Opens the app. With [resume] (no page: the app was closed or could not be
     * started from the background) the app also resumes the track once open.
     */
    private fun openAppIntent(resume: Boolean): PendingIntent = PendingIntent.getActivity(
        this,
        if (resume) 1 else 0,
        Intent(this, MainActivity::class.java).apply {
            if (resume) action = MainActivity.ACTION_RESUME
        },
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    private fun buildNotification(state: NowPlaying): Notification {
        val noPage = RekordMediaBridge.webView == null && latest != null
        val open = openAppIntent(resume = noPage)
        // Android 13+ draws the media player from the session, not from the
        // notification text: tapping it opens the session activity, so that one
        // resumes too when there is no page.
        if (noPage != sessionOpensToResume) {
            sessionOpensToResume = noPage
            session.setSessionActivity(open)
        }
        val stop = MediaButtonReceiver.buildMediaButtonPendingIntent(
            this,
            PlaybackStateCompat.ACTION_STOP,
        )
        val subtitle = listOf(state.artist, state.album)
            .filter { it.isNotEmpty() }
            .joinToString(" · ")
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_rekord_note)
            .setContentTitle(state.title)
            .setContentText(if (noPage && !state.playing) getString(R.string.media_open_to_resume) else subtitle)
            .setSubText(castTarget?.let { getString(R.string.cast_playing_on, it) })
            .setLargeIcon(art)
            .setContentIntent(open)
            .setDeleteIntent(stop)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(state.playing)
            .setShowWhen(false)
            .setOnlyAlertOnce(true)
            .addAction(
                android.R.drawable.ic_media_previous,
                getString(R.string.media_previous),
                MediaButtonReceiver.buildMediaButtonPendingIntent(
                    this,
                    PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS,
                ),
            )
            .addAction(
                if (state.playing) android.R.drawable.ic_media_pause
                else android.R.drawable.ic_media_play,
                getString(if (state.playing) R.string.media_pause else R.string.media_play),
                MediaButtonReceiver.buildMediaButtonPendingIntent(
                    this,
                    PlaybackStateCompat.ACTION_PLAY_PAUSE,
                ),
            )
            .addAction(
                android.R.drawable.ic_media_next,
                getString(R.string.media_next),
                MediaButtonReceiver.buildMediaButtonPendingIntent(
                    this,
                    PlaybackStateCompat.ACTION_SKIP_TO_NEXT,
                ),
            )
            .setStyle(
                androidx.media.app.NotificationCompat.MediaStyle()
                    .setMediaSession(session.sessionToken)
                    .setShowActionsInCompactView(0, 1, 2)
                    .setShowCancelButton(true)
                    .setCancelButtonIntent(stop),
            )
            .build()
    }

    /**
     * The cover art comes from the hub over HTTP: it is downloaded once per URL and
     * redrawn when ready, without blocking the notification.
     */
    private fun requestArt(url: String?) {
        if (url == null) {
            artUrl = null
            art = null
            thumb = null
            return
        }
        if (url == artUrl) return
        artUrl = url
        art = null
        thumb = null
        artLoader.execute {
            val bitmap = downloadArt(url)
            // If the track changed in the meantime, this cover art is no longer needed.
            if (bitmap == null || url != artUrl) return@execute
            main.post {
                if (url != artUrl) return@post
                art = bitmap
                thumb = try {
                    Bitmap.createScaledBitmap(bitmap, 128, 128, true)
                } catch (e: Exception) {
                    null
                }
                latest?.let { render(it) }
                notifyChildrenChanged(ROOT_ID)
            }
        }
    }

    private fun downloadArt(url: String): Bitmap? {
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 5_000
                readTimeout = 5_000
                instanceFollowRedirects = true
            }
            if (connection.responseCode !in 200..299) return null
            connection.inputStream.use { BitmapFactory.decodeStream(it) }
        } catch (e: Exception) {
            RekordLog.w("cover art not downloaded: ${e.message}")
            null
        } finally {
            connection?.disconnect()
        }
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.media_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.media_channel_description)
            setShowBadge(false)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    /** If the app is closed from recents the WebView dies, and the audio with it. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        stop(this)
    }

    override fun onDestroy() {
        running = null
        RekordLog.i("service: stopped")
        RekordMediaBridge.onDropped = null
        releaseLocks()
        try {
            if (resumeWakeLock?.isHeld == true) resumeWakeLock?.release()
        } catch (e: Exception) {
            RekordLog.w("resume wake lock not released: ${e.message}")
        }
        unwatchSystem()
        // `latest` is not cleared here: if the service dies without going through stop()
        // (memory, system) the page is still playing, and the next state it sends
        // will restart it. Whoever stops the music takes care of clearing it.
        artLoader.shutdownNow()
        main.removeCallbacksAndMessages(null)
        unregisterNoisy()
        session.isActive = false
        session.release()
        NotificationManagerCompat.from(this).cancel(NOTIFICATION_ID)
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL_ID = "rekord.playback"
        private const val NOTIFICATION_ID = 1

        /** In the foreground this long after a pause (Media3's default is the same). */
        private const val PAUSE_GRACE_MS = 10 * 60_000L
        /** Page heartbeat while it means to play. */
        private const val WATCHDOG_MS = 10_000L
        /** "Playing" without a position update for this long goes in the log. */
        private const val STALL_REPORT_MS = 25_000L
        /** Wanting to play with nothing coming out: locks are dropped after this. */
        private const val SILENT_INTENT_MAX_MS = 10 * 60_000L
        /** Safety timeout of the playback wake lock, re-armed by every heartbeat. */
        private const val WAKE_LOCK_TIMEOUT_MS = 10 * 60_000L
        /** Interruption armed, waiting on a call or other audio: poll as a backstop. */
        private const val ARMED_RECHECK_MS = 30_000L
        private const val RESUME_WAKE_MS = 15_000L
        private const val RESUME_RECHECK_MS = 10_500L

        private const val PREFS = "rekord.media"
        private const val ROOT_ID = "rekord.root"
        private const val ROOT_RECENT = "rekord.recent"
        private const val RESUME_ID = "rekord.resume"

        @Volatile
        private var running: RekordMediaService? = null

        @Volatile
        private var latest: NowPlaying? = null

        /** Name of the connected Cast device, null when the music plays here. */
        @Volatile
        private var castTarget: String? = null

        /**
         * Called by [RekordCast] when a Cast session starts or ends. The
         * service is not started from here: it is started by the first "playing"
         * state that the page mirrors from the receiver.
         */
        fun setCastTarget(deviceName: String?) {
            if (castTarget == deviceName) return
            castTarget = deviceName
            running?.applyCastTarget()
        }

        val isPlaying: Boolean
            get() = latest?.playing == true

        /** A play from outside is waiting for the page (read by MainActivity). */
        val awaitingPage: Boolean
            get() = running?.remotePlay?.pending == true

        /**
         * Used by MainActivity to decide whether to keep the WebView running when it
         * goes to the background: while the page plays or means to, and while the
         * service is still in the foreground after a pause (a pause caused by
         * another app may be resumed from here).
         */
        val keepWebViewAwake: Boolean
            get() {
                val state = latest ?: return false
                val service = running
                return state.playing || state.wantsPlay || service?.inForeground == true ||
                    service?.remotePlay?.pending == true
            }

        /**
         * The app was opened from the notification after a play from outside found
         * no page (or the user asked to resume it): play once the page is up.
         */
        fun resumeFromApp(context: Context) {
            val service = running
            if (service != null) {
                service.requestPlay("notification: open and resume")
                return
            }
            // Foreground activity: starting the service is allowed. It restores the
            // last track and plays it as soon as the page answers.
            try {
                ContextCompat.startForegroundService(
                    context,
                    Intent(context, RekordMediaService::class.java).setAction(ACTION_RESUME),
                )
            } catch (e: Exception) {
                RekordLog.w("service not started for resume: ${e.javaClass.simpleName}: ${e.message}")
            }
        }

        private const val ACTION_RESUME = "app.rekord.client.action.RESUME"

        /**
         * Called by the page on every track or state change: the first
         * time it starts the service, then it updates it.
         */
        fun publish(context: Context, state: NowPlaying) {
            latest = state
            val service = running
            if (service != null) {
                service.accept(state)
                return
            }
            // The service is only created while a track is playing (or about to): it is
            // the only case in which Android allows starting a foreground service (the
            // user just pressed play, in front of the app), and the only one where it is
            // needed. A paused track without a service has nothing to keep alive.
            if (!state.wantsPlay) return
            try {
                ContextCompat.startForegroundService(
                    context,
                    Intent(context, RekordMediaService::class.java),
                )
            } catch (e: Exception) {
                // From the background on Android 12+ (the system had stopped the
                // service): the music plays on, without notification for now.
                RekordLog.w("service not started: ${e.javaClass.simpleName}: ${e.message}")
            }
        }

        /**
         * Ends the session. [forget] (the queue emptied in the page) also drops the
         * saved last track; otherwise (app closed, notification dismissed) it stays
         * for a later resume from the car or the system's media controls.
         */
        fun stop(context: Context, forget: Boolean = false) {
            latest = null
            val service = running
            if (service != null) {
                if (forget) service.forgetSaved()
                service.cancelRemotePlay("stop")
                service.locksHeld = false
                service.releaseLocks()
                service.unregisterNoisy()
                ServiceCompat.stopForeground(service, ServiceCompat.STOP_FOREGROUND_REMOVE)
                service.inForeground = false
                service.started = false
                // A media browser may keep the service bound: leave its session
                // paused, not "playing" a track that is gone.
                service.session.setPlaybackState(
                    PlaybackStateCompat.Builder()
                        .setState(PlaybackStateCompat.STATE_PAUSED, 0L, 0f)
                        .setActions(PlaybackStateCompat.ACTION_PLAY or PlaybackStateCompat.ACTION_PLAY_FROM_MEDIA_ID)
                        .build(),
                )
                service.stopSelf()
            } else {
                if (forget) {
                    val editor = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                    for (k in NowPlayingStore.KEYS) editor.remove(k)
                    editor.apply()
                }
                context.stopService(Intent(context, RekordMediaService::class.java))
            }
        }
    }
}
