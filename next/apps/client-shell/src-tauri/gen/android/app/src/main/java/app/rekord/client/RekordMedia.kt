package app.rekord.client

import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject

/**
 * Brano in riproduzione, cosi' come lo racconta il lettore nella WebView.
 *
 * L'audio suona dentro la pagina: qui non si riproduce niente, si ripete al
 * sistema cosa sta suonando perche' possa disegnare la notifica e la schermata
 * di blocco.
 */
data class NowPlaying(
    val title: String,
    val artist: String,
    val album: String,
    val artworkUrl: String?,
    val playing: Boolean,
    val durationMs: Long,
    val positionMs: Long,
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
                )
            } catch (e: Exception) {
                Logger.warn("RekordMedia: stato non leggibile: ${e.message}")
                null
            }
        }
    }
}

/**
 * I comandi della notifica tornano al lettore per la strada che il client ha
 * gia' pronta per i gusci nativi: un evento nel DOM, gli stessi nomi di azione
 * della Media Session (vedi `src/lib/mediaSession.ts`).
 */
object RekordMediaBridge {
    @Volatile
    var webView: WebView? = null

    fun send(action: String, value: Double? = null) {
        val view = webView ?: return
        val detail = if (value == null) {
            "{action:'$action'}"
        } else {
            "{action:'$action',value:$value}"
        }
        val script =
            "window.dispatchEvent(new CustomEvent('rekord:media-action',{detail:$detail}))"
        // evaluateJavascript vuole il thread principale, e i comandi arrivano dal
        // thread della notifica o del bottone sulle cuffie.
        view.post {
            // Con l'app in secondo piano e la musica in pausa la WebView e' sospesa:
            // un play dalla notifica parlerebbe a un lettore addormentato. Prima si
            // riaccende, poi le si dice cosa fare.
            view.onResume()
            view.evaluateJavascript(script, null)
        }
    }
}

/**
 * Superficie esposta alla pagina come `window.RekordMediaNative`. La WebView
 * carica solo il nostro bundle locale, quindi non c'e' pagina di terzi che possa
 * chiamarla.
 */
class RekordMedia(private val activity: MainActivity) {
    @JavascriptInterface
    fun update(json: String) {
        val state = NowPlaying.fromJson(json) ?: return
        activity.runOnUiThread {
            // Il permesso si chiede al primo brano, non all'avvio: prima c'e'
            // qualcosa da mostrare, poi si chiede di poterlo mostrare.
            if (state.playing) activity.ensureNotificationPermission()
            RekordMediaService.publish(activity, state)
        }
    }

    @JavascriptInterface
    fun stop() {
        activity.runOnUiThread { RekordMediaService.stop(activity) }
    }
}
