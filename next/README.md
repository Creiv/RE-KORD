# RE-KORD

Nuova implementazione modulare (staging in `next/`). Stesso nome prodotto; sostituirà l’app attuale quando pronta.

## Architettura

| App | Ruolo |
|-----|--------|
| **rekord-server** | Backend API + SQLite + scan + stream media + SPA client (stesso origin) |
| **client-ui** | Frontend completo (player, libreria, preferiti, playlist) via API |
| **client-shell** | Shell Tauri 2 che carica `client-ui` locale |
| **@rekord/ui** | Componenti grafici condivisi (Button, Panel, Field, …) |

In produzione / accesso remoto il hub serve `client-ui` su `/` (same-origin con `/api/v1` e `/media`), come il server legacy. In dev puoi ancora usare Vite su `:7422` con proxy.

### UI components

Tutti gli elementi grafici passano da componenti in `packages/ui` (condivisi) o da componenti di app in `apps/*/src/components`. Le view restano sottili e orchestrano solo layout + stato.

## Requisiti

- Rust 1.80+
- Node 20+ / pnpm 9+
- Per il client desktop: dipendenze Tauri 2 ([docs](https://v2.tauri.app/start/prerequisites/))
- Per Android: Android SDK + NDK e JDK 17+ (vedi [docs/ANDROID.md](docs/ANDROID.md))

## Avvio rapido (dev)

```bash
cd next
pnpm install

# Terminale 1 — server API
cargo run -p rekord-server

# Terminale 2 — pannello hub (opzionale in dev: http://127.0.0.1:7421/admin/)
pnpm dev:server-ui

# Terminale 3 — client UI nel browser
pnpm dev:client-ui
# oppure shell Tauri:
pnpm --filter @rekord/client-shell tauri dev
```

Default hub: `http://127.0.0.1:7420` (bind `0.0.0.0:7420` → raggiungibile in LAN).  
Per solo localhost: `REKORD_BIND=127.0.0.1:7420`.

1. Apri il client su `http://127.0.0.1:7420/` (UI servita dal hub se `apps/client-ui/dist` è presente) oppure Vite (`pnpm dev:client-ui`)
2. Il pannello hub è su `http://127.0.0.1:7420/admin`: cartella musica, struttura libreria, scansioni, job, diagnostica, log, backup, account, integrazioni e rete
3. Imposta la libreria dal pannello hub (o `PUT /api/v1/library/path`), avvia lo scan e ascolta
4. Accesso remoto: pannello hub → Rete (URL in LAN / tunnel Cloudflare) — apri l’URL dal telefono; API e UI sullo stesso origin
5. Le operazioni che toccano la macchina (cartella musica, scansioni, credenziali, ripristini, tunnel) richiedono l’account Default e una richiesta locale; per abilitarle da remoto usa l’interruttore in Rete → Operazioni di macchina

## Build

```bash
pnpm build:ui
pnpm build:server
pnpm pack:linux        # server + client linux artifacts in release/
# Windows (cross o su host Windows):
pnpm pack:windows
# Android: APK debug su arm64, pronto da installare
pnpm android:build --install
```

Il progetto Android nativo è versionato in `apps/client-shell/src-tauri/gen/android`:
dettagli e firma di release in [docs/ANDROID.md](docs/ANDROID.md).

## Moduli opzionali

Vedi [docs/MODULES.md](docs/MODULES.md). Tutti disabilitati nell’MVP.

## API

Vedi [docs/API.md](docs/API.md).
