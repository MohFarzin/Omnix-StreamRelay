import type { WebSocket } from "ws";
import type { ChatMessage } from "./chat/types.js";
import { onChat } from "./chat/engine.js";
import { processStatus } from "./relay/ffmpeg.js";
import { ingestBoth } from "./relay/mediamtx.js";
import { listTargets } from "./db.js";
import { decrypt, maskKey } from "./crypto.js";
import { activePlatforms, chatDiagnostics } from "./chat/engine.js";

const clients = new Set<WebSocket>();

export function broadcast(obj: unknown): void {
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

export function startHub(): void {
  onChat((msg: ChatMessage) => broadcast({ type: "chat", ...msg }));
  let tickBusy = false;
  setInterval(() => {
    if (tickBusy) return;
    tickBusy = true;
    void (async () => {
      try {
        for (const ws of [...clients]) {
          if (ws.readyState !== 1) clients.delete(ws);
        }
        const both = await ingestBoth();
        broadcast({
          type: "ingest",
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
        });
        const procs = processStatus();
        for (const t of listTargets()) {
          const p = procs[t.id];
          let keyMasked = "******";
          try {
            keyMasked = maskKey(decrypt(t.stream_key_enc));
          } catch {
            /* ignore */
          }
          const err = p?.running ? null : shortErr(t.last_error);
          broadcast({
            type: "target",
            id: t.id,
            label: t.label,
            platform: t.platform,
            lane: t.lane === "vertical" ? "vertical" : "main",
            enabled: Boolean(t.enabled),
            state: p?.running ? "forwarding" : err ? "error" : "idle",
            error: err,
            uptimeSec: p?.uptimeSec ?? 0,
            outboundBytes: p?.outboundApprox ?? 0,
            keyMasked,
          });
        }
      } finally {
        tickBusy = false;
      }
    })();
  }, 1500);
}
