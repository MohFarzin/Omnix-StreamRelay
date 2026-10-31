import type { WebSocket } from "ws";
import type { ChatMessage } from "./chat/types.js";
import { onChat, activePlatforms, chatDiagnostics } from "./chat/engine.js";
import { processStatus } from "./relay/ffmpeg.js";
import { ingestBoth } from "./relay/mediamtx.js";
import { listTargets } from "./db.js";
import { decrypt, maskKey } from "./crypto.js";

const clients = new Set<WebSocket>();
const keyMaskCache = new Map<string, { enc: string; masked: string }>();
let lastSessionFp = "";
let tickN = 0;

export function broadcast(obj: unknown): void {
  if (!clients.size) return;
  const data = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

export function addClient(ws: WebSocket): void {
  clients.add(ws);
  const drop = () => clients.delete(ws);
  ws.on("close", drop);
  ws.on("error", drop);
}

function shortErr(err: string | null): string | null {
  if (!err) return null;
  if (/Non-monotonous DTS|Failed to update header|incorrect timestamps/i.test(err)) return null;
  const safe = err
    .replace(/rtmps?:\/\/\S+/gi, (url) =>
      url.replace(/\/([^/?\s]{6,})(?=$|\s)/, (_m, key: string) => `/${maskKey(key)}`)
    )
    .replace(/\b(?:sk_|live_)[A-Za-z0-9_-]{8,}\b/g, (k) => maskKey(k))
    .replace(/\b[a-z0-9]{4}(?:-[a-z0-9]{4}){3,}\b/gi, (k) => maskKey(k));
  return safe.length > 120 ? `${safe.slice(0, 117)}…` : safe;
}

function maskedKey(id: string, enc: string): string {
  const hit = keyMaskCache.get(id);
  if (hit && hit.enc === enc) return hit.masked;
  let masked = "******";
  try {
    masked = maskKey(decrypt(enc));
  } catch {
  }
  keyMaskCache.set(id, { enc, masked });
  return masked;
}

export function startHub(): void {
  onChat((msg: ChatMessage) => broadcast({ type: "chat", ...msg }));
  let tickBusy = false;

  setInterval(() => {
    if (tickBusy || clients.size === 0) return;
    tickBusy = true;
    tickN += 1;
    void (async () => {
      try {
        for (const ws of [...clients]) {
          if (ws.readyState !== 1) clients.delete(ws);
        }
        if (!clients.size) return;

        const both = await ingestBoth();
        const procs = processStatus();
        const targets = listTargets().map((t) => {
          const p = procs[t.id];
          const err = p?.running ? null : shortErr(t.last_error);
          return {
            id: t.id,
            label: t.label,
            platform: t.platform,
            lane: t.lane === "vertical" ? "vertical" : "main",
            enabled: Boolean(t.enabled),
            state: p?.running ? "forwarding" : err ? "error" : "idle",
            error: err,
            uptimeSec: p?.uptimeSec ?? 0,
            outboundBytes: p?.outboundApprox ?? 0,
            keyMasked: maskedKey(t.id, t.stream_key_enc),
          };
        });

        let sessionPayload: unknown = null;
        try {
          const { getLiveSession } = await import("./live/session.js");
          const { peekRuntime } = await import("./live/runtime.js");
          const { mediaStatus } = await import("./live/media.js");
          const session = getLiveSession();
          const runtime = peekRuntime();
          const remainBucket = Math.floor((runtime.remainingMs ?? 0) / 1000);
          const fp = `${runtime.phase}:${remainBucket}:${session.status}`;

          const wantMedia = fp !== lastSessionFp || tickN % 6 === 0;
          lastSessionFp = fp;
          sessionPayload = {
            type: "session",
            session,
            runtime,
            media: wantMedia ? mediaStatus() : undefined,
          };
        } catch {
        }

        broadcast({
          type: "hub",
          ingest: {
            live: both.main.live,
            bytesIn: both.main.bytesIn,
            path: both.main.path,
            vertical: {
              live: both.vertical.live,
              bytesIn: both.vertical.bytesIn,
              path: both.vertical.path,
            },
            chatPlatforms: activePlatforms(),
            chat: chatDiagnostics(),
          },
          targets,
          session: sessionPayload,
        });
      } finally {
        tickBusy = false;
      }
    })();
  }, 2500);
}
