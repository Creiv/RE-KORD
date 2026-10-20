# Security policy

## Reporting a vulnerability

Please report security problems **privately**. Do not open a public issue.

- Use GitHub's private reporting: **Security › Report a vulnerability** on
  [github.com/Creiv/RE-KORD](https://github.com/Creiv/RE-KORD/security/advisories/new).
- Include the RE-KORD version, the platform, how the hub is exposed (LAN, tunnel, reverse
  proxy, Docker), steps to reproduce and the impact you expect.

We aim to acknowledge reports within a week and to agree on a disclosure date once a fix
is available. Credit is given in the release notes unless you prefer otherwise.

## Supported versions

| Version | Supported |
|---|---|
| 5.x (RE-KORD 5, Rust / Tauri) | Yes |
| Legacy (Electron / Node, up to the legacy 5.0) | No; please upgrade |

## Security model

RE-KORD is a **personal hub for a trusted home network**. Understanding what it does and
does not protect helps you expose it safely.

### No user authentication

Accounts are profiles, not logins: there are **no passwords or PINs**. Anyone who can
reach the hub's port can browse the library, play music and use any account's personal
data (favorites, playlists, moods, settings). Protection comes from *where* the hub can be
reached and from the operation levels below.

### Optional access key

Setting `REKORD_ACCESS_KEY` adds one shared secret in front of the whole API. Unset, nothing
changes. Set, every request to `/api` (including the legacy `/api/*` aliases without `v1`)
and to `/media` must present the key; the static UI (`/`, `/assets`, the `/admin` page shell,
service worker, manifest) and CORS preflights stay public, because they carry no data and
are needed to ask for the key.

- **What it is:** a hub-wide key, typically to expose the hub through a tunnel or a reverse
  proxy. **What it is not:** per-user authentication. Accounts remain profiles; anyone with
  the key can use any account's personal data. There is one key for every device: there is
  no per-device revocation. To rotate it, change the variable and restart the hub; every
  client then asks for the new one.
- **Format and fail-closed start:** 32 to 256 characters from `A-Z a-z 0-9 . _ ~ -`
  (generate one with `openssl rand -hex 32`). A variable that is set but empty, too short,
  too long or with any other character (spaces and line breaks included) stops the hub from
  starting; the error names the variable, never its value. The desktop server flavor's
  embedded hub does not start either, and its connect screen says why.
- **How it travels:** the `X-Rekord-Access-Key` header for API calls, or the `accessKey`
  query parameter for what cannot send headers (`<audio>`, `<img>`, downloads, Cast). The
  hub keeps only a SHA-256 digest, compares in constant time, never logs the key or echoes
  it, and removes it from the header and the query string before the request reaches any
  handler. The health endpoint answers without the key with a minimal body
  (`accessKey: "required"`, no version) so clients can ask for it.
- **Local requests are not exempt.** A reverse proxy on the hub computer that rewrites
  `Host` and adds no forwarding header would make every remote request look local. The key
  is a layer in front of the [operation levels](#operation-levels) and of the remote-admin
  switch: it does not replace them. In Docker, `docker exec rekord curl ...` needs the
  header too.
- **HTTPS is mandatory for remote access.** Over plain HTTP the key travels in clear text.
  Use the Cloudflare tunnel or an HTTPS reverse proxy; on the LAN the hub itself speaks
  plain HTTP, so anyone able to sniff your local network can read the key.
- **A key in a URL can leak.** Query strings end up in reverse-proxy access logs (configure
  the proxy not to log them, see [DEPLOY.md](docs/DEPLOY.md#access-key)), in browser history
  when a media URL is opened in a tab, in the operating system's media controls (artwork
  URLs) and on Cast devices. `Referrer-Policy: no-referrer` keeps it out of `Referer`.
- **Cast:** the stream and cover URLs handed to a Chromecast carry the key, so the key
  reaches the Cast device and the receiver app running on it. The client warns before
  casting to a hub that has a key.
- **QR pairing:** the admin panel's QR can include the key (*Network*, "include access key
  in QR", off by default). It is put in the URL fragment (`#rekordKey=...`), which browsers
  never send to servers or proxies, and the clients remove it from the address bar once
  read. Anyone who sees or photographs that QR has the key.
- **On the device:** clients (web, PWA, desktop, Android) store the key in the WebView's
  local storage, keyed by hub origin, and never send it to another hub. Settings can change
  or forget it. The admin panel uses the same storage when it is served by the same hub.
- **Wrong keys:** the hub counts *distinct* wrong keys per source. Five within a minute lock
  that source out for 60 seconds (`429 access_key_rate_limited` with `Retry-After`); during
  the lock even the right key is refused, so the lock gives no hint. Repeating the same
  stale key does not count. The source is the connecting address; `CF-Connecting-IP` or the
  last `X-Forwarded-For` hop are used only when that address is loopback (cloudflared, a
  reverse proxy on the hub computer), and IPv6 clients are grouped by `/64`. Counters are in
  memory and never logged. **Trade-off:** someone who shares your source (the same NAT, or a
  proxy that adds no `X-Forwarded-For`) can keep you locked out a minute at a time. The real
  protection against guessing is the key's length.
- Clients up to 5.2.0 do not know about the key and cannot connect to a hub that has one.

### Network binding

- The hub listens on `0.0.0.0:7420` by default, so it is reachable from your LAN. Set
  `REKORD_BIND=127.0.0.1:7420` to restrict it to the hub computer.
- Do **not** forward port 7420 on your router. For access from outside, use the Cloudflare
  tunnel or your own HTTPS reverse proxy.

### Operation levels

Every request is classified as **local** or **remote**. A request is local only when it
comes from the loopback interface, with a loopback `Host`, without proxy headers
(`X-Forwarded-For`, `X-Forwarded-Host`, `X-Real-IP`, `CF-Connecting-IP`, `CF-Ray`) and
from an allowed origin. Requests through the Cloudflare tunnel or a reverse proxy are
therefore always remote, even though they reach the hub from `127.0.0.1`.

| Level | Examples | Allowed |
|---|---|---|
| Personal data | Favorites, playlists, moods, queue, settings, playback | Any client |
| Library operations | Studio downloads, metadata, covers, trivia, file and folder deletion, account create/rename/delete | Local requests from any account, or any request when remote admin is on |
| Machine operations | Music folder, scans, layout, credentials (YouTube cookies, Discogs token), backup download and restore, tunnel, yt-dlp update, jobs, the remote-admin switch | The **Default** account **and** a local request, or the Default account anywhere when remote admin is on |

Refusals are `403` with `forbidden_remote` or `forbidden_default_account`.

### Machine operations

The **remote-admin switch** (admin panel, *Network › Machine operations › Also allow these
operations remotely*, or `REKORD_ALLOW_REMOTE_ADMIN=1`) lifts the local requirement. It can
only be turned on from the hub computer, and restoring a backup never turns it on.

With the switch on, anyone who reaches the hub, **including through the tunnel**, can use
the Default account to change the music folder, delete files, read backups (which contain
your credentials) and start downloads. Turn it on only on a network you trust, and
preferably not while a tunnel is running.

In Docker no request is local, so either run machine operations with
`docker exec rekord curl ... http://127.0.0.1:7420/...` or enable remote admin on a trusted
network.

### Origin policy

The hub refuses to be scripted by arbitrary web pages. Browsers may call the API only from:

- the hub's own pages (same origin, including through the tunnel);
- the RE-KORD apps (`tauri://localhost`, `http://tauri.localhost`, `https://tauri.localhost`);
- the development servers on ports 7421 and 7422 of `localhost`;
- origins listed in `REKORD_ALLOWED_ORIGINS`.

Other origins get `403 cross_origin_forbidden` on writes and no CORS headers on reads. A
foreign page is never treated as local. Responses carry `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and a restrictive
`Permissions-Policy`.

### Remote access tunnel

The built-in remote access starts a **Cloudflare quick tunnel** (`cloudflared tunnel
--url http://127.0.0.1:7420`). It gets a random `https://….trycloudflare.com` address that
changes on every start.

- Because the hub has no login, **anyone who learns the address can use the hub** as a
  remote client (personal data, playback), unless an [access key](#optional-access-key) is
  set. Share it only with people you trust and stop the tunnel when you are done.
- Cloudflare terminates TLS, so it sees full URLs, `accessKey` query parameters included.
- Tunnel requests are remote: library and machine operations stay blocked unless remote
  admin is on.
- Traffic passes through Cloudflare's network under Cloudflare's terms.

### Files, media and external content

- Media, cover and transcode routes validate library-relative paths: no `..`, no hidden or
  reserved segments, and the resolved path must stay inside the music folder.
- Artwork downloads from metadata providers are checked against server-side request
  forgery (no private or loopback addresses).
- Request bodies are size-limited (2 MiB by default, 512 MiB for restores).
- Bundled third-party tools (yt-dlp, QuickJS-ng, cloudflared, ffmpeg) are pinned and verified against
  SHA-256 hashes in `scripts/third-party.sha256`; yt-dlp self-updates are verified against
  the release's checksums.

### Data at rest

The hub stores its database, settings and credentials (Discogs token, YouTube cookies) in
its data folder in plain form; protect it with file permissions (the systemd unit runs as a
dedicated `rekord` user). **Backup ZIPs contain those credentials**: keep them private.

### Hardening checklist

- Keep the hub on a trusted LAN, or bind it to `127.0.0.1` behind a reverse proxy that adds
  authentication.
- Exposing it beyond the LAN: set `REKORD_ACCESS_KEY` (`openssl rand -hex 32`) and reach it
  only over HTTPS (tunnel or reverse proxy); keep the key out of the proxy's access logs.
- Leave remote admin off unless you need it.
- Run the tunnel only when needed.
- Use the systemd package (dedicated user, read-only system) or the Docker image (non-root).
- Keep RE-KORD and yt-dlp up to date.
