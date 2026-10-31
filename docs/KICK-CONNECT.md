# Connect Kick (via Omnix Link)

Kick is configured once on **Omnix Link**, not on the egg Startup screen.

## Create a Kick app

1. Enable **2FA** on your Kick account (Settings → Security).
2. Open **[Kick Developer settings](https://kick.com/settings/developer)** (or [dev.kick.com](https://dev.kick.com/)).
3. Create an app, e.g. name `Omnix Link`.
4. Set **Redirect URL** exactly to:

```text
https://relaylink.omnixstudio.xyz/oauth/kick/callback
```

5. Enable these scopes only (leave the rest off):
   - **Read user information** (`user:read`)
   - **Read stream key** (`streamkey:read`) — auto-fills Destinations
   - **Read channel information** (`channel:read`)
   - **Update channel information** (`channel:write`) — Live Manager titles
   - **Write to Chat feed** (`chat:write`) — optional replies from the chat bot
6. Copy **Client ID** and **Client Secret**.

## Put credentials on Omnix Link

On the Hyderabad / Link host `.env` (next to the Link app):

```bash
KICK_CLIENT_ID=…
KICK_CLIENT_SECRET=…
```

Restart the Link container/process so `kick_ready` becomes true on the relay page.

## Streamer steps

1. Panel → Omnix Link connected.
2. Open Omnix Link → **Connect Kick** → Allow.
3. Paste Kick **Server URL** + stream key once into Destinations (Kick still needs the RTMPS key from Creator dashboard).
4. OBS: CBR ≤ 8000 kbps, keyframe interval **2**.

Omnix Link uses Kick OAuth 2.1 with PKCE (`code_challenge` S256).
