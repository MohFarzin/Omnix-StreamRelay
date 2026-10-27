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

export async function listPaths(): Promise<PathInfo[]> {
  const res = await fetch(`${config.mtxApiUrl}/v3/paths/list`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) throw new Error(`MediaMTX API ${res.status}`);
  const body = (await res.json()) as {
    items?: Array<{ name: string; ready?: boolean; bytesReceived?: number }>;
  };
  return (body.items ?? []).map((p) => ({
    name: p.name,
    ready: Boolean(p.ready),
    bytesReceived: Number(p.bytesReceived ?? 0),
  }));
}

export async function ingestLive(lane: IngestLane = "main"): Promise<IngestState> {
  const path = ingestPath(lane);
  try {
    const paths = await listPaths();
    const key = lane === "vertical" ? config.streamKeyVertical : config.streamKey;
    const hit = paths.find((p) => p.name === path || p.name.endsWith(`/${key}`));
    if (!hit) return { live: false, bytesIn: 0, path, lane };
    return { live: hit.ready, bytesIn: hit.bytesReceived, path: hit.name, lane };
  } catch {
    return { live: false, bytesIn: 0, path, lane };
  }
}

export async function ingestBoth(): Promise<{ main: IngestState; vertical: IngestState }> {
  const [main, vertical] = await Promise.all([ingestLive("main"), ingestLive("vertical")]);
  return { main, vertical };
}
