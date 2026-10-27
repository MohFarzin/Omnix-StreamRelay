import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { hashToken } from "./crypto.js";

export type StreamTarget = {
  id: string;
  label: string;
  platform: string;
  rtmp_url: string;
  stream_key_enc: string;
  enabled: number;
  last_error: string | null;
  updated_at: number;
  /** main = 16:9 OBS path; vertical = 9:16 Aitum path */
  lane: "main" | "vertical";
};

export type CommandRow = {
  name: string;
  response: string;
  enabled: number;
  cooldown_sec: number;
};

let db: DatabaseSync;

export function getDb(): DatabaseSync {
  return db;
}

export function initDb(): void {
  mkdirSync(config.dataDir, { recursive: true });
  db = new DatabaseSync(join(config.dataDir, "omnix.sqlite"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS viewers (
      platform TEXT NOT NULL,
      viewer_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      welcomed_at INTEGER,
      PRIMARY KEY (platform, viewer_id)
    );
    CREATE TABLE IF NOT EXISTS commands (
      name TEXT PRIMARY KEY,
      response TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      cooldown_sec INTEGER NOT NULL DEFAULT 5
    );
    CREATE TABLE IF NOT EXISTS stream_targets (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      platform TEXT NOT NULL,
      rtmp_url TEXT NOT NULL,
      stream_key_enc TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  // Migration: dual ingest lanes (main / vertical)
  try {
    db.exec(`ALTER TABLE stream_targets ADD COLUMN lane TEXT NOT NULL DEFAULT 'main'`);
  } catch {
    /* column already exists */
  }

  const welcome = db.prepare("SELECT value FROM settings WHERE key = ?").get("welcome");
  if (!welcome) {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
      "welcome",
      "Welcome to the stream, {user}! Thanks for chatting."
    );
  }

  const cmds = db.prepare("SELECT COUNT(*) AS c FROM commands").get() as { c: number };
  if (cmds.c === 0) {
    const ins = db.prepare(
      "INSERT INTO commands (name, response, enabled, cooldown_sec) VALUES (?, ?, 1, 10)"
    );
    ins.run("discord", "Join our Discord: https://discord.gg/example");
    ins.run("specs", "PC: ask the streamer — bot runs on Omnix StreamRelay VPS.");
  }
}

export function getSetting(key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

function normalizeTarget(row: StreamTarget): StreamTarget {
  return { ...row, lane: row.lane === "vertical" ? "vertical" : "main" };
}

export function listTargets(): StreamTarget[] {
  return (db.prepare("SELECT * FROM stream_targets ORDER BY id").all() as StreamTarget[]).map(
    normalizeTarget
  );
}

export function getTarget(id: string): StreamTarget | undefined {
  const row = db.prepare("SELECT * FROM stream_targets WHERE id = ?").get(id) as
    | StreamTarget
    | undefined;
  return row ? normalizeTarget(row) : undefined;
}

export function upsertTarget(t: {
  id: string;
  label: string;
  platform: string;
  rtmp_url: string;
  stream_key_enc: string;
  enabled?: number;
  lane?: "main" | "vertical";
}): void {
  const now = Date.now();
  const lane = t.lane === "vertical" ? "vertical" : "main";
  db.prepare(
    `INSERT INTO stream_targets (id, label, platform, rtmp_url, stream_key_enc, enabled, last_error, updated_at, lane)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       label = excluded.label,
       platform = excluded.platform,
       rtmp_url = excluded.rtmp_url,
       stream_key_enc = excluded.stream_key_enc,
       enabled = excluded.enabled,
       lane = excluded.lane,
       updated_at = excluded.updated_at`
  ).run(
    t.id,
    t.label,
    t.platform,
    t.rtmp_url,
    t.stream_key_enc,
    t.enabled ?? 0,
    now,
    lane
  );
}

export function setTargetEnabled(id: string, enabled: boolean): void {
  db.prepare("UPDATE stream_targets SET enabled = ?, updated_at = ? WHERE id = ?").run(
    enabled ? 1 : 0,
    Date.now(),
    id
  );
}

export function setTargetError(id: string, err: string | null): void {
  db.prepare("UPDATE stream_targets SET last_error = ?, updated_at = ? WHERE id = ?").run(
    err,
    Date.now(),
    id
  );
}

export function deleteTarget(id: string): void {
  db.prepare("DELETE FROM stream_targets WHERE id = ?").run(id);
}

export function listCommands(): CommandRow[] {
  return db.prepare("SELECT * FROM commands ORDER BY name").all() as CommandRow[];
}

export function upsertCommand(name: string, response: string, cooldown_sec = 5, enabled = 1): void {
  db.prepare(
    `INSERT INTO commands (name, response, enabled, cooldown_sec) VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET response = excluded.response, enabled = excluded.enabled, cooldown_sec = excluded.cooldown_sec`
  ).run(name.toLowerCase(), response, enabled, cooldown_sec);
}

export function deleteCommand(name: string): void {
  db.prepare("DELETE FROM commands WHERE name = ?").run(name.toLowerCase());
}

export function findOrCreateViewer(
  platform: string,
  viewerId: string,
  displayName: string
): { isNew: boolean } {
  const existing = db
    .prepare("SELECT viewer_id FROM viewers WHERE platform = ? AND viewer_id = ?")
    .get(platform, viewerId);
  if (existing) return { isNew: false };
  db.prepare(
    "INSERT INTO viewers (platform, viewer_id, display_name, first_seen_at, welcomed_at) VALUES (?, ?, ?, ?, ?)"
  ).run(platform, viewerId, displayName, Date.now(), Date.now());
  return { isNew: true };
}

export function storeRefreshToken(id: string, token: string, expiresAt: number): void {
  db.prepare(
    "INSERT INTO refresh_tokens (id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)"
  ).run(id, hashToken(token), expiresAt, Date.now());
}

export function consumeRefreshToken(token: string): boolean {
  const h = hashToken(token);
  const row = db.prepare("SELECT id, expires_at FROM refresh_tokens WHERE token_hash = ?").get(h) as
    | { id: string; expires_at: number }
    | undefined;
  if (!row) return false;
  db.prepare("DELETE FROM refresh_tokens WHERE id = ?").run(row.id);
  return row.expires_at > Date.now();
}

export function revokeAllRefreshTokens(): void {
  db.prepare("DELETE FROM refresh_tokens").run();
}
