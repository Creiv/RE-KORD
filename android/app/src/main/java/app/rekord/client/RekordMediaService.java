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
import android.net.Uri;
import android.os.Binder;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.support.v4.media.MediaDescriptionCompat;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.media.session.MediaButtonReceiver;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * MediaSession nativa per il client RE-KORD: notifica media, lock screen,
 * tasti cuffie/auto. L'audio resta nel WebView; qui solo metadati e controlli.
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
    private String mediaId = "";
    private String mediaUri = "";
    private String playbackState = "none";
    private long durationMs = 0;
    private long positionMs = 0;
    private float speed = 1.0f;
    private boolean hasPrevious = false;
    private boolean hasNext = false;
    private int queueIndex = 0;
    private List<MediaSessionCompat.QueueItem> playQueue = new ArrayList<>();
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
        session.setFlags(
            MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS |
            MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS |
            MediaSessionCompat.FLAG_HANDLES_QUEUE_COMMANDS
        );
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

                @Override
                public void onSkipToQueueItem(long id) {
                    notifyAction("playqueueindex", id);
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
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && session != null) {
            MediaButtonReceiver.handleIntent(session, intent);
        }
        return START_STICKY;
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
    public void updateStateFromJson(String json) {
        try {
            JSONObject o = new JSONObject(json);
            final boolean skipMetadata = o.optBoolean("skipMetadata", false);
            if (!skipMetadata) {
                this.title = o.optString("title", "");
                this.artist = o.optString("artist", "");
                this.album = o.optString("album", "");
                this.mediaId = o.optString("mediaId", "");
                this.mediaUri = o.optString("mediaUri", "");
                this.hasPrevious = o.optBoolean("hasPrevious", false);
                this.hasNext = o.optBoolean("hasNext", false);
                this.queueIndex = o.optInt("queueIndex", 0);

                String nextArtwork = o.isNull("artworkUrl") ? null : o.optString("artworkUrl", null);
                if (nextArtwork != null && !nextArtwork.equals(this.artworkUrl)) {
                    this.artworkUrl = nextArtwork;
                    fetchArtwork(nextArtwork);
                } else if (nextArtwork == null) {
                    this.artworkUrl = null;
                    this.artwork = null;
                    this.artworkLoadedFor = null;
                }

                List<MediaSessionCompat.QueueItem> nextQueue = new ArrayList<>();
                JSONArray queueJson = o.optJSONArray("queue");
                if (queueJson != null) {
                    for (int i = 0; i < queueJson.length(); i++) {
                        JSONObject item = queueJson.optJSONObject(i);
                        if (item == null) continue;
                        String id = item.optString("id", "");
                        long queueId = item.optLong("queueId", i);
                        String itemTitle = item.optString("title", "");
                        String itemArtist = item.optString("artist", "");
                        String itemAlbum = item.optString("album", "");
                        String itemMediaUri = item.optString("mediaUri", "");
                        String itemArtwork = item.optString("artworkUrl", "");

                        MediaDescriptionCompat.Builder desc = new MediaDescriptionCompat.Builder()
                            .setMediaId(id)
                            .setTitle(itemTitle)
                            .setSubtitle(itemArtist)
                            .setDescription(itemAlbum);
                        if (!itemMediaUri.isEmpty()) {
                            try {
                                desc.setMediaUri(Uri.parse(itemMediaUri));
                            } catch (Exception ignored) {
                                /* */
                            }
                        }
                        if (!itemArtwork.isEmpty()) {
                            try {
                                desc.setIconUri(Uri.parse(itemArtwork));
                            } catch (Exception ignored) {
                                /* */
                            }
                        }
                        nextQueue.add(new MediaSessionCompat.QueueItem(desc.build(), queueId));
                    }
                }
                this.playQueue = nextQueue;
            }
            this.playbackState = o.optString("playbackState", "none");
            if (!o.optBoolean("skipPosition", false)) {
                long nextDurationMs = (long) Math.max(0, o.optDouble("duration", 0) * 1000.0);
                if (nextDurationMs > 0) {
                    this.durationMs = nextDurationMs;
                }
                this.positionMs = (long) Math.max(0, o.optDouble("position", 0) * 1000.0);
            }
            this.speed = (float) (o.optDouble("playbackRate", 1) > 0 ? o.optDouble("playbackRate", 1) : 1);
            apply();
        } catch (Exception e) {
            Log.w(TAG, "stato media non valido: " + e.getMessage());
        }
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
            session.setQueue(new ArrayList<>());
            stopForegroundCompat();
            return;
        }

        MediaMetadataCompat.Builder meta = new MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist)
            .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, album)
            .putString(MediaMetadataCompat.METADATA_KEY_MEDIA_ID, mediaId);
        if (durationMs > 0) {
            meta.putLong(MediaMetadataCompat.METADATA_KEY_DURATION, durationMs);
        }
        if (!mediaUri.isEmpty()) {
            meta.putString(MediaMetadataCompat.METADATA_KEY_MEDIA_URI, mediaUri);
            try {
                meta.putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_ICON_URI, artworkUrl != null ? artworkUrl : "");
            } catch (Exception ignored) {
                /* */
            }
        }
        if (artwork != null) {
            meta.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, artwork);
            meta.putBitmap(MediaMetadataCompat.METADATA_KEY_ART, artwork);
        }
        session.setMetadata(meta.build());
        session.setQueue(playQueue.isEmpty() ? null : playQueue);

        int state = "playing".equals(playbackState)
            ? PlaybackStateCompat.STATE_PLAYING
            : PlaybackStateCompat.STATE_PAUSED;
        long actions =
            PlaybackStateCompat.ACTION_PLAY |
            PlaybackStateCompat.ACTION_PAUSE |
            PlaybackStateCompat.ACTION_PLAY_PAUSE |
            PlaybackStateCompat.ACTION_SEEK_TO |
            PlaybackStateCompat.ACTION_STOP;
        if (hasPrevious) {
            actions |= PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS;
        }
        if (hasNext) {
            actions |= PlaybackStateCompat.ACTION_SKIP_TO_NEXT;
        }
        if (!playQueue.isEmpty()) {
            actions |= PlaybackStateCompat.ACTION_SKIP_TO_QUEUE_ITEM;
        }

        session.setPlaybackState(
            new PlaybackStateCompat.Builder()
                .setState(state, positionMs, speed)
                .setActions(actions)
                .setActiveQueueItemId(queueIndex < playQueue.size() ? playQueue.get(queueIndex).getQueueId() : -1)
                .build()
        );
        session.setActive(true);

        Notification notification = buildNotification();
        // Foreground mantenuto anche in pausa finché c'è una sessione attiva:
        // l'audio vive nel WebView, se il processo viene sospeso in background
        // (OEM aggressivi) i controlli lock screen e la ripresa fallirebbero.
        // Lo stato "none" passa da stopForegroundCompat() prima di arrivare qui.
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

        PendingIntent prevIntent = hasPrevious
            ? MediaButtonReceiver.buildMediaButtonPendingIntent(
                this,
                PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
            )
            : null;
        PendingIntent nextIntent = hasNext
            ? MediaButtonReceiver.buildMediaButtonPendingIntent(
                this,
                PlaybackStateCompat.ACTION_SKIP_TO_NEXT
            )
            : null;
        long playPauseAction = "playing".equals(playbackState)
            ? PlaybackStateCompat.ACTION_PAUSE
            : PlaybackStateCompat.ACTION_PLAY;
        int playPauseIcon = "playing".equals(playbackState)
            ? android.R.drawable.ic_media_pause
            : android.R.drawable.ic_media_play;
        PendingIntent playPauseIntent = MediaButtonReceiver.buildMediaButtonPendingIntent(
            this,
            playPauseAction
        );

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(artist)
            .setSubText(album)
            .setLargeIcon(artwork)
            .setContentIntent(contentIntent)
            .setOnlyAlertOnce(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC);

        if (prevIntent != null) {
            b.addAction(
                new NotificationCompat.Action(
                    android.R.drawable.ic_media_previous,
                    "Precedente",
                    prevIntent
                )
            );
        }
        b.addAction(
            new NotificationCompat.Action(playPauseIcon, "Play/Pausa", playPauseIntent)
        );
        if (nextIntent != null) {
            b.addAction(
                new NotificationCompat.Action(
                    android.R.drawable.ic_media_next,
                    "Successivo",
                    nextIntent
                )
            );
        }

        androidx.media.app.NotificationCompat.MediaStyle style =
            new androidx.media.app.NotificationCompat.MediaStyle()
                .setMediaSession(session.getSessionToken())
                .setShowActionsInCompactView(compactActionIndices(hasPrevious, hasNext));

        b.setStyle(style);
        return b.build();
    }

    private int[] compactActionIndices(boolean showPrev, boolean showNext) {
        if (showPrev && showNext) return new int[] { 0, 1, 2 };
        if (showPrev) return new int[] { 0, 1 };
        if (showNext) return new int[] { 0, 1 };
        return new int[] { 0 };
    }
}
