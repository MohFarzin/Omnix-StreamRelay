# Omnix StreamRelay

[![License: MIT](https://img.shields.io/badge/License-MIT-0B3D91.svg)](LICENSE)
[![Image](https://img.shields.io/badge/ghcr.io-omnix--streamrelay-111111?logo=github)](https://github.com/MohFarzin/Omnix-StreamRelay/pkgs/container/omnix-streamrelay)
[![Repo](https://img.shields.io/badge/GitHub-Omnix--StreamRelay-181717?logo=github)](https://github.com/MohFarzin/Omnix-StreamRelay)

Self-hosted multistream relay by **OmnixStudio**. Publish from OBS once; the node fans the feed to Twitch, YouTube, Kick, or any RTMP endpoint you configure.

| | |
|---|---|
| Dashboard | Browser panel (JWT login) |
| Relay | MediaMTX ingest + FFmpeg egress |
| Storage | SQLite · destination keys AES-GCM |
| Deploy | Pterodactyl / Jexactyl egg · Docker Compose |
| Contact | [admin@omnixstudio.xyz](mailto:admin@omnixstudio.xyz) |

```
OBS / Aitum  ──RTMP / SRT──►  your node (MediaMTX)
                                   │
                                   ├─ Twitch
                                   ├─ YouTube  (16:9 · 9:16)
                                   ├─ Kick
                                   └─ custom RTMP
```

---

## Setup

### Panel (Pterodactyl / Jexactyl)

1. **Import egg** — Nest → Import → [`pterodactyl/egg-omnix-streamrelay.json`](pterodactyl/egg-omnix-streamrelay.json)  
   Image: `ghcr.io/mohfarzin/omnix-streamrelay:latest` (built by GitHub Actions; Wings pulls it).
2. **Create server** — allocate three ports and match them in egg vars:

| Role | Protocol | Egg variable |
|------|----------|--------------|
| Dashboard | TCP (primary) | `SERVER_PORT` |
| OBS RTMP | TCP | `RTMP_PORT` |
| SRT | UDP preferred | `SRT_PORT` |

3. Set `PUBLIC_HOST` to your DNS or IP. Leave secrets as `auto`.
4. **Start** → open `http://PUBLIC_HOST:PRIMARY_PORT/` → login with the token from the console or `FIRST_LOGIN.txt`.

### OBS

| | Main (16:9) | Vertical (9:16) |
|---|-------------|-----------------|
| Service | Custom | Custom |
| Server | `rtmp://PUBLIC_HOST:RTMP_PORT/live` | same |
| Stream key | `mystream` | `mystream_v` |
| Auth | Off | Off |

Use CBR and a **2 s** keyframe interval for Twitch / Kick. Keep Kick at **≤ 8000 kbps**. Vertical feed: [Aitum guide](docs/VERTICAL-AITUM.md).

### Destinations

In the panel: **Connect** Google / Twitch / Kick, then create or paste destinations. Leave toggles **On** — when OBS stops and starts again, enabled destinations recycle on their own.

Kick needs its **per-account** Server URL from the Kick dashboard (do not reuse another account’s ingest host).

### Compose (no panel)

```bash
git clone https://github.com/MohFarzin/Omnix-StreamRelay.git
cd Omnix-StreamRelay
cp .env.example .env   # DOMAIN, ACME_EMAIL, openssl rand -hex 32 for secrets
docker compose up -d --build
```

Point DNS at the host before first start if you use Caddy HTTPS.

### Chat (optional)

Video works with empty chat vars. After changing chat env, restart the panel.

| Platform | Variables |
|----------|-----------|
| Twitch | `TWITCH_CHANNEL`, `TWITCH_ACCESS_TOKEN` |
| YouTube | `YOUTUBE_LIVE_CHAT_ID` + API key or OAuth |
| Kick | `KICK_CHANNEL` (+ `KICK_ACCESS_TOKEN` to reply) |

### Update

- **Panel:** new image on Wings → restart (or reinstall).
- **Compose:** `git pull && docker compose up -d --build`

---

## Reference

### Behaviour

- Default egress is **passthrough** (`ffmpeg -c copy`). Optional CFR normalize for Kick / Twitch via `KICK_TRANSCODE` / `TWITCH_TRANSCODE` when ingest is VFR or over Kick’s bitrate cap.
- Dual ingest lanes: `live/{STREAM_KEY}` (main) and `live/{STREAM_KEY_VERTICAL}` (vertical). Destinations carry a `main` | `vertical` lane.
- One operator per egg. Friends get their own node — never share bootstrap tokens or stream keys across instances.
- Platform Connect stores tokens on **your** volume only. OmnixStudio does not keep streamer OAuth tokens on the marketing site. Optional outbound pairing: [Omnix Link](https://github.com/MohFarzin/Omnix-Link) (`https://relaylink.omnixstudio.xyz`).

### Ports & volume overrides

Primary allocation drives the dashboard. Match `RTMP_PORT` / `SRT_PORT` to Wings allocations (host port = container port). Optional overrides on the volume: `data/ports.env`, `data/public_host`.

### Security

- Timing-safe bootstrap compare · login rate limit · body size cap · CSP  
- Destination keys encrypted at rest; API/UI return masked values  
- Do not commit `.env`, panel API keys, or SSH material  

### Repository

```
bot-backend/     API, relay manager, chat, SQLite
client-ui/       Dashboard & mobile chat UI
pterodactyl/     Egg, Dockerfile, entrypoint
docs/            Platform & companion guides
desktop/         Optional Tauri companion
relay/           Compose MediaMTX helpers
.github/         Image build & publish
```

### Development

```bash
cd bot-backend
npm install
npm test
npm run dev
```

Requires MediaMTX (or the full container) and the same environment as production.

### Guides

| Document | Topic |
|----------|--------|
| [Vertical / Aitum](docs/VERTICAL-AITUM.md) | 9:16 second publish path |
| [Connect platforms](docs/CONNECT-PLATFORMS.md) | YouTube · Twitch · Kick Connect |
| [YouTube Live](docs/YOUTUBE-LIVE.md) | Live manager · create / bind |
| [Privacy: Connect](docs/PRIVACY-CONNECT.md) | Where tokens live |
| [Mobile chat](docs/MOBILE-CHAT.md) | PWA companion |
| [Desktop](docs/DESKTOP.md) | Windows app · overlay |
| [Omnix Link](https://github.com/MohFarzin/Omnix-Link) | Outbound pairing · encrypted token jobs |
| [OAuth broker](docs/OAUTH-BROKER.md) | Legacy ticket helper (prefer Link) |

---

## License

[MIT](LICENSE) · © 2026 OmnixStudio / MohFarzin · [admin@omnixstudio.xyz](mailto:admin@omnixstudio.xyz)
