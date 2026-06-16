package app.rekord.client;

import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.util.Log;
import android.webkit.WebView;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;
import org.json.JSONObject;

/**
 * Motore audio nativo (Media3 ExoPlayer) per l'APK RE-KORD.
 * Eventi verso la webapp via window.__rekordNativePlaybackEvent.
 */
public class RekordPlaybackEngine implements Player.Listener {

    private static final String TAG = "RekordPlayback";
    private static final long TICK_MS = 500L;

    private float volume = 1f;
    private Runnable volumeFadeRunnable;
    private static final long VOLUME_FADE_TICK_MS = 180L;

    private final Context appContext;
    private final Handler mainHandler;
    private WebView webView;
    private ExoPlayer player;
    private boolean enabled = false;

    private final Runnable tickRunnable =
        new Runnable() {
            @Override
            public void run() {
                if (player == null || !enabled || !player.isPlaying()) return;
                emitTimeUpdate();
                mainHandler.postDelayed(this, TICK_MS);
            }
        };

    public RekordPlaybackEngine(Context context, Handler mainHandler) {
        this.appContext = context.getApplicationContext();
        this.mainHandler = mainHandler;
    }

    public void bindWebView(WebView webView) {
        this.webView = webView;
    }

    public boolean isEnabled() {
        return enabled;
    }

    public void configure(boolean on) {
        enabled = on;
        if (!on) {
            cancelVolumeFade();
            setVolume(1f);
            stopPositionTicker();
            stop();
            releasePlayer();
        }
    }

    private void ensurePlayer() {
        if (player != null) return;
        player = new ExoPlayer.Builder(appContext).build();
        player.addListener(this);
    }

    public void load(String url, double positionSec, boolean autoplay) {
        if (!enabled || url == null || url.isEmpty()) return;
        cancelVolumeFade();
        setVolume(1f);
        ensurePlayer();
        stopPositionTicker();
        long posMs = (long) Math.max(0, positionSec * 1000.0);
        try {
            player.setMediaItem(MediaItem.fromUri(Uri.parse(url)));
            player.prepare();
            player.seekTo(posMs);
            player.setPlayWhenReady(autoplay);
        } catch (Exception e) {
            Log.w(TAG, "load fallito: " + e.getMessage());
            emitError(e.getMessage() != null ? e.getMessage() : "load_failed");
        }
    }

    public void play() {
        if (!enabled || player == null) return;
        player.setPlayWhenReady(true);
    }

    public void pause() {
        if (player == null) return;
        player.setPlayWhenReady(false);
    }

    public void seek(double sec) {
        if (player == null) return;
        player.seekTo((long) Math.max(0, sec * 1000.0));
        emitTimeUpdate();
    }

    public void stop() {
        cancelVolumeFade();
        stopPositionTicker();
        if (player == null) return;
        player.stop();
        player.clearMediaItems();
    }

    public void setVolume(float value) {
        volume = Math.max(0f, Math.min(1f, value));
        if (player != null) player.setVolume(volume);
    }

    public void cancelVolumeFade() {
        if (volumeFadeRunnable != null) {
            mainHandler.removeCallbacks(volumeFadeRunnable);
            volumeFadeRunnable = null;
        }
    }

    /** Fade lineare del volume (sleep timer). Al termine mette in pausa. */
    public void sleepFadeAndPause(long durationMs) {
        cancelVolumeFade();
        if (!enabled || player == null || durationMs <= 0) {
            pause();
            return;
        }
        final float startVol = volume;
        final long fadeStartMs = System.currentTimeMillis();
        volumeFadeRunnable =
            new Runnable() {
                @Override
                public void run() {
                    if (!enabled || player == null) return;
                    long elapsed = System.currentTimeMillis() - fadeStartMs;
                    float ratio = Math.min(1f, elapsed / (float) durationMs);
                    setVolume(startVol * (1f - ratio));
                    if (ratio >= 1f) {
                        volumeFadeRunnable = null;
                        pause();
                        return;
                    }
                    mainHandler.postDelayed(this, VOLUME_FADE_TICK_MS);
                }
            };
        mainHandler.post(volumeFadeRunnable);
    }

    private void releasePlayer() {
        cancelVolumeFade();
        stopPositionTicker();
        if (player == null) return;
        player.removeListener(this);
        player.release();
        player = null;
    }

    private void startPositionTicker() {
        stopPositionTicker();
        mainHandler.postDelayed(tickRunnable, TICK_MS);
    }

    private void stopPositionTicker() {
        mainHandler.removeCallbacks(tickRunnable);
    }

    @Override
    public void onIsPlayingChanged(boolean isPlaying) {
        emitSimple(isPlaying ? "playing" : "paused");
        if (isPlaying) startPositionTicker();
        else stopPositionTicker();
        emitTimeUpdate();
    }

    @Override
    public void onPlaybackStateChanged(int state) {
        if (player == null) return;
        if (state == Player.STATE_ENDED) {
            stopPositionTicker();
            emitSimple("ended");
        } else if (state == Player.STATE_READY) {
            emitReady();
            emitTimeUpdate();
        }
    }

    @Override
    public void onPlayerError(PlaybackException error) {
        stopPositionTicker();
        String msg = error.getMessage();
        emitError(msg != null ? msg : "playback_error");
    }

    private void emitReady() {
        if (player == null) return;
        long durMs = player.getDuration();
        if (durMs <= 0 || durMs == C.TIME_UNSET) return;
        dispatchEvent("ready", durMs / 1000.0, player.getCurrentPosition() / 1000.0, null);
    }

    private void emitTimeUpdate() {
        if (player == null) return;
        long durMs = player.getDuration();
        double durSec =
            durMs > 0 && durMs != C.TIME_UNSET ? durMs / 1000.0 : 0;
        dispatchEvent("timeupdate", durSec, player.getCurrentPosition() / 1000.0, null);
    }

    private void emitSimple(String type) {
        dispatchEvent(type, -1, -1, null);
    }

    private void emitError(String message) {
        dispatchEvent("error", -1, -1, message);
    }

    private void dispatchEvent(
        String type,
        double duration,
        double position,
        String message
    ) {
        if (webView == null) return;
        try {
            JSONObject o = new JSONObject();
            o.put("type", type);
            if (duration >= 0) o.put("duration", duration);
            if (position >= 0) o.put("position", position);
            if (message != null) o.put("message", message);
            String js =
                "(function(){try{if(typeof window.__rekordNativePlaybackEvent==='function'){window.__rekordNativePlaybackEvent(JSON.parse(" +
                JSONObject.quote(o.toString()) +
                "));}}catch(e){}})()";
            webView.post(() -> webView.evaluateJavascript(js, null));
        } catch (Exception e) {
            Log.w(TAG, "evento web fallito: " + e.getMessage());
        }
    }
}
