# Omnix OAuth broker (optional)

**Default product path:** Direct Connect on the egg (device code / local redirect) so tokens never touch OmnixStudio. See [PRIVACY-CONNECT.md](PRIVACY-CONNECT.md).

This broker is an **optional** convenience for multi-host linking later — not required and not the trust default.

Streamlabs-style **Connect** for many self-hosted eggs without each user creating a Google/Twitch/Kick developer app.

## Flow

1. Dashboard **Connect Google** → egg `/api/v1/youtube/oauth/start` (or `/api/v1/oauth/{platform}/start`).
2. Browser opens `{OAUTH_BROKER_URL}/v1/connect?platform=youtube&return_url=…&state=…`.
3. Broker runs the platform OAuth (product Client ID/Secret).
4. Broker stores a one-time ticket and redirects to the egg  
   `/api/v1/oauth/broker/return?ticket=…&sig=…&state=…`.
5. Egg verifies HMAC, redeems the ticket, stores encrypted tokens in SQLite.

## Run locally

```bash
cd oauth-broker
python -m venv .venv
# Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env   # fill secrets
uvicorn app:app --host 0.0.0.0 --port 8791
```

## Egg env

| Variable | Purpose |
|----------|---------|
| `OAUTH_BROKER_URL` | e.g. `https://auth.omnixstudio.xyz` |
| `OAUTH_BROKER_SECRET` | Shared secret (same as broker `BROKER_SECRET`) |

Prefer `data/oauth.env` on the volume (loaded by `start.sh`) so secrets stay off the public egg form.
