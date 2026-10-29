import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertConfig, config } from "./config.js";
import { initDb } from "./db.js";
import { registerRoutes } from "./routes.js";
import { verifyAccess } from "./auth.js";
import { addClient, startHub } from "./hub.js";
import { startChatEngine, stopChatEngine } from "./chat/engine.js";
import { startReconcileLoop, stopReconcileLoop } from "./relay/ffmpeg.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  assertConfig();
  initDb();

  const app = Fastify({
    logger: true,
    bodyLimit: 3 * 1024 * 1024,
    trustProxy: true,
  });
  const { registerSecurity } = await import("./security.js");
  await registerSecurity(app);
  await app.register(fastifyWebsocket);
  const publicRoot =
    process.env.PUBLIC_DIR || join(__dirname, "..", "public");
  await app.register(fastifyStatic, {
    root: publicRoot,
    prefix: "/",
    // Avoid stale dashboard JS/CSS after deploys (esp. browsers hitting Abu Dhabi)
    setHeaders(res, pathName) {
      if (/\.(html?|js|css)$/i.test(pathName)) {
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
        res.setHeader("Pragma", "no-cache");
      }
    },
  });
  await registerRoutes(app);

  app.get("/api/v1/ws", { websocket: true }, (socket, req) => {
    let authed = false;
    const timer = setTimeout(() => {
      if (!authed) socket.close();
    }, 5000);
    const clearAuthTimer = () => clearTimeout(timer);
    socket.on("close", clearAuthTimer);
    socket.on("error", clearAuthTimer);

    socket.on("message", (raw) => {
      void (async () => {
        try {
          const rawStr = String(raw);
          if (rawStr.length > 4096) {
            socket.close();
            return;
          }
          const msg = JSON.parse(rawStr) as { type?: string; token?: string };
          if (!authed) {
            if (msg.type !== "auth" || !msg.token || msg.token.length > 4096) return;
            await verifyAccess(msg.token);
            authed = true;
            clearAuthTimer();
            addClient(socket);
            socket.send(JSON.stringify({ type: "auth", ok: true }));
            return;
          }
        } catch {
          try {
            socket.send(JSON.stringify({ type: "auth", ok: false }));
          } catch {
            /* ignore */
          }
          socket.close();
        }
      })();
    });
    void req;
  });

  startHub();
  startReconcileLoop();
  await startChatEngine();

  await app.listen({ port: config.port, host: "0.0.0.0" });
  console.log(`Omnix StreamRelay bot on :${config.port}`);

  const shutdown = async () => {
    stopReconcileLoop();
    await stopChatEngine();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
