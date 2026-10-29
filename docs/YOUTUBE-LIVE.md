# YouTube Live manager

Omnix can create a YouTube Control Room broadcast (title, description, privacy, thumbnail), bind RTMP, and push the stream key into a dashboard destination — so you do not paste keys by hand every session.

## 1. Google Cloud OAuth client

1. Open [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services.
2. Enable **YouTube Data API v3**.
3. Create **OAuth client ID** → type **Web application**.
4. Add an **Authorized redirect URI** exactly as shown in the Omnix dashboard under **YouTube Live manager** (example):

   `http://YOUR_HOST:DASH_PORT/api/v1/youtube/oauth/callback`

   Prefer HTTPS if you terminate TLS in front of the panel. Set egg/env:

   - `YOUTUBE_OAUTH_SCHEME=https` when the public URL is HTTPS  
   - or `YOUTUBE_REDIRECT_URI=https://…/api/v1/youtube/oauth/callback` for a full override

5. Copy **Client ID** and **Client secret**.

## 2. Egg / environment

| Variable | Required |
|----------|----------|
| `YOUTUBE_CLIENT_ID` | Yes |
| `YOUTUBE_CLIENT_SECRET` | Yes |
| `YOUTUBE_REDIRECT_URI` | Optional override |
| `YOUTUBE_OAUTH_SCHEME` | Optional `http` / `https` |

Restart the server after changing these.

## 3. Connect in the dashboard

1. Open Omnix → **YouTube Live manager**.
2. Click **Connect Google** and approve access (YouTube scopes).
3. If the panel is plain HTTP and Google rejects the redirect, use **Paste refresh token** (OAuth Playground / Cloud) instead.

## 4. Create a live

1. Fill **title**, **description**, **privacy**, **feed** (main or vertical).
2. Optional thumbnail (JPEG/PNG/WebP, under 2MB).
3. Click **Create YouTube live**.
4. Omnix writes `rtmp://a.rtmp.youtube.com/live2` + the new key into destination `youtube` or `youtube-v` and can enable it.
5. Start OBS into the relay as usual — YouTube should leave “Preparing” once data arrives.

Create **main** and **vertical** separately if you need both keys.

## 5. Chat

When a broadcast includes a live chat id, Omnix stores it and restarts the chat engine so YouTube chat can appear in **Live chat** / `/chat.html` (still needs a successful OAuth token).
