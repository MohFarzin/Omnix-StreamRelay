




import { config } from "../config.js";
import { saveYoutubeTokens } from "./tokens.js";

const SCOPES = [
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/youtube.upload",
].join(" ");

export type DeviceSession = {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  verificationUrlComplete?: string;
  intervalSec: number;
  expiresAt: number;
};


const pending = new Map<string, DeviceSession & { id: string }>();

export function deviceFlowConfigured(): boolean {
  return Boolean(config.youtube.clientId && config.youtube.clientSecret);
}

export async function startDeviceFlow(): Promise<{
  sessionId: string;
  userCode: string;
  verificationUrl: string;
  verificationUrlComplete?: string;
  intervalSec: number;
  expiresInSec: number;
}> {
  if (!deviceFlowConfigured()) {
    throw Object.assign(new Error("YouTube Connect is unavailable on this build"), { statusCode: 503 });
  }
  const res = await fetch("https://oauth2.googleapis.com/device/code", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.youtube.clientId,
      scope: SCOPES,
    }),
  });
  const body = (await res.json()) as {
    device_code?: string;
    user_code?: string;
    verification_url?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !body.device_code || !body.user_code) {
    throw Object.assign(
      new Error(
        body.error_description ||
          body.error ||
          "Device Connect failed — use redirect Connect, or create a Google OAuth client of type “TVs and Limited Input devices”."
      ),
      { statusCode: 400 }
    );
  }
  const sessionId = body.device_code.slice(0, 16);
  const expiresIn = Number(body.expires_in ?? 1800);
  const intervalSec = Math.max(3, Number(body.interval ?? 5));
  const verificationUrl = body.verification_uri || body.verification_url || "https://www.google.com/device";
  pending.set(sessionId, {
    id: sessionId,
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUrl,
    verificationUrlComplete: body.verification_uri_complete,
    intervalSec,
    expiresAt: Date.now() + expiresIn * 1000,
  });

  for (const [k, v] of pending) {
    if (v.expiresAt < Date.now()) pending.delete(k);
  }
  return {
    sessionId,
    userCode: body.user_code,
    verificationUrl,
    verificationUrlComplete: body.verification_uri_complete,
    intervalSec,
    expiresInSec: expiresIn,
  };
}

export async function pollDeviceFlow(
  sessionId: string
): Promise<{ status: "pending" | "slow_down" | "connected"; message?: string }> {
  const session = pending.get(sessionId);
  if (!session) {
    throw Object.assign(new Error("Connect session expired — start again"), { statusCode: 400 });
  }
  if (session.expiresAt < Date.now()) {
    pending.delete(sessionId);
    throw Object.assign(new Error("Connect session expired — start again"), { statusCode: 400 });
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.youtube.clientId,
      client_secret: config.youtube.clientSecret,
      device_code: session.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  const body = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (body.access_token) {
    saveYoutubeTokens({
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresIn: body.expires_in,
    });
    pending.delete(sessionId);
    return { status: "connected" };
  }

  if (body.error === "authorization_pending") {
    return { status: "pending" };
  }
  if (body.error === "slow_down") {
    return { status: "slow_down", message: "Polling too fast — waiting…" };
  }
  if (body.error === "expired_token" || body.error === "access_denied") {
    pending.delete(sessionId);
    throw Object.assign(new Error(body.error_description || body.error || "Connect denied/expired"), {
      statusCode: 400,
    });
  }
  throw Object.assign(new Error(body.error_description || body.error || `token poll ${res.status}`), {
    statusCode: 400,
  });
}
