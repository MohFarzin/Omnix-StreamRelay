import { decrypt, encrypt } from "../crypto.js";
import { getSetting, setSetting } from "../db.js";
import { config } from "../config.js";

const K_REFRESH = "yt_oauth_refresh_enc";
const K_ACCESS = "yt_oauth_access_enc";
const K_EXP = "yt_oauth_access_exp";
const K_STATE = "yt_oauth_state";
const K_CHAT = "yt_live_chat_id";

export type YoutubeTokenBundle = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

export function youtubeOAuthConfigured(): boolean {
  if (config.oauthBrokerUrl && config.oauthBrokerSecret) return true;
  return Boolean(config.youtube.clientId && config.youtube.clientSecret);
}

export function youtubeConnectMode(): "broker" | "direct" | "none" {
  if (config.youtube.clientId && config.youtube.clientSecret) return "direct";
  if (config.oauthBrokerUrl && config.oauthBrokerSecret) return "broker";
  return "none";
}

export function getStoredRefreshToken(): string | null {
  const enc = getSetting(K_REFRESH);
  if (enc) {
    try {
      return decrypt(enc);
    } catch {
      return null;
    }
  }
  return config.youtube.refreshToken || null;
}

export function getStoredAccessToken(): { token: string; expiresAt: number } | null {
  const enc = getSetting(K_ACCESS);
  const exp = Number(getSetting(K_EXP) || 0);
  if (enc) {
    try {
      return { token: decrypt(enc), expiresAt: exp };
    } catch {
      return null;
    }
  }
  if (config.youtube.accessToken) {
    return { token: config.youtube.accessToken, expiresAt: Date.now() + 3_600_000 };
  }
  return null;
}

export function saveYoutubeTokens(bundle: {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
}): void {
  setSetting(K_ACCESS, encrypt(bundle.accessToken));

  let expiresInSec = Number(bundle.expiresIn ?? 3600);
  if (!Number.isFinite(expiresInSec) || expiresInSec <= 0) expiresInSec = 3600;
  if (expiresInSec > 86_400) {

    if (expiresInSec > 1_000_000 && expiresInSec < 10_000_000) expiresInSec = Math.floor(expiresInSec / 1000);
    else expiresInSec = 3600;
  }
  expiresInSec = Math.min(7200, Math.max(60, expiresInSec));
  const exp = Date.now() + (expiresInSec - 60) * 1000;
  setSetting(K_EXP, String(exp));
  if (bundle.refreshToken) setSetting(K_REFRESH, encrypt(bundle.refreshToken));
}

export function clearYoutubeTokens(): void {
  setSetting(K_REFRESH, "");
  setSetting(K_ACCESS, "");
  setSetting(K_EXP, "0");
}

export function setOAuthState(state: string): void {
  setSetting(K_STATE, `${state}:${Date.now()}`);
}

export function consumeOAuthState(state: string): boolean {
  const raw = getSetting(K_STATE) || "";
  setSetting(K_STATE, "");
  const [saved, ts] = raw.split(":");
  if (!saved || saved !== state) return false;
  if (Date.now() - Number(ts || 0) > 15 * 60_000) return false;
  return true;
}

export function setLiveChatId(id: string): void {
  setSetting(K_CHAT, id);
}

export function getLiveChatId(): string {
  return getSetting(K_CHAT) || config.youtube.liveChatId || "";
}

export function youtubeConnected(): boolean {
  return Boolean(getStoredRefreshToken() || getStoredAccessToken()?.token);
}

export function youtubeNeedsReconnect(): boolean {
  if (!getStoredRefreshToken() && !getStoredAccessToken()?.token) return false;
  const cached = getStoredAccessToken();
  const accessOk = Boolean(cached?.token && cached.expiresAt > Date.now() + 30_000);
  if (accessOk) return false;

  if (config.oauthBrokerUrl && config.oauthBrokerSecret) return false;
  if (config.youtube.clientId && config.youtube.clientSecret) return false;
  return true;
}
