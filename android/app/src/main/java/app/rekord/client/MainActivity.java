package app.rekord.client;

import android.Manifest;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import org.json.JSONObject;

public class MainActivity extends BridgeActivity {

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private RekordMediaService mediaService;
    private String pendingStateJson;

    private final ServiceConnection mediaConnection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder service) {
            mediaService = ((RekordMediaService.LocalBinder) service).getService();
            mediaService.setActionListener((action, seekTimeSec) ->
                mainHandler.post(() -> dispatchMediaAction(action, seekTimeSec))
            );
            if (pendingStateJson != null) {
                String json = pendingStateJson;
                pendingStateJson = null;
                applyMediaState(json);
            }
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            mediaService = null;
        }
    };

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView webView = this.bridge.getWebView();
        // Ponte media minimale, disponibile su OGNI pagina (anche l'app
        // caricata dal server): niente runtime Capacitor nelle pagine remote.
        webView.addJavascriptInterface(new MediaJsApi(), "RekordMediaNative");
        bindService(
            new Intent(this, RekordMediaService.class),
            mediaConnection,
            Context.BIND_AUTO_CREATE
        );
        requestNotificationPermissionIfNeeded();
    }

    @Override
    public void onDestroy() {
        try {
            unbindService(mediaConnection);
        } catch (Exception ignored) {
            /* non bound */
        }
        super.onDestroy();
    }

    /** Tasti widget/cuffie/auto → webapp (window.__rekordMediaAction). */
    private void dispatchMediaAction(String action, double seekTimeSec) {
        WebView webView = this.bridge != null ? this.bridge.getWebView() : null;
        if (webView == null) return;
        String js =
            "window.__rekordMediaAction && window.__rekordMediaAction(" +
            JSONObject.quote(action) +
            "," +
            seekTimeSec +
            ");";
        webView.evaluateJavascript(js, null);
    }

    private void applyMediaState(String json) {
        if (mediaService == null) {
            pendingStateJson = json;
            return;
        }
        try {
            JSONObject o = new JSONObject(json);
            mediaService.updateState(
                o.optString("title", ""),
                o.optString("artist", ""),
                o.optString("album", ""),
                o.isNull("artworkUrl") ? null : o.optString("artworkUrl", null),
                o.optString("playbackState", "none"),
                o.optDouble("duration", 0),
                o.optDouble("position", 0),
                o.optDouble("playbackRate", 1)
            );
        } catch (Exception e) {
            android.util.Log.w("RekordClient", "stato media non valido: " + e.getMessage());
        }
    }

    /** Android 13+: senza POST_NOTIFICATIONS la notifica media resta nascosta. */
    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            return;
        }
        requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 9001);
    }

    private class MediaJsApi {

        /** Stato completo (JSON) dalla webapp — vedi src/lib/mediaSession.ts. */
        @JavascriptInterface
        public void update(String json) {
            mainHandler.post(() -> applyMediaState(json));
        }
    }
}
