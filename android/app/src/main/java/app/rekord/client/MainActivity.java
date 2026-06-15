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
    private String pendingMediaAction;
    private double pendingMediaSeekSec = -1;

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
    public void onResume() {
        super.onResume();
        mainHandler.post(this::deliverPendingMediaAction);
    }

    @Override
    public void onPause() {
        super.onPause();
        // Capacitor mette in pausa il WebView: con sessione media attiva
        // riattiviamo i timer così play/pause dalla lock screen funzionano.
        if (mediaService != null && mediaService.isSessionActive()) {
            wakeWebViewForMedia();
        }
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
        pendingMediaAction = action;
        pendingMediaSeekSec = seekTimeSec;
        deliverPendingMediaAction();
    }

    private void wakeWebViewForMedia() {
        WebView webView = this.bridge != null ? this.bridge.getWebView() : null;
        if (webView == null) return;
        webView.onResume();
        webView.resumeTimers();
    }

    private void deliverPendingMediaAction() {
        if (pendingMediaAction == null) return;
        WebView webView = this.bridge != null ? this.bridge.getWebView() : null;
        if (webView == null) return;
        wakeWebViewForMedia();
        final String action = pendingMediaAction;
        final double seekTimeSec = pendingMediaSeekSec;
        String js =
            "(function(){if(typeof window.__rekordMediaAction==='function'){window.__rekordMediaAction(" +
            JSONObject.quote(action) +
            "," +
            seekTimeSec +
            ");return true;}return false;})()";
        webView.post(() ->
            webView.evaluateJavascript(js, value -> {
                if ("true".equals(value) &&
                    pendingMediaAction != null &&
                    pendingMediaAction.equals(action)) {
                    pendingMediaAction = null;
                    pendingMediaSeekSec = -1;
                }
            })
        );
    }

    private void applyMediaState(String json) {
        if (mediaService == null) {
            pendingStateJson = json;
            return;
        }
        try {
            JSONObject o = new JSONObject(json);
            mediaService.updateStateFromJson(json);
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
