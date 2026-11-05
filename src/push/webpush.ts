/* Web Push from the Worker with nothing but Web Crypto (docs/whot-cup-prd.md PX-4).
   VAPID (RFC 8292) proves the push comes from us; the payload is encrypted for the browser that subscribed
   (RFC 8291, "aes128gcm" content coding, RFC 8188), so the push service in between can't read it.

   Settings: VAPID_PUBLIC_KEY (base64url, the 65-byte uncompressed P-256 point), VAPID_PRIVATE_KEY (base64url, the
   32-byte private scalar), VAPID_SUBJECT (a mailto: or https: contact for push services). Without all three, push is
   off and nothing is sent. Generate a pair with: npm run vapid */

export interface PushEnv { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string }
export interface Subscription { endpoint: string; p256dh: string; auth: string }

const enc = new TextEncoder();
export const b64u = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const cat = (...parts: (Uint8Array | number[])[]) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

export const pushReady = (env: PushEnv) => !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);

/** RFC 8291: encrypt `plain` for the browser holding the private half of `p256dh`, with its `auth` secret.
    `salt` and `server` are for test vectors only; every real message gets a fresh salt and key pair. */
export async function encryptPayload(p256dh: Uint8Array, auth: Uint8Array, plain: Uint8Array, salt = crypto.getRandomValues(new Uint8Array(16)), server?: CryptoKeyPair): Promise<Uint8Array> {
  const as = server ?? await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey) as ArrayBuffer);
  const ua = await crypto.subtle.importKey("raw", p256dh, { name: "ECDH", namedCurve: "P-256" }, false, []);
  // The standard field is `public` (workers-types spells it `$public`; the runtime and Node take `public`).
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: ua } as unknown as SubtleCryptoDeriveKeyAlgorithm, as.privateKey, 256));
  const ikm = (await hmac(await hmac(auth, shared), cat(enc.encode("WebPush: info\0"), p256dh, asPub, [1]))).slice(0, 32);
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(enc.encode("Content-Encoding: aes128gcm\0"), [1]))).slice(0, 16);
  const nonce = (await hmac(prk, cat(enc.encode("Content-Encoding: nonce\0"), [1]))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, cat(plain, [2])));   // 2: the last (only) record
  return cat(salt, [0, 0, 0x10, 0], [asPub.length], asPub, ct);                                                     // record size 4096
}

let signing: { pub: string; key: Promise<CryptoKey> } | null = null;
function signingKey(env: PushEnv): Promise<CryptoKey> {
  if (signing && signing.pub === env.VAPID_PUBLIC_KEY) return signing.key;
  const p = unb64u(env.VAPID_PUBLIC_KEY!);
  const key = crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: b64u(p.slice(1, 33)), y: b64u(p.slice(33, 65)), d: env.VAPID_PRIVATE_KEY!, ext: false }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  signing = { pub: env.VAPID_PUBLIC_KEY!, key };
  return key;
}

/** RFC 8292: the Authorization header for one push service. */
export async function vapidAuth(env: PushEnv, endpoint: string, now = Date.now()): Promise<string> {
  const part = (o: unknown) => b64u(enc.encode(JSON.stringify(o)));
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT })}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await signingKey(env), enc.encode(unsigned)));
  return `vapid t=${unsigned}.${b64u(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

/** Send one push. Returns the push service's status (201 is normal; 404 and 410 mean the subscription is gone). */
export async function sendPush(env: PushEnv, sub: Subscription, payload: unknown, ttlSec: number): Promise<number> {
  const body = await encryptPayload(unb64u(sub.p256dh), unb64u(sub.auth), enc.encode(JSON.stringify(payload)));
  const r = await fetch(sub.endpoint, {
    method: "POST", body,
    headers: { Authorization: await vapidAuth(env, sub.endpoint), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: String(ttlSec), Urgency: "high" },
  });
  return r.status;
}

/* Only the browsers' own push services: a subscription can't point our Worker at any other host. */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /(^|\.)notify\.windows\.com$/, /^push\.services\.mozilla\.com$/];
export function validSubscription(v: unknown): Subscription | null {
  const s = v as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  if (!s || typeof s.endpoint !== "string" || s.endpoint.length > 1024 || typeof s.keys?.p256dh !== "string" || typeof s.keys?.auth !== "string") return null;
  let u: URL; try { u = new URL(s.endpoint); } catch { return null; }
  if (u.protocol !== "https:" || !PUSH_HOSTS.some(re => re.test(u.hostname))) return null;
  try { if (unb64u(s.keys.p256dh).length !== 65 || unb64u(s.keys.auth).length !== 16) return null; } catch { return null; }
  return { endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth };
}
