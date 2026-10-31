import { config, ingestPath, type IngestLane } from "../config.js";

export type PathInfo = {
  name: string;
  ready: boolean;
  bytesReceived: number;
};

export type IngestState = { live: boolean; bytesIn: number; path: string; lane: IngestLane };

function authHeader(): string {
  const raw = `${config.mtxApiUser}:${config.mtxApiPass}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

let pathsCache: { at: number; paths: PathInfo[] } | null = null;
const PATHS_TTL_MS = 400;

export async function listPaths(): Promise<PathInfo[]> {
  const now = Date.now();
  if (pathsCache && now - pathsCache.at < PATHS_TTL_MS) return pathsCache.paths;
  const res = await fetch(`${config.mtxApiUrl}/v3/paths/list`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) throw new Error(`MediaMTX API ${res.status}`);
  const body = (await res.json()) as {
    items?: Array<{ name: string; ready?: boolean; bytesReceived?: number }>;
  };
  const paths = (body.items ?? []).map((p) => ({
    name: p.name,
    ready: Boolean(p.ready),
    bytesReceived: Number(p.bytesReceived ?? 0),
  }));
  pathsCache = { at: now, paths };
  return paths;
}

function stateFromPaths(paths: PathInfo[], lane: IngestLane): IngestState {
  const path = ingestPath(lane);
  const key = lane === "vertical" ? config.streamKeyVertical : config.streamKey;
  const hit = paths.find((p) => p.name === path || p.name.endsWith(`/${key}`));
  if (!hit) return { live: false, bytesIn: 0, path, lane };
  return { live: hit.ready, bytesIn: hit.bytesReceived, path: hit.name, lane };
}

export async function ingestLive(lane: IngestLane = "main"): Promise<IngestState> {
  try {
    return stateFromPaths(await listPaths(), lane);
  } catch {
    return { live: false, bytesIn: 0, path: ingestPath(lane), lane };
  }
}

export async function ingestBoth(): Promise<{ main: IngestState; vertical: IngestState }> {
  try {
    const paths = await listPaths();
    return {
      main: stateFromPaths(paths, "main"),
      vertical: stateFromPaths(paths, "vertical"),
    };
  } catch {
    return {
      main: { live: false, bytesIn: 0, path: ingestPath("main"), lane: "main" },
      vertical: { live: false, bytesIn: 0, path: ingestPath("vertical"), lane: "vertical" },
    };
  }
}
