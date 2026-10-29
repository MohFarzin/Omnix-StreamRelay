# Mobile / tablet chat (PWA)

You do not need a separate Android app for side-monitor chat.

## Use it

1. On your phone or tablet, open:

   `http://YOUR_HOST:DASH_PORT/chat.html`

2. Log in with the same **bootstrap token**.
3. Filter Twitch / YouTube / Kick, read chat, send bot replies.
4. Optional: browser menu → **Add to Home Screen** / **Install app** (uses [`manifest.webmanifest`](../client-ui/manifest.webmanifest)).

The full dashboard also has a **Mobile view** link above Live chat.

## Native Android

A Play Store / React Native app is only needed if the PWA is not enough (push notifications, store listing). The plan is to keep using this JWT + WebSocket chat API — no second streaming stack on the phone.
