import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { setSetting } from "../db.js";
import { brokerConfigured, buildBrokerConnectUrl } from "./broker-client.js";
import { savePlatformTokens } from "./platform-tokens.js";
import { setOAuthState } from "../youtube/tokens.js";

/** Kick OAuth scopes — chat + identity. Stream Server URL/key stay per-account (paste once). */
const SCOPES = "user:read channel:read chat:write";

export function kickDirectConfigured(): boolean {
  return Boolean(config.kick.clientId && config.kick.clientSecret);
}

/** Prefer local Connect — tokens stay on this egg. */
export function kickConnectMode(): "broker" | "direct" | "none" {
  if (kickDirectConfigured()) return "direct";
  if (brokerConfigured()) return "broker";
  return "none";
}

export function kickRedirectUri(): string {
  if (process.env.KICK_REDIRECT_URI) return process.env.KICK_REDIRECT_URI.replace(/\/$/, "");
  const host = config.publicHost || "localhost";
  const scheme = process.env.OAUTH_RETURN_SCHEME || process.env.YOUTUBE_OAUTH_SCHEME || "http";
  return `${scheme}://${host}:${config.port}/api/v1/oauth/callback/kick`;
}

export function buildKickAuthUrl(): { url: string; state: string; mode: "broker" | "direct" } {
  const mode = kickConnectMode();
  if (mode === "none") {
    throw Object.assign(new Error("Kick Connect is unavailable on this build"), { statusCode: 503 });
  }
  const state = `kick:${randomBytes(16).toString("hex")}`;
  setOAuthState(state);
  if (mode === "broker") {
    return { url: buildBrokerConnectUrl("kick", state), state, mode };
  }
  const params = new URLSearchParams({
    client_id: config.kick.clientId,
    redirect_uri: kickRedirectUri(),
    response_type: "code",
    scope: SCOPES,
    state,
  });
  return { url: `https://id.kick.com/oauth/authorize?${params}`, state, mode };
}

export async function exchangeKickCode(code: string): Promise<{ channel?: string }> {
  const tokenRes = await fetch("https://id.kick.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.kick.clientId,
      client_secret: config.kick.clientSecret,
      redirect_uri: kickRedirectUri(),
      code,
    }),
  });
  const tokenBody = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (!tokenRes.ok || !tokenBody.access_token) {
    throw Object.assign(new Error(tokenBody.error || `Kick token ${tokenRes.status}`), {
      statusCode: 400,
    });
  }

  let channel = "";
  try {
    const me = await fetch("https://api.kick.com/public/v1/users", {
      headers: { Authorization: `Bearer ${tokenBody.access_token}` },
    });
    if (me.ok) {
      const body = (await me.json()) as { data?: Array<{ name?: string; username?: string }> };
      channel = body.data?.[0]?.name || body.data?.[0]?.username || "";
    }
  } catch {
    /* optional */
  }

  savePlatformTokens("kick", {
    accessToken: tokenBody.access_token,
    refreshToken: tokenBody.refresh_token,
    expiresIn: tokenBody.expires_in,
    meta: channel ? { channel } : {},
  });
  if (channel) setSetting("kick_channel_override", channel);

  return { channel: channel || undefined };
}
