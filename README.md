# Omnix StreamRelay

Self-hosted multistream relay + cross-platform chat control. OBS sends **one** RTMP/SRT feed to your VPS; the VPS fans out with **FFmpeg `-c copy`** (no transcode) and runs the chat bot. You control everything from a **browser** dashboard over HTTPS.

## Deploy options

### A) Pterodactyl (recommended for your panel)

See **[`pterodactyl/README.md`](pterodactyl/README.md)** and import **`pterodactyl/egg-omnix-streamrelay.json`**.  
Single container (MediaMTX + bot + FFmpeg). No external database.

### B) Docker Compose (VPS without panel)

```bash
git clone <your-repo-url> Live-Stream && cd Live-Stream
cp .env.example .env
# edit .env — DOMAIN, ACME_EMAIL, secrets, STREAM_KEY, MTX_* passwords
docker compose up -d --build
```

Open `https://YOUR_DOMAIN/` → enter `BOOTSTRAP_TOKEN` → manage targets / chat / commands.

DNS: point `DOMAIN` A/AAAA at the VPS before first start (Caddy needs it for Let’s Encrypt).

### Required `.env` secrets

| Variable | Purpose |
|----------|---------|
| `DOMAIN` / `ACME_EMAIL` | HTTPS via Caddy |
| `MASTER_KEY` | Encrypts stream keys in SQLite |
| `BOOTSTRAP_TOKEN` | Dashboard login (exchanges for JWT) |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | JWT signing |
| `MTX_PUBLISH_PASS` / `MTX_API_PASS` | MediaMTX publish + API |
| `STREAM_KEY` | Ingest path segment |

Generate secrets: `openssl rand -hex 32`

## OBS → VPS

**RTMP**

- Server: `rtmp://publisher:MTX_PUBLISH_PASS@YOUR_DOMAIN:1935/live`
- Stream key: value of `STREAM_KEY` (e.g. `mystream`)

**SRT**

- `srt://YOUR_DOMAIN:8890?streamid=publish:live/STREAM_KEY`
- Use MediaMTX publisher credentials per [MediaMTX auth docs](https://mediamtx.org/docs) if prompted by your encoder.

Open ports: `80`, `443`, `1935/tcp`, `8890/udp`.

## Dashboard workflow

1. **Login** with bootstrap token (JWT access + refresh stored in the browser).
2. **Add targets** (Twitch / YouTube / Kick / custom): RTMP base URL + stream key (stored encrypted).
3. **Toggle** enable — when OBS is live, bot starts `ffmpeg -c copy` to each enabled destination.
4. **Chat**: unified feed; `!commands`; first-seen welcome; send-as-bot.

### Typical destination URLs

| Platform | `rtmpUrl` | `streamKey` |
|----------|-----------|-------------|
| Twitch | `rtmp://live.twitch.tv/app` | Twitch stream key |
| YouTube | `rtmp://a.rtmp.youtube.com/live2` | YouTube stream key |
| Kick | Kick’s provided RTMP server URL | Kick stream key |

## Chat credentials (optional env)

Set in `.env` to enable platforms:

- **Twitch:** `TWITCH_CHANNEL`, `TWITCH_ACCESS_TOKEN` (oauth token for the bot account)
- **YouTube:** `YOUTUBE_LIVE_CHAT_ID` + `YOUTUBE_API_KEY` and/or OAuth access token for send
- **Kick:** `KICK_CHANNEL` + optional `@gbrlstr/kick-flow` (optionalDep) + `KICK_ACCESS_TOKEN` for send

## Layout

```
relay/          MediaMTX ingest
bot-backend/    API, JWT, FFmpeg manager, chat, SQLite
client-ui/      Browser dashboard (served by bot)
Caddyfile       TLS reverse proxy → bot:8080
docker-compose.yml
PLAN.md         Design decisions
```

## Local bot dev (optional)

```bash
cd bot-backend && npm install && npm run dev
```

Needs MediaMTX reachable and the same env vars as compose.

## Security notes

- Never commit `.env`.
- Stream keys are AES-GCM encrypted with `MASTER_KEY`; API returns masked keys only.
- Rotate `BOOTSTRAP_TOKEN` after first setup if it was shared in chat.
