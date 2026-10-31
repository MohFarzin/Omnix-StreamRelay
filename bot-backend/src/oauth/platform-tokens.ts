import { decrypt, encrypt } from "../crypto.js";
import { getSetting, setSetting } from "../db.js";
import { config } from "../config.js";
import { brokerConfigured } from "./broker-client.js";

type Platform = "twitch" | "kick";

function keys(p: Platform) {
  return {
    refresh: `${p}_oauth_refresh_enc`,
    access: `${p}_oauth_access_enc`,
    exp: `${p}_oauth_access_exp`,
    meta: `${p}_oauth_meta`,
  };
}

export function savePlatformTokens(
  platform: Platform,
  bundle: { accessToken: string; refreshToken?: string; expiresIn?: number; meta?: Record<string, string> }
): void {
  const k = keys(platform);
  setSetting(k.access, encrypt(bundle.accessToken));
  const exp = Date.now() + Math.max(60, Number(bundle.expiresIn ?? 3600) - 60) * 1000;
  setSetting(k.exp, String(exp));
  if (bundle.refreshToken) setSetting(k.refresh, encrypt(bundle.refreshToken));
  if (bundle.meta) setSetting(k.meta, JSON.stringify(bundle.meta));
}

export function clearPlatformTokens(platform: Platform): void {
  const k = keys(platform);
  setSetting(k.refresh, "");
  setSetting(k.access, "");
  setSetting(k.exp, "0");
  setSetting(k.meta, "");
}

export function platformConnected(platform: Platform): boolean {
  const k = keys(platform);
  const enc = getSetting(k.refresh) || getSetting(k.access);
  if (enc) {
    try {
      decrypt(enc);
      return true;
    } catch {}
  }
  if (platform === "twitch") return Boolean(config.twitch.accessToken);
  if (platform === "kick") return Boolean(config.kick.accessToken);
  return false;
}

export function getPlatformAccess(platform: Platform): { token: string; expiresAt: number } | null {
  const k = keys(platform);
  const enc = getSetting(k.access);
  const exp = Number(getSetting(k.exp) || 0);
  if (enc) {
    try {
      return { token: decrypt(enc), expiresAt: exp };
    } catch {
      return null;
    }
  }
  if (platform === "twitch" && config.twitch.accessToken) {
    return { token: config.twitch.accessToken, expiresAt: Date.now() + 3_600_000 };
  }
  if (platform === "kick" && config.kick.accessToken) {
    return { token: config.kick.accessToken, expiresAt: Date.now() + 3_600_000 };
  }
  return null;
}

export function getPlatformRefresh(platform: Platform): string | null {
  const enc = getSetting(keys(platform).refresh);
  if (!enc) {
    if (platform === "twitch") return config.twitch.refreshToken || null;
    return null;
  }
  try {
    return decrypt(enc);
  } catch {
    return null;
  }
}

export function getPlatformMeta(platform: Platform): Record<string, string> {
  const raw = getSetting(keys(platform).meta);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

export function platformConnectAvailable(platform: Platform): boolean {
  if (brokerConfigured()) return true;
  if (platform === "twitch") return Boolean(config.twitch.clientId && config.twitch.clientSecret);
  if (platform === "kick") return Boolean(config.kick.clientId && config.kick.clientSecret);
  return false;
}
