# Omnix Desktop (Tauri) — lightweight Windows companion

Web dashboard remains first-class. The Windows app adds:

- Same JWT login + full panel features (create live, destinations, chat)
- Always-on-top **chat overlay** while gaming (low RAM via Tauri + system WebView)

## Dev prerequisites

- [Rust](https://rustup.rs/) + MSVC build tools
- Node 22+
- [Tauri CLI](https://v2.tauri.app/start/prerequisites/)

```bash
cd desktop
npm install
npm run tauri dev
```

Set the relay URL when prompted (e.g. `http://mumbai.war67.online:8890`) or via env `OMNIX_RELAY_URL`.

## Build `.exe`

```bash
cd desktop
npm run tauri build
```

Artifacts under `desktop/src-tauri/target/release/bundle/`.

## Mobile

Use `/chat.html` PWA — read chat / reply only. No native Android encoder in this phase.
