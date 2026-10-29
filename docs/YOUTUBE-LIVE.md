# YouTube Live manager (Streamlabs-style Connect)

## For streamers (normal use)

1. Start the Omnix egg / server.
2. Open the dashboard → log in with the bootstrap token from `FIRST_LOGIN.txt`.
3. Click **Connect Google** → pick your Google account → **Allow**.
4. Fill title / description / privacy / thumbnail → **Create YouTube live**.
5. Point OBS at the Connection details (Server + stream key). Leave Destinations **On**.

You never paste a Client ID, Client Secret, or API key into the egg.

## For OmnixStudio operators (once per product / host)

Google still requires **one** OAuth app owned by the product (same as Streamlabs). Streamers never see it.

### Option A — Omnix OAuth broker (recommended for public / many hosts)

Run [`oauth-broker/`](../oauth-broker/) at e.g. `https://auth.omnixstudio.xyz` with product Google (and Twitch/Kick) credentials. On each egg set:

- `OAUTH_BROKER_URL=https://auth.omnixstudio.xyz`
- `OAUTH_BROKER_SECRET=…` (shared HMAC; put in `data/oauth.env`, not the public egg UI)

### Option B — Direct OAuth on one host (Mumbai / lab)

Create a Web OAuth client once, enable YouTube Data API v3, then on that host only create `data/oauth.env`:

```bash
YOUTUBE_CLIENT_ID=…
YOUTUBE_CLIENT_SECRET=…
YOUTUBE_OAUTH_SCHEME=http
# or YOUTUBE_REDIRECT_URI=http://HOST:PORT/api/v1/youtube/oauth/callback
```

Add the redirect URI shown by a direct-mode host to the Google OAuth client. Restart the egg.

Do **not** put these values in streamer-facing Startup fields.
