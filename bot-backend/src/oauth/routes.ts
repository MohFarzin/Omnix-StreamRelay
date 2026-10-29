import type { FastifyInstance } from "fastify";
import { setSetting } from "../db.js";
import { restartChatEngine } from "../chat/engine.js";
import {
  clearYoutubeTokens,
  consumeOAuthState,
  saveYoutubeTokens,
  youtubeConnected,
  youtubeConnectMode,
} from "../youtube/tokens.js";
import { brokerConfigured, redeemBrokerTicket } from "./broker-client.js";
import {
  clearPlatformTokens,
  getPlatformMeta,
  platformConnected,
  savePlatformTokens,
} from "./platform-tokens.js";
import { buildKickAuthUrl, exchangeKickCode, kickConnectMode, kickRedirectUri } from "./kick.js";
import {
  buildTwitchAuthUrl,
  exchangeTwitchCode,
  pushTwitchDestination,
  twitchConnectMode,
  twitchRedirectUri,
} from "./twitch.js";
import { getPlatformAccess } from "./platform-tokens.js";
import {
  getOrCreateLinkPairingCode,
  ingestLinkPush,
  rotateLinkPairingCode,
  verifyLinkPairingCode,
} from "./link.js";
import { config } from "../config.js";

export async function registerOAuthRoutes(app: FastifyInstance): Promise<void> {
  /** Omnix Link pairing — show in dashboard; used by Broker site to push tokens here. */
  app.get("/api/v1/oauth/link/status", async () => ({
    pairingCode: getOrCreateLinkPairingCode(),
    publicUrl: config.publicHost
      ? `${process.env.OAUTH_RETURN_SCHEME || process.env.YOUTUBE_OAUTH_SCHEME || "http"}://${config.publicHost}:${config.port}`
      : null,
    hint: "Add this URL + pairing code on Omnix Link, then Connect platforms there. Tokens are saved on this server.",
  }));

  app.post("/api/v1/oauth/link/rotate", async () => ({
    pairingCode: rotateLinkPairingCode(),
  }));

  app.post<{ Body: { pairingCode?: string } }>("/api/v1/oauth/link/verify", async (req, reply) => {
    const code = String(req.body?.pairingCode ?? "");
    if (!verifyLinkPairingCode(code)) {
      return reply.code(401).send({ error: "Invalid pairing code" });
    }
    return { ok: true, service: "Omnix StreamRelay" };
  });

  app.post<{
    Body: {
      pairingCode?: string;
      platform?: string;
      accessToken?: string;
      refreshToken?: string;
      expiresIn?: number;
      extra?: Record<string, string>;
    };
  }>("/api/v1/oauth/link/push", async (req, reply) => {
    try {
      return await ingestLinkPush({
        pairingCode: String(req.body?.pairingCode ?? ""),
        platform: String(req.body?.platform ?? ""),
        accessToken: String(req.body?.accessToken ?? ""),
        refreshToken: req.body?.refreshToken,
        expiresIn: req.body?.expiresIn,
        extra: req.body?.extra,
      });
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 400).send({ error: err.message });
    }
  });

  app.get("/api/v1/oauth/status", async () => ({
    broker: brokerConfigured(),
    youtube: {
      connectAvailable: youtubeConnectMode() !== "none",
      connected: youtubeConnected(),
      mode: youtubeConnectMode(),
    },
    twitch: {
      connectAvailable: twitchConnectMode() !== "none",
      connected: platformConnected("twitch"),
      mode: twitchConnectMode(),
      redirectUri: twitchConnectMode() === "direct" ? twitchRedirectUri() : null,
      meta: getPlatformMeta("twitch"),
      hint:
        twitchConnectMode() === "none"
          ? "Twitch Connect unavailable on this build"
          : "Connect Twitch for chat; stream key is pulled into Destinations when Twitch allows it",
    },
    kick: {
      connectAvailable: kickConnectMode() !== "none",
      connected: platformConnected("kick"),
      mode: kickConnectMode(),
      redirectUri: kickConnectMode() === "direct" ? kickRedirectUri() : null,
      meta: getPlatformMeta("kick"),
      hint:
        kickConnectMode() === "none"
          ? "Kick Connect unavailable on this build"
          : "Connect Kick for chat; paste Kick Server URL + stream key once under Destinations (per-account)",
    },
  }));

  app.get<{ Params: { platform: string } }>("/api/v1/oauth/:platform/start", async (req, reply) => {
    try {
      const platform = String(req.params.platform || "").toLowerCase();
      if (platform === "youtube") {
        const { buildAuthUrl } = await import("../youtube/oauth.js");
        const { url, mode } = buildAuthUrl();
        return { url, mode };
      }
      if (platform === "twitch") {
        const { url, mode } = buildTwitchAuthUrl();
        return { url, mode };
      }
      if (platform === "kick") {
        const { url, mode } = buildKickAuthUrl();
        return { url, mode };
      }
      return reply.code(400).send({ error: "platform must be youtube|twitch|kick" });
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 400).send({ error: err.message });
    }
  });

  app.post<{ Params: { platform: string } }>("/api/v1/oauth/:platform/disconnect", async (req, reply) => {
    const platform = String(req.params.platform || "").toLowerCase();
    if (platform === "youtube") {
      clearYoutubeTokens();
      return { ok: true };
    }
    if (platform === "twitch" || platform === "kick") {
      clearPlatformTokens(platform);
      void restartChatEngine().catch(() => undefined);
      return { ok: true };
    }
    return reply.code(400).send({ error: "unknown platform" });
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/api/v1/oauth/callback/twitch",
    async (req, reply) => {
      try {
        if (req.query.error) {
          return reply.type("text/html").send(resultHtml(false, String(req.query.error)));
        }
        const code = String(req.query.code || "");
        const state = String(req.query.state || "");
        if (!code || !state || !consumeOAuthState(state)) {
          return reply.type("text/html").send(resultHtml(false, "Invalid Twitch Connect session"));
        }
        const { login, streamKey } = await exchangeTwitchCode(code);
        void restartChatEngine().catch(() => undefined);
        const extra = streamKey
          ? ` Channel ${login}. Stream key saved to Destinations (Twitch · main).`
          : ` Channel ${login}. Add/paste stream key under Destinations if missing.`;
        return reply.type("text/html").send(resultHtml(true, `Twitch connected.${extra}`));
      } catch (e) {
        return reply.type("text/html").send(resultHtml(false, (e as Error).message));
      }
    }
  );

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/api/v1/oauth/callback/kick",
    async (req, reply) => {
      try {
        if (req.query.error) {
          return reply.type("text/html").send(resultHtml(false, String(req.query.error)));
        }
        const code = String(req.query.code || "");
        const state = String(req.query.state || "");
        if (!code || !state || !consumeOAuthState(state)) {
          return reply.type("text/html").send(resultHtml(false, "Invalid Kick Connect session"));
        }
        const { channel } = await exchangeKickCode(code);
        void restartChatEngine().catch(() => undefined);
        return reply
          .type("text/html")
          .send(
            resultHtml(
              true,
              `Kick connected${channel ? ` (${channel})` : ""}. Paste Kick Server URL + stream key once under Destinations, then turn On.`
            )
          );
      } catch (e) {
        return reply.type("text/html").send(resultHtml(false, (e as Error).message));
      }
    }
  );

  /** After Twitch Connect, retry pulling stream key into Destinations. */
  app.post("/api/v1/oauth/twitch/sync-key", async (_req, reply) => {
    try {
      const access = getPlatformAccess("twitch");
      const meta = getPlatformMeta("twitch");
      if (!access?.token || !meta.user_id || !configHasTwitchApp()) {
        return reply.code(400).send({ error: "Connect Twitch first" });
      }
      const keyRes = await fetch(
        `https://api.twitch.tv/helix/streams/key?broadcaster_id=${encodeURIComponent(meta.user_id)}`,
        {
          headers: {
            Authorization: `Bearer ${access.token}`,
            "Client-Id": process.env.TWITCH_CLIENT_ID || "",
          },
        }
      );
      const keyJson = (await keyRes.json()) as { data?: Array<{ stream_key?: string }> };
      const streamKey = keyJson.data?.[0]?.stream_key;
      if (!streamKey) return reply.code(400).send({ error: "Twitch did not return a stream key" });
      await pushTwitchDestination(streamKey);
      return { ok: true, targetId: "twitch" };
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 400).send({ error: err.message });
    }
  });

  app.get<{ Querystring: { ticket?: string; sig?: string; state?: string; error?: string } }>(
    "/api/v1/oauth/broker/return",
    async (req, reply) => {
      try {
        if (req.query.error) {
          return reply.type("text/html").send(resultHtml(false, String(req.query.error)));
        }
        const ticket = String(req.query.ticket || "");
        const sig = String(req.query.sig || "");
        const state = String(req.query.state || "");
        if (!ticket || !sig || !state) {
          return reply.type("text/html").send(resultHtml(false, "missing ticket/state"));
        }
        if (!consumeOAuthState(state)) {
          return reply.type("text/html").send(resultHtml(false, "Invalid or expired Connect session — try again"));
        }
        const redeemed = await redeemBrokerTicket(ticket, sig);
        if (redeemed.platform === "youtube") {
          saveYoutubeTokens({
            accessToken: redeemed.accessToken,
            refreshToken: redeemed.refreshToken,
            expiresIn: redeemed.expiresIn,
          });
        } else {
          savePlatformTokens(redeemed.platform, {
            accessToken: redeemed.accessToken,
            refreshToken: redeemed.refreshToken,
            expiresIn: redeemed.expiresIn,
            meta: redeemed.extra,
          });
          if (redeemed.extra?.channel) {
            setSetting(`${redeemed.platform}_channel_override`, redeemed.extra.channel);
          }
          if (redeemed.platform === "twitch" && redeemed.accessToken && redeemed.extra?.user_id) {
            try {
              const keyRes = await fetch(
                `https://api.twitch.tv/helix/streams/key?broadcaster_id=${encodeURIComponent(redeemed.extra.user_id)}`,
                {
                  headers: {
                    Authorization: `Bearer ${redeemed.accessToken}`,
                    "Client-Id": process.env.TWITCH_CLIENT_ID || "",
                  },
                }
              );
              const keyJson = (await keyRes.json()) as { data?: Array<{ stream_key?: string }> };
              const streamKey = keyJson.data?.[0]?.stream_key;
              if (streamKey) await pushTwitchDestination(streamKey);
            } catch {
              /* optional */
            }
          }
          void restartChatEngine().catch(() => undefined);
        }
        return reply
          .type("text/html")
          .send(resultHtml(true, `${label(redeemed.platform)} connected. You can close this tab.`));
      } catch (e) {
        return reply.type("text/html").send(resultHtml(false, (e as Error).message));
      }
    }
  );
}

function configHasTwitchApp(): boolean {
  return Boolean(process.env.TWITCH_CLIENT_ID);
}

function label(p: string): string {
  if (p === "youtube") return "Google / YouTube";
  if (p === "twitch") return "Twitch";
  if (p === "kick") return "Kick";
  return p;
}

function resultHtml(ok: boolean, message: string): string {
  const safe = String(message)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Omnix Connect</title>
<style>body{font-family:system-ui;background:#0a0c10;color:#eef2f7;display:grid;place-items:center;min-height:100vh;margin:0}
card{background:#161b24;border:1px solid #2a3140;border-radius:12px;padding:1.5rem 1.75rem;max-width:28rem}
a{color:#5b9dff}</style></head><body><card>
<h1 style="margin:0 0 .5rem;font-size:1.2rem">${ok ? "Connected" : "Not connected"}</h1>
<p style="margin:0;color:#9aa6b8">${safe}</p>
<p style="margin:1rem 0 0"><a href="/">Back to dashboard</a></p>
<script>try{window.opener&&window.opener.postMessage({type:"omnix-oauth",ok:${ok ? "true" : "false"}},"*")}catch(e){}</script>
</card></body></html>`;
}
