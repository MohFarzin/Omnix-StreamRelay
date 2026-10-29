import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { encrypt } from "../crypto.js";
import { getTarget, setSetting, upsertTarget } from "../db.js";
import { reconcile, resetTargetBackoff } from "../relay/ffmpeg.js";
import { assertStreamKey } from "../validate.js";
import { brokerConfigured, buildBrokerConnectUrl } from "./broker-client.js";
import { savePlatformTokens } from "./platform-tokens.js";
import { setOAuthState } from "../youtube/tokens.js";

const SCOPES = [
  "chat:read",
  "chat:edit",
  "user:read:email",
  "channel:read:stream_key",
].join(" ");

export function twitchDirectConfigured(): boolean {
  return Boolean(config.twitch.clientId && config.twitch.clientSecret);
}

/** Prefer local Connect — tokens stay on this egg. */
export function twitchConnectMode(): "broker" | "direct" | "none" {
  if (twitchDirectConfigured()) return "direct";
  if (brokerConfigured()) return "broker";
  return "none";
}

export function twitchRedirectUri(): string {
  if (process.env.TWITCH_REDIRECT_URI) return process.env.TWITCH_REDIRECT_URI.replace(/\/$/, "");
  const host = config.publicHost || "localhost";
  const scheme = process.env.OAUTH_RETURN_SCHEME || process.env.YOUTUBE_OAUTH_SCHEME || "http";
  return `${scheme}://${host}:${config.port}/api/v1/oauth/callback/twitch`;
}

export function buildTwitchAuthUrl(): { url: string; state: string; mode: "broker" | "direct" } {
  const mode = twitchConnectMode();
  if (mode === "none") {
    throw Object.assign(new Error("Twitch Connect is unavailable on this build"), { statusCode: 503 });
  }
  const state = `twitch:${randomBytes(16).toString("hex")}`;
  setOAuthState(state);
  if (mode === "broker") {
    return { url: buildBrokerConnectUrl("twitch", state), state, mode };
  }
  const params = new URLSearchParams({
    client_id: config.twitch.clientId,
    redirect_uri: twitchRedirectUri(),
    response_type: "code",
    scope: SCOPES,
    state,
    force_verify: "true",
  });
  return { url: `https://id.twitch.tv/oauth2/authorize?${params}`, state, mode };
}

export async function exchangeTwitchCode(code: string): Promise<{
  login: string;
  userId: string;
  streamKey?: string;
}> {
  const tokenRes = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.twitch.clientId,
      client_secret: config.twitch.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: twitchRedirectUri(),
    }),
  });
  const tokenBody = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    message?: string;
  };
  if (!tokenRes.ok || !tokenBody.access_token) {
    throw Object.assign(new Error(tokenBody.message || `Twitch token ${tokenRes.status}`), {
      statusCode: 400,
    });
  }

  const userRes = await fetch("https://api.twitch.tv/helix/users", {
    headers: {
      Authorization: `Bearer ${tokenBody.access_token}`,
      "Client-Id": config.twitch.clientId,
    },
  });
  const userJson = (await userRes.json()) as { data?: Array<{ id?: string; login?: string }> };
  const user = userJson.data?.[0];
  const login = user?.login || "";
  const userId = user?.id || "";
  if (!login) {
    throw Object.assign(new Error("Twitch did not return a username"), { statusCode: 400 });
  }

  savePlatformTokens("twitch", {
    accessToken: tokenBody.access_token,
    refreshToken: tokenBody.refresh_token,
    expiresIn: tokenBody.expires_in,
    meta: { channel: login, user_id: userId },
  });
  setSetting("twitch_channel_override", login);

  let streamKey: string | undefined;
  try {
    const keyRes = await fetch(`https://api.twitch.tv/helix/streams/key?broadcaster_id=${encodeURIComponent(userId)}`, {
      headers: {
        Authorization: `Bearer ${tokenBody.access_token}`,
        "Client-Id": config.twitch.clientId,
      },
    });
    const keyJson = (await keyRes.json()) as { data?: Array<{ stream_key?: string }> };
    streamKey = keyJson.data?.[0]?.stream_key;
  } catch {
    /* optional */
  }

  if (streamKey) {
    await pushTwitchDestination(streamKey);
  }

  return { login, userId, streamKey };
}

export async function pushTwitchDestination(streamKey: string): Promise<void> {
  const id = "twitch";
  const existing = getTarget(id);
  upsertTarget({
    id,
    label: existing?.label || "Twitch · main",
    platform: "twitch",
    rtmp_url: "rtmp://live.twitch.tv/app",
    stream_key_enc: encrypt(assertStreamKey(streamKey)),
    enabled: existing?.enabled ?? 0,
    lane: "main",
  });
  resetTargetBackoff(id);
  await reconcile();
}
