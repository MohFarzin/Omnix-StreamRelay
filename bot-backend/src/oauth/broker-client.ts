import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

export type BrokerPlatform = "youtube" | "twitch" | "kick";

export function brokerConfigured(): boolean {
  return Boolean(config.oauthBrokerUrl && config.oauthBrokerSecret);
}

export function publicReturnBase(): string {
  const host = config.publicHost || "localhost";
  const scheme = process.env.OAUTH_RETURN_SCHEME || process.env.YOUTUBE_OAUTH_SCHEME || "http";
  return `${scheme}://${host}:${config.port}`;
}

function sign(payload: string): string {
  return createHmac("sha256", config.oauthBrokerSecret).update(payload).digest("hex");
}

export function verifyBrokerSig(ticket: string, sig: string): boolean {
  if (!config.oauthBrokerSecret || !ticket || !sig) return false;
  const expected = sign(ticket);
  try {
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(sig, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function buildBrokerConnectUrl(platform: BrokerPlatform, eggState: string): string {
  if (!brokerConfigured()) {
    throw Object.assign(new Error("YouTube Connect is unavailable on this build"), { statusCode: 503 });
  }
  const returnUrl = `${publicReturnBase()}/api/v1/oauth/broker/return`;
  const params = new URLSearchParams({
    platform,
    return_url: returnUrl,
    state: eggState,
  });
  return `${config.oauthBrokerUrl}/v1/connect?${params}`;
}

export async function redeemBrokerTicket(
  ticket: string,
  sig: string
): Promise<{
  platform: BrokerPlatform;
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  extra?: Record<string, string>;
}> {
  if (!verifyBrokerSig(ticket, sig)) {
    throw Object.assign(new Error("Invalid broker signature"), { statusCode: 400 });
  }
  const res = await fetch(`${config.oauthBrokerUrl}/v1/ticket/${encodeURIComponent(ticket)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Omnix-Broker-Secret": config.oauthBrokerSecret,
    },
    body: JSON.stringify({ sig }),
  });
  const json = (await res.json()) as {
    error?: string;
    platform?: BrokerPlatform;
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    extra?: Record<string, string>;
  };
  if (!res.ok || !json.access_token || !json.platform) {
    throw Object.assign(new Error(json.error || `broker redeem ${res.status}`), { statusCode: 400 });
  }
  return {
    platform: json.platform,
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresIn: json.expires_in,
    extra: json.extra,
  };
}

export async function brokerRefresh(
  platform: BrokerPlatform,
  refreshToken: string
): Promise<{ accessToken: string; expiresIn?: number; refreshToken?: string }> {
  if (!brokerConfigured()) {
    throw Object.assign(new Error("broker not configured"), { statusCode: 503 });
  }
  const res = await fetch(`${config.oauthBrokerUrl}/v1/refresh`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Omnix-Broker-Secret": config.oauthBrokerSecret,
    },
    body: JSON.stringify({ platform, refresh_token: refreshToken }),
  });
  const json = (await res.json()) as {
    error?: string;
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
  };
  if (!res.ok || !json.access_token) {
    throw Object.assign(new Error(json.error || `broker refresh ${res.status}`), { statusCode: 400 });
  }
  return {
    accessToken: json.access_token,
    expiresIn: json.expires_in,
    refreshToken: json.refresh_token,
  };
}

export function newEggOAuthState(): string {
  return randomBytes(16).toString("hex");
}
