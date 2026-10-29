import type { FastifyInstance } from "fastify";
import { bootstrapOk, issueTokens, refresh, verifyAccess } from "./auth.js";
import { activePlatforms, chatDiagnostics, sendChat } from "./chat/engine.js";
import { encrypt, maskKey, decrypt } from "./crypto.js";
import {
  deleteCommand,
  deleteTarget,
  getSetting,
  getTarget,
  listCommands,
  listTargets,
  setSetting,
  setTargetEnabled,
  upsertCommand,
  upsertTarget,
} from "./db.js";
import { processStatus, reconcile, resetTargetBackoff, stopTarget } from "./relay/ffmpeg.js";
import { ingestBoth } from "./relay/mediamtx.js";
import type { Platform } from "./chat/types.js";
import { config } from "./config.js";
import { clientIp, rateLimitLogin, tooMany } from "./security.js";
import {
  assertCommandName,
  assertLane,
  assertShortText,
  assertStreamKey,
  assertTargetId,
  normalizeIngestUrl,
} from "./validate.js";
import { registerYoutubeRoutes } from "./youtube/routes.js";

async function requireAuth(header: string | undefined): Promise<void> {
  if (!header?.startsWith("Bearer ")) throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  await verifyAccess(header.slice(7));
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/health", async () => ({ ok: true, service: "Omnix StreamRelay" }));

  app.post<{ Body: { bootstrapToken?: string } }>("/api/v1/auth/login", async (req, reply) => {
    if (!rateLimitLogin(clientIp(req))) return tooMany(reply);
    const token = String(req.body?.bootstrapToken ?? "");
    if (!bootstrapOk(token)) return reply.code(401).send({ error: "invalid bootstrap token" });
    const tokens = await issueTokens();
    return { ...tokens, wsPath: "/api/v1/ws" };
  });

  app.post<{ Body: { refreshToken?: string } }>("/api/v1/auth/refresh", async (req, reply) => {
    if (!rateLimitLogin(clientIp(req), 60)) return tooMany(reply);
    try {
      const tokens = await refresh(String(req.body?.refreshToken ?? ""));
      return tokens;
    } catch {
      return reply.code(401).send({ error: "invalid refresh token" });
    }
  });

  app.addHook("preHandler", async (req, reply) => {
    const path = req.url.split("?")[0] ?? "";
    if (
      path === "/api/v1/health" ||
      path === "/api/v1/auth/login" ||
      path === "/api/v1/auth/refresh" ||
      path === "/api/v1/youtube/oauth/callback" ||
      !path.startsWith("/api/")
    ) {
      return;
    }
    if (path === "/api/v1/ws") return;
    try {
      await requireAuth(req.headers.authorization);
    } catch {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  await registerYoutubeRoutes(app);

  app.get("/api/v1/setup", async (req) => {
    const hostHeader = String(req.headers.host ?? "");
    const hostFromHeader = hostHeader.split(":")[0] || "";
    const publicHost = config.publicHost || hostFromHeader || "YOUR_HOST";
    const dashboardPort = hostHeader.includes(":")
      ? Number(hostHeader.split(":")[1]) || config.port
      : config.port;
    const obsServer = `rtmp://${publicHost}:${config.rtmpPort}/live`;
    const srtUrl = `srt://${publicHost}:${config.srtPort}?streamid=publish:live/${config.streamKey}`;
    const srtUrlVertical = `srt://${publicHost}:${config.srtPort}?streamid=publish:live/${config.streamKeyVertical}`;
    const dashboardUrl = `http://${publicHost}:${dashboardPort}/`;
    return {
      publicHost,
      dashboardPort,
      rtmpPort: config.rtmpPort,
      srtPort: config.srtPort,
      streamKey: config.streamKey,
      streamKeyVertical: config.streamKeyVertical,
      obsServer,
      obsAuthRequired: false,
      srtUrl,
      srtUrlVertical,
      dashboardUrl,
      chat: chatDiagnostics(),
      kickHint: {
        rtmpUrl: "",
        note: "Kick Server URL is per-account — paste it from Kick Creator → Settings → Stream (leave empty in UI until pasted). Key only in Stream key field.",
      },
      verticalHint:
        "Aitum Vertical / 2nd OBS: same Server URL, stream key = vertical key below. Add targets with lane=vertical to fan-out 9:16.",
    };
  });

  app.get("/api/v1/status", async () => {
    const both = await ingestBoth();
    return {
      uptimeSec: Math.floor(process.uptime()),
      ingest: both.main,
      ingestVertical: both.vertical,
      targets: listTargets().map((t) => ({
        id: t.id,
        label: t.label,
        platform: t.platform,
        lane: t.lane === "vertical" ? "vertical" : "main",
        enabled: Boolean(t.enabled),
        lastError: t.last_error,
        proc: processStatus()[t.id] ?? null,
      })),
      chatPlatforms: activePlatforms(),
      chat: chatDiagnostics(),
    };
  });

  app.get("/api/v1/chat/status", async () => chatDiagnostics());

  app.get("/api/v1/targets", async () =>
    listTargets().map((t) => {
      let keyMasked = "******";
      try {
        keyMasked = maskKey(decrypt(t.stream_key_enc));
      } catch {
        /* ignore */
      }
      return {
        id: t.id,
        label: t.label,
        platform: t.platform,
        lane: t.lane === "vertical" ? "vertical" : "main",
        rtmpUrl: t.rtmp_url,
        keyMasked,
        enabled: Boolean(t.enabled),
        lastError: t.last_error,
      };
    })
  );

  app.put<{
    Params: { id: string };
    Body: {
      label?: string;
      platform?: string;
      rtmpUrl?: string;
      streamKey?: string;
      enabled?: boolean;
      lane?: string;
    };
  }>("/api/v1/targets/:id", async (req, reply) => {
    try {
      const id = assertTargetId(req.params.id);
      const existing = getTarget(id);
      const streamKeyRaw = req.body.streamKey;
      if (!existing && !streamKeyRaw) return reply.code(400).send({ error: "streamKey required for create" });
      const platform = String(req.body.platform ?? existing?.platform ?? "custom").slice(0, 32);
      const label = assertShortText(String(req.body.label ?? existing?.label ?? id), 64);
      const rtmpUrl = normalizeIngestUrl(
        String(req.body.rtmpUrl ?? existing?.rtmp_url ?? ""),
        platform
      );
      const lane = assertLane(req.body.lane ?? existing?.lane ?? "main");
      const enc = streamKeyRaw ? encrypt(assertStreamKey(streamKeyRaw)) : existing!.stream_key_enc;
      if (streamKeyRaw) resetTargetBackoff(id);
      upsertTarget({
        id,
        label,
        platform,
        rtmp_url: rtmpUrl,
        stream_key_enc: enc,
        enabled: req.body.enabled === undefined ? existing?.enabled : req.body.enabled ? 1 : 0,
        lane,
      });
      await reconcile();
      return { ok: true };
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 400).send({ error: err.message });
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/targets/:id/enable", async (req, reply) => {
    try {
      const id = assertTargetId(req.params.id);
      if (!getTarget(id)) return reply.code(404).send({ error: "not found" });
      setTargetEnabled(id, true);
      resetTargetBackoff(id);
      await reconcile();
      return { ok: true, enabled: true };
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 400).send({ error: err.message });
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/targets/:id/disable", async (req, reply) => {
    try {
      const id = assertTargetId(req.params.id);
      if (!getTarget(id)) return reply.code(404).send({ error: "not found" });
      setTargetEnabled(id, false);
      stopTarget(id);
      return { ok: true, enabled: false };
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 400).send({ error: err.message });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/v1/targets/:id", async (req, reply) => {
    try {
      const id = assertTargetId(req.params.id);
      stopTarget(id);
      deleteTarget(id);
      return { ok: true };
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 400).send({ error: err.message });
    }
  });

  app.get("/api/v1/commands", async () => listCommands());

  app.put<{
    Params: { name: string };
    Body: { response?: string; cooldownSec?: number; enabled?: boolean };
  }>("/api/v1/commands/:name", async (req, reply) => {
    try {
      const name = assertCommandName(req.params.name);
      if (!req.body.response) return reply.code(400).send({ error: "response required" });
      const response = assertShortText(String(req.body.response), 400);
      const cooldown = Math.min(Math.max(Number(req.body.cooldownSec ?? 5) || 5, 0), 3600);
      upsertCommand(name, response, cooldown, req.body.enabled === false ? 0 : 1);
      return { ok: true };
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 400).send({ error: err.message });
    }
  });

  app.delete<{ Params: { name: string } }>("/api/v1/commands/:name", async (req, reply) => {
    try {
      deleteCommand(assertCommandName(req.params.name));
      return { ok: true };
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 400).send({ error: err.message });
    }
  });

  app.get("/api/v1/settings/welcome", async () => ({ template: getSetting("welcome") }));

  app.put<{ Body: { template?: string } }>("/api/v1/settings/welcome", async (req, reply) => {
    try {
      if (!req.body.template) return reply.code(400).send({ error: "template required" });
      setSetting("welcome", assertShortText(String(req.body.template), 400));
      return { ok: true };
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 400).send({ error: err.message });
    }
  });

  app.post<{ Body: { text?: string; platforms?: Platform[] } }>("/api/v1/chat/send", async (req, reply) => {
    try {
      const text = assertShortText(String(req.body.text ?? ""), 400);
      await sendChat(text, req.body.platforms);
      return { ok: true };
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 400).send({ error: err.message });
    }
  });
}
