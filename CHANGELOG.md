# RE-KORD 5.0

## Highlights

- Rete di sicurezza: CI GitHub Actions, lint/typecheck server, test integrazione API, E2E Playwright
- Refactor strutturali: Player, Studio, UserState, API client, LibraryView, SettingsView
- Robustezza runtime: shutdown graceful, job queue, sync user-state con revision, provider adapter
- Osservabilità: logging Pino, endpoint `/api/diagnostics`, pannello in Impostazioni
- Naming unificato REKORD con migrazione storage legacy KORD/WPP
- PWA offline per shell/asset, stati UI coerenti, virtualizzazione liste
- Packaging: versione sincronizzata, `.desktop` Linux, guida upgrade

## Stabilizzazione (5.0.0)

Bugfix e hardening senza bump di versione:

- Fix lint CI (`UserStateContext` destructuring settings patch)
- Hardening sync user-state: hook deps, test race coda/playlist vs sync server vecchio
- Fix hook deps `themeManager` per autocolor/GIF su cambio settings
- Split `useStudioPanels` in hook modulari (catalog, download, enrichment)
- Script mobile QA in `scripts/optional/mobile-qa/` (opt-in, fuori CI)
- Vite dev: ignore watch su `android/build`, `dist`, `release`

## Upgrade from 4.4

See [docs/UPGRADE-5.0.md](docs/UPGRADE-5.0.md).
