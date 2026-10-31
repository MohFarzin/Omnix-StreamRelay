export const config = {
  port: Number(process.env.PORT ?? 8080),
  dataDir: process.env.DATA_DIR ?? "./data",
  masterKey: process.env.MASTER_KEY ?? "",
  bootstrapToken: process.env.BOOTSTRAP_TOKEN ?? "",
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET ?? "",
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET ?? "",
  mtxApiUrl: process.env.MTX_API_URL ?? "http://127.0.0.1:9997",
  mtxApiUser: process.env.MTX_API_USER ?? "admin",
  mtxApiPass: process.env.MTX_API_PASS ?? "",
  mtxRtspBase: process.env.MTX_RTSP_BASE ?? "rtsp://127.0.0.1:8554",
  ingestPathPrefix: process.env.INGEST_PATH_PREFIX ?? "live",
  streamKey: process.env.STREAM_KEY ?? "mystream",

  streamKeyVertical: process.env.STREAM_KEY_VERTICAL ?? `${process.env.STREAM_KEY ?? "mystream"}_v`,

  publicHost: process.env.PUBLIC_HOST || process.env.SERVER_IP || "",
  rtmpPort: Number(process.env.RTMP_PORT ?? 1935),
  srtPort: Number(process.env.SRT_PORT ?? 8890),
  publishUser: process.env.MTX_PUBLISH_USER ?? "publisher",
  twitch: {
    clientId: process.env.TWITCH_CLIENT_ID ?? "",
    clientSecret: process.env.TWITCH_CLIENT_SECRET ?? "",
    accessToken: process.env.TWITCH_ACCESS_TOKEN ?? "",
    refreshToken: process.env.TWITCH_REFRESH_TOKEN ?? "",
    channel: process.env.TWITCH_CHANNEL ?? "",
    botUserId: process.env.TWITCH_BOT_USER_ID ?? "",
  },
  youtube: {
    apiKey: process.env.YOUTUBE_API_KEY ?? "",
    clientId: process.env.YOUTUBE_CLIENT_ID ?? "",
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET ?? "",
    accessToken: process.env.YOUTUBE_ACCESS_TOKEN ?? "",
    refreshToken: process.env.YOUTUBE_REFRESH_TOKEN ?? "",
    liveChatId: process.env.YOUTUBE_LIVE_CHAT_ID ?? "",
  },
  kick: {
    clientId: process.env.KICK_CLIENT_ID ?? "",
    clientSecret: process.env.KICK_CLIENT_SECRET ?? "",
    accessToken: process.env.KICK_ACCESS_TOKEN ?? "",
    channel: process.env.KICK_CHANNEL ?? "",
  },




  oauthBrokerUrl: (process.env.OAUTH_BROKER_URL ?? "").replace(/\/$/, ""),
  oauthBrokerSecret: process.env.OAUTH_BROKER_SECRET ?? "",
};

export function assertConfig(): void {
  for (const k of ["masterKey", "bootstrapToken", "jwtAccessSecret", "jwtRefreshSecret"] as const) {
    if (!config[k] || config[k].length < 16) {
      throw new Error(`${k} must be set (16+ chars). See .env.example`);
    }
  }
}

export type IngestLane = "main" | "vertical";

export function ingestPath(lane: IngestLane = "main"): string {
  const key = lane === "vertical" ? config.streamKeyVertical : config.streamKey;
  return `${config.ingestPathPrefix}/${key}`;
}

export function ingestRtspUrl(lane: IngestLane = "main"): string {
  return `${config.mtxRtspBase}/${ingestPath(lane)}`;
}
