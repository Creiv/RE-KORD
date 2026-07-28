# Optional modules

RE-KORD core ships without optional modules. Stubs live under `modules/`.

## Manifest

`modules.manifest.toml` (copied to the data dir on first server start):

```toml
[modules]
plectr = false
web-share = false
nebula = false
studio = false
themes = false
```

## Rules

1. Do not implement a module without explicit product confirmation.
2. Enabling a flag alone does not load code until the module crate/UI is wired.
3. Modules must not be required for player / library / favorites / playlists.

## Status (MVP)

All modules are **stubs** (`enabled: false`).
