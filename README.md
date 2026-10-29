# Omnix StreamRelay

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-MohFarzin%2FOmnix--StreamRelay-181717?logo=github)](https://github.com/MohFarzin/Omnix-StreamRelay)

Self-hosted multistream relay for creators. Point OBS (or Aitum) at **your** server once; the server fans the same feed out to Twitch, YouTube, Kick, or any custom RTMP destination.

- Browser dashboard (no desktop app)
- Passthrough by default (`ffmpeg -c copy`) — light on CPU and RAM
- Dual ingest: 16:9 main + 9:16 vertical ([Aitum setup guide](docs/VERTICAL-AITUM.md))
- Optional multi-platform chat bot
- SQLite only (no external database)
- First-class [Pterodactyl](https://pterodactyl.io/) / Jexactyl egg

**Repository:** https://github.com/MohFarzin/Omnix-StreamRelay  
**Contact:** admin@omnixstudio.xyz

---

## How it works

```
OBS / Aitum ──RTMP/SRT──► your VPS (MediaMTX)
                              │
                              ├─► Twitch
                              ├─► YouTube (16:9 and/or 9:16)
                              ├─► Kick
                              └─► custom RTMP
```

You manage destinations and chat from the web UI. Stream keys are encrypted at rest.

---

## Quick start (Pterodactyl / Jexactyl)

This is the easiest path for panel hosts.

### 1. Import the egg

1. Panel → **Nests** → create or open nest **OmnixStudio** (or any nest you prefer).
2. **Import egg** → upload  
   [`pterodactyl/egg-omnix-streamrelay.json`](pterodactyl/egg-omnix-streamrelay.json)
3. Save.

The egg image is published automatically from this repo:

`ghcr.io/mohfarzin/omnix-streamrelay:latest`

Wings pulls it when the server starts. You do **not** need to upload source files by hand.

> **First-time GitHub setup (repo owner):** after you push this project, open the Actions tab and confirm the **Docker image** workflow succeeded. In **Packages**, set `omnix-streamrelay` to **Public** so Wings can pull without a token.

### 2. Create a server

1. **Admin → Servers → Create**
2. Egg: **Omnix StreamRelay**
3. Allocations (host port = container port):

| Allocation | Purpose | Egg variable |
|------------|---------|--------------|
| Primary TCP | Dashboard | used as `SERVER_PORT` |
| Extra TCP | OBS RTMP | set `RTMP_PORT` to this port |
| Extra (UDP if possible) | SRT | set `SRT_PORT` to this port |

4. Startup variables (minimum):

| Variable | What to put |
|----------|-------------|
| `PUBLIC_HOST` | Your public DNS or IP (e.g. `stream.example.com`) |
| `RTMP_PORT` | Same number as your RTMP allocation |
| `SRT_PORT` | Same number as your SRT allocation |
| Secrets (`BOOTSTRAP_TOKEN`, keys, …) | Leave **`auto`** |

5. Create → wait for install → **Start**.

### 3. Log in

1. Open `http://PUBLIC_HOST:PRIMARY_PORT/`
2. Read the bootstrap token from the console or `FIRST_LOGIN.txt` on the volume
3. Paste it into the dashboard login

### 4. Connect OBS

**Main (16:9)**

| Field | Value |
|-------|--------|
| Service | Custom |
| Server | `rtmp://PUBLIC_HOST:RTMP_PORT/live` |
| Stream key | `mystream` (or your `STREAM_KEY`) |
| Authentication | Off |

**Vertical (9:16)** — optional  

Use [Aitum Vertical](https://obsproject.com/forum/resources/aitum-vertical.1715/) + [Aitum Multistream](https://obsproject.com/forum/resources/aitum-multistream.1991/) (or a second OBS). Same server URL, stream key `mystream_v`.

→ Full walkthrough: **[Vertical / Aitum guide](docs/VERTICAL-AITUM.md)**

**Recommended encode settings for Twitch / Kick:** CBR, keyframe interval **2**, Kick bitrate ≤ 8000 kbps.

### 5. Add destinations

In the dashboard:

1. Add Twitch / YouTube / Kick / Custom
2. Choose feed **main** or **vertical**
3. Paste each platform’s server URL + stream key
4. Turn **On**

Leave destinations On. Stop/start OBS when you go live again — the relay reconnects for you.

**Kick:** paste the Server URL from *your* Kick Creator dashboard (it is per-account).

---

## Docker Compose (no panel)

```bash
git clone https://github.com/MohFarzin/Omnix-StreamRelay.git
cd Omnix-StreamRelay
cp .env.example .env
# edit DOMAIN, ACME_EMAIL, and secrets (openssl rand -hex 32)
docker compose up -d --build
```

Point DNS at the VPS before first start if you use Caddy + HTTPS.

---

## Optional chat bot

Video works without chat. To enable chat, set these on the egg (or in `.env`) and restart:

| Platform | Variables |
|----------|-----------|
| Twitch | `TWITCH_CHANNEL`, `TWITCH_ACCESS_TOKEN` |
| YouTube | `YOUTUBE_LIVE_CHAT_ID` + API key or OAuth token |
| Kick | `KICK_CHANNEL` (+ `KICK_ACCESS_TOKEN` to reply) |

---

## Updating

**Panel:** recreate/reinstall the server or pull the new image on Wings, then restart. Image tags update when this GitHub repo builds successfully.

**Compose:**

```bash
git pull
docker compose up -d --build
```

---

## Docs

| Guide | Topic |
|-------|--------|
| [Vertical / Aitum](docs/VERTICAL-AITUM.md) | 9:16 feed, Aitum plugins, second OBS option |
| [YouTube Live manager](docs/YOUTUBE-LIVE.md) | Google OAuth, create broadcast + key into relay |
| [Mobile chat (PWA)](docs/MOBILE-CHAT.md) | Phone/tablet chat companion |

## Project layout

```
bot-backend/     API, FFmpeg manager, chat, SQLite
client-ui/       Browser dashboard
pterodactyl/     Egg JSON, Dockerfile, start scripts
docs/            Extra guides (vertical / Aitum, …)
relay/           Compose MediaMTX helpers
.github/         CI — builds and pushes the container image
```

---

## Development

```bash
cd bot-backend
npm install
npm test
npm run dev
```

Needs a reachable MediaMTX (or a full container) and the same env vars as production.

---

## Security notes

- Never commit `.env`, stream keys, or panel API tokens
- Destination keys are encrypted (AES-GCM); the API only returns masked keys
- Login is rate-limited; bootstrap compare is timing-safe
- One operator per server — give friends their own instance

---

## License

This project is licensed under the [MIT License](LICENSE).

Copyright © 2026 OmnixStudio / MohFarzin  
Contact: admin@omnixstudio.xyz
