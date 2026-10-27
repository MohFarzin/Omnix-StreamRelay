FROM node:22-alpine AS build
WORKDIR /app
COPY bot-backend/package.json bot-backend/package-lock.json* ./
RUN npm install
COPY bot-backend/tsconfig.json ./
COPY bot-backend/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
RUN apk add --no-cache ffmpeg wget ca-certificates
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
COPY client-ui/ ./public/
ENV NODE_ENV=production
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --retries=5 --start-period=20s \
  CMD wget -qO- http://127.0.0.1:8080/api/v1/health || exit 1
CMD ["node", "--experimental-sqlite", "dist/index.js"]
