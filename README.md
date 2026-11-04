# Omnix StreamRelay

[![License: MIT](https://img.shields.io/badge/License-MIT-0B3D91.svg)](LICENSE)
[![ghcr.io](https://img.shields.io/badge/ghcr.io-omnix--streamrelay-111111?logo=github)](https://github.com/MohFarzin/Omnix-StreamRelay/pkgs/container/omnix-streamrelay)
[![GitHub](https://img.shields.io/badge/GitHub-Omnix--StreamRelay-181717?logo=github)](https://github.com/MohFarzin/Omnix-StreamRelay)

Point OBS at **your** VPS once. The node fans that feed out to Twitch, YouTube, Kick, or any RTMP URL you add. Browser dashboard only — no desktop app required for the relay itself.

| | |
|---|---|
| Stack | MediaMTX + FFmpeg · TypeScript bot · SQLite |
| Deploy | Pterodactyl / Jexactyl egg · or Docker Compose |
| Image | `ghcr.io/mohfarzin/omnix-streamrelay:latest` |
| Contact | [admin@omnixstudio.xyz](mailto:admin@omnixstudio.xyz) |

```
OBS / Aitum ──RTMP / SRT──► your node
                              ├─ Twitch
                              ├─ YouTube (main 16:9; vertical is a second publish)
                              ├─ Kick
                              └─ custom RTMP
```

---

## Setup

### Panel egg

1. Import [`pterodactyl/egg-omnix-streamrelay.json`](pterodactyl/egg-omnix-streamrelay.json).
2. Create a server with **three** allocations and set egg vars to match:

| Role | Egg variable |
|------|----------------|
| Dashboard (primary TCP) | `SERVER_PORT` |
| OBS RTMP | `RTMP_PORT` |
| SRT (UDP if you can) | `SRT_PORT` |

3. Set `PUBLIC_HOST` to your DNS or IP. Leave secrets as `auto`.
4. Start the server. Open `http://PUBLIC_HOST:PRIMARY_PORT/` and log in with the token from the console or `FIRST_LOGIN.txt`.

If install hangs forever, the Wings node is usually missing the image. Build on that node:

```bash
sudo docker build -t omnix-streamrelay:latest -f pterodactyl/Dockerfile .
```

(or fix GHCR pull — see [docs/GHCR.md](docs/GHCR.md)).

### OBS

| | Main 16:9 | Vertical 9:16 |
|---|-----------|----------------|
| Service | Custom | Custom |
| Server | `rtmp://PUBLIC_HOST:RTMP_PORT/live` | same |
| Stream key | `mystream` | `mystream_v` |
| Auth | Off | Off |

Twitch / Kick: CBR, keyframe interval **2**. Kick bitrate **≤ 8000 kbps**.  
Vertical setup: [docs/VERTICAL-AITUM.md](docs/VERTICAL-AITUM.md).

### Destinations & Live Manager

Connect Google / Twitch / Kick (panel or [Omnix Link](https://relaylink.omnixstudio.xyz)), then Create / Start in Live Manager. Leave destination toggles **On** — OBS stop/start recycles them.

**YouTube vertical is not automatic.** The YouTube Live API does not create or bind the Shorts / Dual **Encoder** stream for you. After Create:

1. Open the live in YouTube Studio.
2. Turn Dual stream on → vertical → **Encoder**.
3. Paste that vertical stream key into the panel when prompted (or edit the vertical destination).

Main 16:9 keys can be created/reused by the API; the 9:16 Encoder key still comes from Studio. Vertical video itself is composed in OBS/Aitum — the relay only forwards a second ingest path.

Kick: paste the **Server URL from that Kick account** (ingest hosts differ per account).

### Compose

```bash
git clone https://github.com/MohFarzin/Omnix-StreamRelay.git
cd Omnix-StreamRelay
cp .env.example .env   # DOMAIN, ACME_EMAIL, openssl rand -hex 32
docker compose up -d --build
```

### Chat (optional)

Video works with chat env empty. Restart after changing these:

| Platform | Variables |
|----------|-----------|
| Twitch | `TWITCH_CHANNEL`, `TWITCH_ACCESS_TOKEN` |
| YouTube | `YOUTUBE_LIVE_CHAT_ID` + API key or OAuth |
| Kick | `KICK_CHANNEL` (+ `KICK_ACCESS_TOKEN` to reply) |

---

## Notes

- Default path is **copy** (`-c copy`). `KICK_TRANSCODE` / `TWITCH_TRANSCODE` only when you need CFR / bitrate caps.
- Two ingest lanes: `live/{STREAM_KEY}` and `live/{STREAM_KEY_VERTICAL}`. Destinations pick `main` or `vertical`.
- One operator per egg. Do not share bootstrap tokens or stream keys across Mumbai / Abu Dhabi / friends’ nodes.
- Connect tokens live on **your** volume. Omnix Link is optional outbound pairing when the egg has no public URL.

### CI image push

Workflow: `.github/workflows/docker-image.yml`.  
If Actions fails with `permission_denied: write_package`, the build worked — GHCR blocked the push. Link the package to this repo (or set secret `GHCR_PAT`). Steps: [docs/GHCR.md](docs/GHCR.md).

### Layout

```
bot-backend/   API, FFmpeg manager, chat, SQLite
client-ui/     Dashboard
pterodactyl/   Egg, Dockerfile, start scripts
docs/          Guides
```

### Docs

| | |
|--|--|
| [Vertical / Aitum](docs/VERTICAL-AITUM.md) | Second OBS publish path |
| [Connect platforms](docs/CONNECT-PLATFORMS.md) | YouTube · Twitch · Kick |
| [YouTube Live](docs/YOUTUBE-LIVE.md) | Create / bind / Studio vertical |
| [Privacy](docs/PRIVACY-CONNECT.md) | Where tokens sit |
| [GHCR](docs/GHCR.md) | Image publish / `write_package` |
| [Omnix Link](https://github.com/MohFarzin/Omnix-Link) | relaylink.omnixstudio.xyz |

---

## License

[MIT](LICENSE) · © 2026 OmnixStudio / MohFarzin · [admin@omnixstudio.xyz](mailto:admin@omnixstudio.xyz)
