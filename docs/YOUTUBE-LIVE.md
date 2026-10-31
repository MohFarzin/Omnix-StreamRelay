# Live Manager (AIO + Custom)

## For streamers (normal use)

1. Start the Omnix egg / server.
2. Open the dashboard → log in with the bootstrap token from `FIRST_LOGIN.txt`.
3. Connect the egg to [Omnix Link](https://relaylink.omnixstudio.xyz) → Connect YouTube / Twitch / Kick.
4. Destinations → **Add automatically** (or they appear after Connect). Flip each **On**.
5. **Live Manager**:
   - **AIO** — one shared title for all platforms (YouTube-only fields like privacy/latency/thumbnail are skipped on Twitch/Kick)
   - **Custom** — different titles per platform
   - **Save preset** → **Set as default**
   - **Apply now** pushes metadata immediately
6. Next session: leave Destinations **On**, start OBS — default preset applies titles without reopening Live Manager.

You never paste a Client ID, Client Secret, or API key into the egg.

### Stream latency (three options)

| Option | When to use |
|--------|-------------|
| **Normal** (default) | Best quality / least buffering |
| **Low latency** | Some chat interaction |
| **Ultra-low latency** | Heavy real-time chat |

Set this before going live — YouTube locks it once the stream is running.

## Google “hasn’t verified this app” warning

Omnix Link’s Google OAuth app is in **Testing** / unverified until Google finishes brand verification. That is normal for a small product.

**Right now (you + friends):**

1. Open [Google Auth Platform → Audience](https://console.cloud.google.com/auth/audience) (same project as Omnix Link).
2. Under **Test users**, add every Google account that will click Connect YouTube (e.g. your stream Gmail).
3. On the warning page: **Advanced** → **Go to Omnix Link (unsafe)** → Allow.

That warning stays until Google verifies the app. It does not mean Connect is broken.

**Permanent fix (operators):** publish the OAuth app and submit verification (privacy + terms already on Link). Until then, keep using Test users + Advanced.

## For OmnixStudio operators (once per product / host)

Google still requires **one** OAuth app owned by the product (same as Streamlabs). Streamers never see it.

### Option A — Omnix Link (recommended)

Run [Omnix Link](https://github.com/MohFarzin/Omnix-Link) at `https://relaylink.omnixstudio.xyz` with product Google credentials. Eggs dial out with a Connect Relay token — no public egg URL.

### Option B — Direct OAuth on one host (lab only)

Create a Web OAuth client once, enable YouTube Data API v3, then on that host only create `data/oauth.env`:

```bash
YOUTUBE_CLIENT_ID=…
YOUTUBE_CLIENT_SECRET=…
YOUTUBE_OAUTH_SCHEME=http
# or YOUTUBE_REDIRECT_URI=http://HOST:PORT/api/v1/youtube/oauth/callback
```

Add the redirect URI shown by a direct-mode host to the Google OAuth client. Restart the egg.

Do **not** put these values in streamer-facing Startup fields.
