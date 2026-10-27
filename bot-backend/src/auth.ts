import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { config } from "./config.js";
import { consumeRefreshToken, storeRefreshToken } from "./db.js";
import { timingSafeStringEq } from "./security.js";

const accessKey = () => new TextEncoder().encode(config.jwtAccessSecret);
const refreshKey = () => new TextEncoder().encode(config.jwtRefreshSecret);

export type AccessClaims = { sub: "operator"; typ: "access" };

export async function issueTokens(): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  const expiresIn = 15 * 60;
  const accessToken = await new SignJWT({ typ: "access" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("operator")
    .setIssuedAt()
    .setExpirationTime(`${expiresIn}s`)
    .sign(accessKey());

  const refreshToken = await new SignJWT({ typ: "refresh" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("operator")
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(refreshKey());

  const { payload } = await jwtVerify(refreshToken, refreshKey());
  storeRefreshToken(String(payload.jti), refreshToken, (payload.exp ?? 0) * 1000);
  return { accessToken, refreshToken, expiresIn };
}

export async function verifyAccess(token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, accessKey());
  if (payload.typ !== "access" || payload.sub !== "operator") throw new Error("invalid access token");
  return { sub: "operator", typ: "access" };
}

export async function refresh(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  const { payload } = await jwtVerify(refreshToken, refreshKey());
  if (payload.typ !== "refresh" || payload.sub !== "operator") throw new Error("invalid refresh token");
  if (!consumeRefreshToken(refreshToken)) throw new Error("refresh token revoked or expired");
  return issueTokens();
}

export function bootstrapOk(token: string): boolean {
  if (!token || !config.bootstrapToken) return false;
  return timingSafeStringEq(token, config.bootstrapToken);
}
