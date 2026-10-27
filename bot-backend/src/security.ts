import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const loginHits = new Map<string, { n: number; reset: number }>();
const LOGIN_HIT_CAP = 5000;

function pruneLoginHits(now: number): void {
  for (const [ip, row] of loginHits) {
    if (now > row.reset) loginHits.delete(ip);
  }
  if (loginHits.size <= LOGIN_HIT_CAP) return;
  const overflow = loginHits.size - LOGIN_HIT_CAP;
  let i = 0;
  for (const ip of loginHits.keys()) {
    loginHits.delete(ip);
    if (++i >= overflow) break;
  }
}

export function timingSafeStringEq(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

export function rateLimitLogin(ip: string, limit = 20, windowMs = 60_000): boolean {
  const now = Date.now();
  if (loginHits.size > 64) pruneLoginHits(now);
  const row = loginHits.get(ip);
  if (!row || now > row.reset) {
    loginHits.set(ip, { n: 1, reset: now + windowMs });
    return true;
  }
  if (row.n >= limit) return false;
  row.n += 1;
  return true;
}

export async function registerSecurity(app: FastifyInstance): Promise<void> {
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cross-Origin-Resource-Policy", "same-origin");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; base-uri 'self'; form-action 'self'"
    );
    return payload;
  });

  app.addHook("preHandler", async (req, reply) => {
    if (req.url.startsWith("/api/") && !["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"].includes(req.method)) {
      return reply.code(405).send({ error: "method not allowed" });
    }
  });
}

export function clientIp(req: FastifyRequest): string {
  return req.ip || "unknown";
}

export function tooMany(reply: FastifyReply) {
  return reply.code(429).send({ error: "too many attempts — try again later" });
}
