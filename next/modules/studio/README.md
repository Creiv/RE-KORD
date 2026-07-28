# Module: studio

Download yt-dlp, Scopri Web (YouTube Music), metadati (Discogs/iTunes/MB/…), copertine e impostazioni correlate.

Abilitato di default nel hub next: le route Studio sono sempre registrate in `rekord-core` (`studio.rs`). Il flag `studio` nel manifest resta informativo per il registry moduli.

## Runtime

- Binario `yt-dlp` sul PATH o `YTDLP_PATH`
- Cookie Netscape opzionali: Impostazioni → Libreria, o env `REKORD_YTDLP_COOKIES`
- Token Discogs opzionale: Impostazioni o env `REKORD_DISCOGS_TOKEN`
- Disabilita download: `ENABLE_YTDLP=0`
