import { createHash, createDecipheriv } from "node:crypto";
import { getSetting, setSetting } from "../db.js";
import { ingestLinkPush, revokeLinkPlatform } from "./link.js";

const K_URL = "omnix_link_url";
const K_TOKEN = "omnix_link_tunnel_token";
const K_STATUS = "omnix_link_status";
const K_MSG = "omnix_link_message";

const DEFAULT_LINK_URL = "https://relaylink.omnixstudio.xyz";

let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;

function lockedLinkUrl(): string {
  // Operator-only override via egg env; panel users cannot change the URL.
  const fromEnv = (process.env.OMNIX_LINK_URL || "").trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  return DEFAULT_LINK_URL;
}

export function getLinkAgentConfig(): { url: string; tunnelToken: string; status: string; message: string } {
  return {
    url: lockedLinkUrl(),
    tunnelToken: getSetting(K_TOKEN) || "",
    status: getSetting(K_STATUS) || "idle",
    message: getSetting(K_MSG) || "",
  };
}

export function saveLinkAgentConfig(input: { url?: string; tunnelToken?: string }): {
  url: string;
  tunnelToken: string;
  status: string;
  message: string;
} {
  // Ignore any client-supplied URL — Link host is fixed by OmnixStudio.
  void input.url;
  void K_URL;
  if (typeof input.tunnelToken === "string") {
    setSetting(K_TOKEN, input.tunnelToken.trim());
    setSetting(K_STATUS, input.tunnelToken.trim() ? "configured" : "idle");
    setSetting(K_MSG, input.tunnelToken.trim() ? "Connecting…" : "");
  }
  void tick().catch(() => undefined);
  return getLinkAgentConfig();
}

function deriveKey(tunnelToken: string): Buffer {
  return createHash("sha256").update(`omnix-relay-link:v1:${tunnelToken}`, "utf8").digest();
}

function b64urlDecode(blob: string): Buffer {
  const pad = "=".repeat((4 - (blob.length % 4)) % 4);
  return Buffer.from(blob.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function unseal(tunnelToken: string, blob: string): Record<string, unknown> {
  const raw = b64urlDecode(blob);
  if (raw.length < 13) throw new Error("ciphertext too short");
  const nonce = raw.subarray(0, 12);
  const ct = raw.subarray(12);
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(tunnelToken), nonce);
  const tag = ct.subarray(ct.length - 16);
  const data = ct.subarray(0, ct.length - 16);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(pt.toString("utf8")) as Record<string, unknown>;
}

async function tick(): Promise<void> {
  if (busy) return;
  const { url, tunnelToken } = getLinkAgentConfig();
  if (!tunnelToken) return;
  busy = true;
  try {
    const helloRes = await fetch(`${url}/api/v1/agent/hello`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        tunnelToken,
        nodeName: process.env.SERVER_NAME || process.env.P_SERVER_UUID || "streamrelay",
        version: process.env.npm_package_version || "1",
      }),
    });
    const hello = (await helloRes.json().catch(() => ({}))) as {
      status?: string;
      message?: string;
      error?: string;
    };
    if (!helloRes.ok) {
      setSetting(K_STATUS, "error");
      setSetting(K_MSG, hello.error || `hello ${helloRes.status}`);
      return;
    }
    setSetting(K_STATUS, hello.status || "unknown");
    setSetting(K_MSG, hello.message || "");

    if (hello.status !== "linked") return;

    const pollRes = await fetch(`${url}/api/v1/agent/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ tunnelToken, ackJobIds: [] }),
    });
    const poll = (await pollRes.json().catch(() => ({}))) as {
      jobs?: Array<{ id: string; sealed: string }>;
      status?: string;
      error?: string;
    };
    if (!pollRes.ok) {
      setSetting(K_STATUS, "error");
      setSetting(K_MSG, poll.error || `poll ${pollRes.status}`);
      return;
    }
    if (poll.status) setSetting(K_STATUS, poll.status);

    const ack: string[] = [];
    for (const job of poll.jobs || []) {
      try {
        const inner = unseal(tunnelToken, job.sealed);
        if (inner.type === "deliver_tokens") {
          await ingestLinkPush({
            pairingCode: getSetting("omnix_link_pairing_code") || "agent",
            platform: String(inner.platform || ""),
            accessToken: String(inner.accessToken || ""),
            refreshToken: (inner.refreshToken as string | null | undefined) ?? null,
            expiresIn: (inner.expiresIn as number | null | undefined) ?? null,
            extra: (inner.extra as Record<string, string> | undefined) || {},
            fromAgent: true,
          });
          ack.push(job.id);
        } else if (inner.type === "revoke_tokens") {
          await revokeLinkPlatform(String(inner.platform || ""));
          ack.push(job.id);
        }
      } catch (e) {
        setSetting(K_MSG, `job failed: ${(e as Error).message}`);
      }
    }
    if (ack.length) {
      await fetch(`${url}/api/v1/agent/poll`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ tunnelToken, ackJobIds: ack }),
      }).catch(() => undefined);
      setSetting(K_MSG, `Received ${ack.length} encrypted token handoff(s)`);
    }
  } catch (e) {
    setSetting(K_STATUS, "error");
    setSetting(K_MSG, (e as Error).message || "link agent error");
  } finally {
    busy = false;
  }
}

export function startLinkAgent(): void {
  if (timer) return;
  void tick().catch(() => undefined);
  timer = setInterval(() => {
    void tick().catch(() => undefined);
  }, 5000);
}
