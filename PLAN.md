# Omnix Live-Stream — Technical Design Plan

> **Status:** APPROVED 2026-10-26. Implementation in progress.
> **Brand:** Omnix StreamRelay
> **Locked:** Q1B · Q2C · Q3B · Q4A · Q5B · Q6A
> **Ponytail level:** full — smallest stack that meets the brief.

---

## 1. Goal

Offload multistream fan-out and multi-platform chat from a Windows OBS PC to a 1 Gbps+ Linux VPS via two Docker containers + one thin Windows control client. Stream path is **passthrough only** (`copy` / MediaMTX native forward — no transcode).

---

## 2. Foundation Evaluation (research summary)

### 2.1 Stream relay candidates

| Option | Passthrough | Dynamic targets | SRT ingest | Fit |
|--------|-------------|-----------------|------------|-----|
| **MediaMTX** (`bluenviron/mediamtx`) | Native `forward` (RTMP/SRT/…) + byte counters | Path config + Control API; push-target API evolving | Yes | **Recommended** |
| nginx-rtmp | Static `push` | Poor (reload/restart) | No (forks only) | Reject — stale module |
| datarhei Restreamer | Yes (FFmpeg) | GUI/API but heavy | Yes | Reject — oversized UI/stack for our own client |
| OvenMediaEngine | Push publishing | REST | Yes | Reject — AGPL + LL-HLS/WebRTC weight |
| Octoplex (MediaMTX+FFmpeg orchestration) | Yes | Live add/remove | Via MediaMTX | Reject — alpha, AGPL, Docker-in-Docker |
| Custom FFmpeg-only controller | `-c copy` / `tee` | Full control | Needs separate ingest | Fallback if MediaMTX forward gaps appear |

**Decision (proposed):** Container 1 = **MediaMTX** as ingest + zero-CPU forward engine. Bot backend drives destination enable/disable by rewriting path `forward` list via MediaMTX Control API (and/or managed FFmpeg `-c copy` sidecar only if a destination protocol needs it).

### 2.2 Chat / bot candidates

| Option | Twitch | YouTube | Kick | Notes |
|--------|--------|---------|------|-------|
| Own thin adapters (proposed) | EventSub WS + Helix `chat/messages` | Live Streaming API (poll/liveChatMessages) | Official Kick API `POST /public/v1/chat` + events webhook/WS | Smallest, controllable |
| `chat-source` (npm) | Yes | Yes | Yes | Tiny/new (low adoption) — optional later, not core |
| Kimsec Unified-chat | Yes | Yes | Yes | Full product; wrong shape (steal ideas, not embed) |
| `@gbrlstr/kick-flow` / `kapi-kit` | — | — | Yes | Optional Kick helper; prefer official API first |

**Decision (proposed):** Hand-rolled TypeScript connectors behind one `ChatProvider` interface. No mega-framework.

### 2.3 Thin Windows client candidates

| Option | Disk | Idle RAM (realistic) | Portable `.exe` | Fit vs `$<30 MB` RAM |
|--------|------|----------------------|-----------------|----------------------|
| **Tauri 2 + WebView2** | ~5–15 MB | ~140–200 MB (WebView2 is Chromium) | Mostly (needs WebView2 runtime; present on Win11) | **Misses 30 MB** |
| Electron | ~100+ MB | ~150–250 MB | Fat | Worse |
| **.NET WinForms / WPF** | Small self-contained | ~50–80 MB typical | Yes (`PublishSingleFile`) | Closer, still rarely &lt;30 MB |
| **Browser UI only** (no desktop shell) | 0 new | 0 if browser already open | N/A — bookmark VPS HTTPS | Meets spirit; not an `.exe` |
| egui / iced (native Rust UI) | Small | Can approach tens of MB | Yes | Harder UI; possible stretch goal |

**Critical honesty:** A modern GUI with a unified chat feed will **not** reliably stay under 30 MB RAM if it embeds a browser engine. Plan proposes **Tauri** for the requested portable `.exe` **or** WinForms if you prioritize RAM over web UI polish. Confirm in §8.

---

## 3. Architecture

```
┌──────────────────── Windows PC ────────────────────┐
│  OBS ──RTMP/SRT──► VPS:1935 / :8890                │
│  client-ui.exe ◄──HTTPS/WSS──► bot-backend :8443   │
└────────────────────────────────────────────────────┘

┌──────────────────── Linux VPS (docker compose) ────┐
│  bridge network: omnix-net                         │
│                                                    │
│  [relay] MediaMTX                                  │
│    ingest: RTMP 1935, SRT 8890                     │
│    path: live/{key}                                │
│    forward[] → Twitch / YouTube / Kick / custom    │
│    control API :9997 (internal only)               │
│                                                    │
│  [bot] Node.js/TypeScript                          │
│    REST + WebSocket :8080 (TLS terminate optional) │
│    Chat adapters: Twitch, YouTube, Kick            │
│    SQLite volume: viewers, commands, targets       │
│    Orchestrates MediaMTX forward list              │
└────────────────────────────────────────────────────┘
```

### Container 1 — `relay/`

- Image: official `bluenviron/mediamtx` (+ thin `relay-agent` only if API gaps force FFmpeg process management).
- Ingest auth: publish user/pass or stream-key path segment.
- Forward: **native MediaMTX forward** (no re-encode).
- Metrics: outbound bytes / destination state from MediaMTX API → proxied by bot.

### Container 2 — `bot-backend/`

- Runtime: Node 22+, TypeScript, **Fastify** (REST) + `@fastify/websocket`.
- DB: **better-sqlite3** on named volume `bot-data`.
- Auth: single long-lived **API token** (Bearer) for v1; JWT optional later if multi-user needed.
- Owns: commands, first-seen welcomes, chat fan-in, target toggles, moderation stubs.

### Client — `client-ui/`

- Remote control only: login, target toggles, unified chat, command editor.
- No media decode, no bot logic, no local SQLite of consequence.
- Talks only to bot-backend (bot proxies relay).

---

## 4. Data model (SQLite)

```sql
viewers(platform TEXT, viewer_id TEXT, display_name TEXT, first_seen_at INTEGER, welcomed_at INTEGER,
        PRIMARY KEY(platform, viewer_id));

commands(name TEXT PRIMARY KEY, response TEXT, enabled INTEGER, cooldown_sec INTEGER);

stream_targets(id TEXT PRIMARY KEY, label TEXT, platform TEXT, rtmp_url TEXT, stream_key TEXT,
               enabled INTEGER, last_error TEXT, updated_at INTEGER);

settings(key TEXT PRIMARY KEY, value TEXT);  -- welcome template, ingest key hash, etc.

api_tokens(id TEXT PRIMARY KEY, token_hash TEXT, created_at INTEGER, last_used_at INTEGER);
```

Stream keys stored encrypted-at-rest with a server `MASTER_KEY` env var (AES-GCM). Never returned in full over API after create (masked).

---

## 5. API specification (bot-backend)

Base: `https://<vps>/api/v1`  
Auth: `Authorization: Bearer <token>` on all routes except `GET /health`.

### Health / session

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Liveness |
| POST | `/auth/login` | Validate token → `{ ok, wsUrl }` |
| GET | `/status` | Uptime, ingest live?, per-target state, rough bandwidth |

### Stream targets

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/targets` | List targets (keys masked) |
| PUT | `/targets/:id` | Create/update URL+key+label |
| POST | `/targets/:id/enable` | Enable forward (hot) |
| POST | `/targets/:id/disable` | Disable forward (hot) |
| DELETE | `/targets/:id` | Remove |

Enable/disable → bot patches MediaMTX path `forward` list and confirms state.

### Chat / bot

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/commands` | List commands |
| PUT | `/commands/:name` | Upsert |
| DELETE | `/commands/:name` | Delete |
| GET | `/settings/welcome` | Welcome template |
| PUT | `/settings/welcome` | Update template |
| POST | `/chat/send` | `{ platforms?: [], text }` send as bot |
| POST | `/moderation/timeout` | Platform-specific stub (Twitch/Kick first) |

### WebSocket `/ws`

Client sends: `{ type: "auth", token }` then subscribes.

Server pushes:

```json
{ "type": "chat", "platform": "twitch|youtube|kick", "user": "...", "userId": "...", "text": "...", "ts": 0 }
{ "type": "target", "id": "twitch", "state": "forwarding|idle|error", "error": null, "outboundBytes": 0 }
{ "type": "ingest", "live": true, "bytesIn": 0 }
{ "type": "status", "uptimeSec": 0 }
```

---

## 6. Chat behavior

1. **Commands:** message matching `!name` (case-insensitive) → reply on **same platform** instantly; optional `broadcastReplies` setting to mirror to all.
2. **First-seen welcome:** on first message from `(platform, viewer_id)` not in `viewers`, insert row + send welcome once (template vars: `{user}`, `{platform}`).
3. **Unified feed:** all inbound messages normalized and broadcast on `/ws`.
4. **Secrets:** OAuth tokens for Twitch/YouTube/Kick in env or encrypted settings; refresh handled in-process.

Platform notes:

- **Twitch:** EventSub WebSocket for chat; Helix send; IRC optional fallback.
- **YouTube:** Live Chat API polling while broadcast live; OAuth for send.
- **Kick:** Official OAuth (`chat:write`, `events:subscribe`); send via Public Chat API; inbound via webhooks or documented realtime channel.

---

## 7. Repo layout (post-approval)

```
/
  PLAN.md                 ← this file
  README.md               ← one-command deploy
  docker-compose.yml
  .env.example
  relay/
    mediamtx.yml
    Dockerfile            # thin wrap if needed
  bot-backend/
    package.json
    src/...
    Dockerfile
  client-ui/
    (Tauri or WinForms — TBD)
    scripts/build-windows.*
```

Volumes: `bot-data`, optional `relay-record` (off by default).  
Healthchecks: MediaMTX API ping; bot `/health`.

OBS on Windows: single output to `rtmp://VPS_IP:1935/live/STREAMKEY` (or SRT equivalent). Platforms receive copies from VPS; OBS bitrate × N destinations ≈ VPS egress.

---

## 8. Approved decisions (2026-10-26)

| Q | Choice | Locked as |
|---|--------|-----------|
| Q1 | **B** | MediaMTX ingest + FFmpeg `-c copy` managed by bot |
| Q2 | **C** | Browser HTTPS dashboard only (no `.exe`) |
| Q3 | **B** | JWT access + refresh |
| Q4 | **A** | Stream keys encrypted in SQLite, editable in UI |
| Q5 | **B** | Kick via `@gbrlstr/kick-flow` (optionalDep) |
| Q6 | **A** | Caddy + Let’s Encrypt in compose |
| Q7 | — | Brand: **Omnix StreamRelay** |

---

## 9. Out of scope (v1) — explicitly skipped

- Transcoding / ABR / recording UI  
- Discord / TikTok destinations  
- Multi-tenant / multi-streamer SaaS  
- Full moderation suite parity with Streamlabs  
- Mobile apps  
- Embedding Restreamer/OME GUIs

---

## 10. Implementation order (after approval)

1. `docker-compose` + MediaMTX ingest smoke test (OBS → VPS → one RTMP sink)  
2. Bot target enable/disable → MediaMTX forward  
3. Twitch chat + commands + SQLite welcome  
4. YouTube + Kick adapters  
5. REST/WS auth + `/status`  
6. Client UI (chosen stack)  
7. README one-command deploy  

---

## 11. Risks

| Risk | Mitigation |
|------|------------|
| MediaMTX dynamic forward API version variance | Pin image tag; FFmpeg fallback path |
| Kick API / bot badge policy changes | Official scopes only; document OAuth |
| YouTube chat polling quota | Backoff; only poll when ingest live |
| &lt;30 MB RAM client infeasible with WebView | Choose Q2 B/C or accept higher RAM |
| Platform ToS / stream-key leakage | Mask keys; encrypt at rest; TLS required for client |
