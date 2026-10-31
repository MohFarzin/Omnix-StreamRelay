import type { FastifyInstance } from "fastify";
import { encrypt } from "../crypto.js";
import { getSetting, getTarget, setSetting, setTargetEnabled, upsertTarget } from "../db.js";
import { reconcile, resetTargetBackoff } from "../relay/ffmpeg.js";
import { restartChatEngine } from "../chat/engine.js";
import { assertLane, assertShortText, assertStreamKey, assertTargetId } from "../validate.js";
import { buildAuthUrl, exchangeCode, redirectUri, savePastedRefreshToken } from "./oauth.js";
import { pollDeviceFlow, startDeviceFlow } from "./device.js";
import {
  createDualEncoderLive,
  ensureVerticalEncoderStream,
  getLiveIngest,
  listManagedLives,
  listVideoCategories,
} from "./live.js";
import {
  clearYoutubeTokens,
  youtubeConnected,
  youtubeOAuthConfigured,
  youtubeConnectMode,
  getLiveChatId,
} from "./tokens.js";

const PRESET_KEY = "youtube.live.presets";

function destIdForLane(lane: "main" | "vertical"): string {
  return lane === "vertical" ? "youtube-v" : "youtube";
}

type LivePreset = {
  id: string;
  name: string;
  title: string;
  description: string;
  privacy: "public" | "unlisted" | "private";
  latency: "normal" | "low" | "ultraLow";
  categoryId: string;
  gameTitle: string;
  updatedAt: string;
};

function readPresets(): LivePreset[] {
  try {
    const raw = getSetting(PRESET_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as LivePreset[];
    return Array.isArray(parsed) ? parsed.slice(0, 40) : [];
  } catch {
    return [];
  }
}

function writePresets(list: LivePreset[]): void {
  setSetting(PRESET_KEY, JSON.stringify(list.slice(0, 40)));
}

function normalizePresetBody(body: Record<string, unknown> | undefined): Omit<LivePreset, "id" | "updatedAt"> {
  const privacyRaw = String(body?.privacy ?? "unlisted");
  const privacy =
    privacyRaw === "public" || privacyRaw === "private" ? privacyRaw : "unlisted";
  const latencyRaw = String(body?.latency ?? "normal");
  const latency =
    latencyRaw === "low" || latencyRaw === "ultraLow" ? latencyRaw : "normal";
  return {
    name: assertShortText(String(body?.name ?? "Preset"), 60),
    title: String(body?.title ?? "").slice(0, 100),
    description: String(body?.description ?? "").slice(0, 5000),
    privacy,
    latency,
    categoryId: String(body?.categoryId ?? "").slice(0, 12),
    gameTitle: String(body?.gameTitle ?? "").slice(0, 80),
  };
}

async function pushDestinationFromLive(opts: {
  lane: "main" | "vertical";
  rtmpUrl: string;
  streamKey: string;
  enable: boolean;
  targetId?: string;
  liveChatId?: string | null;
}): Promise<{ targetId: string; enabled: boolean }> {
  const id = assertTargetId(String(opts.targetId || destIdForLane(opts.lane)));
  const existing = getTarget(id);
  const label =
    existing?.label ||
    (opts.lane === "vertical" ? "YouTube · Shorts encoder" : "YouTube · main");
  upsertTarget({
    id,
    label,
    platform: "youtube",
    rtmp_url: opts.rtmpUrl,
    stream_key_enc: encrypt(assertStreamKey(opts.streamKey)),
    enabled: opts.enable ? 1 : existing?.enabled ?? 0,
    lane: opts.lane,
  });
  resetTargetBackoff(id);
  if (opts.enable) setTargetEnabled(id, true);
  await reconcile();
  void restartChatEngine().catch(() => undefined);
  return { targetId: id, enabled: opts.enable };
}

export async function registerYoutubeRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/youtube/status", async () => {
    const mode = youtubeConnectMode();
    const ready = youtubeOAuthConfigured();
    return {
      oauthConfigured: ready,
      connectAvailable: ready,
      connected: youtubeConnected(),
      mode,
      redirectUri: mode === "direct" ? redirectUri() : null,
      liveChatId: getLiveChatId() || null,
      privacy:
        "Your Google/YouTube tokens are stored encrypted only on this Omnix server. OmnixStudio does not receive or keep them.",
      hint: ready
        ? "Connect Google — tokens stay on this machine (device code or local redirect)."
        : "YouTube Connect is unavailable on this build.",
    };
  });

  app.post("/api/v1/youtube/oauth/device/start", async (_req, reply) => {
    try {
      return await startDeviceFlow();
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 400).send({ error: err.message });
    }
  });

  app.post<{ Body: { sessionId?: string } }>("/api/v1/youtube/oauth/device/poll", async (req, reply) => {
    try {
      const sessionId = String(req.body?.sessionId ?? "");
      if (!sessionId) return reply.code(400).send({ error: "sessionId required" });
      return await pollDeviceFlow(sessionId);
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 400).send({ error: err.message });
    }
  });

  app.get("/api/v1/youtube/oauth/start", async (_req, reply) => {
    try {
      const { url, mode } = buildAuthUrl();
      return { url, mode };
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 400).send({ error: err.message });
    }
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/api/v1/youtube/oauth/callback",
    async (req, reply) => {
      try {
        if (req.query.error) {
          return reply.type("text/html").send(oauthResultHtml(false, String(req.query.error)));
        }
        const code = String(req.query.code || "");
        const state = String(req.query.state || "");
        if (!code || !state) {
          return reply.type("text/html").send(oauthResultHtml(false, "missing code/state"));
        }
        await exchangeCode(code, state);
        return reply.type("text/html").send(oauthResultHtml(true, "Google connected. You can close this tab."));
      } catch (e) {
        const err = e as Error;
        return reply.type("text/html").send(oauthResultHtml(false, err.message));
      }
    }
  );

  app.post<{ Body: { refreshToken?: string } }>("/api/v1/youtube/oauth/token", async (req, reply) => {
    try {
      await savePastedRefreshToken(String(req.body?.refreshToken ?? ""));
      return { ok: true, connected: true };
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 400).send({ error: err.message });
    }
  });

  app.post("/api/v1/youtube/oauth/disconnect", async () => {
    clearYoutubeTokens();
    return { ok: true, connected: false };
  });

  app.get("/api/v1/youtube/live/list", async (_req, reply) => {
    try {
      const lives = await listManagedLives();
      return { lives };
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 400).send({ error: err.message });
    }
  });

  app.get<{ Querystring: { region?: string } }>("/api/v1/youtube/categories", async (req, reply) => {
    try {
      const categories = await listVideoCategories(String(req.query.region || "US"));
      return { categories };
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 400).send({ error: err.message });
    }
  });

  app.get("/api/v1/youtube/live/presets", async () => ({ presets: readPresets() }));

  app.post<{ Body: Record<string, unknown> }>("/api/v1/youtube/live/presets", async (req, reply) => {
    try {
      const base = normalizePresetBody(req.body);
      if (!base.title && !base.description && !base.gameTitle) {
        return reply.code(400).send({ error: "Preset needs a title, description, or game" });
      }
      const list = readPresets();
      const preset: LivePreset = {
        id: `p_${Date.now().toString(36)}`,
        ...base,
        updatedAt: new Date().toISOString(),
      };
      list.unshift(preset);
      writePresets(list);
      return { ok: true, preset, presets: readPresets() };
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 400).send({ error: err.message });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/v1/youtube/live/presets/:id", async (req, reply) => {
    const id = String(req.params.id || "");
    if (!id) return reply.code(400).send({ error: "id required" });
    const next = readPresets().filter((p) => p.id !== id);
    writePresets(next);
    return { ok: true, presets: next };
  });

  app.post<{
    Body: {
      broadcastId?: string;
      lane?: string;
      targetId?: string;
      enable?: boolean;
    };
  }>("/api/v1/youtube/live/use", async (req, reply) => {
    try {
      const lane = assertLane(req.body?.lane ?? "main");
      const enable = req.body?.enable !== false;
      const broadcastId = String(req.body?.broadcastId ?? "");
      const ingest = await getLiveIngest(broadcastId);

      const keys =
        lane === "vertical"
          ? await ensureVerticalEncoderStream()
          : {
              streamId: ingest.streamId,
              streamKey: ingest.streamKey,
              rtmpUrl: ingest.rtmpUrl,
            };
      const pushed = await pushDestinationFromLive({
        lane,
        rtmpUrl: keys.rtmpUrl,
        streamKey: keys.streamKey,
        enable,
        targetId: req.body?.targetId,
        liveChatId: ingest.broadcast.liveChatId,
      });

      const { getLiveSession, saveSessionYouTube, setSessionStatus } = await import("../live/session.js");
      const cur = getLiveSession();
      if (cur.status !== "live") {
        saveSessionYouTube({
          mainId: lane === "main" ? ingest.broadcast.broadcastId : cur.youtubeMainId || ingest.broadcast.broadcastId,
          verticalId: ingest.broadcast.broadcastId,
          watchMain:
            lane === "main" ? ingest.broadcast.watchUrl : cur.watchMain || ingest.broadcast.watchUrl,
          watchVertical: ingest.broadcast.watchUrl,
          status: "prepared",
        });
        setSessionStatus("prepared");
      }
      return {
        ok: true,
        ...ingest.broadcast,
        streamId: keys.streamId,
        streamKey: keys.streamKey,
        rtmpUrl: keys.rtmpUrl,
        session: getLiveSession(),
        ...pushed,
      };
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 400).send({ error: err.message });
    }
  });

  app.post<{
    Body: {
      title?: string;
      description?: string;
      privacy?: string;
      lane?: string;
      thumbnailBase64?: string;
      thumbnailMime?: string;
      targetId?: string;
      enable?: boolean;
      scheduledStartIso?: string;
      latency?: string;
      categoryId?: string;
      gameTitle?: string;
    };
  }>("/api/v1/youtube/live/create", async (req, reply) => {
    try {
      const lane = assertLane(req.body?.lane ?? "main");
      const title = assertShortText(String(req.body?.title ?? ""), 100);
      const description = String(req.body?.description ?? "").slice(0, 5000);
      const privacyRaw = String(req.body?.privacy ?? "unlisted");
      const privacy =
        privacyRaw === "public" || privacyRaw === "private" ? privacyRaw : "unlisted";
      const latencyRaw = String(req.body?.latency ?? "normal");
      const latency =
        latencyRaw === "low" || latencyRaw === "ultraLow" ? latencyRaw : "normal";

      const dual = await createDualEncoderLive({
        title,
        description,
        privacy,
        latency,
        categoryId: req.body?.categoryId ? String(req.body.categoryId).slice(0, 12) : undefined,
        gameTitle: req.body?.gameTitle ? String(req.body.gameTitle).slice(0, 80) : undefined,
        thumbnailBase64: req.body?.thumbnailBase64
          ? String(req.body.thumbnailBase64).slice(0, 2_800_000)
          : undefined,
        thumbnailMime: req.body?.thumbnailMime ? String(req.body.thumbnailMime).slice(0, 64) : undefined,
        scheduledStartIso: req.body?.scheduledStartIso
          ? String(req.body.scheduledStartIso).slice(0, 40)
          : undefined,
      });
      const created = {
        broadcastId: dual.broadcastId,
        watchUrl: dual.watchUrl,
        liveChatId: dual.liveChatId,
        streamId: lane === "vertical" ? dual.vertical.streamId : dual.main.streamId,
        streamKey: lane === "vertical" ? dual.vertical.streamKey : dual.main.streamKey,
        rtmpUrl: lane === "vertical" ? dual.vertical.rtmpUrl : dual.main.rtmpUrl,
        thumbnailError: dual.thumbnailError,
      };

      const enable = req.body?.enable !== false;
      const pushed = await pushDestinationFromLive({
        lane,
        rtmpUrl: created.rtmpUrl,
        streamKey: created.streamKey,
        enable,
        targetId: req.body?.targetId,
        liveChatId: created.liveChatId,
      });

      if (lane === "main") {
        await pushDestinationFromLive({
          lane: "vertical",
          rtmpUrl: dual.vertical.rtmpUrl,
          streamKey: dual.vertical.streamKey,
          enable: false,
          liveChatId: dual.liveChatId,
        }).catch(() => undefined);
      }

      const { getLiveSession, saveSessionYouTube, setSessionStatus } = await import("../live/session.js");
      const cur = getLiveSession();
      if (cur.status !== "live") {
        saveSessionYouTube({
          mainId: dual.broadcastId,
          verticalId: dual.broadcastId,
          watchMain: dual.watchUrl,
          watchVertical: dual.watchUrl,
          status: cur.status === "idle" ? "prepared" : undefined,
        });
        if (cur.status === "idle") setSessionStatus("prepared");
      }

      return {
        ok: true,
        ...created,
        ...pushed,
        session: getLiveSession(),
      };
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 400).send({ error: err.message });
    }
  });
}

function oauthResultHtml(ok: boolean, message: string): string {
  const safe = String(message)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Omnix YouTube</title>
<style>body{font-family:system-ui;background:#0a0c10;color:#eef2f7;display:grid;place-items:center;min-height:100vh;margin:0}
card{background:#161b24;border:1px solid #2a3140;border-radius:12px;padding:1.5rem 1.75rem;max-width:28rem}
a{color:#5b9dff}</style></head><body><card>
<h1 style="margin:0 0 .5rem;font-size:1.2rem">${ok ? "Connected" : "Not connected"}</h1>
<p style="margin:0;color:#9aa6b8">${safe}</p>
<p style="margin:1rem 0 0"><a href="/">Back to dashboard</a></p>
<script>try{window.opener&&window.opener.postMessage({type:"omnix-yt-oauth",ok:${ok ? "true" : "false"}},"*")}catch(e){}</script>
</card></body></html>`;
}
