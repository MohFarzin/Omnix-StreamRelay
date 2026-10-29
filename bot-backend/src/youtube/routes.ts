import type { FastifyInstance } from "fastify";
import { encrypt } from "../crypto.js";
import { getTarget, upsertTarget, setTargetEnabled } from "../db.js";
import { reconcile, resetTargetBackoff } from "../relay/ffmpeg.js";
import { restartChatEngine } from "../chat/engine.js";
import { assertLane, assertShortText, assertStreamKey, assertTargetId } from "../validate.js";
import { buildAuthUrl, exchangeCode, redirectUri, savePastedRefreshToken } from "./oauth.js";
import { createAndBindLive } from "./live.js";
import {
  clearYoutubeTokens,
  youtubeConnected,
  youtubeOAuthConfigured,
  getLiveChatId,
} from "./tokens.js";

function destIdForLane(lane: "main" | "vertical"): string {
  return lane === "vertical" ? "youtube-v" : "youtube";
}

export async function registerYoutubeRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/youtube/status", async () => ({
    oauthConfigured: youtubeOAuthConfigured(),
    connected: youtubeConnected(),
    redirectUri: youtubeOAuthConfigured() ? redirectUri() : null,
    liveChatId: getLiveChatId() || null,
    hint: youtubeOAuthConfigured()
      ? "Add this exact redirect URI in Google Cloud → Credentials → OAuth client."
      : "Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET (egg Startup or .env), then restart.",
  }));

  app.get("/api/v1/youtube/oauth/start", async (_req, reply) => {
    try {
      const { url } = buildAuthUrl();
      return { url, redirectUri: redirectUri() };
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 400).send({ error: err.message });
    }
  });

  // Browser redirect from Google (may arrive without Authorization header — use one-time state)
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
    };
  }>("/api/v1/youtube/live/create", async (req, reply) => {
    try {
      const lane = assertLane(req.body?.lane ?? "main");
      const title = assertShortText(String(req.body?.title ?? ""), 100);
      const description = String(req.body?.description ?? "").slice(0, 5000);
      const privacyRaw = String(req.body?.privacy ?? "unlisted");
      const privacy =
        privacyRaw === "public" || privacyRaw === "private" ? privacyRaw : "unlisted";

      const created = await createAndBindLive({
        title,
        description,
        privacy,
        lane,
        thumbnailBase64: req.body?.thumbnailBase64
          ? String(req.body.thumbnailBase64).slice(0, 2_800_000)
          : undefined,
        thumbnailMime: req.body?.thumbnailMime ? String(req.body.thumbnailMime).slice(0, 64) : undefined,
        scheduledStartIso: req.body?.scheduledStartIso
          ? String(req.body.scheduledStartIso).slice(0, 40)
          : undefined,
      });

      const id = assertTargetId(String(req.body?.targetId || destIdForLane(lane)));
      const existing = getTarget(id);
      const label =
        existing?.label ||
        (lane === "vertical" ? "YouTube · vertical" : "YouTube · main");
      const enable = req.body?.enable !== false;

      upsertTarget({
        id,
        label,
        platform: "youtube",
        rtmp_url: created.rtmpUrl,
        stream_key_enc: encrypt(assertStreamKey(created.streamKey)),
        enabled: enable ? 1 : existing?.enabled ?? 0,
        lane,
      });
      resetTargetBackoff(id);
      if (enable) setTargetEnabled(id, true);
      await reconcile();
      void restartChatEngine().catch(() => undefined);

      return {
        ok: true,
        ...created,
        targetId: id,
        enabled: enable,
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
