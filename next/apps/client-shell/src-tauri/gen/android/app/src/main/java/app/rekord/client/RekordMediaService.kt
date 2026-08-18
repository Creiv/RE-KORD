package app.rekord.client

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.media.session.MediaButtonReceiver
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Tiene in vita la riproduzione quando l'app va in secondo piano e disegna la
 * notifica media di sistema.
 *
 * Il suono resta nella WebView: questo servizio non ha un lettore. Fa due cose
 * che dalla pagina non si possono fare. Primo, essere un servizio in foreground,
 * cosi' Android non congela il processo a schermo spento. Secondo, tenere una
 * MediaSession: da lei nascono la notifica, i comandi in schermata di blocco e
 * il tasto sulle cuffie, che poi tornano alla pagina via [RekordMediaBridge].
 *
 * MediaSessionCompat e' deprecata in favore di Media3, ma Media3 chiede di
 * implementare un `Player`: qui il player e' un tag <audio> dall'altra parte di
 * un ponte JavaScript, quindi la sessione "a mano" resta la strada corta.
 */
@Suppress("DEPRECATION")
class RekordMediaService : Service() {
    private lateinit var session: MediaSessionCompat
    private val artLoader = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())

    @Volatile
    private var artUrl: String? = null
    private var art: Bitmap? = null
    private var inForeground = false

    override fun onCreate() {
        super.onCreate()
        createChannel()
        session = MediaSessionCompat(this, "RE-KORD").apply {
            setCallback(object : MediaSessionCompat.Callback() {
                override fun onPlay() = RekordMediaBridge.send("play")
                override fun onPause() = RekordMediaBridge.send("pause")
                override fun onSkipToNext() = RekordMediaBridge.send("nexttrack")
                override fun onSkipToPrevious() = RekordMediaBridge.send("previoustrack")
                override fun onSeekTo(pos: Long) =
                    RekordMediaBridge.send("seekto", pos / 1000.0)

                override fun onStop() {
                    RekordMediaBridge.send("pause")
                    stop(this@RekordMediaService)
                }
            })
            isActive = true
        }
        running = this
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        MediaButtonReceiver.handleIntent(session, intent)
        val state = latest
        if (state == null) {
            // La musica e' finita nel frattempo (coda svuotata a un passo dal play).
            // Chi e' stato avviato con startForegroundService deve comunque andare in
            // foreground, altrimenti Android lo uccide con un'eccezione: si entra e
            // si esce subito.
            enterForeground(buildNotification(idle()))
            stop(this)
            return START_NOT_STICKY
        }
        render(state)
        return START_NOT_STICKY
    }

    /** Riscrive sessione e notifica con lo stato appena arrivato dalla pagina. */
    private fun render(state: NowPlaying) {
        requestArt(state.artworkUrl)
        session.setMetadata(
            MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, state.title)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, state.artist)
                .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, state.album)
                .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, state.durationMs)
                .apply { art?.let { putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, it) } }
                .build(),
        )
        session.setPlaybackState(
            PlaybackStateCompat.Builder()
                .setState(
                    if (state.playing) PlaybackStateCompat.STATE_PLAYING
                    else PlaybackStateCompat.STATE_PAUSED,
                    state.positionMs,
                    if (state.playing) 1f else 0f,
                )
                .setActions(
                    PlaybackStateCompat.ACTION_PLAY or
                        PlaybackStateCompat.ACTION_PAUSE or
                        PlaybackStateCompat.ACTION_PLAY_PAUSE or
                        PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
                        PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
                        PlaybackStateCompat.ACTION_SEEK_TO or
                        PlaybackStateCompat.ACTION_STOP,
                )
                .build(),
        )
        val notification = buildNotification(state)
        if (state.playing) {
            if (inForeground) {
                NotificationManagerCompat.from(this).notify(NOTIFICATION_ID, notification)
            } else {
                enterForeground(notification)
            }
        } else {
            // In pausa non si sta riproducendo niente: si lascia il foreground
            // (Android 14 lo pretende) ma la notifica resta, cosi' si puo'
            // ripartire da lei. DETACH la tiene in piedi dopo l'uscita.
            if (inForeground) {
                ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_DETACH)
                inForeground = false
            }
            NotificationManagerCompat.from(this).notify(NOTIFICATION_ID, notification)
        }
    }

    private fun enterForeground(notification: Notification) {
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            notification,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
            } else {
                0
            },
        )
        inForeground = true
    }

    private fun idle() = NowPlaying(
        title = getString(R.string.app_name),
        artist = "",
        album = "",
        artworkUrl = null,
        playing = false,
        durationMs = 0L,
        positionMs = 0L,
    )

    private fun buildNotification(state: NowPlaying): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = MediaButtonReceiver.buildMediaButtonPendingIntent(
            this,
            PlaybackStateCompat.ACTION_STOP,
        )
        val subtitle = listOf(state.artist, state.album)
            .filter { it.isNotEmpty() }
            .joinToString(" · ")
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_rekord_note)
            .setContentTitle(state.title)
            .setContentText(subtitle)
            .setLargeIcon(art)
            .setContentIntent(open)
            .setDeleteIntent(stop)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(state.playing)
            .setShowWhen(false)
            .setOnlyAlertOnce(true)
            .addAction(
                android.R.drawable.ic_media_previous,
                getString(R.string.media_previous),
                MediaButtonReceiver.buildMediaButtonPendingIntent(
                    this,
                    PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS,
                ),
            )
            .addAction(
                if (state.playing) android.R.drawable.ic_media_pause
                else android.R.drawable.ic_media_play,
                getString(if (state.playing) R.string.media_pause else R.string.media_play),
                MediaButtonReceiver.buildMediaButtonPendingIntent(
                    this,
                    PlaybackStateCompat.ACTION_PLAY_PAUSE,
                ),
            )
            .addAction(
                android.R.drawable.ic_media_next,
                getString(R.string.media_next),
                MediaButtonReceiver.buildMediaButtonPendingIntent(
                    this,
                    PlaybackStateCompat.ACTION_SKIP_TO_NEXT,
                ),
            )
            .setStyle(
                androidx.media.app.NotificationCompat.MediaStyle()
                    .setMediaSession(session.sessionToken)
                    .setShowActionsInCompactView(0, 1, 2)
                    .setShowCancelButton(true)
                    .setCancelButtonIntent(stop),
            )
            .build()
    }

    /**
     * La copertina arriva dall'hub via HTTP: si scarica una volta per URL e si
     * ridisegna quando e' pronta, senza bloccare la notifica.
     */
    private fun requestArt(url: String?) {
        if (url == null) {
            artUrl = null
            art = null
            return
        }
        if (url == artUrl) return
        artUrl = url
        art = null
        artLoader.execute {
            val bitmap = downloadArt(url)
            // Se nel frattempo il brano e' cambiato, questa copertina non serve piu'.
            if (bitmap == null || url != artUrl) return@execute
            main.post {
                if (url != artUrl) return@post
                art = bitmap
                latest?.let { render(it) }
            }
        }
    }

    private fun downloadArt(url: String): Bitmap? {
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 5_000
                readTimeout = 5_000
                instanceFollowRedirects = true
            }
            if (connection.responseCode !in 200..299) return null
            connection.inputStream.use { BitmapFactory.decodeStream(it) }
        } catch (e: Exception) {
            Logger.warn("RekordMedia: copertina non scaricata: ${e.message}")
            null
        } finally {
            connection?.disconnect()
        }
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.media_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.media_channel_description)
            setShowBadge(false)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    /** Se l'app viene chiusa dai recenti la WebView muore, e con lei l'audio. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        stop(this)
    }

    override fun onDestroy() {
        running = null
        // `latest` non si azzera qui: se il servizio muore senza passare da stop()
        // (memoria, sistema) la pagina sta ancora suonando, e il prossimo stato che
        // manda lo fara' ripartire. A svuotarlo ci pensa chi ferma la musica.
        artLoader.shutdownNow()
        main.removeCallbacksAndMessages(null)
        session.isActive = false
        session.release()
        NotificationManagerCompat.from(this).cancel(NOTIFICATION_ID)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val CHANNEL_ID = "rekord.playback"
        private const val NOTIFICATION_ID = 1

        @Volatile
        private var running: RekordMediaService? = null

        @Volatile
        private var latest: NowPlaying? = null

        /** Serve a MainActivity per decidere se tenere sveglia la WebView. */
        val isPlaying: Boolean
            get() = latest?.playing == true

        /**
         * Chiamata dalla pagina a ogni cambio di brano o di stato: la prima
         * volta accende il servizio, poi lo aggiorna.
         */
        fun publish(context: Context, state: NowPlaying) {
            latest = state
            val service = running
            if (service != null) {
                service.render(state)
                return
            }
            // Il servizio nasce solo con un brano che suona: e' l'unico caso in cui
            // Android lascia accendere un foreground service, ed e' l'unico in cui
            // serve. Un brano in pausa senza servizio non ha niente da tenere in vita.
            if (!state.playing) return
            ContextCompat.startForegroundService(
                context,
                Intent(context, RekordMediaService::class.java),
            )
        }

        fun stop(context: Context) {
            latest = null
            val service = running
            if (service != null) {
                ServiceCompat.stopForeground(service, ServiceCompat.STOP_FOREGROUND_REMOVE)
                service.inForeground = false
                service.stopSelf()
            } else {
                context.stopService(Intent(context, RekordMediaService::class.java))
            }
        }
    }
}
