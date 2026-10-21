/* Small crypto helpers on Web Crypto. Keys are imported once per isolate. */

const enc = new TextEncoder();
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");

const hmacKeys = new Map<string, Promise<CryptoKey>>();
const aesKeys = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string) {
  let k = hmacKeys.get(secret);
  if (!k) { k = crypto.subtle.importKey("raw", unb64(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); hmacKeys.set(secret, k); }
  return k;
}
function aesKey(secret: string) {
  let k = aesKeys.get(secret);
  if (!k) {
    const raw = unb64(secret);
    if (raw.length !== 32) throw new Error("PHONE_ENC_KEY must be 32 bytes");
    k = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]); aesKeys.set(secret, k);
  }
  return k;
}

/** HMAC-SHA256 as hex. `purpose` separates uses of one key (phone, ip, code), so one can't stand in for another. */
export async function hmac(secret: string, purpose: string, value: string): Promise<string> {
  return hex(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(`${purpose}\u0000${value}`)));
}

export async function sha256(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(value)));
}

/** AES-256-GCM, stored as "v1:" + base64(iv | ciphertext). The version lets keys rotate later. */
export async function encrypt(secret: string, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), enc.encode(plain)));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return "v1:" + b64(out);
}
export async function decrypt(secret: string, stored: string): Promise<string> {
  if (!stored.startsWith("v1:")) throw new Error("unknown phone encryption version");
  const all = unb64(stored.slice(3));
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12) }, await aesKey(secret), all.slice(12)));
}

/** A uniformly random 6-digit code. */
export function sixDigits(): string {
  const lim = 4_294_000_000;                 // largest multiple of 1e6 under 2^32: no modulo bias
  const a = new Uint32Array(1);
  do crypto.getRandomValues(a); while (a[0] >= lim);
  return String(a[0] % 1_000_000).padStart(6, "0");
}

/** A random token for cookies: 32 bytes, URL-safe base64. */
export function token(): string {
  return b64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Constant-time string comparison for equal-length hex digests. */
export function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
