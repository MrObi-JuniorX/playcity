import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { currentSession, cookies } from "../auth/session";
import { hmac, same, sha256, token } from "../auth/crypto";
import type { AuthEnv } from "../auth/env";
import { ipOf } from "../http";

/* Who may use the console (docs/whot-cup-prd.md, AD-1).

   Three things must all hold for a console request:
   1. a player session (the phone sign-in from Phase 1);
   2. that player on the staff list (the staff table, or OWNER_PLAYER_IDS for the first owner);
   3. a console session, opened only by a passkey that player registered. Console sessions last 8 hours and are
      tied to the player, so a stolen console cookie is useless without the same player's session.

   Registering a first passkey needs only (1) and (2); every later passkey needs a console session too, so a stolen
   phone session can't add an attacker's key to an account that already has one.

   For now there is also a shared code (the CONSOLE_CODE secret; see "the temporary code" below), because players
   can't sign in on a deployed site yet. It stops working the moment cash is switched on. */

export type Role = "owner" | "cup-admin" | "integrity" | "finance";
export const ROLES: Role[] = ["owner", "cup-admin", "integrity", "finance"];
export const CONSOLE_COOKIE = "__Host-pc_c";
const CONSOLE_MS = 8 * 3600_000;
const CHALLENGE_MS = 5 * 60_000;

export type ConsoleEnv = AuthEnv & { OWNER_PLAYER_IDS?: string; CASH_ENABLED?: string; CONSOLE_CODE?: string };

export async function rolesOf(env: ConsoleEnv, playerId: string): Promise<Role[]> {
  const roles = new Set<Role>();
  if ((env.OWNER_PLAYER_IDS || "").split(",").map(s => s.trim()).includes(playerId)) roles.add("owner");
  const row = await env.DB.prepare("SELECT roles FROM staff WHERE player_id = ?").bind(playerId).first<string>("roles");
  for (const r of (row || "").split(",")) if (ROLES.includes(r as Role)) roles.add(r as Role);
  return [...roles];
}

export interface Staff { playerId: string; roles: Role[]; name: string | null }
export interface ConsoleUser extends Staff { sessionId: string }

/** The player behind this request if they are staff, whether or not they have unlocked the console yet. */
export async function staffOf(env: ConsoleEnv, req: Request): Promise<Staff | null> {
  const s = await currentSession(env, req);
  if (!s) return null;
  const roles = await rolesOf(env, s.playerId);
  if (!roles.length) return null;
  const name = await env.DB.prepare("SELECT name FROM players WHERE id = ?").bind(s.playerId).first<string>("name");
  return { playerId: s.playerId, roles, name };
}

/** A fully unlocked console user (phone session + staff + passkey session), or null. */
export async function consoleUser(env: ConsoleEnv, req: Request): Promise<ConsoleUser | null> {
  const t = cookies(req)[CONSOLE_COOKIE];
  if (t?.startsWith("code.")) return (await codeCookieOk(env, t)) ? CODE_USER : null;
  const staff = await staffOf(env, req);
  if (!staff || !t || t.length > 64) return null;
  const id = await sha256(t);
  const row = await env.DB.prepare("SELECT player_id FROM console_sessions WHERE id = ? AND revoked_at IS NULL AND expires_at > ?").bind(id, Date.now()).first<string>("player_id");
  return row === staff.playerId ? { ...staff, sessionId: id } : null;
}

export const can = (u: { roles: Role[] }, ...need: Role[]) => u.roles.includes("owner") || need.some(r => u.roles.includes(r));

/* ---------- passkeys ---------- */

const b64url = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));

const rp = (req: Request) => { const u = new URL(req.url); return { rpID: u.hostname, origin: u.origin }; };

async function saveChallenge(env: ConsoleEnv, playerId: string, kind: "register" | "login", challenge: string) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM webauthn_challenges WHERE player_id = ? AND kind = ?").bind(playerId, kind),
    env.DB.prepare("INSERT INTO webauthn_challenges (id, player_id, kind, challenge, expires_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), playerId, kind, challenge, now + CHALLENGE_MS),
  ]);
}
/** Take (and delete) the player's pending challenge: each one works once. */
async function takeChallenge(env: ConsoleEnv, playerId: string, kind: "register" | "login"): Promise<string | null> {
  return env.DB.prepare("DELETE FROM webauthn_challenges WHERE player_id = ? AND kind = ? AND expires_at > ? RETURNING challenge").bind(playerId, kind, Date.now()).first<string>("challenge");
}

export async function passkeyCount(env: ConsoleEnv, playerId: string): Promise<number> {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE player_id = ?").bind(playerId).first<number>("n")) ?? 0;
}

export async function registerOptions(env: ConsoleEnv, req: Request, staff: Staff) {
  const existing = await env.DB.prepare("SELECT id, transports FROM passkeys WHERE player_id = ?").bind(staff.playerId).all<{ id: string; transports: string | null }>();
  const options = await generateRegistrationOptions({
    rpName: "playcity console", rpID: rp(req).rpID,
    userName: staff.name || "staff", userDisplayName: staff.name || "staff", userID: new Uint8Array(new TextEncoder().encode(staff.playerId)),
    attestationType: "none",
    excludeCredentials: existing.results.map(c => ({ id: c.id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
  await saveChallenge(env, staff.playerId, "register", options.challenge);
  return options;
}

export async function registerVerify(env: ConsoleEnv, req: Request, staff: Staff, response: RegistrationResponseJSON, name: string): Promise<string | null> {
  const expectedChallenge = await takeChallenge(env, staff.playerId, "register");
  if (!expectedChallenge) return null;
  const { rpID, origin } = rp(req);
  let v;
  try { v = await verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true }); }
  catch { return null; }
  if (!v.verified) return null;
  const c = v.registrationInfo.credential;
  await env.DB.prepare("INSERT INTO passkeys (id, player_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(c.id, staff.playerId, b64url(c.publicKey), c.counter, c.transports ? JSON.stringify(c.transports) : null, name.slice(0, 40) || "Passkey", Date.now()).run();
  return c.id;
}

export async function loginOptions(env: ConsoleEnv, req: Request, staff: Staff) {
  const keys = await env.DB.prepare("SELECT id, transports FROM passkeys WHERE player_id = ?").bind(staff.playerId).all<{ id: string; transports: string | null }>();
  if (!keys.results.length) return null;
  const options = await generateAuthenticationOptions({
    rpID: rp(req).rpID, userVerification: "required",
    allowCredentials: keys.results.map(c => ({ id: c.id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
  });
  await saveChallenge(env, staff.playerId, "login", options.challenge);
  return options;
}

/** Check a passkey assertion and open a console session. Returns the Set-Cookie line, or null. */
export async function loginVerify(env: ConsoleEnv, req: Request, staff: Staff, response: AuthenticationResponseJSON): Promise<{ cookie: string; passkeyId: string } | null> {
  const expectedChallenge = await takeChallenge(env, staff.playerId, "login");
  if (!expectedChallenge || typeof response?.id !== "string") return null;
  const key = await env.DB.prepare("SELECT id, public_key, counter, transports FROM passkeys WHERE id = ? AND player_id = ?").bind(response.id, staff.playerId)
    .first<{ id: string; public_key: string; counter: number; transports: string | null }>();
  if (!key) return null;
  const { rpID, origin } = rp(req);
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
      credential: { id: key.id, publicKey: unb64url(key.public_key), counter: key.counter, transports: key.transports ? JSON.parse(key.transports) : undefined },
    });
  } catch { return null; }
  if (!v.verified) return null;
  const t = token(), now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?").bind(v.authenticationInfo.newCounter, now, key.id),
    env.DB.prepare("INSERT INTO console_sessions (id, player_id, passkey_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").bind(await sha256(t), staff.playerId, key.id, now, now + CONSOLE_MS),
  ]);
  return { cookie: consoleCookie(t), passkeyId: key.id };
}

const consoleCookie = (value: string) => `${CONSOLE_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${CONSOLE_MS / 1000}`;
export const clearConsoleCookie = () => `${CONSOLE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

/* ---------- the temporary code ---------- */

/* One shared secret that opens the console as an owner, with no player session. The cookie is signed and bound to the
   code, so changing the secret ends every session; it holds no row because console_sessions needs a real player. */
const MAX_WRONG_PER_IP = 5, IP_WINDOW_MS = 15 * 60_000;
const MAX_WRONG_ALL = 30, ALL_WINDOW_MS = 24 * 3600_000;
export const CODE_ACTOR = "console-code";
const CODE_USER: ConsoleUser = { playerId: CODE_ACTOR, roles: ["owner"], name: "Console code", sessionId: "code" };

export const codeEnabled = (env: ConsoleEnv) => !!env.CONSOLE_CODE && !!env.PHONE_HMAC_KEY && env.CASH_ENABLED !== "1";

const codeSig = (env: ConsoleEnv, exp: string) => hmac(env.PHONE_HMAC_KEY!, "console-code-cookie", `${exp}:${env.CONSOLE_CODE}`);

async function codeCookieOk(env: ConsoleEnv, value: string): Promise<boolean> {
  if (!codeEnabled(env) || value.length > 100) return false;
  const [, exp, sig] = value.split(".");
  return Number(exp) > Date.now() && !!sig && same(sig, await codeSig(env, exp));
}

/** Try the code. Each try takes a place in the limits before the code is looked at, in one statement, so guesses sent
    together can't slip past the count. A right code gives its place back; a refused try takes none, so hammering a
    locked console doesn't lengthen the lock. Returns the Set-Cookie line, "wrong", or "locked". */
export async function unlockWithCode(env: ConsoleEnv, req: Request, code: string): Promise<{ cookie: string } | "wrong" | "locked"> {
  const hk = env.PHONE_HMAC_KEY!, now = Date.now(), ip = await hmac(hk, "ip", ipOf(req) || "none");
  const place = await env.DB.prepare(`INSERT INTO console_code_attempts (ip_hash, at) SELECT ?1, ?2
      WHERE (SELECT COUNT(*) FROM console_code_attempts WHERE ip_hash = ?1 AND at > ?3) < ?4
        AND (SELECT COUNT(*) FROM console_code_attempts WHERE at > ?5) < ?6 RETURNING id`)
    .bind(ip, now, now - IP_WINDOW_MS, MAX_WRONG_PER_IP, now - ALL_WINDOW_MS, MAX_WRONG_ALL).first<number>("id");
  if (place === null) {
    const all = await env.DB.prepare("SELECT COUNT(*) AS n FROM console_code_attempts WHERE at > ?").bind(now - ALL_WINDOW_MS).first<number>("n");
    if ((all ?? 0) >= MAX_WRONG_ALL) console.error(JSON.stringify({ alert: true, msg: "console code locked: too many wrong tries" }));
    return "locked";
  }
  if (!same(await hmac(hk, "console-code", code), await hmac(hk, "console-code", env.CONSOLE_CODE!))) return "wrong";
  await env.DB.prepare("DELETE FROM console_code_attempts WHERE id = ?").bind(place).run();
  const exp = String(now + CONSOLE_MS);
  return { cookie: consoleCookie(`code.${exp}.${await codeSig(env, exp)}`) };
}

/* ---------- audit (AD-6) ---------- */

/** An audit row. With `onlyIfChanged`, it is written only when the statement just before it in the same batch changed
    a row, so a guarded update that lost a race leaves no record of a change that never happened. */
export function auditStatement(env: ConsoleEnv, actor: string, action: string, target: string | null, before: unknown, after: unknown, onlyIfChanged = false): D1PreparedStatement {
  const vals = [actor, action, target, before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after), Date.now()];
  return onlyIfChanged
    ? env.DB.prepare("INSERT INTO audit (actor, action, target, before_json, after_json, at) SELECT ?, ?, ?, ?, ?, ? WHERE changes() > 0").bind(...vals)
    : env.DB.prepare("INSERT INTO audit (actor, action, target, before_json, after_json, at) VALUES (?, ?, ?, ?, ?, ?)").bind(...vals);
}

/** Daily housekeeping for the console tables. */
export async function consoleCleanup(env: ConsoleEnv, now = Date.now()) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM webauthn_challenges WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM console_sessions WHERE expires_at < ?").bind(now - 30 * 24 * 3600_000),
    env.DB.prepare("DELETE FROM console_code_attempts WHERE at < ?").bind(now - ALL_WINDOW_MS),
    env.DB.prepare("DELETE FROM audit WHERE at < ?").bind(now - 2 * 365 * 24 * 3600_000),
  ]);
}
