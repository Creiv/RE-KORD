package app.rekord.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Play from the car / Bluetooth with the app in the background:
 * `./gradlew :app:testUniversalDebugUnitTest` from gen/android.
 */
class RemotePlayTest {
    private fun track(playing: Boolean = false, wantsPlay: Boolean = playing, position: Long = 0L) = NowPlaying(
        title = "Song",
        artist = "Artist",
        album = "Album",
        artworkUrl = "http://hub/cover/1?size=256",
        playing = playing,
        durationMs = 200_000L,
        positionMs = position,
        wantsPlay = wantsPlay,
        pauseReason = if (playing) "" else "user",
    )

    @Test
    fun pendingUntilThePageMeansToPlay() {
        val r = RemotePlayRequest()
        assertEquals(15_000L, r.begin(now = 1_000L, pageAlive = true))
        assertTrue(r.pending)
        // A stale paused state (the page has not run the command yet) changes nothing.
        assertFalse(r.onPageState(playing = false, wantsPlay = false))
        assertTrue(r.pending)
        // Loading the track counts: the usual rules take over from here.
        assertTrue(r.onPageState(playing = false, wantsPlay = true))
        assertFalse(r.pending)
        // Fulfilled once only.
        assertFalse(r.onPageState(playing = true, wantsPlay = true))
    }

    @Test
    fun noPageGetsTheLongerWindow() {
        val r = RemotePlayRequest()
        assertEquals(45_000L, r.begin(now = 0L, pageAlive = false))
        assertTrue(r.coldStart)
        assertEquals(30_000L, r.remaining(15_000L))
        assertTrue(r.pending)
    }

    @Test
    fun expiresAtTheDeadline() {
        val r = RemotePlayRequest(windowMs = 10_000L)
        r.begin(now = 5_000L, pageAlive = true)
        assertEquals(1L, r.remaining(14_999L))
        assertEquals(0L, r.remaining(15_000L))
        assertFalse(r.pending)
        assertEquals(0L, r.remaining(16_000L))
    }

    @Test
    fun aPauseCancelsIt() {
        val r = RemotePlayRequest()
        r.begin(0L, true)
        assertTrue(r.cancel())
        assertFalse(r.pending)
        assertFalse(r.cancel())
        assertFalse(r.onPageState(playing = true, wantsPlay = true))
    }

    @Test
    fun aSecondPlayRestartsTheWindow() {
        val r = RemotePlayRequest(windowMs = 10_000L)
        r.begin(0L, true)
        r.begin(8_000L, true)
        assertEquals(10_000L, r.remaining(8_000L))
        assertEquals(2_000L, r.remaining(16_000L))
    }

    @Test
    fun aRecreatedServiceHasNoGrace() {
        // The 5.1 bug: lastActiveAt = 0 in a service the media button just recreated
        // gave a negative grace, so it left the foreground right away.
        val grace = ForegroundPolicy.graceLeft(now = 50_000_000L, lastActiveAt = 0L, graceMs = 600_000L)
        assertTrue(grace < 0)
        assertFalse(ForegroundPolicy.holdForeground(false, false, false, remotePlayPending = false, graceLeft = grace))
        // With the play pending it holds, whatever the grace says.
        assertTrue(ForegroundPolicy.holdForeground(false, false, false, remotePlayPending = true, graceLeft = grace))
    }

    @Test
    fun graceRunsFromTheLastActivity() {
        assertEquals(540_000L, ForegroundPolicy.graceLeft(now = 160_000L, lastActiveAt = 100_000L, graceMs = 600_000L))
        assertTrue(ForegroundPolicy.holdForeground(false, false, false, false, 540_000L))
        val over = ForegroundPolicy.graceLeft(now = 800_000L, lastActiveAt = 100_000L, graceMs = 600_000L)
        assertFalse(ForegroundPolicy.holdForeground(false, false, false, false, over))
        assertTrue(ForegroundPolicy.holdForeground(false, false, interruptionArmed = true, remotePlayPending = false, graceLeft = over))
    }

    @Test
    fun locksForAPendingPlayButNeverWhileCasting() {
        assertTrue(ForegroundPolicy.holdLocks(casting = false, playing = false, wantsPlay = false, silentTooLong = false, remotePlayPending = true))
        assertFalse(ForegroundPolicy.holdLocks(casting = true, playing = false, wantsPlay = false, silentTooLong = false, remotePlayPending = true))
        assertFalse(ForegroundPolicy.holdLocks(casting = true, playing = true, wantsPlay = true, silentTooLong = false, remotePlayPending = false))
        // Paused: released.
        assertFalse(ForegroundPolicy.holdLocks(casting = false, playing = false, wantsPlay = false, silentTooLong = false, remotePlayPending = false))
        // Hub gone for good: let go, unless a fresh play from the car asks again.
        assertFalse(ForegroundPolicy.holdLocks(false, false, wantsPlay = true, silentTooLong = true, remotePlayPending = false))
        assertTrue(ForegroundPolicy.holdLocks(false, false, wantsPlay = true, silentTooLong = true, remotePlayPending = true))
    }

    @Test
    fun savedTrackComesBackPaused() {
        val map = NowPlayingStore.encode(track(playing = true, position = 42_000L), savedAtMs = 123L)
        val back = NowPlayingStore.decode { map[it] }!!
        assertEquals("Song", back.title)
        assertEquals("Artist", back.artist)
        assertEquals("Album", back.album)
        assertEquals("http://hub/cover/1?size=256", back.artworkUrl)
        assertEquals(200_000L, back.durationMs)
        assertEquals(42_000L, back.positionMs)
        assertFalse(back.playing)
        assertFalse(back.wantsPlay)
        assertEquals("", back.pauseReason)
        assertEquals("123", map[NowPlayingStore.KEY_SAVED_AT])
    }

    @Test
    fun nothingSavedOrUnreadable() {
        assertNull(NowPlayingStore.decode { null })
        assertNull(NowPlayingStore.decode { if (it == NowPlayingStore.KEY_TITLE) "  " else "x" })
        val back = NowPlayingStore.decode {
            when (it) {
                NowPlayingStore.KEY_TITLE -> "T"
                NowPlayingStore.KEY_DURATION -> "garbage"
                NowPlayingStore.KEY_POSITION -> "-5"
                NowPlayingStore.KEY_ARTWORK -> ""
                else -> null
            }
        }!!
        assertEquals(0L, back.durationMs)
        assertEquals(0L, back.positionMs)
        assertNull(back.artworkUrl)
    }

    @Test
    fun savesOnChangesNotOnEveryPositionTick() {
        val a = track(playing = true, position = 10_000L)
        assertTrue(NowPlayingStore.worthSaving(null, a))
        assertFalse(NowPlayingStore.worthSaving(a, a.copy(positionMs = 15_000L)))
        assertTrue(NowPlayingStore.worthSaving(a, a.copy(positionMs = 70_000L)))
        assertTrue(NowPlayingStore.worthSaving(a, a.copy(playing = false)))
        assertTrue(NowPlayingStore.worthSaving(a, a.copy(title = "Other")))
        assertFalse(NowPlayingStore.worthSaving(a, a.copy(wantsPlay = false, pauseReason = "external")))
    }

    @Test
    fun mediaBrowserRefusesUnknownApps() {
        val own = 10_123
        // The app itself, the system's media controls / Bluetooth, Android Auto.
        assertTrue(BrowserAccess.allowed(own, own, "app.rekord.client", trusted = false, systemApp = false))
        assertTrue(BrowserAccess.allowed(1_000, own, "com.android.systemui", trusted = true, systemApp = true))
        assertTrue(BrowserAccess.allowed(1_002, own, "com.android.bluetooth", trusted = false, systemApp = true))
        assertTrue(BrowserAccess.allowed(10_200, own, "com.google.android.projection.gearhead", trusted = false, systemApp = false))
        // Any other installed app gets no session (no control, no track title).
        assertFalse(BrowserAccess.allowed(10_300, own, "com.example.snoop", trusted = false, systemApp = false))
    }

    @Test
    fun resumeTicketIsOneShotAndShortLived() {
        val ticket = ResumeTicket(validMs = 10_000L)
        // Never issued: an "open and resume" start sent by another app.
        assertFalse(ticket.take(now = 5_000L))
        ticket.issue(now = 1_000L)
        assertTrue(ticket.take(now = 2_000L))
        assertFalse("used once", ticket.take(now = 2_100L))
        ticket.issue(now = 1_000L)
        assertFalse("too late", ticket.take(now = 12_000L))
    }
}
