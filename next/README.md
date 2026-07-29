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
- Per Android: Android SDK + `tauri android init` (vedi `scripts/android-init.sh`)

## Avvio rapido (dev)

```bash
cd next
pnpm install

# Terminale 1 — server API
cargo run -p rekord-server

# Terminale 2 — admin UI (opzionale)
pnpm dev:server-ui

# Terminale 3 — client UI nel browser
pnpm dev:client-ui
# oppure shell Tauri:
pnpm --filter @rekord/client-shell tauri dev
```

Default hub: `http://127.0.0.1:7420` (bind `0.0.0.0:7420` → raggiungibile in LAN).  
Per solo localhost: `REKORD_BIND=127.0.0.1:7420`.

1. Apri il client su `http://127.0.0.1:7420/` (UI servita dal hub se `apps/client-ui/dist` è presente) oppure Vite (`pnpm dev:client-ui`)
2. Imposta libreria via Settings / admin UI (`:7421`) o `PUT /api/v1/library/path`
3. Avvia scan e ascolta
4. Accesso remoto: Settings → Rete (LAN URL / Cloudflare tunnel) — apri l’URL dal telefono; API e UI sullo stesso origin

## Build

```bash
pnpm build:ui
pnpm build:server
pnpm pack:linux        # server + client linux artifacts in release/
# Windows (cross o su host Windows):
pnpm pack:windows
```

## Moduli opzionali

Vedi [docs/MODULES.md](docs/MODULES.md). Tutti disabilitati nell’MVP.

## API

Vedi [docs/API.md](docs/API.md).
