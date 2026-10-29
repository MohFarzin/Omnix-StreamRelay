# Connect YouTube / Twitch / Kick (Streamlabs-style)

**Privacy:** Account tokens stay on **your** Omnix machine. See [PRIVACY-CONNECT.md](PRIVACY-CONNECT.md). OmnixStudio does not keep them on a central website in the default design. Source is open on GitHub.

## What public users do

1. Install the egg / start Omnix.
2. Open the dashboard → log in with `FIRST_LOGIN.txt`.
3. Click **Connect Google / Twitch / Kick** → pick account → Allow (device code or browser — still local).
4. **YouTube:** Create live (title, description, thumbnail) → key goes into Destinations automatically.
5. **Twitch:** Connect usually also pulls the stream key into Destinations (`Twitch · main`). Turn **On** when OBS is live.
6. **Kick:** Connect enables chat. Paste **Server URL + stream key once** from Kick Creator (Kick’s ingest host is per-account). Turn **On**.

They never open Google Cloud / Twitch Dev / Kick Dev consoles.

## Why *you* (OmnixStudio) still create apps once

Google, Twitch, and Kick only allow “Sign in with …” for an **app** that someone registered. Streamlabs registers one app; customers just Connect.

| Audience | How Connect works |
|----------|-------------------|
| Your Mumbai / friends | Product credentials in `data/oauth.env` on that host (what you did for YouTube) |
| Public internet (many IPs) | Run [`oauth-broker/`](../oauth-broker/) once; eggs set `OAUTH_BROKER_URL` + `OAUTH_BROKER_SECRET` |

Self-hosters who refuse a broker can follow the advanced operator section in [`YOUTUBE-LIVE.md`](YOUTUBE-LIVE.md) / below — that is optional, not the default story.

## Destinations vs Connect

| Action | Destinations |
|--------|----------------|
| YouTube **Create live** | Writes RTMP URL + key (`youtube` / `youtube-v`) |
| Twitch **Connect** | Tries to write `rtmp://live.twitch.tv/app` + key (`twitch`) |
| Kick **Connect** | Chat only — paste Server URL + key once (Kick has no single shared ingest) |
| Manual paste | Still available under **Add destination** |

## Operator: Twitch app (once)

1. [Twitch Developer Console](https://dev.twitch.tv/console) → Create application.
2. OAuth Redirect URL (Mumbai example):  
   `http://mumbai.war67.online:8890/api/v1/oauth/callback/twitch`
3. Copy Client ID + Client Secret into `data/oauth.env`:

```bash
TWITCH_CLIENT_ID=…
TWITCH_CLIENT_SECRET=…
```

4. Restart egg. Add yourself as a Twitch app tester if required. **Connect Twitch** in the panel.

## Operator: Kick app (once)

1. Kick Developer / creator OAuth app (see Kick docs for current portal).
2. Redirect: `http://mumbai.war67.online:8890/api/v1/oauth/callback/kick`
3. In `data/oauth.env`:

```bash
KICK_CLIENT_ID=…
KICK_CLIENT_SECRET=…
```

4. Restart → **Connect Kick** → paste Kick Server URL + key under Destinations once.
