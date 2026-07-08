package app.rekord.client;

import android.Manifest;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.google.android.gms.cast.framework.CastContext;
import org.json.JSONObject;

public class MainActivity extends BridgeActivity {

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private RekordMediaService mediaService;
    private RekordCastManager castManager;
    private String pendingStateJson;
    private String pendingMediaAction;
    private double pendingMediaSeekSec = -1;
    private int pendingMediaRetries = 0;
    private static final long MEDIA_ACTION_RETRY_MS = 400L;
    private static final int MEDIA_ACTION_MAX_RETRIES = 30;
    private static final long MEDIA_COMMAND_WAKE_MS = 12_000L;
    private final Runnable deliverPendingMediaActionRunnable = this::deliverPendingMediaAction;

    private AudioManager audioManager;
    private AudioFocusRequest audioFocusRequest;
    private PowerManager.WakeLock mediaCommandWakeLock;

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
        try {
            CastContext.getSharedInstance(this);
            castManager = new RekordCastManager(this, (action, seekTimeSec) ->
                mainHandler.post(() -> dispatchMediaAction(action, seekTimeSec))
            );
        } catch (Exception e) {
            android.util.Log.w("RekordClient", "Cast SDK non disponibile: " + e.getMessage());
        }
        WebView webView = this.bridge.getWebView();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            webView.setRendererPriorityPolicy(
                WebView.RENDERER_PRIORITY_IMPORTANT,
                true
            );
        }
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
    public void onDestroy() {
        try {
            unbindService(mediaConnection);
        } catch (Exception ignored) {
            /* non bound */
        }
        super.onDestroy();
    }

    /** Tasti widget/cuffie/Cast → webapp (window.__rekordMediaAction). */
    private void dispatchMediaAction(String action, double seekTimeSec) {
        pendingMediaAction = action;
        pendingMediaSeekSec = seekTimeSec;
        if ("play".equals(action) || "unmute".equals(action)) {
            requestPlaybackAudioFocus(() -> deliverPendingMediaAction());
            return;
        }
        deliverPendingMediaAction();
    }

    private void deliverPendingMediaAction() {
        if (pendingMediaAction == null) return;
        WebView webView = this.bridge != null ? this.bridge.getWebView() : null;
        if (webView == null) {
            schedulePendingMediaRetry();
            return;
        }
        acquireMediaCommandWakeLock();
        // Solo al comando utente: riattiva brevemente il WebView per play/pause da lock screen.
        webView.onResume();
        webView.resumeTimers();
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
                    pendingMediaRetries = 0;
                    mainHandler.removeCallbacks(deliverPendingMediaActionRunnable);
                } else {
                    schedulePendingMediaRetry();
                }
            })
        );
    }

    private void schedulePendingMediaRetry() {
        if (pendingMediaAction == null) return;
        if (pendingMediaRetries >= MEDIA_ACTION_MAX_RETRIES) {
            pendingMediaRetries = 0;
            return;
        }
        pendingMediaRetries++;
        mainHandler.removeCallbacks(deliverPendingMediaActionRunnable);
        mainHandler.postDelayed(deliverPendingMediaActionRunnable, MEDIA_ACTION_RETRY_MS);
    }

    /** Tiene la CPU attiva mentre il WebView esegue play/pause da lock screen o Bluetooth. */
    private void acquireMediaCommandWakeLock() {
        if (mediaCommandWakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm == null) return;
            mediaCommandWakeLock = pm.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "Rekord:MediaCommand"
            );
            mediaCommandWakeLock.setReferenceCounted(false);
        }
        if (!mediaCommandWakeLock.isHeld()) {
            mediaCommandWakeLock.acquire(MEDIA_COMMAND_WAKE_MS);
        }
    }

    private void requestPlaybackAudioFocus(Runnable then) {
        if (audioManager == null) {
            audioManager = (AudioManager) getSystemService(AUDIO_SERVICE);
        }
        if (audioManager == null) {
            then.run();
            return;
        }
        int result;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (audioFocusRequest == null) {
                AudioAttributes attrs = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build();
                audioFocusRequest = new AudioFocusRequest.Builder(
                    AudioManager.AUDIOFOCUS_GAIN
                )
                    .setAudioAttributes(attrs)
                    .setAcceptsDelayedFocusGain(true)
                    .setOnAudioFocusChangeListener(focusChange -> {
                        /* la webapp gestisce pause/play sull'elemento audio */
                    })
                    .build();
            }
            result = audioManager.requestAudioFocus(audioFocusRequest);
        } else {
            result = audioManager.requestAudioFocus(
                focusChange -> {
                    /* */
                },
                AudioManager.STREAM_MUSIC,
                AudioManager.AUDIOFOCUS_GAIN
            );
        }
        if (
            result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED ||
            result == AudioManager.AUDIOFOCUS_REQUEST_DELAYED
        ) {
            then.run();
        } else {
            then.run();
        }
    }

    private void applyMediaState(String json) {
        if (mediaService == null) {
            pendingStateJson = json;
            return;
        }
        try {
            mediaService.updateStateFromJson(json);
            if (castManager != null) castManager.syncFromJson(json);
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
