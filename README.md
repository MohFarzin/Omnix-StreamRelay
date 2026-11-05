# Omnix StreamRelay

**Point OBS at your own server once.** StreamRelay ingests that feed and fans it out to Twitch, YouTube, Kick, and any custom RTMP URL you add — while you keep full control of keys, toggles, and Live Manager from a browser dashboard.

| | |
|---|---|
| **Product** | Omnix StreamRelay · OmnixStudio |
| **Deploy** | Pterodactyl / Jexactyl egg · Docker Compose |
| **Image** | [`ghcr.io/mohfarzin/omnix-streamrelay:latest`](https://github.com/MohFarzin/Omnix-StreamRelay/pkgs/container/omnix-streamrelay) |
| **Companion** | [Omnix Link](https://relaylink.omnixstudio.xyz) · [github.com/MohFarzin/Omnix-Link](https://github.com/MohFarzin/Omnix-Link) |
| **License** | [MIT](LICENSE) |
| **Contact** | [admin@omnixstudio.xyz](mailto:admin@omnixstudio.xyz) |

```
  OBS / Aitum
       │  RTMP or SRT
       ▼
┌──────────────────────────────┐
│     Your StreamRelay node    │
│  MediaMTX · FFmpeg · bot     │
│  SQLite · browser dashboard  │
└──────────────┬───────────────┘
               │
     ┌─────────┼─────────┬──────────┐
     ▼         ▼         ▼          ▼
  Twitch   YouTube    Kick     Custom RTMP
           (main +            (any URL)
            vertical*)
```

\*Vertical YouTube needs a Studio Encoder key — see [YouTube vertical](#youtube-vertical--dual-encoder).

---

## Table of contents

1. [What this is](#what-this-is)
2. [How it works](#how-it-works)
3. [Features](#features)
4. [Try it — panel egg](#try-it--panel-egg)
5. [OBS and Aitum](#obs-and-aitum)
6. [Destinations and Live Manager](#destinations-and-live-manager)
7. [YouTube vertical / Dual Encoder](#youtube-vertical--dual-encoder)
8. [Platform notes](#platform-notes)
9. [Omnix Link](#omnix-link)
10. [Chat (optional)](#chat-optional)
11. [Mobile chat and desktop companion](#mobile-chat-and-desktop-companion)
12. [Docker Compose](#docker-compose)
13. [Egg variables](#egg-variables)
14. [Encoding and transcode](#encoding-and-transcode)
15. [Security and privacy](#security-and-privacy)
16. [Container image and CI](#container-image-and-ci)
17. [Repository layout](#repository-layout)
18. [Documentation](#documentation)
19. [Support and license](#support-and-license)

---

## What this is

Omnix StreamRelay is a **self-hosted multistream relay**. Your gaming PC (or encoder) publishes **one** (or two) streams to a Linux node you control. That node:

- Accepts ingest via **RTMP** and **SRT** (MediaMTX)
- Relays to each enabled destination with **FFmpeg** (default: zero-transcode copy)
- Exposes a **browser dashboard** for destinations, Live Manager, chat, Connect, and Omnix Link
- Stores destination stream keys **encrypted** in local SQLite (`data/omnix.sqlite`)

It is **not** a SaaS restream account. There is no shared login across friends: **one operator per egg / server**. If a friend needs StreamRelay, they get their own node.

The web dashboard is first-class. An optional Windows [Tauri companion](docs/DESKTOP.md) exists for chat overlay; there is no Electron client and no requirement to use the desktop app for day-to-day streaming.

---

## How it works

| Layer | Role |
|-------|------|
| **MediaMTX** | Ingest (`live/{STREAM_KEY}`, `live/{STREAM_KEY_VERTICAL}`) |
| **Bot (TypeScript)** | JWT auth, destinations API, FFmpeg process manager, chat, Live Manager, Connect |
| **FFmpeg** | Per-destination push; default `-c copy` |
| **SQLite** | Encrypted destination keys, OAuth tokens, presets — on **your** volume |
| **Dashboard** | `client-ui` served by the bot |

### Dual ingest (main + vertical)

| Lane | Default path | Typical use |
|------|--------------|-------------|
| **main** | `live/mystream` | 16:9 — Twitch, YouTube main, Kick, custom |
| **vertical** | `live/mystream_v` | 9:16 — YouTube Dual / Shorts-style, vertical Kick, etc. |

Same host and RTMP port; different stream keys. Destinations choose feed **main** or **vertical**. The relay does **not** crop or compose vertical video — that stays in OBS / [Aitum](docs/VERTICAL-AITUM.md).

### Session behaviour

- Leave destination toggles **On**. When OBS stops and starts again, StreamRelay detects ingest leave/return and **recycles** enabled destinations (same effect as Off → On).
- YouTube main often gets a short settle + one automatic reconnect so Studio leaves “Preparing” / black without a manual toggle.
- Kick RTMPS URLs are normalized to `:443/app` when needed. Kick’s **Server URL is per account** — always paste from that Kick dashboard.

---

## Features

- Multistream to Twitch, YouTube, Kick, and custom RTMP
- Dual feed (main 16:9 + vertical 9:16)
- Live Manager (AIO / Custom titles, presets, Create / Start / End for connected platforms)
- Connect Google / Twitch / Kick (panel, or via Omnix Link)
- Encrypted destination keys; keys masked in the UI
- Optional multi-platform chat in the dashboard
- Mobile chat PWA at `/chat.html`
- Optional Windows desktop companion + chat overlay
- Pterodactyl egg + published GHCR image
- Adaptive ports (`SERVER_PORT` / `RTMP_PORT` / `SRT_PORT`) for Wings allocations that are not classic 1935/8890

---

## Try it — panel egg

### 1. Import the egg

Use [`pterodactyl/egg-omnix-streamrelay.json`](pterodactyl/egg-omnix-streamrelay.json) (same content as `FINAL-egg-omnix-streamrelay.json`). Nest: OmnixStudio · Egg name: **Omnix StreamRelay**.

### 2. Create a server with three allocations

Map Startup variables to the ports Wings assigned:

| Role | Egg variable | Notes |
|------|--------------|--------|
| Dashboard (primary TCP) | `SERVER_PORT` (or optional `DASHBOARD_PORT`) | Open this in the browser |
| OBS RTMP | `RTMP_PORT` | Must equal the RTMP allocation |
| SRT | `SRT_PORT` | UDP preferred when the panel allows it |

Set **Public Host** (`PUBLIC_HOST`) to your DNS name or public IP. Leave secrets (`BOOTSTRAP_TOKEN`, `MASTER_KEY`, JWT secrets, MediaMTX passwords) on **`auto`** unless you have a reason to pin them.

### 3. Start and log in

1. Start the server.
2. Read the console (or `FIRST_LOGIN.txt` on the volume) for the bootstrap token.
3. Open `http://PUBLIC_HOST:PRIMARY_PORT/` and sign in.

That token is your dashboard password. Treat it like a password; do not share it between Mumbai, Abu Dhabi, or other operators.

### 4. If install hangs

Wings is usually missing the local image tag. On **that** Wings node:

```bash
sudo docker build -t omnix-streamrelay:latest -f pterodactyl/Dockerfile .
```

Or ensure the node can pull `ghcr.io/mohfarzin/omnix-streamrelay:latest` (package must be public, or the node must be logged into GHCR). See [docs/GHCR.md](docs/GHCR.md).

Rebuild updates the shared local tag — only **restart the egg you intend** if several StreamRelay servers share a node.

---

## OBS and Aitum

### Main (16:9)

| Setting | Value |
|---------|--------|
| Service | Custom |
| Server | `rtmp://PUBLIC_HOST:RTMP_PORT/live` |
| Stream key | `mystream` (or your `STREAM_KEY`) |
| Authentication | Off |

### Vertical (9:16)

| Setting | Value |
|---------|--------|
| Service | Custom |
| Server | Same as main |
| Stream key | `mystream_v` (or your `STREAM_KEY_VERTICAL`) |

Use [Aitum Vertical](https://obsproject.com/forum/resources/aitum-vertical.1715/) + Multistream (or a second OBS) so the 9:16 canvas publishes on its own path. Full walkthrough: [docs/VERTICAL-AITUM.md](docs/VERTICAL-AITUM.md).

### SRT (optional)

```
srt://PUBLIC_HOST:SRT_PORT?streamid=publish:live/mystream
srt://PUBLIC_HOST:SRT_PORT?streamid=publish:live/mystream_v
```

### Encode tips

| Platform | Guidance |
|----------|----------|
| Twitch / Kick | CBR · keyframe interval **2** (0 / auto / 4+ often buffers) |
| Kick bitrate | **≤ 8000 kbps** |
| YouTube | Often tolerates longer keyframes; still fine to match Twitch/Kick at 2 |

---

## Destinations and Live Manager

### Destinations

Each destination has a **name**, **feed** (main / vertical), **server URL**, and **stream key**. Platform is inferred from the name/URL (YouTube, Twitch, Kick, custom) — you do not pick a separate platform field.

Presets help fill Server URL for YouTube / Twitch / Kick; Kick Server URL is left empty so you paste the value from **your** Kick Creator dashboard.

Deleting a destination requires typing its exact **name** to confirm.

### Live Manager

After Connect:

1. Choose **AIO** (one shared title) or **Custom** (per platform).
2. Save a preset and optionally set it as default.
3. **Create** / **Start** / **End** as your session needs.
4. Leave destinations **On** for the next session — OBS recycle handles the rest.

YouTube-only fields (privacy, latency, thumbnail) are skipped on Twitch/Kick when using AIO.

Stream latency (YouTube): **Normal** (default), **Low**, or **Ultra-low** — set before going live; YouTube locks it once the broadcast is running.

### Connect

- **On the panel:** Connect Google / Twitch / Kick (device code or redirect to your host). Tokens land encrypted in **your** SQLite.
- **Via Omnix Link:** when the egg has no convenient public URL — see below.

You should not paste Client ID / Client Secret into streamer-facing Startup fields for normal use.

---

## YouTube vertical / Dual Encoder

**Create / Start will not automatically enable Dual stream or fill the vertical Encoder key.**

YouTube’s Live API can create and bind the **main 16:9** broadcast and stream. It does **not** expose the Studio Dual / Shorts **Encoder** path the same way. After Create:

1. Open the live event in **YouTube Studio**.
2. Enable **Dual stream** → vertical → **Encoder**.
3. Copy that vertical stream key.
4. Paste it into StreamRelay when prompted, or edit the vertical YouTube destination (`youtube-v` / feed **vertical**).

Composition of the 9:16 picture remains in OBS / Aitum. StreamRelay only forwards `live/{STREAM_KEY_VERTICAL}` to that key.

More context: [docs/YOUTUBE-LIVE.md](docs/YOUTUBE-LIVE.md).

---

## Platform notes

| Platform | Video | Chat | Notes |
|----------|-------|------|--------|
| **YouTube** | Connect + Create/Start | Optional chat ID / API or OAuth | Main via API; vertical via Studio Encoder |
| **Twitch** | Connect usually fills ingest + key | `TWITCH_CHANNEL` + token | Prefer CFR / keyframe 2; optional `TWITCH_TRANSCODE` |
| **Kick** | Paste Server URL + key once | `KICK_CHANNEL` (+ token to reply) | Server URL is **per account**; default copy, optional `KICK_TRANSCODE` |
| **Custom** | Paste any RTMP URL + key | — | Full control |

---

## Omnix Link

[Omnix Link](https://relaylink.omnixstudio.xyz) ([repo](https://github.com/MohFarzin/Omnix-Link)) is the optional web companion:

1. Sign in on Link → copy a **tunnel token**.
2. StreamRelay → Omnix Link → paste → Save.
3. Confirm the pending connection on Link (IP / node).
4. Connect platforms on Link; the egg **polls outbound** and decrypts sealed jobs into local SQLite.

The egg never needs a public URL for this path. Local Connect on StreamRelay still works without Link. Do not reuse tunnel tokens across operators or regions.

Privacy detail: [docs/PRIVACY-CONNECT.md](docs/PRIVACY-CONNECT.md).

---

## Chat (optional)

Video relay works with all chat fields empty. To enable chat, set egg env (or Compose `.env`) and **restart** the panel:

| Platform | Variables |
|----------|-----------|
| Twitch | `TWITCH_CHANNEL`, `TWITCH_ACCESS_TOKEN` |
| YouTube | `YOUTUBE_LIVE_CHAT_ID` + API key or OAuth from Connect |
| Kick | `KICK_CHANNEL` (+ `KICK_ACCESS_TOKEN` to send replies) |

Chat appears under Connection in the dashboard (minimized when connected). Help (**?**) covers OBS + chat setup.

---

## Mobile chat and desktop companion

| Surface | What it is |
|---------|------------|
| **`/chat.html`** | Phone / tablet PWA — read chat, filter platforms, reply. Same bootstrap login. [docs/MOBILE-CHAT.md](docs/MOBILE-CHAT.md) |
| **Desktop (Tauri)** | Optional Windows companion + always-on-top chat overlay. Web panel remains primary. [docs/DESKTOP.md](docs/DESKTOP.md) |

---

## Docker Compose

For a VPS with Docker (Caddy TLS in Compose when configured):

```bash
git clone https://github.com/MohFarzin/Omnix-StreamRelay.git
cd Omnix-StreamRelay
cp .env.example .env
```

Fill at least:

| Variable | Purpose |
|----------|---------|
| `DOMAIN` | Public hostname |
| `ACME_EMAIL` | TLS certificates |
| `MASTER_KEY`, `BOOTSTRAP_TOKEN`, JWT secrets | `openssl rand -hex 32` each |
| `STREAM_KEY` / `STREAM_KEY_VERTICAL` | OBS path segments |
| `MTX_PUBLISH_PASS` / `MTX_API_PASS` | MediaMTX |

```bash
docker compose up -d --build
```

Optional volume overrides on eggs: `data/ports.env`, `data/public_host`, operator `data/oauth.env`.

---

## Egg variables

### Required for day-to-day use

| Variable | Meaning |
|----------|---------|
| `PUBLIC_HOST` | DNS or IP printed in FIRST_LOGIN / OBS URLs |
| `RTMP_PORT` | Must match RTMP allocation |
| `SRT_PORT` | Must match SRT allocation |
| `STREAM_KEY` | Main ingest key (default `mystream`) |
| `STREAM_KEY_VERTICAL` | Vertical ingest key (default `mystream_v`) |
| `BOOTSTRAP_TOKEN` | Dashboard login (`auto` recommended) |

### Leave on `auto` unless you know otherwise

`MASTER_KEY`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `MTX_API_PASS`, `MTX_PUBLISH_PASS` (OBS auth is off — publish pass is legacy).

### Optional

| Variable | Meaning |
|----------|---------|
| `DASHBOARD_PORT` | Override primary allocation for HTTP |
| `TWITCH_*` / `YOUTUBE_*` / `KICK_*` | Chat (and legacy token fields) |
| `OAUTH_BROKER_URL` | Legacy/optional broker; prefer panel Connect or Omnix Link |
| `TWITCH_TRANSCODE` / `KICK_TRANSCODE` | Escape hatches — see below |

---

## Encoding and transcode

**Default for every destination:** FFmpeg **`-c copy`** (passthrough). That keeps CPU low and quality identical to OBS.

| Flag | When to use |
|------|-------------|
| `TWITCH_TRANSCODE=1` | Twitch rejects VFR / odd timing (e.g. Error #1000) — shared CFR 1080p60 path |
| `KICK_TRANSCODE=1` | Only if Kick needs a light H.264 re-encode (≤ ~8000 kbps). Default remains copy; wrong re-encode can show “live” with a blank picture |

Do not turn general VPS “always transcode” on for YouTube/Twitch/custom — copy is the product path.

---

## Security and privacy

- Login: bootstrap token (timing-safe compare), JWT access + refresh, rate limits, body size caps, CSP
- Destination stream keys: AES-GCM in SQLite; masked in API/UI
- Target id and URL validation on writes
- Connect tokens stay on **your** volume by default — OmnixStudio does not keep a permanent vault of streamer Google/Twitch/Kick refresh tokens on the marketing site
- One operator per egg; never copy keys or bootstrap tokens between nodes

Full write-up: [docs/PRIVACY-CONNECT.md](docs/PRIVACY-CONNECT.md).

---

## Container image and CI

| Item | Value |
|------|--------|
| Published image | `ghcr.io/mohfarzin/omnix-streamrelay:latest` |
| Dockerfile | [`pterodactyl/Dockerfile`](pterodactyl/Dockerfile) |
| Workflow | [`.github/workflows/docker-image.yml`](.github/workflows/docker-image.yml) |

CI builds and pushes on `main` / `master` and version tags. If Actions fails with:

```text
denied: permission_denied: write_package
```

the **image built**; GHCR rejected the **push**. Grant this repository **Write** under the package’s Manage Actions access, or set secret `GHCR_PAT`. Step-by-step: [docs/GHCR.md](docs/GHCR.md).

Wings can also use a locally built `omnix-streamrelay:latest` without pulling GHCR.

---

## Repository layout

```
bot-backend/     API, FFmpeg manager, chat, Connect, SQLite
client-ui/       Browser dashboard (+ chat PWA assets)
pterodactyl/     Egg JSON, Dockerfile, start scripts
desktop/         Optional Tauri Windows companion
docs/            Guides (vertical, Connect, YouTube, privacy, GHCR, …)
.github/         Docker image workflow
```

---

## Documentation

| Guide | Contents |
|-------|----------|
| [Vertical / Aitum](docs/VERTICAL-AITUM.md) | Second OBS publish, Aitum plugins |
| [Connect platforms](docs/CONNECT-PLATFORMS.md) | YouTube · Twitch · Kick Connect |
| [YouTube Live](docs/YOUTUBE-LIVE.md) | Live Manager, latency, Studio vertical |
| [Privacy](docs/PRIVACY-CONNECT.md) | Where tokens live |
| [Kick Connect](docs/KICK-CONNECT.md) | Kick app / chat |
| [Mobile chat](docs/MOBILE-CHAT.md) | `/chat.html` PWA |
| [Desktop](docs/DESKTOP.md) | Tauri companion |
| [GHCR](docs/GHCR.md) | Image publish and `write_package` |
| [Omnix Link](https://github.com/MohFarzin/Omnix-Link) | Outbound pairing companion |

---

## Support and license

- Issues and source: [github.com/MohFarzin/Omnix-StreamRelay](https://github.com/MohFarzin/Omnix-StreamRelay)
- Email: [admin@omnixstudio.xyz](mailto:admin@omnixstudio.xyz)

Released under the [MIT License](LICENSE).  
© 2026 OmnixStudio / MohFarzin
