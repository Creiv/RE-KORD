# RE-KORD 5.0

## Highlights

- Rete di sicurezza: CI GitHub Actions, lint/typecheck server, test integrazione API, E2E Playwright
- Refactor strutturali: Player, Studio, UserState, API client, LibraryView, SettingsView
- Robustezza runtime: shutdown graceful, job queue, sync user-state con revision, provider adapter
- Osservabilità: logging Pino, endpoint `/api/diagnostics`, pannello in Impostazioni
- Naming unificato REKORD con migrazione storage legacy KORD/WPP
- PWA offline per shell/asset, stati UI coerenti, virtualizzazione liste
- Packaging: versione sincronizzata, `.desktop` Linux, guida upgrade

## Upgrade from 4.4

See [docs/UPGRADE-5.0.md](docs/UPGRADE-5.0.md).
