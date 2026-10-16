package app.rekord.client

import android.Manifest
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle

class MainActivity : TauriActivity() {
  private var webView: WebView? = null
  private var notificationAsked = false
  private var sendToBackOnce = false

  /**
   * We handle the Back button ourselves (see [installBackHandler]): WryActivity's
   * handler, once it reaches the end of the history, closes the activity — and with
   * it the WebView where the music is playing.
   */
  override val handleBackNavigation: Boolean = false

  /**
   * Registered when the activity is constructed, as ComponentActivity requires: this
   * way there is no need to invent a request code that could clash with the Tauri
   * plugins. The answer changes nothing: without the permission the music still
   * plays, just without a notification.
   */
  private val askNotifications =
    registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

  override fun onCreate(savedInstanceState: Bundle?) {
    applyOrientationPolicy()
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    alive = true
    RekordMediaBridge.attach(applicationContext)
    // Google Cast: without Play Services it stays off and the page doesn't show the button.
    RekordCast.init(applicationContext)
    RekordCast.bindActivity(this)
    handleMediaIntent(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handleMediaIntent(intent)
  }

  /**
   * Started by the media service: a car or headset PLAY found no page
   * ([ACTION_RESUME_IN_BACKGROUND]), or the user tapped the notification that
   * says to open the app to resume ([ACTION_RESUME]). The service holds the
   * command and delivers it as soon as the page has restored its queue.
   */
  private fun handleMediaIntent(intent: Intent?) {
    when (intent?.action) {
      ACTION_RESUME -> RekordMediaService.resumeFromApp(this)
      ACTION_RESUME_IN_BACKGROUND -> {
        // Only while the service is really waiting on a page: an activity recreated
        // later from its task keeps this intent, and must then simply open.
        if (!RekordMediaService.awaitingPage) return
        RekordLog.i("activity: started by the media service to resume playback")
        // The WebView may already exist (wry creates it inside super.onCreate).
        val view = webView
        if (view != null) view.post { moveTaskToBack(true) } else sendToBackOnce = true
      }
      else -> return
    }
    // Consumed: a configuration change or a re-delivery must not resume again.
    intent.action = Intent.ACTION_MAIN
  }

  /**
   * Phones in portrait, as in 5.0 (the compact UI is designed that way);
   * tablets and TVs rotate freely. The threshold is Android's own for "sw600dp"
   * layouts: below 600 dp on the short side it is a phone.
   */
  private fun applyOrientationPolicy() {
    val config = resources.configuration
    val isTv = (config.uiMode and Configuration.UI_MODE_TYPE_MASK) ==
      Configuration.UI_MODE_TYPE_TELEVISION ||
      packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK)
    requestedOrientation = if (!isTv && config.smallestScreenWidthDp < 600) {
      ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
    } else {
      ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    this.webView = webView
    RekordMediaBridge.webView = webView
    // The names match those looked up by `src/lib/nativeMedia.ts` and
    // `src/lib/platform/downloads.ts`.
    webView.addJavascriptInterface(RekordMedia(this), "RekordMediaNative")
    webView.addJavascriptInterface(RekordFiles(applicationContext), "RekordFilesNative")
    // `src/lib/cast/androidCast.ts`.
    webView.addJavascriptInterface(RekordCastJs(), "RekordCastNative")
    installBackHandler(webView)
    // Started from the background for a car PLAY (where Android allows it): the
    // WebView exists now, so get out of the way of whatever the user was doing.
    // The page keeps loading and plays (keepWebViewAwake holds while the service
    // waits on the play).
    if (sendToBackOnce) {
      sendToBackOnce = false
      webView.post { moveTaskToBack(true) }
    }
  }

  /**
   * While casting, the volume keys control the Chromecast, not the phone (with the
   * screen off, [RekordMediaService]'s MediaSession takes care of it).
   */
  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if (RekordCast.isConnected) {
      val direction = when (event.keyCode) {
        KeyEvent.KEYCODE_VOLUME_UP -> 1
        KeyEvent.KEYCODE_VOLUME_DOWN -> -1
        else -> 0
      }
      if (direction != 0) {
        if (event.action == KeyEvent.ACTION_DOWN) RekordCast.adjustVolume(direction)
        return true
      }
    }
    return super.dispatchKeyEvent(event)
  }

  /**
   * Back: first walk back through the page history (the client pushes an entry
   * for every view and every open dialog, so Back closes it).
   * At the end of the history the app doesn't close: it goes to the background as
   * with the Home button, and the music keeps playing — the media service keeps the process alive.
   */
  private fun installBackHandler(view: WebView) {
    onBackPressedDispatcher.addCallback(
      this,
      object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
          if (view.canGoBack()) {
            view.goBack()
          } else {
            moveTaskToBack(true)
          }
        }
      },
    )
  }

  /**
   * WryActivity pauses the WebView when the app goes to the background, and pausing
   * the WebView also silences the page's audio. If a track is playing, it is
   * resumed immediately: the foreground service keeps the process alive, so the
   * music keeps playing with the screen off.
   */
  override fun onResume() {
    super.onResume()
    inFront = true
  }

  override fun onPause() {
    inFront = false
    super.onPause()
    // Not only while a track plays: also while one is loading or reconnecting
    // (the screen locked right after tapping a track), and for a while after a
    // pause, so that a pause caused by another app (a call, a video) can be
    // resumed from the background. While casting, the page advances the queue
    // (track ends on the receiver → next track): it must stay awake to notice.
    if (RekordMediaService.keepWebViewAwake || RekordCast.isConnected) {
      webView?.onResume()
      RekordLog.i("activity paused: WebView kept running")
    }
  }

  /** The page started (or is starting) a track while the activity is not in front. */
  fun keepWebViewAwake() {
    if (lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) return
    webView?.onResume()
  }

  fun ensureNotificationPermission() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    if (notificationAsked) return
    notificationAsked = true
    val granted = ContextCompat.checkSelfPermission(
      this,
      Manifest.permission.POST_NOTIFICATIONS,
    ) == PackageManager.PERMISSION_GRANTED
    if (!granted) askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
  }

  companion object {
    const val ACTION_RESUME = "app.rekord.client.action.OPEN_AND_RESUME"
    const val ACTION_RESUME_IN_BACKGROUND = "app.rekord.client.action.RESUME_IN_BACKGROUND"

    /** Created and not destroyed: the WebView exists or is being created. */
    @Volatile
    var alive = false
      private set

    /** Activity resumed (read by [RekordMediaBridge.sleepIfHidden]). */
    @Volatile
    var inFront = false
      private set
  }

  override fun onDestroy() {
    // We only get here when the activity really dies (removed from recents,
    // process reclaimed by the system): Back sends it to the background without
    // destroying it. The WebView dies with the activity, and the audio lives inside
    // the WebView: the notification must not outlive a track that no longer plays.
    // A configuration change doesn't come through here (configChanges in the manifest).
    if (RekordMediaBridge.webView === webView) RekordMediaBridge.webView = null
    webView = null
    alive = false
    RekordCast.bindActivity(null)
    if (!isChangingConfigurations) RekordMediaService.stop(this)
    super.onDestroy()
  }
}
