# Omnix StreamRelay

Send **one** OBS (or Aitum) feed to your own server. The server copies that feed out to Twitch, YouTube, Kick, or any RTMP destination — and optionally runs a small multi-chat bot.

No desktop app. Control is a browser dashboard. No external database (SQLite on disk). Default path is **pasststhrough** (`ffmpeg -c copy`), so a small VPS can push several destinations without melting the CPU.

Built for [OmnixStudio](https://github.com/) / self-hosted panels (Pterodactyl / Jexactyl) and plain Docker Compose.

---

## What you get

| Piece | Role |
|--------|------|
| **MediaMTX** | Ingest from OBS (RTMP / SRT) |
| **Bot (Node)** | Dashboard API, JWT login, starts/stops FFmpeg per destination |
| **FFmpeg** | Remux to each platform (`-c copy`; optional Kick re-encode via env) |
| **SQLite** | Encrypted destination keys, commands, welcome state |
| **Browser UI** | Dark dashboard: destinations, live chat, toggles |

**Dual feed:** main 16:9 and vertical 9:16 on the same host with two stream keys (e.g. `mystream` + `mystream_v`). Composition stays in OBS/Aitum; the relay only fans out.

---

## Requirements

- Linux host or Pterodactyl Wings node
- Docker (for the egg / compose image)
- Ports for dashboard HTTP, RTMP, and SRT (exact numbers are adaptive — see below)
- OBS (and Aitum if you use vertical)

---

## Deploy

### A) Pterodactyl / Jexactyl (recommended)

1. Import [`pterodactyl/egg-omnix-streamrelay.json`](pterodactyl/egg-omnix-streamrelay.json).
2. On **each** Wings node, from this repo:

```bash
sudo docker build -t omnix-streamrelay:latest -f pterodactyl/Dockerfile .
```

The egg uses `~omnix-streamrelay:latest` (local image). If that tag is missing, install/start can sit on “Installing…” forever.

3. Allocate ports (host port = container port):

| Role | Egg / env | Typical |
|------|-----------|---------|
| Dashboard | primary → `SERVER_PORT` | any free TCP |
| OBS RTMP | `RTMP_PORT` | `1935` or whatever Wings gave you |
| SRT | `SRT_PORT` | `8890` or panel UDP alloc |

4. Set `PUBLIC_HOST` to your public DNS. Leave secrets as `auto` on first start, then open `FIRST_LOGIN.txt` / console for the bootstrap token.
5. Start the server → open `http://PUBLIC_HOST:DASHBOARD_PORT/`.

More detail: [`pterodactyl/README.md`](pterodactyl/README.md).

### B) Docker Compose (bare VPS)

```bash
git clone https://github.com/YOUR_ORG/Omnix-StreamRelay.git
cd Omnix-StreamRelay
cp .env.example .env
# fill DOMAIN, ACME_EMAIL, and all secrets
docker compose up -d --build
```

Point DNS at the VPS before first start if you use Caddy + Let’s Encrypt.

---

## OBS setup

**Main (16:9)**

- Service: Custom  
- Server: `rtmp://YOUR_HOST:RTMP_PORT/live`  
- Stream key: `mystream` (or your `STREAM_KEY`)  
- Auth: **off** (path is the secret)

**Vertical / Aitum (9:16)**

- Same server URL  
- Stream key: `mystream_v` (or `STREAM_KEY_VERTICAL`)

**Output tips (Twitch / Kick)**

- Rate control: **CBR**  
- Keyframe interval: **2**  
- Bitrate: keep Kick ≤ ~8000 kbps  

Leave destination toggles **On** in the dashboard. Stop/start OBS as needed — the relay should reconnect without toggling each destination every time.

---

## Dashboard

1. Log in with the bootstrap token (exchanged for JWT).
2. Add destinations: name, feed (main / vertical), server URL, stream key.
3. Turn each destination **On**.
4. Optional: chat commands + welcome message (needs chat env vars — see below).

| Platform | Server URL | Stream key |
|----------|------------|------------|
| Twitch | `rtmp://live.twitch.tv/app` | Twitch key |
| YouTube | `rtmp://a.rtmp.youtube.com/live2` | YouTube key (reusable key is fine) |
| Kick | **Paste from Kick Creator** (per-account host) | Kick key |
| Custom | Your RTMP base | Your key |

Kick’s ingest host is **per account** — don’t hardcode someone else’s URL. Twitch/Kick keys are normally long-lived; YouTube only needs a new key if you reset it or ended that stream setup in Studio.

---

## Chat bot (optional)

Video relay works with chat empty. To enable chat, set egg / `.env` vars and **restart**:

- Twitch: `TWITCH_CHANNEL`, `TWITCH_ACCESS_TOKEN`
- YouTube: `YOUTUBE_LIVE_CHAT_ID` + API key or OAuth token
- Kick: `KICK_CHANNEL` (+ `KICK_ACCESS_TOKEN` to reply)

---

## Environment (compose)

See [`.env.example`](.env.example). Minimum ideas:

| Variable | Purpose |
|----------|---------|
| `MASTER_KEY` | AES-GCM for destination keys in SQLite |
| `BOOTSTRAP_TOKEN` | First dashboard login |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Session tokens |
| `STREAM_KEY` / `STREAM_KEY_VERTICAL` | Ingest path segments |
| `RTMP_PORT` / `SRT_PORT` / `PUBLIC_HOST` | Adaptive ports / URLs |
| `KICK_TRANSCODE=1` | Optional: re-encode Kick ≤ 8 Mbps (default is copy) |

Generate secrets with `openssl rand -hex 32`.

---

## Repo layout

```
bot-backend/     Node API, FFmpeg manager, chat, SQLite
client-ui/       Dashboard (static; served by the bot)
pterodactyl/     Dockerfile, egg JSON, MediaMTX template, start.sh
relay/           Compose MediaMTX bits
docker-compose.yml
Caddyfile        TLS for compose installs
```

---

## Local bot development

```bash
cd bot-backend
npm install
npm run dev
```

You still need MediaMTX (or a full container) reachable with matching env.

```bash
npm test
```

---

## Security

- Do **not** commit `.env`, `ops/`, SQLite files, or stream keys.
- Destination keys are encrypted at rest; API/UI only show masked keys.
- Login is rate-limited; bootstrap compare is timing-safe; API has CSP + body size limits.
- One operator per server instance — don’t share a single egg login across people; give friends their own node.

---

## License / contributing

This project is intended for public use. If you fork it:

1. Change default secrets and tokens.
2. Build the Docker image on every Wings node you use.
3. Never paste live stream keys into issues or chat logs.

PRs that keep the copy-first relay path and avoid heavy VPS transcoding are preferred.

---

## Name

**Omnix StreamRelay** — product line under OmnixStudio. Workspace folder: `Omnix-StreamRelay`.
