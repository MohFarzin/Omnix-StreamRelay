# Vertical streaming with Aitum (9:16)

Omnix StreamRelay can take a **second ingest** for vertical video (TikTok / YouTube Shorts / Kick vertical / etc.) while your main 16:9 feed keeps running.

You send:

| Feed | Typical use | Stream key (default) |
|------|-------------|----------------------|
| **Main** | 16:9 desktop / console | `mystream` |
| **Vertical** | 9:16 phone-style | `mystream_v` |

Same RTMP server URL for both. Different keys. In the dashboard, destinations use feed **main** or **vertical**.

The relay does **not** crop or compose vertical video for you. That happens in OBS (usually with **Aitum**).

---

## Plugins you need (Aitum)

Install **both** plugins. One builds the vertical canvas; the other helps you stream it as a separate output.

| Plugin | What it does | Download |
|--------|----------------|----------|
| **Aitum Vertical** | Adds a real 9:16 canvas inside OBS | [OBS Forum](https://obsproject.com/forum/resources/aitum-vertical.1715/) · [GitHub](https://github.com/Aitum/obs-vertical-canvas) |
| **Aitum Multistream** | Extra stream outputs (send vertical on its own RTMP) | [OBS Forum](https://obsproject.com/forum/resources/aitum-multistream.1991/) · [GitHub](https://github.com/Aitum/obs-aitum-multistream) |

### Install

1. Open the OBS Forum links above (or the GitHub releases pages).
2. Download the installer / zip for your OBS version and OS.
3. Run the installer (or follow the GitHub README for manual install).
4. Restart OBS.
5. Confirm you see **Vertical** / Aitum options in OBS.

If something fails to load, re-read that plugin’s own README on GitHub or the forum resource page — versions must match your OBS build.

---

## Recommended setup (one OBS + Aitum)

1. Install **Aitum Vertical** + **Aitum Multistream** (links above).
2. Build your **16:9** scene as usual → stream it to Omnix with key `mystream`.
3. Build your **9:16** layout on the Aitum Vertical canvas (overlays, camera crop, etc.).
4. In Aitum Multistream (or the vertical output settings), add a custom RTMP destination:

| Field | Value |
|-------|--------|
| Server | `rtmp://YOUR_HOST:RTMP_PORT/live` |
| Stream key | `mystream_v` |
| Auth | Off |

5. In the Omnix dashboard, add destinations with feed **Vertical (9:16)** and turn them **On**.
6. Go live: main OBS + vertical output both publishing.

You can run main-only, vertical-only, or both at once.

---

## Alternative: second OBS instance

You do **not** have to use Aitum. Another common approach:

1. Run **OBS #1** → 16:9 → Omnix key `mystream`.
2. Run **OBS #2** (second portable install or second profile) → set canvas to 1080×1920 (or 720×1280) → Omnix key `mystream_v`.
3. Same server URL on both.

Portable OBS tip: download a second copy into another folder so settings don’t clash. More CPU on your PC than Aitum-in-one-OBS, but no extra plugins.

---

## Omnix dashboard checklist

1. Connection → **Show details** → note Server + **Vertical** key.
2. Add each vertical platform destination → Feed = **vertical**.
3. Leave toggles **On**.
4. Start vertical publish from Aitum / second OBS.

If vertical destinations stay idle, the relay is not receiving `mystream_v` yet — check the Vertical key and that Aitum/OBS #2 is actually streaming.

---

## Encode tips

Same as main for Twitch / Kick: **CBR**, keyframe interval **2**, Kick ≤ **8000** kbps. YouTube Shorts / vertical YouTube use a separate stream key in Studio (or a second live event); paste that into a **vertical** destination.

---

## Links (bookmark these)

**Aitum Vertical**

- Forum: https://obsproject.com/forum/resources/aitum-vertical.1715/
- GitHub: https://github.com/Aitum/obs-vertical-canvas

**Aitum Multistream**

- Forum: https://obsproject.com/forum/resources/aitum-multistream.1991/
- GitHub: https://github.com/Aitum/obs-aitum-multistream

**This project**

- https://github.com/MohFarzin/Omnix-StreamRelay
