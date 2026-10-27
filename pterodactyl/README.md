# Omnix StreamRelay — Pterodactyl egg

## Final egg

Import/update: **`egg-omnix-streamrelay.json`**

## Before first start (fixes “Installing…” freeze)

On **each** Wings node, build the local image (tilde `~` = no registry pull):

```bash
sudo docker build -t omnix-streamrelay:latest -f pterodactyl/Dockerfile .
```

Install script only creates `data/`, `logs/`, `README-OMNIX.txt`. It does **not** pull the app image.

## Ports (adaptive)

| Allocation | Egg / env | Use |
|------------|-----------|-----|
| Primary | `SERVER_PORT` | Dashboard HTTP |
| Extra | `RTMP_PORT` (default 1935) | OBS RTMP |
| Extra | `SRT_PORT` (default 8890) | SRT UDP |

Set `PUBLIC_HOST` to the public DNS. Optional `DASHBOARD_PORT` overrides primary.

Host port = container port (Ptero). MediaMTX binds RTMP/SRT to those numbers.

## Startup done string

Console must eventually print `Omnix StreamRelay bot on` (from Node). Startup config looks for that marker.
