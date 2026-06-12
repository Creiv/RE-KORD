# RE-KORD — Mappa completa delle funzionalità

> Versione app: 4.0.0 — documento generato dall'analisi del codice (giugno 2026).
> Organizzato per pagina/sezione e categoria.

## Novità — giugno 2026

- **Opacità vetro regolabile**: slider 0–100% con campo numerico nelle Impostazioni, anteprima live e salvataggio automatico (debounce 500ms); sotto il 50% di opacità il tema custom sceglie il bianco/nero del testo dalla luminosità dello sfondo che traspare
- **Condivisione tema**: pulsante "Esporta tema" (zip condivisibile col solo tema, senza dati utente, sfondo immagine incluso) e upload unificato "backup o tema" che riconosce l'archivio e applica il tema su qualsiasi PC/server/account
- **Cover mancanti istantanee**: se una copertina non esiste compaiono subito le iniziali, senza attesa; i tentativi anti-rete-flaky proseguono in background
- **Mobile**: l'app occupa sempre tutta l'altezza dello schermo (100dvh nativo), metriche dashboard in griglia 2×2, fix header pagina artista e card "Playlist al volo", tap target più generosi
- **Player**: icona play/pausa stabile al cambio brano, anche con crossfade attivo
- **Rifiniture**: dialog con Escape ovunque, popover che evitano la tastiera/bottom nav, scala z-index unificata (toast), token colore per stati danger/warning leggibili su ogni tema
- **Client Android (APK)**: app nativa Capacitor che si connette a un server RE-KORD come il client desktop — indirizzo manuale o **scan del QR di Impostazioni → Rete**, che autocompila e porta dritti alla scelta account; riconnessione automatica all'avvio
- **QR generato in locale**: il QR di Impostazioni → Rete non passa più da un servizio esterno

## Indice

1. [Navigazione & Shell dell'app](#1-navigazione--shell-dellapp)
2. [Dashboard](#2-dashboard)
3. [Libreria](#3-libreria)
4. [Studio (Ascolto / Listen)](#4-studio-ascolto--listen)
5. [Coda](#5-coda)
6. [Playlists](#6-playlists)
7. [Preferiti / Recenti](#7-preferiti--recenti)
8. [Statistiche](#8-statistiche)
9. [Achievements ("Resonance")](#9-achievements-resonance)
10. [Player (barra globale)](#10-player-barra-globale)
11. [Visualizzatori & Karaoke](#11-visualizzatori--karaoke)
12. [Plectr (gioco ritmico)](#12-plectr-gioco-ritmico)
13. [Studio / Tools (manutenzione libreria)](#13-studio--tools-manutenzione-libreria)
14. [Impostazioni](#14-impostazioni)
15. [Server / Backend (Express)](#15-server--backend-express)
16. [Piattaforme & Deployment](#16-piattaforme--deployment)
17. [Funzionalità trasversali](#17-funzionalità-trasversali)

---

## 1. Navigazione & Shell dell'app

### TopBar
- Pulsante sincronizzazione manuale libreria (con animazione di stato e tooltip)
- Pulsante ricerca (toggle barra di ricerca, visibile solo in Libreria)
- Pulsante installazione PWA (nascondibile)
- Titolo pagina attiva (mobile) e logo RE-KORD (desktop)

### Sidebar (desktop)
- Collassabile (stato ricordato in localStorage)
- Navigazione primaria: Dashboard, Libreria, Studio (Ascolto), Gioco (Plectr)
- Navigazione secondaria: Coda, Playlists, Preferiti, Recenti, Statistiche, Achievements, Impostazioni
- Badge account + indicatore stato sincronizzazione

### Bottom Nav (mobile)
- 3 voci primarie (Dashboard, Libreria, Studio)
- Sheet "Altro" con tutte le voci secondarie (chiudibile con Escape o click esterno)

### Snackbar sync
- Notifiche delle attività di sincronizzazione libreria in background

---

## 2. Dashboard

- Hero card con pulsante "Ascolta/Riprendi" (avvia shuffle intelligente o riprende)
- 4 metriche: artisti, album, tracce, avvisi qualità
- Card mix consigliati (DashboardMixCard)
- Griglia "Album aggiornati di recente" (click → dettaglio album in Libreria)
- Top 5 preferiti per play count (click → riproduzione radio)
- Sezione avvisi qualità con conteggi per tipo e link a Studio

---

## 3. Libreria

### Ricerca globale
- Ricerca per titolo / artista / album / genere
- Filtri segmentati: Tutti / Artisti / Album / Tracce
- Risultati limitati (12 artisti, 12 album, 50 tracce)

### Browse in 3 modalità
- **Artisti**: griglia tile, ordinamento per nome o play count
- **Generi**: griglia con preview copertine, tile "Senza genere", conteggi tracce/album, ordinamenti
- **Mood** (sperimentale): filtri per 14 mood con match "Qualsiasi/Tutti" e lista tracce filtrata

### Dettaglio Artista
- Riproduzione shuffle dell'artista
- Pulsante info entità (trivia/bio)
- Ordinamento album: data / nome / play count
- Griglia album cliccabile

### Dettaglio Album
- Copertina grande con upload al click (badge edit al hover)
- Play sequenziale dell'album
- Editor metadati album
- Esclusione shuffle bulk (intero album)
- Info entità
- Gestione generi inline: chip con conteggi, aggiunta da popover, rimozione e applicazione a tracce mancanti (con conferma)
- Tracklist cliccabile (riproduzione sequenziale da posizione)

### Dettaglio Genere
- Riproduzione del genere, esclusione shuffle bulk
- Ordinamento tracce (nome / play count), lista virtuale

### Riga traccia (componente comune)
- Copertina, titolo, artista·album, chip qualità/durata, stato testi, play count
- Pulsanti: play, preferito (toggle), edit metadati, escludi da shuffle

---

## 4. Studio (Ascolto / Listen)

- Copertina album con upload al click
- Metadati traccia corrente: titolo, artista·album, durata, play count, stato testi (LRC/Plain/Mancante), chip qualità/formato
- Azioni rapide: preferito, edit metadati, esclusione shuffle
- Visualizzatore animato (lazy-loaded, modalità scelta nelle impostazioni)
- Pannello coda: traccia corrente + 5 successive, click per saltare, link "Gestisci coda"
- Pannello Recenti/Testi a tab:
  - Recenti: ultime 6 tracce ascoltate (click → radio)
  - Testi: scroll sincronizzato se LRC, testo preformattato se plain; auto-switch al tab testi se presenti

---

## 5. Coda

- Salvataggio coda come playlist (con nome)
- Svuotamento coda
- Lista virtuale con traccia attiva evidenziata e auto-scroll
- Riordino tracce, riproduzione da posizione

---

## 6. Playlists

- Creazione playlist con nome
- Rinomina inline con auto-save
- Eliminazione (con conferma)
- Riproduzione playlist
- Aggiunta della traccia in riproduzione
- Rimozione singole tracce
- Vista master-detail con conteggi

---

## 7. Preferiti / Recenti

- Liste virtuali dedicate
- Pulsante "Riproduci" (shuffle preferiti / riproduzione recenti)
- Click traccia → riproduzione radio
- Stati vuoti dedicati

---

## 8. Statistiche

### Modalità
- **Plays**: top per conteggio ascolti
- **Preferiti**: top per tracce preferite
- **Plectr**: top per punteggi del gioco (con grade)
- **Bloccati**: top esclusi da shuffle

### Contenuti
- Top 3 per ciascuna modalità: tracce, artisti, album, generi (click → apre in Libreria)
- Overview globale: play totali, tracce ascoltate, artisti/album toccati, preferiti, blocchi shuffle, tracce giocate a Plectr

---

## 9. Achievements ("Resonance")

### Livelli & XP
- 10 tier (da "Kicker" a "King of RE-KORD"), 20+ livelli con progressione quadratica
- Barra progresso XP con XP mancanti al prossimo livello
- XP da: play, preferiti (×5), playlist (×10), artisti (×3), blocchi shuffle (×2) + bonus badge

### Badge (60+, in 13 categorie)
- Play count (first play → 7500 plays)
- Preferiti (1 → 200)
- Playlist (1 → 20)
- Diversità artisti (3 → 100)
- Diversità generi (3 → 20)
- Esplorazione libreria (tracce ascoltate e % libreria: 5% → 75%)
- Shuffle (1 → 25)
- "Deep dive" artista (10 → 100 play sullo stesso artista)
- Album (10 / 50)
- Curatore playlist (30 tracce in una playlist)
- Ossessione traccia (20 play sulla stessa traccia)
- Streak giorni consecutivi (3 / 7 / 14 / 30)
- Tracce Plectr giocate (10 → 500)

### UI
- Griglia badge con stato sbloccato/bloccato, icona, descrizione e bonus XP
- Statistiche inline (play totali, artisti, preferiti, badge, streak)
- CTA verso Studio e Statistiche

---

## 10. Player (barra globale)

### Controlli
- Play/pausa, next/prev (prev riavvia la traccia se >3s)
- Seek con drag della barra e tastiera (frecce, step ±2%)
- Crossfade tra tracce (off / 3s / 5s) con doppio deck audio e prefetch del brano successivo

### Coda & shuffle
- Coda fino a 500 tracce con finestra scorrevole in memoria e rifornimento automatico a lotti
- Ripetizione OFF → ALL → ONE
- **Smart shuffle**: distribuzione per genere/mood/artista simili al seed, spaziatura artisti consecutivi, penalità tracce recenti, ripristino ordine originale alla disattivazione
- Radio globale (coda intelligente da 500 tracce a partire da un seed)
- Radio di collezione (album / artista / genere / playlist)
- Esclusioni shuffle per traccia e per album (con migrazione chiavi legacy)

### Conteggi & sessione
- Play contato al 50% di ascolto
- Ripristino coda + posizione all'avvio (opzionale)
- Persistenza su stato utente con flush prima della chiusura della tab

### Integrazione OS (Media Session)
- Metadati e artwork multi-risoluzione (96→512px) per lock screen / widget / Android Auto
- Comandi hardware: play/pausa, next/prev, seek, shuffle, repeat, preferito, escludi da shuffle
- Gestione mute intelligente in Android Auto (mute da volante ≈ pausa)

### Mobile
- Swipe sinistra/destra sulla barra per next/prev, tap per aprire la vista Ascolto
- Menu rapido mobile: repeat, shuffle, preferito, escludi

---

## 11. Visualizzatori & Karaoke

- 8 modalità: Bars, Mirror, Wave, Smooth wave, H·M·B waves, Signals, **DiscoWall**, **Karaoke**
- Analisi FFT in tempo reale con mappa logaritmica delle frequenze
- Colori derivati dal tema attivo (accent + text)
- **DiscoWall**: griglia di celle reattive, colori legati alle note del chart Plectr, effetti burst/costellazioni, FPS adattivo, scaling DPR
- **Karaoke**: parsing LRC sincronizzato al millisecondo (riga precedente/corrente/successiva), fallback testo semplice proporzionale al progresso, rendering su canvas con sfondo attenuato
- Pausa dei visualizzatori non essenziali quando Plectr è aperto (opzionale)

---

## 12. Plectr (gioco ritmico)

### Gameplay
- 4 corsie (tasti D / F / J / K), ciascuna con colore dedicato
- Tipi di nota: tap, hold (con durata), swipe direzionali
- Finestre di precisione: Perfect / Good / OK + feedback Early/Late
- Tipi di miss: miss, dropped (hold perso), slide miss, hold miss
- Combo con soglie visive, punteggio, accuracy, voti F → S
- Lane pad interattivi con feedback visivo (pressed / holding / hit / miss)

### Difficoltà
- Easy ("4B Lite"), Normal ("4B Standard"), Hard ("4B Maximum", con accordi a 2 note)
- Scelta salvata in localStorage

### Generazione automatica dei chart
- Analisi audio DSP della traccia: FFT, onset detection, stima BPM (78–176) con autocorrelazione, quantizzazione su griglia beat — **eseguita in un Web Worker** (zero stutter in gioco durante il prefetch del brano successivo; fallback sul main thread se il worker non è disponibile)
- Pattern di corsie dedicati per difficoltà, seed deterministico per brano
- Cache LRU dei chart + prefetch del brano successivo in coda
- Statistiche chart: BPM stimato, energia media, densità note

### Punteggi
- Record di sessione + record persistenti per traccia/difficoltà sincronizzati sull'account (score, grade, accuracy, max combo)
- Confluiscono nelle Statistiche (modalità Plectr) e negli achievement

### Modalità
- Standalone con countdown 3s e lead-in 4s
- Sincronizzata col player live (RhythmDockPanel nel dock), con clock smoothing per sincronia precisa
- Sfondo DiscoWall integrato e karaoke opzionale

---

## 13. Studio / Tools (manutenzione libreria)

### Download da YouTube (yt-dlp)
- URL singolo / playlist / release, con validazione del tipo e avviso se >35 brani
- Ricerca YouTube Music (artisti / album / canzoni) con espansione catalogo release dell'artista
- Catalogo web "Discover": raccomandazioni basate sulla libreria locale, anteprima audio ~30s, tracklist
- Download batch multi-release: selezione con checkbox, doppia barra progresso (album + tracce), riepilogo ok/parziali/falliti
- Log strutturato (stderr yt-dlp filtrato), stop/cancellazione download
- Selezione cartella destinazione con browser filesystem, ricerca percorsi e creazione sottocartelle
- Cookie YouTube caricabili per contenuti autenticati
- Riconciliazione automatica della libreria post-download

### Metadati traccia
- Editor: titolo, data rilascio, generi (chips con suggerimenti dalla libreria), mood (max 3 su 14 preset colorati)
- Testi sincronizzati: fetch automatico (LRC > plain), salvataggio rapido, editor manuale
- Eliminazione traccia (con conferma e cleanup dello stato player)
- Scansione metadati: singola traccia o massiva (con progress, skip già completate, stop)

### Metadati album
- Editor: titolo, data rilascio, etichetta, paese
- Conteggio tracce attese vs presenti (da catalogo)
- Eliminazione cartella album (con conferma)

### Copertine
- Ricerca artwork multi-fonte: iTunes, Deezer, MusicBrainz, TheAudioDB, Cover Art Archive
- Riempimento query dalla traccia in riproduzione
- Applicazione su album target o upload manuale

### Info entità (trivia/bio)
- Ricerca biografie/trivia multilingua (Wikipedia, TheAudioDB) per artista o album selezionati
- Esclusione automatica dei duplicati già salvati
- Modifica del testo candidato, salvataggio batch, rimozione voci

### Catalogo & selezione
- Catalogo locale per account ("My Selection"): add/remove artisti e album
- Dettaglio artista espandibile con elenco album

### Manutenzione
- Sanitizzazione titoli (dry-run o apply, per album o intera libreria)
- Pruning metadati orfani (confronto meta ↔ file fisici)
- Riconciliazione incrementale dell'indice (debounced / immediata / manuale) con delta per traccia/album

---

## 14. Impostazioni

### Account
- Lista account con avatar a iniziale
- Creazione, selezione (cambio sessione), eliminazione (non per il default)
- Sincronizzazione cambio account tra schede (evento finestra)

### Interfaccia e temi
- **Lingua**: Inglese / Italiano (~1300 stringhe ciascuna)
- **Tema**: 18 preset in 5 gruppi
  - Dual color: Midnight, Neon, Prism Engine
  - Dark: Slate, Dark Amethyst, Dark Citrus, Dark Carmine
  - Colorful: Sunset, Aurora, Ember, Forest, Ocean, Rose
  - Light: Slate, Amethyst, Citrus, Carmine
  - Custom
- **Tema custom**: 4 colori (sfondo, sezioni, accent1, accent2); sfondo a colore o immagine (upload JPEG/PNG/WebP/GIF max 8MB; fit: cover / contain / fill / repeat / center); bianco/nero del testo scelto dalla luminosità del colore Sezioni (dallo sfondo quando il vetro è molto trasparente)
- **Stile UI**: Classic (geometrie squadrate) / Modern (raggi morbidi, bottoni a pillola)
- **Superfici vetro**: trasparenze con blur (auto-disattivate se il browser/OS non le supporta) e **opacità regolabile** 0–100% (slider + campo numerico, anteprima live, salvataggio con debounce 500ms; controlli disabilitati a vetro spento)
- **Visualizzatore**: scelta delle 8 modalità + opzione "disattiva sfondo visualizzatore in Plectr"
- **Crossfade audio**: off / 3s / 5s

### Scorciatoie tastiera
- `/` o `Ctrl+K`: ricerca libreria
- `Spazio`: play/pausa
- `I`: vai a Listen
- `P`: apri Plectr

### Libreria
- Percorso root, stato lettura/scrittura, lock da variabile d'ambiente
- Sola lettura da accesso remoto, label personalizzata da server

### Download
- Upload/rimozione file cookies YouTube (.txt), stato file attivo

### Rete e accesso remoto
- Indirizzo LAN stimato
- Login/logout Cloudflare, tunnel pubblico start/stop
- URL pubblico con pulsante copia e **QR code** (scansionabile dal client Android per connettersi al volo; generato in locale con la libreria `qrcode`, nessun servizio esterno)

### Backup, ripristino e condivisione tema
- Backup: zip completo dei dati utente (preferenze, playlist, coda, metadati, stato — incluse tutte le impostazioni tema: preset/custom, stile UI, vetro e opacità)
- **Esporta tema**: zip condivisibile (`rekord-theme-*.zip`) col solo tema corrente — colori, stile UI, vetro+opacità e sfondo immagine — senza alcuna informazione sull'utente
- **Upload backup o tema**: un solo pulsante che riconosce automaticamente l'archivio — un backup ripristina tutto, un export tema applica solo il tema all'account corrente (funziona tra PC, server e utenti diversi); a import riuscito la pagina si ricarica da sola

### Log attività
- Tabella storica delle azioni server (max 500 voci) con refresh

### Info app
- Versione, crediti, note privacy offline-first

---

## 15. Server / Backend (Express)

### Libreria & scansione
- Scansione ricorsiva del filesystem, indice con cache a epoche
- Ricerca full-text, dettaglio artisti/album, risoluzione batch tracce
- Refresh in background, dedup richieste concorrenti (singleflight)
- Selezione libreria per account (include/exclude artisti, album, tracce)

### Streaming
- File audio via `/media/*` (FLAC, M4A, MP3, WebM) con MIME corretti
- Copertine album, stat file per caching client

### Multiutente & stato
- CRUD account
- Stato utente versionato con optimistic locking (CAS): playlist, preferenze, play count, mood, record Plectr, coda
- Patch incrementali (flush 400ms, 3s per la sola coda), endpoint dashboard

### Accesso remoto
- Rilevamento LAN con scoring delle interfacce
- Tunnel Cloudflare quick: login via browser, start/stop, URL pubblico
- Modello permessi: admin solo da localhost/Docker gateway; remoto e tunnel in sola lettura

### YouTube / yt-dlp
- Ricerca e browse via Innertube, listing release in streaming NDJSON
- Anteprima proxy con token (durata limitata ~31s)
- Download con progress real-time, log rotante, kill graceful, riepilogo downloaded/skipped/failed
- Allowlist anti-SSRF (youtube.com, music.youtube.com, soundcloud.com, bandcamp.com)
- Discover con cache TTL 8 minuti

### Metadati
- Aggregazione iTunes / Last.fm / MusicBrainz / LrcLib / Wikipedia / TheAudioDB
- Persistenza locale per album (kord-albuminfo.json, kord-trackinfo.json)
- Ricerca e applicazione artwork (download da URL o upload max 15MB)
- Sanitizzazione titoli, normalizzazione generi, mood per traccia

### Backup & manutenzione
- Zip completo con manifest, restore atomico con invalidazione cache
- Export/import tema: `GET /api/backup/theme-export` (zip `rekord-theme/`), import auto-riconosciuto dall'endpoint di restore (solo settings tema, nessun dato utente)
- Migrazione schema v2 → v3 (idempotente)
- Activity log JSONL append-only
- Pulizie filesystem: clear destinazione download, eliminazione batch tracce, eliminazione cartelle album

### Sicurezza & robustezza
- Path safety (anti-traversal), CORS rigoroso, limiti upload per tipo
- Cache headers differenziati, error handling standardizzato
- Startup token per Electron, TCP_NODELAY per gli stream

---

## 16. Piattaforme & Deployment

### Web / PWA
- Installabile, lock orientamento portrait su telefono con overlay di avviso rotazione
- Safe-area insets, fallback CSS per device senza Screen Orientation API

### Electron (desktop)
- Server embedded come child process, porta dinamica con health-check (timeout 30s)
- Effetto vetro nativo, tray, context isolation
- Packaging win / linux / mac, varianti client o server (`pack-release`)

### Docker
- Immagine multi-stage con yt-dlp e cloudflared inclusi
- Volumi `/music` e `/config`, env MUSIC_ROOT (lock), healthcheck, utente non-root
- docker-compose con variabili REKORD_PORT, REKORD_MUSIC_HOST, REKORD_CONFIG_HOST

### Android (client APK, Capacitor)
- Shell di connessione identica al client desktop (stessa pagina di `connect.html`): IP locale/URL pubblico, lingua EN/IT, scelta account — in più **scan QR** (plugin nativo `@capacitor/barcode-scanner`) che autocompila e connette
- Riconnessione automatica all'avvio al server salvato; **tasto Indietro = navigazione di pagina** (history del routing SPA via `@capacitor/app`), alla radice torna alla shell
- **Widget di ascolto nativo**: MediaSession Android via plugin `@jofr/capacitor-media-session` (notifica media, lock screen, tasti cuffie/auto, seek) — `src/lib/mediaSession.ts` usa il bridge nativo nel client e l'API web in Chrome/PWA
- **Blocco rotazione portrait** a livello manifest (parità con la PWA installata)
- L'app viene caricata **direttamente dal server** (`?rekordAccount=…&rekordClient=1`): si aggiorna a ogni rebuild del server senza ricompilare l'APK
- Build/pacchetto: `npm run pack:android:client -- <versione>` → `release/RE-KORD-Client-<versione>-android.apk` (JDK 21 auto-provisioned, minSdk 26)

---

## 17. Funzionalità trasversali

- i18n completo EN/IT con interpolazione variabili, ordinamenti locale-aware
- Accessibilità: ARIA label/live, navigazione tastiera, focus management nelle modali, reduced-motion rispettato
- Splash loader con 15 tip rotanti (ogni 4s), skeleton/shimmer, stati vuoti/errore/busy ovunque
- Dialoghi di conferma centralizzati (varianti default / danger / warning, code sequenziali)
- Liste virtuali (TanStack Virtual) per le performance su librerie grandi
- Snackbar di stato sync con durata minima di visibilità
- Copertine con fallback istantaneo a iniziali quando l'immagine non esiste (cache di sessione dei mancanti, retry anti-rete-flaky in background con ripristino automatico dell'immagine)
