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
| Optional Omnix Link (Relay Link) | Only if *you* paste a tunnel token — **not** the default |

## Open source

The full source is public: https://github.com/MohFarzin/Omnix-StreamRelay  

You can audit that Connect handlers write to local SQLite via `saveYoutubeTokens` / platform token helpers — there is no upload of refresh tokens to `omnixstudio.xyz` in the default path.

## Omnix Link / Relay Link (optional)

[Omnix-Link](https://github.com/MohFarzin/Omnix-Link) (`https://relaylink.omnixstudio.xyz`) lets you sign in, create a **tunnel token**, paste it into StreamRelay, and confirm the egg’s outbound connection (works without a public IP). Connect platforms on the website; your egg **pulls** an encrypted handoff. Prefer local Connect on StreamRelay if you do not want that path.

## Docs site

Marketing/docs on OmnixStudio domains are separate from holding a permanent token vault.
