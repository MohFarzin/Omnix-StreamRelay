# Omnix StreamRelay — single image for Pterodactyl Wings (one container)
FROM bluenviron/mediamtx:1.11.3 AS mtx

FROM node:22-bookworm-slim AS botbuild
WORKDIR /app
COPY bot-backend/package.json bot-backend/package-lock.json* ./
RUN npm install
COPY bot-backend/tsconfig.json ./
COPY bot-backend/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ffmpeg ca-certificates curl wget iproute2 tini \
  && rm -rf /var/lib/apt/lists/* \
  && useradd -m -d /home/container container

COPY --from=mtx /mediamtx /usr/local/bin/mediamtx
COPY --from=botbuild /app/dist /opt/omnix/bot/dist
COPY --from=botbuild /app/node_modules /opt/omnix/bot/node_modules
COPY --from=botbuild /app/package.json /opt/omnix/bot/package.json
COPY client-ui/ /opt/omnix/public/
COPY pterodactyl/mediamtx.yml.template /opt/omnix/mediamtx.yml.template
COPY pterodactyl/start.sh /opt/omnix/start.sh
COPY pterodactyl/entrypoint.sh /entrypoint.sh
RUN chmod +x /opt/omnix/start.sh /entrypoint.sh

USER container
ENV USER=container HOME=/home/container
ENV NODE_ENV=production
ENV DATA_DIR=/home/container/data
ENV PUBLIC_DIR=/opt/omnix/public
ENV MTX_API_URL=http://127.0.0.1:9997
ENV MTX_RTSP_BASE=rtsp://127.0.0.1:8554
WORKDIR /home/container

EXPOSE 8080 1935 8554 8890/udp 9997

ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/entrypoint.sh"]
CMD ["bash", "/opt/omnix/start.sh"]
