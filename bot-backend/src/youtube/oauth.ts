import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { brokerConfigured, brokerRefresh, buildBrokerConnectUrl } from "../oauth/broker-client.js";
import {
  consumeOAuthState,
  getStoredAccessToken,
  getStoredRefreshToken,
  saveYoutubeTokens,
  setOAuthState,
  youtubeConnectMode,
  youtubeOAuthConfigured,
} from "./tokens.js";

const SCOPES = [
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/youtube.upload",
].join(" ");

export function redirectUri(): string {
  if (process.env.YOUTUBE_REDIRECT_URI) return process.env.YOUTUBE_REDIRECT_URI.replace(/\/$/, "");
  const host = config.publicHost || "localhost";
  const port = config.port;
  const scheme = process.env.YOUTUBE_OAUTH_SCHEME || "http";
  return `${scheme}://${host}:${port}/api/v1/youtube/oauth/callback`;
}

export function buildAuthUrl(): { url: string; state: string; mode: "broker" | "direct" } {
  const mode = youtubeConnectMode();
  if (mode === "none") {
    throw Object.assign(new Error("YouTube Connect is unavailable on this build"), { statusCode: 503 });
  }
  const state = randomBytes(16).toString("hex");
  setOAuthState(state);
  if (mode === "broker") {
    return { url: buildBrokerConnectUrl("youtube", state), state, mode };
  }
  const params = new URLSearchParams({
    client_id: config.youtube.clientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, state, mode };
}

async function tokenRequest(body: Record<string, string>): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !json.access_token) {
    throw Object.assign(
      new Error(json.error_description || json.error || `token exchange ${res.status}`),
      { statusCode: 400 }
    );
  }
  return json as { access_token: string; refresh_token?: string; expires_in?: number };
}

export async function exchangeCode(code: string, state: string): Promise<void> {
  if (!consumeOAuthState(state)) {
    throw Object.assign(new Error("Invalid or expired OAuth state — try Connect Google again"), {
      statusCode: 400,
    });
  }
  if (!config.youtube.clientId || !config.youtube.clientSecret) {
    throw Object.assign(new Error("Direct YouTube OAuth is not configured on this host"), {
      statusCode: 503,
    });
  }
  const json = await tokenRequest({
    code,
    client_id: config.youtube.clientId,
    client_secret: config.youtube.clientSecret,
    redirect_uri: redirectUri(),
    grant_type: "authorization_code",
  });
  saveYoutubeTokens({
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresIn: json.expires_in,
  });
}

/** Ops-only fallback — not shown in normal Streamlabs-style UI. */
export async function savePastedRefreshToken(refreshToken: string): Promise<void> {
  const token = refreshToken.trim();
  if (token.length < 20) {
    throw Object.assign(new Error("refresh token looks too short"), { statusCode: 400 });
  }
  if (!youtubeOAuthConfigured() || brokerConfigured()) {
    // Allow paste only for direct mode
    if (!config.youtube.clientId || !config.youtube.clientSecret) {
      throw Object.assign(new Error("Paste-token fallback needs direct OAuth on this host"), {
        statusCode: 400,
      });
    }
  }
  const json = await tokenRequest({
    client_id: config.youtube.clientId,
    client_secret: config.youtube.clientSecret,
    refresh_token: token,
    grant_type: "refresh_token",
  });
  saveYoutubeTokens({
    accessToken: json.access_token,
    refreshToken: token,
    expiresIn: json.expires_in,
  });
}

export async function getValidAccessToken(): Promise<string> {
  const cached = getStoredAccessToken();
  if (cached?.token && cached.expiresAt > Date.now() + 30_000) return cached.token;

  const refresh = getStoredRefreshToken();
  if (!refresh) {
    throw Object.assign(new Error("YouTube not connected — Connect Google first"), {
      statusCode: 401,
    });
  }

  if (brokerConfigured()) {
    const json = await brokerRefresh("youtube", refresh);
    saveYoutubeTokens({
      accessToken: json.accessToken,
      refreshToken: json.refreshToken,
      expiresIn: json.expiresIn,
    });
    return json.accessToken;
  }

  if (!config.youtube.clientId || !config.youtube.clientSecret) {
    if (cached?.token) return cached.token;
    throw Object.assign(new Error("YouTube Connect is unavailable on this build"), { statusCode: 503 });
  }
  const json = await tokenRequest({
    client_id: config.youtube.clientId,
    client_secret: config.youtube.clientSecret,
    refresh_token: refresh,
    grant_type: "refresh_token",
  });
  saveYoutubeTokens({
    accessToken: json.access_token,
    expiresIn: json.expires_in,
  });
  return json.access_token;
}
