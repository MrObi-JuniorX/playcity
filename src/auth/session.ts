import { sha256, token } from "./crypto";
import type { AuthEnv } from "./env";

/* Sessions (ID-5): an HttpOnly, Secure, SameSite=Lax cookie holds a random token; the sessions row is keyed by its
   SHA-256, so the table alone opens nothing. __Host- cookies can't be set by subdomains or widened to other paths.
   A second, long-lived cookie names the device, a signal for seating and fraud checks (PRD SE-2, T7). */
export const SESSION_COOKIE = "__Host-pc_s";
export const DEVICE_COOKIE = "__Host-pc_d";
export const SESSION_MS = 30 * 24 * 3600_000;
const TOUCH_MS = 3600_000;                       // refresh last_seen at most hourly: one write an hour, not per request

export function cookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get("Cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export const sessionCookie = (value: string, maxAgeSec: number) =>
  `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
export const deviceCookie = (value: string) =>
  `${DEVICE_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${2 * 365 * 24 * 3600}`;

const DEVICE = /^[A-Za-z0-9_-]{20,64}$/;
/** This browser's device id, and a Set-Cookie line when it is new. */
export function deviceOf(req: Request): { id: string; set: string | null } {
  const have = cookies(req)[DEVICE_COOKIE];
  if (have && DEVICE.test(have)) return { id: have, set: null };
  const id = token();
  return { id, set: deviceCookie(id) };
}

export interface Session { id: string; playerId: string; deviceId: string }

/** The signed-in player for this request, or null. Expired and revoked sessions count as signed out. */
export async function currentSession(env: AuthEnv, req: Request): Promise<Session | null> {
  const t = cookies(req)[SESSION_COOKIE];
  if (!t || t.length > 64) return null;
  const id = await sha256(t), now = Date.now();
  const row = await env.DB.prepare("SELECT player_id, device_id, last_seen_at FROM sessions WHERE id = ? AND revoked_at IS NULL AND expires_at > ?")
    .bind(id, now).first<{ player_id: string; device_id: string; last_seen_at: number }>();
  if (!row) return null;
  if (now - row.last_seen_at > TOUCH_MS) await env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").bind(now, id).run();
  return { id, playerId: row.player_id, deviceId: row.device_id };
}

/** Start a session; returns the cookie line. */
export async function startSession(env: AuthEnv, playerId: string, deviceId: string, ipHash: string): Promise<string> {
  const t = token(), now = Date.now();
  await env.DB.prepare("INSERT INTO sessions (id, player_id, device_id, ip_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(await sha256(t), playerId, deviceId, ipHash, now, now, now + SESSION_MS).run();
  return sessionCookie(t, SESSION_MS / 1000);
}
