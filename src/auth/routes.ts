import { allowedCountries, COUNTRIES, maskPhone, normalizePhone } from "./phone";
import { encrypt, hmac, same, sixDigits } from "./crypto";
import { codeMessage, smsSender } from "./sms";
import { turnstileOk } from "./turnstile";
import { countryCap, limits } from "./limits";
import { currentSession, deviceOf, sessionCookie, startSession } from "./session";
import { isDev, type AuthEnv } from "./env";
import { fail, ipOf, json, readJson as body, sameOrigin, type Json } from "../http";

/* Identity endpoints (docs/whot-cup-prd.md, Phase 1).
   GET   /api/auth/config        Turnstile site key and the countries that can sign in
   POST  /api/auth/otp/start     { country, phone, turnstile } -> a code by SMS (the answer never says whether the number has an account)
   POST  /api/auth/otp/verify    { country, phone, code } -> signed in (Set-Cookie), { player, created }
   POST  /api/auth/signout       this device
   POST  /api/auth/signout-all   every device (S-9)
   GET   /api/me                 the signed-in player
   PATCH /api/me                 { name?, avatar?, adult?, weeklyLimit?, coolOff?, smsCheckin? }
   GET   /api/dev/outbox         dev mode only: the last code sent to a number, for the local sign-in page */

const SHAPES = ["circle", "triangle", "cross", "square", "star"] as const;
const COLORS = ["maroon", "gold", "green", "blue", "purple", "orange", "teal", "pink"] as const;
const COOL_OFF: Record<string, number> = { "24h": 24 * 3600_000, "7d": 7 * 24 * 3600_000, "30d": 30 * 24 * 3600_000 };
const RAISE_DELAY_MS = 24 * 3600_000;
const MAX_LIMIT = 10_000_000;

function keys(env: AuthEnv): { hk: string; ek: string } | null {
  return env.PHONE_HMAC_KEY && env.PHONE_ENC_KEY ? { hk: env.PHONE_HMAC_KEY, ek: env.PHONE_ENC_KEY } : null;
}

export async function authRoute(req: Request, env: AuthEnv, path: string): Promise<Response | null> {
  const m = req.method;
  if (path === "/api/auth/config" && m === "GET") return config(env);
  if (path === "/api/me" && m === "GET") return me(req, env);
  if (path === "/api/dev/outbox" && m === "GET") return devOutbox(req, env);
  const writes: Record<string, (r: Request, e: AuthEnv) => Promise<Response>> = {
    "POST /api/auth/otp/start": start, "POST /api/auth/otp/verify": verify,
    "POST /api/auth/signout": signout, "POST /api/auth/signout-all": signoutAll, "PATCH /api/me": updateMe,
  };
  const h = writes[`${m} ${path}`];
  if (!h) return path.startsWith("/api/auth/") || path === "/api/me" ? fail(404, "not-found") : null;
  if (!sameOrigin(req)) return fail(403, "bad-origin");
  return h(req, env);
}

function config(env: AuthEnv): Response {
  return json({
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || (isDev(env) ? "dev" : null),
    countries: allowedCountries(env.AUTH_COUNTRIES).map(c => ({ iso: c.iso, dial: c.dial, name: c.name })),
    available: !!keys(env) && !!smsSender(env) && (!!env.TURNSTILE_SECRET || isDev(env)),
  });
}

/* ---------- sending a code ---------- */

async function start(req: Request, env: AuthEnv): Promise<Response> {
  const k = keys(env), sender = smsSender(env);
  if (!k || !sender) return fail(503, "unavailable");                       // fail closed: nothing half-configured goes live
  const b = await body(req);
  if (!b) return fail(400, "bad-request");
  const country = allowedCountries(env.AUTH_COUNTRIES).find(c => c.iso === b.country);
  if (!country) return fail(400, "country-not-supported");
  const e164 = normalizePhone(country, String(b.phone ?? ""));
  if (!e164) return fail(400, "bad-number");
  const ip = ipOf(req);
  if (!(await turnstileOk(env, b.turnstile, ip))) return fail(403, "turnstile");

  const L = limits(env), now = Date.now();
  const phoneHmac = await hmac(k.hk, "phone", e164), ipHash = await hmac(k.hk, "ip", ip || "none");
  const day = now - 24 * 3600_000;
  const counts = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS first FROM otp_requests WHERE phone_hmac = ? AND created_at > ?").bind(phoneHmac, now - 15 * 60_000),
    env.DB.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS first FROM otp_requests WHERE phone_hmac = ? AND created_at > ?").bind(phoneHmac, day),
    env.DB.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS first FROM otp_requests WHERE ip_hash = ? AND created_at > ?").bind(ipHash, now - 3600_000),
    env.DB.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS first FROM otp_requests WHERE ip_hash = ? AND created_at > ?").bind(ipHash, day),
    env.DB.prepare("SELECT COUNT(*) AS n FROM otp_requests WHERE country = ? AND created_at > ?").bind(country.iso, day),
    env.DB.prepare("SELECT COUNT(*) AS n FROM otp_requests WHERE created_at > ?").bind(day),
  ]);
  const row = (i: number) => (counts[i].results[0] as { n: number; first: number | null });
  const wait = (i: number, windowMs: number) => Math.max(1, Math.ceil(((row(i).first ?? now) + windowMs - now) / 1000));
  if (row(0).n >= L.perNumber15m) return fail(429, "too-many-for-number", { retryAfter: wait(0, 15 * 60_000) });
  if (row(1).n >= L.perNumberDay) return fail(429, "too-many-for-number", { retryAfter: wait(1, 24 * 3600_000) });
  if (row(2).n >= L.perIpHour) return fail(429, "too-many-from-network", { retryAfter: wait(2, 3600_000) });
  if (row(3).n >= L.perIpDay) return fail(429, "too-many-from-network", { retryAfter: wait(3, 24 * 3600_000) });
  if (row(4).n >= countryCap(L, country.iso)) { alert("sms country cap reached", { country: country.iso }); return fail(503, "busy"); }
  if (row(5).n >= L.globalDay) { alert("sms daily spend cap reached", { sent: row(5).n }); return fail(503, "busy"); }
  if (row(5).n + 1 === Math.ceil(L.globalDay * L.alertAt)) alert("sms daily spend at alert level", { sent: row(5).n + 1, cap: L.globalDay });

  const code = sixDigits();
  await env.DB.batch([
    env.DB.prepare("UPDATE otp_requests SET superseded = 1 WHERE phone_hmac = ? AND used_at IS NULL AND superseded = 0").bind(phoneHmac),
    env.DB.prepare("INSERT INTO otp_requests (phone_hmac, ip_hash, country, code_hmac, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(phoneHmac, ipHash, country.iso, await hmac(k.hk, "code", `${phoneHmac}:${code}`), now, now + L.codeTtlMs),
  ]);
  if (!(await sender.send("+" + e164, codeMessage(code), phoneHmac))) return fail(502, "sms-failed");
  return json({ ok: true, expiresIn: Math.round(L.codeTtlMs / 1000) });
}

/* Structured line for the alerting pipeline. Never carries a number or a code. */
function alert(msg: string, data: Json) { console.error(JSON.stringify({ alert: true, msg, ...data })); }

/* ---------- checking a code and signing in ---------- */

async function verify(req: Request, env: AuthEnv): Promise<Response> {
  const k = keys(env);
  if (!k) return fail(503, "unavailable");
  const b = await body(req);
  if (!b) return fail(400, "bad-request");
  const country = allowedCountries(env.AUTH_COUNTRIES).find(c => c.iso === b.country);
  const e164 = country ? normalizePhone(country, String(b.phone ?? "")) : null;
  const code = String(b.code ?? "");
  if (!country || !e164 || !/^\d{6}$/.test(code)) return fail(400, "bad-request");
  const L = limits(env), now = Date.now();
  const phoneHmac = await hmac(k.hk, "phone", e164);
  const otp = await env.DB.prepare("SELECT id, code_hmac, attempts, expires_at FROM otp_requests WHERE phone_hmac = ? AND used_at IS NULL AND superseded = 0 ORDER BY id DESC LIMIT 1")
    .bind(phoneHmac).first<{ id: number; code_hmac: string; attempts: number; expires_at: number }>();
  if (!otp || otp.expires_at <= now) return fail(400, "code-expired");
  if (otp.attempts >= L.maxAttempts) return fail(400, "code-locked");
  const good = same(otp.code_hmac, await hmac(k.hk, "code", `${phoneHmac}:${code}`));
  if (!good) {
    const r = await env.DB.prepare("UPDATE otp_requests SET attempts = attempts + 1 WHERE id = ? RETURNING attempts").bind(otp.id).first<{ attempts: number }>();
    const left = Math.max(0, L.maxAttempts - (r?.attempts ?? L.maxAttempts));
    return fail(400, left ? "code-wrong" : "code-locked", { attemptsLeft: left });
  }
  // Single use: only the request that flips used_at signs in, even if two arrive together.
  const used = await env.DB.prepare("UPDATE otp_requests SET used_at = ? WHERE id = ? AND used_at IS NULL AND attempts < ? RETURNING id").bind(now, otp.id, L.maxAttempts).first();
  if (!used) return fail(400, "code-expired");

  const id = crypto.randomUUID();
  const inserted = await env.DB.prepare(
    "INSERT INTO players (id, phone_hmac, phone_enc, phone_country, phone_last2, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(phone_hmac) DO NOTHING RETURNING id")
    .bind(id, phoneHmac, await encrypt(k.ek, e164), country.iso, e164.slice(-2), now, now).first<{ id: string }>();
  const player = await env.DB.prepare("SELECT * FROM players WHERE phone_hmac = ?").bind(phoneHmac).first<PlayerRow>();
  if (!player) return fail(500, "server-error");
  const dev = deviceOf(req);
  const cookie = await startSession(env, player.id, dev.id, await hmac(k.hk, "ip", ipOf(req) || "none"));
  const headers = new Headers({ "Cache-Control": "no-store" });
  headers.append("Set-Cookie", cookie);
  if (dev.set) headers.append("Set-Cookie", dev.set);
  return Response.json({ player: view(player), created: !!inserted }, { headers });
}

/* ---------- signing out ---------- */

async function signout(req: Request, env: AuthEnv): Promise<Response> {
  const s = await currentSession(env, req);
  if (s) await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?").bind(Date.now(), s.id).run();
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
}

async function signoutAll(req: Request, env: AuthEnv): Promise<Response> {
  const s = await currentSession(env, req);
  if (!s) return fail(401, "signed-out");
  await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE player_id = ? AND revoked_at IS NULL").bind(Date.now(), s.playerId).run();
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
}

/* ---------- the profile ---------- */

interface PlayerRow {
  id: string; phone_enc: string; phone_country: string; phone_last2: string; name: string | null;
  avatar_shape: string | null; avatar_color: string | null; adult_at: number | null;
  weekly_limit: number | null; weekly_limit_next: number | null; weekly_limit_next_at: number | null; weekly_limit_next_set: number;
  cool_off_until: number | null; created_at: number; sms_checkin: number;
}

function view(p: PlayerRow) {
  const dial = COUNTRIES.find(c => c.iso === p.phone_country)?.dial ?? "";
  const now = Date.now();
  return {
    id: p.id, name: p.name,
    avatar: p.avatar_shape ? { shape: p.avatar_shape, color: p.avatar_color } : null,
    phone: maskPhone(dial, p.phone_last2),
    adult: p.adult_at !== null,
    weeklyLimit: p.weekly_limit,
    weeklyLimitNext: p.weekly_limit_next_set ? { value: p.weekly_limit_next, at: p.weekly_limit_next_at } : null,
    coolOffUntil: p.cool_off_until && p.cool_off_until > now ? p.cool_off_until : null,
    smsCheckin: !!p.sms_checkin,
    complete: !!p.name && !!p.avatar_shape && p.adult_at !== null,
  };
}

/* A raise to the weekly limit that has waited its 24 hours becomes the limit. */
async function settleLimit(env: AuthEnv, p: PlayerRow): Promise<PlayerRow> {
  if (!p.weekly_limit_next_set || (p.weekly_limit_next_at ?? Infinity) > Date.now()) return p;
  await env.DB.prepare("UPDATE players SET weekly_limit = weekly_limit_next, weekly_limit_next = NULL, weekly_limit_next_at = NULL, weekly_limit_next_set = 0, updated_at = ? WHERE id = ?")
    .bind(Date.now(), p.id).run();
  return { ...p, weekly_limit: p.weekly_limit_next, weekly_limit_next: null, weekly_limit_next_at: null, weekly_limit_next_set: 0 };
}

async function loadMe(req: Request, env: AuthEnv): Promise<PlayerRow | null> {
  const s = await currentSession(env, req);
  if (!s) return null;
  const p = await env.DB.prepare("SELECT * FROM players WHERE id = ?").bind(s.playerId).first<PlayerRow>();
  return p ? settleLimit(env, p) : null;
}

async function me(req: Request, env: AuthEnv): Promise<Response> {
  const p = await loadMe(req, env);
  return p ? json({ player: view(p) }) : fail(401, "signed-out");
}

export function cleanName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f<>"'`\\]/g, "").replace(/\s+/g, " ").trim();
  return [...s].length >= 2 && [...s].length <= 14 ? s : null;
}

async function updateMe(req: Request, env: AuthEnv): Promise<Response> {
  const p = await loadMe(req, env);
  if (!p) return fail(401, "signed-out");
  const b = await body(req);
  if (!b) return fail(400, "bad-request");
  const now = Date.now(), set: string[] = [], args: unknown[] = [];
  const put = (col: string, v: unknown) => { set.push(`${col} = ?`); args.push(v); };

  if ("name" in b) { const n = cleanName(b.name); if (!n) return fail(400, "bad-name"); put("name", n); }
  if ("avatar" in b) {
    const a = b.avatar as Json | null;
    if (!a || !SHAPES.includes(a.shape as never) || !COLORS.includes(a.color as never)) return fail(400, "bad-avatar");
    put("avatar_shape", a.shape); put("avatar_color", a.color);
  }
  if ("adult" in b) {                                         // a declaration, made once; it can't be withdrawn here
    if (b.adult !== true) return fail(400, "bad-adult");
    if (p.adult_at === null) put("adult_at", now);
  }
  if ("weeklyLimit" in b) {
    const v = b.weeklyLimit;
    if (v !== null && (!Number.isInteger(v) || (v as number) < 0 || (v as number) > MAX_LIMIT)) return fail(400, "bad-limit");
    const next = v as number | null, cur = p.weekly_limit;
    const lower = next !== null && (cur === null || next <= cur);
    if (lower) { put("weekly_limit", next); put("weekly_limit_next", null); put("weekly_limit_next_at", null); put("weekly_limit_next_set", 0); }
    else { put("weekly_limit_next", next); put("weekly_limit_next_at", now + RAISE_DELAY_MS); put("weekly_limit_next_set", 1); }   // a raise, or removing the limit, waits 24 h
  }
  if ("smsCheckin" in b) {                                    // a text when check-in opens: the only SMS besides sign-in codes
    if (typeof b.smsCheckin !== "boolean") return fail(400, "bad-sms");
    put("sms_checkin", b.smsCheckin ? 1 : 0);
  }
  if ("coolOff" in b) {
    const ms = COOL_OFF[String(b.coolOff)];
    if (!ms) return fail(400, "bad-cool-off");
    const until = now + ms;
    if (!p.cool_off_until || p.cool_off_until < until) put("cool_off_until", until);   // a cool-off only ever gets longer
  }
  if (!set.length) return json({ player: view(p) });
  put("updated_at", now);
  await env.DB.prepare(`UPDATE players SET ${set.join(", ")} WHERE id = ?`).bind(...args, p.id).run();
  const fresh = await env.DB.prepare("SELECT * FROM players WHERE id = ?").bind(p.id).first<PlayerRow>();
  return json({ player: view(fresh!) });
}

/* ---------- dev only ---------- */

async function devOutbox(req: Request, env: AuthEnv): Promise<Response> {
  const k = keys(env);
  if (!isDev(env) || !k) return fail(404, "not-found");
  const u = new URL(req.url);
  const country = allowedCountries(env.AUTH_COUNTRIES).find(c => c.iso === u.searchParams.get("country"));
  const e164 = country ? normalizePhone(country, u.searchParams.get("phone") || "") : null;
  if (!e164) return fail(400, "bad-request");
  const row = await env.DB.prepare("SELECT body FROM dev_sms_outbox WHERE phone_hmac = ? ORDER BY id DESC LIMIT 1").bind(await hmac(k.hk, "phone", e164)).first<{ body: string }>();
  return json({ body: row?.body ?? null });
}

/* ---------- housekeeping (daily cron) ---------- */

export async function cleanup(env: AuthEnv, now = Date.now()) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM otp_requests WHERE created_at < ?").bind(now - 24 * 3600_000),
    env.DB.prepare("DELETE FROM dev_sms_outbox WHERE created_at < ?").bind(now - 3600_000),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ? OR revoked_at < ?").bind(now - 30 * 24 * 3600_000, now - 30 * 24 * 3600_000),
  ]);
}
