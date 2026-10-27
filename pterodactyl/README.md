# Pterodactyl / Jexactyl — Omnix StreamRelay

## Egg file

Import **`egg-omnix-streamrelay.json`** (same contents as `FINAL-egg-omnix-streamrelay.json`).

- Author: `admin@omnixstudio.xyz`
- Source: https://github.com/MohFarzin/Omnix-StreamRelay
- Default image: `ghcr.io/mohfarzin/omnix-streamrelay:latest`

Wings **pulls the image from GitHub Container Registry**. You do not upload the project zip into the server volume for the app to run.

Optional image in the egg dropdown: `~omnix-streamrelay:latest` for admins who still build locally on the node.

## Operator steps

1. Import the egg into a nest.
2. Create a server with 3 allocations (dashboard + RTMP + SRT).
3. Set `PUBLIC_HOST`, `RTMP_PORT`, `SRT_PORT`. Leave secrets as `auto`.
4. Start → open the dashboard → login with bootstrap token from console / `FIRST_LOGIN.txt`.

## Ports

| Role | Variable | Notes |
|------|----------|--------|
| Dashboard | primary → `SERVER_PORT` | optional `DASHBOARD_PORT` override |
| RTMP | `RTMP_PORT` | must match allocation |
| SRT | `SRT_PORT` | UDP preferred |

Host port = container port.

## Publishing the image (maintainers)

Push to `master`/`main` runs `.github/workflows/docker-image.yml`, which builds `pterodactyl/Dockerfile` and pushes to GHCR. Make the package **public** so panel nodes can pull without credentials.
