package app.rekord.client;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Binder;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * MediaSession nativa per il client RE-KORD: notifica media, lock screen,
 * tasti cuffie/auto/volante. Pilotata dalla webapp via RekordMediaNative
 * (addJavascriptInterface in MainActivity). Foreground service durante la
 * riproduzione per proteggere l'audio del WebView in background.
 */
public class RekordMediaService extends Service {

    public interface ActionListener {
        void onMediaAction(String action, double seekTimeSec);
    }

    private static final String TAG = "RekordMediaService";
    private static final String CHANNEL_ID = "rekord_media";
    private static final int NOTIFICATION_ID = 41;

    private final IBinder binder = new LocalBinder();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService artworkExecutor = Executors.newSingleThreadExecutor();

    private MediaSessionCompat session;
    private ActionListener listener;

    private String title = "";
    private String artist = "";
    private String album = "";
    private String artworkUrl = null;
    private Bitmap artwork = null;
    private String artworkLoadedFor = null;
    private String playbackState = "none";
    private long durationMs = 0;
    private long positionMs = 0;
    private float speed = 1.0f;
    private boolean foreground = false;

    public class LocalBinder extends Binder {
        RekordMediaService getService() {
            return RekordMediaService.this;
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        session = new MediaSessionCompat(this, "RekordMediaSession");
        session.setCallback(
            new MediaSessionCompat.Callback() {
                @Override
                public void onPlay() {
                    notifyAction("play", -1);
                }

                @Override
                public void onPause() {
                    notifyAction("pause", -1);
                }

                @Override
                public void onStop() {
                    notifyAction("pause", -1);
                }

                @Override
                public void onSkipToNext() {
                    notifyAction("nexttrack", -1);
                }

                @Override
                public void onSkipToPrevious() {
                    notifyAction("previoustrack", -1);
                }

                @Override
                public void onSeekTo(long pos) {
                    notifyAction("seekto", pos / 1000.0);
                }
            }
        );
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Riproduzione",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setShowBadge(false);
            nm.createNotificationChannel(channel);
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return binder;
    }

    @Override
    public void onDestroy() {
        if (session != null) {
            session.setActive(false);
            session.release();
        }
        artworkExecutor.shutdownNow();
        super.onDestroy();
    }

    public void setActionListener(ActionListener l) {
        this.listener = l;
    }

    private void notifyAction(String action, double seekTimeSec) {
        ActionListener l = this.listener;
        if (l != null) l.onMediaAction(action, seekTimeSec);
    }

    /** Stato completo dalla webapp; chiamare dal main thread. */
    public void updateState(
        String title,
        String artist,
        String album,
        String artworkUrl,
        String playbackState,
        double durationSec,
        double positionSec,
        double speed
    ) {
        this.title = title != null ? title : "";
        this.artist = artist != null ? artist : "";
        this.album = album != null ? album : "";
        this.playbackState = playbackState != null ? playbackState : "none";
        this.durationMs = (long) Math.max(0, durationSec * 1000.0);
        this.positionMs = (long) Math.max(0, positionSec * 1000.0);
        this.speed = (float) (speed > 0 ? speed : 1.0);

        if (artworkUrl != null && !artworkUrl.equals(this.artworkUrl)) {
            this.artworkUrl = artworkUrl;
            fetchArtwork(artworkUrl);
        } else if (artworkUrl == null) {
            this.artworkUrl = null;
            this.artwork = null;
            this.artworkLoadedFor = null;
        }

        apply();
    }

    private void fetchArtwork(final String url) {
        if (url.equals(artworkLoadedFor)) return;
        artworkExecutor.execute(() -> {
            Bitmap bmp = null;
            try {
                HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);
                try (InputStream in = conn.getInputStream()) {
                    bmp = BitmapFactory.decodeStream(in);
                }
            } catch (Exception e) {
                Log.w(TAG, "artwork non scaricata: " + e.getMessage());
            }
            final Bitmap result = bmp;
            mainHandler.post(() -> {
                if (!url.equals(this.artworkUrl)) return;
                this.artwork = result;
                this.artworkLoadedFor = url;
                apply();
            });
        });
    }

    private void apply() {
        if (session == null) return;
        if ("none".equals(playbackState)) {
            session.setActive(false);
            stopForegroundCompat();
            return;
        }

        MediaMetadataCompat.Builder meta = new MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist)
            .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, album);
        if (durationMs > 0) {
            meta.putLong(MediaMetadataCompat.METADATA_KEY_DURATION, durationMs);
        }
        if (artwork != null) {
            meta.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, artwork);
            meta.putBitmap(MediaMetadataCompat.METADATA_KEY_ART, artwork);
        }
        session.setMetadata(meta.build());

        int state = "playing".equals(playbackState)
            ? PlaybackStateCompat.STATE_PLAYING
            : PlaybackStateCompat.STATE_PAUSED;
        long actions =
            PlaybackStateCompat.ACTION_PLAY |
            PlaybackStateCompat.ACTION_PAUSE |
            PlaybackStateCompat.ACTION_PLAY_PAUSE |
            PlaybackStateCompat.ACTION_SKIP_TO_NEXT |
            PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS |
            PlaybackStateCompat.ACTION_SEEK_TO |
            PlaybackStateCompat.ACTION_STOP;
        session.setPlaybackState(
            new PlaybackStateCompat.Builder()
                .setState(state, positionMs, speed)
                .setActions(actions)
                .build()
        );
        session.setActive(true);

        Notification notification = buildNotification();
        if ("playing".equals(playbackState)) {
            if (!foreground) {
                if (Build.VERSION.SDK_INT >= 29) {
                    startForeground(
                        NOTIFICATION_ID,
                        notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                    );
                } else {
                    startForeground(NOTIFICATION_ID, notification);
                }
                foreground = true;
            } else {
                notifySafely(notification);
            }
        } else {
            if (foreground) {
                // In pausa: notifica rimovibile ma ancora visibile
                stopForeground(STOP_FOREGROUND_DETACH);
                foreground = false;
            }
            notifySafely(notification);
        }
    }

    private void notifySafely(Notification notification) {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(NOTIFICATION_ID, notification);
        } catch (Exception e) {
            Log.w(TAG, "notify fallita: " + e.getMessage());
        }
    }

    private void stopForegroundCompat() {
        if (foreground) {
            stopForeground(STOP_FOREGROUND_REMOVE);
            foreground = false;
        } else {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(NOTIFICATION_ID);
        }
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(
            this,
            0,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(artist)
            .setSubText(album)
            .setLargeIcon(artwork)
            .setContentIntent(contentIntent)
            .setOnlyAlertOnce(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setStyle(
                new androidx.media.app.NotificationCompat.MediaStyle().setMediaSession(
                    session.getSessionToken()
                )
            );
        return b.build();
    }
}
