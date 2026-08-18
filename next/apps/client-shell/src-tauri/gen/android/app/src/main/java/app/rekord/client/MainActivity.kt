package app.rekord.client

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat

class MainActivity : TauriActivity() {
  private var webView: WebView? = null
  private var notificationAsked = false

  /**
   * Registrato alla costruzione dell'activity, come vuole ComponentActivity: cosi'
   * non serve inventare un codice di richiesta che potrebbe pestare i piedi ai
   * plugin Tauri. La risposta non cambia niente: senza permesso la musica suona
   * comunque, resta senza notifica.
   */
  private val askNotifications =
    registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    this.webView = webView
    RekordMediaBridge.webView = webView
    // Il nome combacia con quello cercato da `src/lib/nativeMedia.ts`.
    webView.addJavascriptInterface(RekordMedia(this), "RekordMediaNative")
  }

  /**
   * WryActivity mette in pausa la WebView quando l'app va in secondo piano, e la
   * pausa della WebView spegne anche l'audio della pagina. Se c'e' un brano che
   * suona la si riaccende subito: il servizio in foreground tiene vivo il
   * processo, quindi la musica continua a schermo spento.
   */
  override fun onPause() {
    super.onPause()
    if (RekordMediaService.isPlaying) webView?.onResume()
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

  override fun onDestroy() {
    // Con l'activity muore la WebView, e l'audio sta dentro la WebView: la
    // notifica non deve sopravvivere a un brano che non suona piu'.
    RekordMediaBridge.webView = null
    webView = null
    RekordMediaService.stop(this)
    super.onDestroy()
  }
}
