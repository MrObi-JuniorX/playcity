import { env, exports } from "cloudflare:workers";
import { expect } from "vitest";

/* Shared by the Worker tests: call the Worker as a browser on our own origin would, and sign in through the real
   code flow (dev mode puts codes in dev_sms_outbox). */
export const ORIGIN = "https://play.test";
export const E = env as unknown as { DB: D1Database; PHONE_HMAC_KEY: string; PHONE_ENC_KEY: string };

export async function call(method: string, path: string, o: { body?: unknown; cookie?: string; ip?: string; origin?: string | null; type?: string } = {}) {
  const headers: Record<string, string> = { "CF-Connecting-IP": o.ip ?? "203.0.113.1" };
  if (o.origin !== null) headers.Origin = o.origin ?? ORIGIN;
  if (o.body !== undefined) headers["Content-Type"] = o.type ?? "application/json";
  if (o.cookie) headers.Cookie = o.cookie;
  const res = await exports.default.fetch(`${ORIGIN}${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, setCookies: res.headers.getSetCookie() };
}

export const sendCode = (country: string, phone: string, ip = "203.0.113.1", turnstile = "dev-pass") =>
  call("POST", "/api/auth/otp/start", { body: { country, phone, turnstile }, ip });

export async function lastCode(country: string, phone: string): Promise<string> {
  const r = await call("GET", `/api/dev/outbox?country=${country}&phone=${encodeURIComponent(phone)}`);
  const m = /(\d{6})/.exec(r.json?.body ?? "");
  if (!m) throw new Error("no code sent: " + JSON.stringify(r.json));
  return m[1];
}

/** Sign in end to end; returns the Cookie header to send afterwards. */
export async function signIn(country: string, phone: string, ip = "203.0.113.1") {
  expect((await sendCode(country, phone, ip)).status).toBe(200);
  const v = await call("POST", "/api/auth/otp/verify", { body: { country, phone, code: await lastCode(country, phone) }, ip });
  expect(v.status).toBe(200);
  const cookie = v.setCookies.map(c => c.split(";")[0]).join("; ");
  return { cookie, player: v.json.player, created: v.json.created, setCookies: v.setCookies };
}

