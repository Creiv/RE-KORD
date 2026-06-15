package app.rekord.client;

import android.content.Context;
import android.net.Uri;
import android.util.Log;
import com.google.android.gms.cast.MediaInfo;
import com.google.android.gms.cast.MediaMetadata;
import com.google.android.gms.cast.framework.CastContext;
import com.google.android.gms.cast.framework.CastSession;
import com.google.android.gms.cast.framework.SessionManagerListener;
import com.google.android.gms.cast.framework.media.RemoteMediaClient;
import com.google.android.gms.common.images.WebImage;
import org.json.JSONObject;

/**
 * Google Cast SDK: carica URL assoluti dal server RE-KORD sul receiver (Google Home).
 * Complementa MediaSession/output picker quando serve LoadRequest esplicito al cambio brano.
 */
public class RekordCastManager implements SessionManagerListener<CastSession> {

    private static final String TAG = "RekordCastManager";

    public interface WebBridge {
        void dispatchToWeb(String action, double seekTimeSec);
    }

    private final CastContext castContext;
    private final WebBridge webBridge;
    private String lastLoadedMediaId = "";
    private boolean castConnected = false;

    public RekordCastManager(Context context, WebBridge webBridge) {
        this.castContext = CastContext.getSharedInstance(context);
        this.webBridge = webBridge;
        castContext.getSessionManager().addSessionManagerListener(this, CastSession.class);
    }

    public boolean isCastConnected() {
        return castConnected;
    }

    /** Stato player dalla webapp (JSON da mediaSession.ts). */
    public void syncFromJson(String json) {
        try {
            JSONObject o = new JSONObject(json);
            String playbackState = o.optString("playbackState", "none");
            if ("none".equals(playbackState)) {
                lastLoadedMediaId = "";
                return;
            }
            CastSession session = castContext.getSessionManager().getCurrentCastSession();
            if (session == null || !session.isConnected()) return;
            RemoteMediaClient client = session.getRemoteMediaClient();
            if (client == null) return;

            String mediaUri = o.optString("mediaUri", "");
            if (mediaUri.isEmpty()) return;

            String mediaId = o.optString("mediaId", "");
            String title = o.optString("title", "");
            String artist = o.optString("artist", "");
            String album = o.optString("album", "");
            String artworkUrl = o.isNull("artworkUrl") ? "" : o.optString("artworkUrl", "");
            long positionMs = (long) Math.max(0, o.optDouble("position", 0) * 1000.0);
            boolean playing = "playing".equals(playbackState);

            MediaMetadata metadata = new MediaMetadata(MediaMetadata.MEDIA_TYPE_MUSIC_TRACK);
            metadata.putString(MediaMetadata.KEY_TITLE, title);
            metadata.putString(MediaMetadata.KEY_ARTIST, artist);
            metadata.putString(MediaMetadata.KEY_ALBUM_TITLE, album);
            if (!artworkUrl.isEmpty()) {
                try {
                    metadata.addImage(new WebImage(Uri.parse(artworkUrl)));
                } catch (Exception ignored) {
                    /* */
                }
            }

            MediaInfo mediaInfo = new MediaInfo.Builder(mediaUri)
                .setStreamType(MediaInfo.STREAM_TYPE_BUFFERED)
                .setContentType(contentTypeForUrl(mediaUri))
                .setMetadata(metadata)
                .build();

            if (!mediaId.equals(lastLoadedMediaId)) {
                lastLoadedMediaId = mediaId;
                client.load(mediaInfo, playing, positionMs);
                Log.d(TAG, "load cast: " + title);
            } else {
                if (playing && !client.isPlaying()) client.play();
                else if (!playing && client.isPlaying()) client.pause();
                if (positionMs > 0) client.seek(positionMs);
            }
        } catch (Exception e) {
            Log.w(TAG, "sync cast fallita: " + e.getMessage());
        }
    }

    private static String contentTypeForUrl(String url) {
        String lower = url.toLowerCase();
        if (lower.contains(".mp3") || lower.contains("format=mp3")) return "audio/mpeg";
        if (lower.contains(".m4a") || lower.contains("format=aac")) return "audio/mp4";
        if (lower.contains(".flac")) return "audio/flac";
        if (lower.contains(".ogg") || lower.contains(".opus")) return "audio/ogg";
        if (lower.contains(".wav")) return "audio/wav";
        return "audio/mpeg";
    }

    @Override
    public void onSessionStarted(CastSession session, String sessionId) {
        castConnected = true;
        webBridge.dispatchToWeb("mute", -1);
    }

    @Override
    public void onSessionEnded(CastSession session, int error) {
        castConnected = false;
        lastLoadedMediaId = "";
        webBridge.dispatchToWeb("unmute", -1);
    }

    @Override
    public void onSessionStarting(CastSession session) {
        /* */
    }

    @Override
    public void onSessionStartFailed(CastSession session, int error) {
        castConnected = false;
    }

    @Override
    public void onSessionEnding(CastSession session) {
        /* */
    }

    @Override
    public void onSessionResuming(CastSession session, String sessionId) {
        /* */
    }

    @Override
    public void onSessionResumed(CastSession session, boolean wasSuspended) {
        castConnected = true;
        webBridge.dispatchToWeb("mute", -1);
    }

    @Override
    public void onSessionResumeFailed(CastSession session, int error) {
        castConnected = false;
    }

    @Override
    public void onSessionSuspended(CastSession session, int reason) {
        castConnected = false;
    }
}
