#!/bin/bash
set -euo pipefail
cd /home/container

export DATA_DIR="${DATA_DIR:-/home/container/data}"
export PUBLIC_DIR="${PUBLIC_DIR:-/opt/omnix/public}"
export MTX_API_URL="${MTX_API_URL:-http://127.0.0.1:9997}"
export MTX_API_USER="${MTX_API_USER:-admin}"
export STREAM_KEY="${STREAM_KEY:-mystream}"
export STREAM_KEY_VERTICAL="${STREAM_KEY_VERTICAL:-${STREAM_KEY}_v}"

mkdir -p "$DATA_DIR" /home/container/logs

# Volume override (works before egg vars exist): data/ports.env
# Example: PUBLIC_HOST=…  RTMP_PORT=19147  SRT_PORT=25542  DASHBOARD_PORT=19102
if [[ -f "$DATA_DIR/ports.env" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$DATA_DIR/ports.env"; set +a
fi

# --- Public hostname ---
if [[ -z "${PUBLIC_HOST:-}" && -f "$DATA_DIR/public_host" ]]; then
  PUBLIC_HOST="$(tr -d '[:space:]' < "$DATA_DIR/public_host")"
fi
export PUBLIC_HOST="${PUBLIC_HOST:-${SERVER_IP:-}}"
if [[ -z "$PUBLIC_HOST" || "$PUBLIC_HOST" == "YOUR_HOST" || "$PUBLIC_HOST" == "0.0.0.0" ]]; then
  PUBLIC_HOST="$(hostname -f 2>/dev/null || hostname || echo YOUR_HOST)"
fi
export PUBLIC_HOST

# --- Port map (Pterodactyl: host port == container port) ---
# Primary allocation → SERVER_PORT → dashboard HTTP
# Egg vars / ports.env: RTMP_PORT / SRT_PORT (defaults 1935 / 8890)
export PORT="${DASHBOARD_PORT:-${SERVER_PORT:-8080}}"
export RTMP_PORT="${RTMP_PORT:-1935}"
export SRT_PORT="${SRT_PORT:-8890}"
export MTX_RTSP_BASE="${MTX_RTSP_BASE:-rtsp://127.0.0.1:8554}"
export MTX_RTMP_BASE="rtmp://127.0.0.1:${RTMP_PORT}"

if [[ "$PORT" == "$RTMP_PORT" ]]; then
  echo "[omnix] WARN: dashboard PORT ($PORT) == RTMP_PORT — set primary allocation to a dedicated TCP port."
fi
if [[ "$PORT" == "$SRT_PORT" ]]; then
  echo "[omnix] note: dashboard :${PORT}/tcp and SRT :${SRT_PORT}/udp share the number (OK if Wings maps both)."
fi

SECRETS="$DATA_DIR/omnix.secrets"
LOGIN_FILE="/home/container/FIRST_LOGIN.txt"

rand() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

placeholder() {
  case "${1:-}" in
    ""|auto|AUTO|change-me*|changeme*) return 0 ;;
    *) return 1 ;;
  esac
}

if [[ -f "$SECRETS" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$SECRETS"; set +a
fi

GENERATED=0
ensure() {
  local name="$1"
  local current="${!name:-}"
  if placeholder "$current"; then
    local val
    val="$(rand)"
    printf -v "$name" '%s' "$val"
    export "$name"
    GENERATED=1
  else
    export "$name"="$current"
  fi
}

ensure BOOTSTRAP_TOKEN
ensure MASTER_KEY
ensure JWT_ACCESS_SECRET
ensure JWT_REFRESH_SECRET
ensure MTX_PUBLISH_PASS
ensure MTX_API_PASS

cat > "$SECRETS" <<EOF
BOOTSTRAP_TOKEN=${BOOTSTRAP_TOKEN}
MASTER_KEY=${MASTER_KEY}
JWT_ACCESS_SECRET=${JWT_ACCESS_SECRET}
JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET}
MTX_PUBLISH_PASS=${MTX_PUBLISH_PASS}
MTX_API_PASS=${MTX_API_PASS}
STREAM_KEY=${STREAM_KEY}
EOF
chmod 600 "$SECRETS" 2>/dev/null || true

cat > "$LOGIN_FILE" <<EOF
Omnix StreamRelay — login / OBS
================================
Dashboard:  http://${PUBLIC_HOST}:${PORT}/
Login token (BOOTSTRAP_TOKEN):
  ${BOOTSTRAP_TOKEN}

OBS / Streamlabs (Custom, NO authentication checkbox):
  Server:     rtmp://${PUBLIC_HOST}:${RTMP_PORT}/live
  Stream Key: ${STREAM_KEY}
Vertical / Aitum (same server, different key):
  Stream Key: ${STREAM_KEY_VERTICAL}
Optional SRT (needs UDP on this port):
  srt://${PUBLIC_HOST}:${SRT_PORT}?streamid=publish:live/${STREAM_KEY}
  srt://${PUBLIC_HOST}:${SRT_PORT}?streamid=publish:live/${STREAM_KEY_VERTICAL}

Ports in use: dash=${PORT} rtmp=${RTMP_PORT} srt=${SRT_PORT}
Chat optional — leave Twitch/YouTube/Kick empty until video works.
Secrets: data/omnix.secrets
EOF

echo "=========================================="
echo " Omnix StreamRelay"
echo " Dashboard:      http://${PUBLIC_HOST}:${PORT}/"
echo " Login token:    ${BOOTSTRAP_TOKEN}"
echo " OBS server:     rtmp://${PUBLIC_HOST}:${RTMP_PORT}/live"
echo " OBS key:        ${STREAM_KEY}"
echo " Vertical key:   ${STREAM_KEY_VERTICAL}"
echo " SRT:            srt://${PUBLIC_HOST}:${SRT_PORT}?streamid=publish:live/${STREAM_KEY}"
echo " (OBS: leave authentication OFF)"
echo " Details: FIRST_LOGIN.txt"
if [[ "$GENERATED" -eq 1 ]]; then
  echo " (new secrets auto-generated and saved)"
fi
echo "=========================================="

sed -e "s|PUBLISH_PASS|${MTX_PUBLISH_PASS}|g" \
    -e "s|API_PASS|${MTX_API_PASS}|g" \
    -e "s|RTMP_PORT|${RTMP_PORT}|g" \
    -e "s|SRT_PORT|${SRT_PORT}|g" \
    /opt/omnix/mediamtx.yml.template > /home/container/mediamtx.yml

echo "[omnix] starting MediaMTX (rtmp :${RTMP_PORT}, srt :${SRT_PORT})…"
/usr/local/bin/mediamtx /home/container/mediamtx.yml \
  >> /home/container/logs/mediamtx.log 2>&1 &
MTX_PID=$!

cleanup() {
  echo "[omnix] stopping…"
  kill "$MTX_PID" 2>/dev/null || true
  wait "$MTX_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 30); do
  if wget -qO- --user=admin --password="${MTX_API_PASS}" \
      "http://127.0.0.1:9997/v3/paths/list" >/dev/null 2>&1; then
    echo "[omnix] MediaMTX ready"
    break
  fi
  sleep 0.5
done

echo "[omnix] starting bot on :${PORT}…"
exec node --experimental-sqlite /opt/omnix/bot/dist/index.js
