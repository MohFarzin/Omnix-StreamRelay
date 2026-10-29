# Privacy: Connect & tokens

## Promise

**Omnix StreamRelay does not store your Google / Twitch / Kick account tokens on OmnixStudio’s website.**

When you click **Connect**:

1. You sign in with Google (or Twitch / Kick).
2. Tokens are saved **encrypted only on your Omnix server** (`data/omnix.sqlite` on your VPS or PC).
3. Creating lives, titles, and destinations happens on **your** dashboard.

OmnixStudio’s role is to ship the open-source app (and optionally a product OAuth Client ID so you don’t create a Google Cloud project). That is **not** the same as holding your YouTube login.

## How Connect works (default)

| Method | Where tokens go |
|--------|-----------------|
| **Device code** (preferred) | Your egg polls Google → tokens written locally |
| **Browser redirect** to your egg | Google redirects to *your* host → tokens written locally |
| Optional broker / “Omnix Link” | Only if *you* enable it later — **not** the default |

## Open source

The full source is public: https://github.com/MohFarzin/Omnix-StreamRelay  

You can audit that Connect handlers write to local SQLite via `saveYoutubeTokens` / platform token helpers — there is no upload of refresh tokens to `omnixstudio.xyz` in the default path.

## Omnix Link website (optional)

`Broker/` (separate GitHub repo / `streamrelay.omnixstudio.xyz`) lets you sign in, pair a StreamRelay, Connect platforms on the website, then **push tokens once to your egg**. Prefer local Connect on StreamRelay if you do not want that handoff.

## Docs site

Marketing/docs on OmnixStudio domains are separate from holding a permanent token vault.
