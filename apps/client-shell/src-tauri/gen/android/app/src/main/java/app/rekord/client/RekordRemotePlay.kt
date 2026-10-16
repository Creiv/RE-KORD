package app.rekord.client

/**
 * A play that comes from outside the app (car, Bluetooth, headset, lock screen,
 * a media browser such as Android Auto or the system's media controls) while the
 * page may be asleep: WebView paused, process just unfrozen, service just
 * restarted by the media button.
 *
 * The service must hold the foreground and the locks from the moment the command
 * arrives (Android only allows entering the foreground from the background inside
 * the short window the media button grants) until the page takes the command over
 * by reporting that it plays or means to. Without this, the old flow waited for the
 * page to answer first, and by then the window was gone: no foreground, frozen or
 * throttled process, restricted network, silence until the phone was unlocked.
 *
 * Plain Kotlin, no Android types: `RemotePlayTest` covers it on the JVM.
 */
class RemotePlayRequest(
    /** How long a page that exists gets to take the command over. */
    private val windowMs: Long = 15_000L,
    /** Same with no page yet (activity being started, page loading the queue). */
    private val coldStartWindowMs: Long = 45_000L,
) {
    /** True from the command until the page takes it over, a pause, or the deadline. */
    var pending = false
        private set

    /** The page did not exist when the command arrived. */
    var coldStart = false
        private set

    private var deadline = 0L

    /**
     * Starts the request (a second play while one is pending restarts it).
     * Returns the window, which is also the delivery window of the command.
     */
    fun begin(now: Long, pageAlive: Boolean): Long {
        val window = if (pageAlive) windowMs else coldStartWindowMs
        pending = true
        coldStart = !pageAlive
        deadline = now + window
        return window
    }

    /**
     * A state from the page. Playing, or meaning to (the track is loading, the
     * stream reconnecting), means the page has the command: from here on the
     * usual rules keep the foreground and the locks. Returns true when this
     * state fulfils the request.
     */
    fun onPageState(playing: Boolean, wantsPlay: Boolean): Boolean {
        if (!pending || !(playing || wantsPlay)) return false
        pending = false
        return true
    }

    /** A pause or stop from anywhere: the play is no longer wanted. */
    fun cancel(): Boolean {
        val was = pending
        pending = false
        return was
    }

    /** Milliseconds left, or 0 when the request expired now (it is then cleared). */
    fun remaining(now: Long): Long {
        if (!pending) return 0L
        val left = deadline - now
        if (left > 0) return left
        pending = false
        return 0L
    }
}

/**
 * When the service stays in the foreground. Kept apart from the service so the
 * rule can be tested: a service just recreated by a media button used to compute
 * its pause grace from a zero timestamp, leave the foreground in the same breath
 * it entered it, and put the WebView back to sleep under the incoming play.
 */
object ForegroundPolicy {
    /** Milliseconds of pause grace left (negative when over, or never active). */
    fun graceLeft(now: Long, lastActiveAt: Long, graceMs: Long): Long =
        if (lastActiveAt <= 0L) -1L else graceMs - (now - lastActiveAt)

    fun holdForeground(
        playing: Boolean,
        wantsPlay: Boolean,
        interruptionArmed: Boolean,
        remotePlayPending: Boolean,
        graceLeft: Long,
    ): Boolean = playing || wantsPlay || interruptionArmed || remotePlayPending || graceLeft > 0

    /** CPU and Wi-Fi locks (none while casting: no audio goes through the phone). */
    fun holdLocks(
        casting: Boolean,
        playing: Boolean,
        wantsPlay: Boolean,
        silentTooLong: Boolean,
        remotePlayPending: Boolean,
    ): Boolean = !casting && (playing || (wantsPlay && !silentTooLong) || remotePlayPending)
}

/**
 * The last track, kept in the app's private preferences so that a car PLAY after
 * the system killed the service (or the whole process) still has something to
 * show and to resume: the session is rebuilt with it and the media browser offers
 * it as the "Resume" item. Only what the notification shows is kept, never the
 * queue: the queue lives in the page (localStorage) and the page restores it.
 *
 * Encoded as plain string pairs so the service can write them to
 * SharedPreferences and the tests can use a map.
 */
object NowPlayingStore {
    const val KEY_TITLE = "np.title"
    const val KEY_ARTIST = "np.artist"
    const val KEY_ALBUM = "np.album"
    const val KEY_ARTWORK = "np.artwork"
    const val KEY_DURATION = "np.durationMs"
    const val KEY_POSITION = "np.positionMs"
    const val KEY_SAVED_AT = "np.savedAt"

    val KEYS = listOf(KEY_TITLE, KEY_ARTIST, KEY_ALBUM, KEY_ARTWORK, KEY_DURATION, KEY_POSITION, KEY_SAVED_AT)

    fun encode(state: NowPlaying, savedAtMs: Long): Map<String, String> = mapOf(
        KEY_TITLE to state.title,
        KEY_ARTIST to state.artist,
        KEY_ALBUM to state.album,
        KEY_ARTWORK to (state.artworkUrl ?: ""),
        KEY_DURATION to state.durationMs.toString(),
        KEY_POSITION to state.positionMs.toString(),
        KEY_SAVED_AT to savedAtMs.toString(),
    )

    /**
     * The saved track, always paused: whatever it was doing when saved, nobody is
     * playing it now. Null when nothing (or nothing readable) was saved.
     */
    fun decode(get: (String) -> String?): NowPlaying? {
        val title = get(KEY_TITLE)?.trim().orEmpty()
        if (title.isEmpty()) return null
        return NowPlaying(
            title = title,
            artist = get(KEY_ARTIST)?.trim().orEmpty(),
            album = get(KEY_ALBUM)?.trim().orEmpty(),
            artworkUrl = get(KEY_ARTWORK)?.trim()?.ifEmpty { null },
            playing = false,
            durationMs = get(KEY_DURATION)?.toLongOrNull()?.coerceAtLeast(0L) ?: 0L,
            positionMs = get(KEY_POSITION)?.toLongOrNull()?.coerceAtLeast(0L) ?: 0L,
            wantsPlay = false,
            pauseReason = "",
        )
    }

    /**
     * Whether a new state is worth a write: another track, a play/pause change,
     * or the position moved by a minute (not every 5 s refresh).
     */
    fun worthSaving(previous: NowPlaying?, next: NowPlaying): Boolean {
        if (previous == null) return true
        if (previous.title != next.title || previous.artist != next.artist || previous.album != next.album) return true
        if (previous.artworkUrl != next.artworkUrl) return true
        if (previous.playing != next.playing) return true
        return kotlin.math.abs(previous.positionMs - next.positionMs) >= 60_000L
    }
}
