# QA mobile RE-KORD (ADB + CDP)

Test funzionali e benchmark prestazioni su dispositivo Android reale.

## Prerequisiti

- Device Android con USB debugging
- `adb` nel PATH
- Server RE-KORD raggiungibile in LAN
- APK debug installato (`app.rekord.client`)

## Setup rapido

```bash
# Terminal 1 — server LAN
npm run dev:server

# Terminal 2 — build e install (se necessario)
npm run pack:android:client
adb install -r release/RE-KORD-Client-5.0.0-android.apk

# Sul telefono: connetti all'IP del PC (es. http://192.168.1.x:3001)
# Avvia l'app e apri la libreria
```

## Script disponibili

| Comando | Descrizione |
|---------|-------------|
| `npm run qa:mobile` | Matrice completa: core, secondarie, player |
| `npm run qa:mobile:studio` | Solo scenari Studio (5 tab × 2 ingressi) |
| `npm run qa:mobile:perf` | Solo benchmark CPU/PSS |

Variabili ambiente:

- `ADB_DEVICE` — serial device (auto-detect se omesso)
- `CDP_PORT` — porta forward CDP (default 9222)
- `PERF_SEC` — secondi campionamento perf (default 20)

## CDP WebView

L'APK debug abilita `WebView.setWebContentsDebuggingEnabled`. Dopo ogni restart app il PID cambia; lo script rifà automaticamente:

```bash
adb forward tcp:9222 localabstract:webview_devtools_remote_<PID>
```

Verifica manuale: `chrome://inspect` → Remote Target.

## Report

Output JSON in `test-results/mobile-qa-<timestamp>/report.json` con:

- `results[]` — pass/fail per scenario
- `benchmark[]` — CPU/PSS e violazioni soglie
- `capture` — pageerror e console error

Screenshot on failure nella stessa cartella.

## Soglie prestazioni (default)

Su Android multi-core, `top` riporta CPU come **somma dei core** (`cpuRaw`, può superare 100%). Lo script normalizza in **% device** (`cpuDevicePct = cpuRaw / coreCount`, scala 0–100) e usa questa metrica per soglie e violazioni.

Core count: `adb shell nproc` (fallback `/proc/cpuinfo`).

Con `alwaysPlay` attivo, valori calibrati su Xiaomi afaa4085 con playback nativo.

| Scenario | CPU device avg max | PSS max |
|----------|-------------------|---------|
| idle_dashboard | 15% | 260 MB |
| library_artists | 15% | 260 MB |
| nebula_play | 35% | 260 MB |
| studio_catalog | 18% | 260 MB |
| studio_listen | 40% | 270 MB |
| background_play | 8% | 205 MB |

Il benchmark attende 5 s dopo ogni navigazione prima del campionamento CPU (settle time).

## Playback su Android

L'app client Android riproduce via `RekordMediaNative` (l'elemento `<audio>` HTML resta in pausa). `syncMediaSessionState` imposta `document.documentElement.dataset.rekordNativePlaying` (`"1"` / `"0"`).

Gli script QA verificano playback con segnali combinati:

1. `dataset.rekordNativePlaying === "1"`
2. `navigator.mediaSession.playbackState === "playing"`
3. Pulsante Pausa visibile nel player dock (`aria-label` Pause/Pausa)
4. `<audio>` HTML non in pausa (browser/desktop)
5. Tempo di riproduzione nel dock avanzato oltre `0:00` (solo come fallback debole)

`ensurePlayback()` prova prima il play del dock (`.player-dock2`), poi Play generici e Play all.

## Troubleshooting

- **Nessuna pagina CDP**: app non in foreground o APK non debug
- **Studio vuoto**: verificare `localStorage rekord-studio-pane`; default mobile è `catalog`
- **ENOBUFS su top**: usare campionamenti brevi (già gestito nello script)
