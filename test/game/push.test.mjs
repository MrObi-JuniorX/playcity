import { describe, it, expect } from "vitest";
import { createECDH, createPublicKey, verify } from "node:crypto";
import { createRequire } from "node:module";
import { encryptPayload, vapidAuth, validSubscription, b64u, unb64u } from "../../src/push/webpush.ts";

/* Web Push (docs/whot-cup-prd.md PX-4): our Web Crypto implementation of RFC 8291 and RFC 8292, checked against the
   RFC's own test vector and decrypted by an independent implementation (http_ece, the library web-push uses). */

const ece = createRequire(import.meta.url)("http_ece");
const buf = (u) => Buffer.from(u);

describe("RFC 8291 payload encryption", () => {
  it("matches the RFC 8291 Appendix A test vector", async () => {
    const asPub = unb64u("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
    const asJwk = { kty: "EC", crv: "P-256", x: b64u(asPub.slice(1, 33)), y: b64u(asPub.slice(33)), d: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", ext: true };
    const server = {
      privateKey: await crypto.subtle.importKey("jwk", asJwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]),
      publicKey: await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, true, []),
    };
    const out = await encryptPayload(
      unb64u("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
      unb64u("BTBZMqHH6r4Tts7J_aSIgg"),
      new TextEncoder().encode("When I grow up, I want to be a watermelon"),
      unb64u("DGv6ra1nlYgDCS1FRnbzlw"), server);
    expect(b64u(out)).toBe("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
  });

  it("decrypts with an independent implementation, for a browser's fresh keys", async () => {
    const ua = createECDH("prime256v1"); ua.generateKeys();
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const msg = JSON.stringify({ title: "Your table is ready", body: "Round 2: main draw. Tap to play.", url: "/whot/?cup=sat", tag: "table" });
    const body = await encryptPayload(new Uint8Array(ua.getPublicKey()), auth, new TextEncoder().encode(msg));
    expect(ece.decrypt(buf(body), { version: "aes128gcm", privateKey: ua, authSecret: buf(auth) }).toString()).toBe(msg);
  });
});

describe("RFC 8292 VAPID", () => {
  it("signs a JWT for the push service's origin that the public key verifies", async () => {
    const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
    const jwk = await crypto.subtle.exportKey("jwk", k.privateKey);
    const pub = new Uint8Array(await crypto.subtle.exportKey("raw", k.publicKey));
    const env = { VAPID_PUBLIC_KEY: b64u(pub), VAPID_PRIVATE_KEY: jwk.d, VAPID_SUBJECT: "mailto:ops@example.org" };
    const now = Date.UTC(2026, 10, 7, 15, 0, 0);
    const h = await vapidAuth(env, "https://fcm.googleapis.com/fcm/send/abc123", now);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h);
    expect(m[4]).toBe(env.VAPID_PUBLIC_KEY);
    expect(JSON.parse(Buffer.from(m[2], "base64url").toString())).toEqual({ aud: "https://fcm.googleapis.com", exp: now / 1000 + 12 * 3600, sub: "mailto:ops@example.org" });
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, format: "jwk" });
    expect(verify("sha256", Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(m[3], "base64url"))).toBe(true);
  });
});

describe("subscriptions", () => {
  const keys = { p256dh: b64u(new Uint8Array(65).fill(4)), auth: b64u(new Uint8Array(16)) };
  it("only accept the browsers' own push services, over https, with well-formed keys", () => {
    expect(validSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/x", keys })).not.toBeNull();
    expect(validSubscription({ endpoint: "https://web.push.apple.com/QGx", keys })).not.toBeNull();
    expect(validSubscription({ endpoint: "https://updates.push.services.mozilla.com/wpush/v2/x", keys })).not.toBeNull();
    expect(validSubscription({ endpoint: "https://evil.example/collect", keys })).toBeNull();               // never point our Worker elsewhere
    expect(validSubscription({ endpoint: "https://fcm.googleapis.com.evil.example/x", keys })).toBeNull();
    expect(validSubscription({ endpoint: "http://fcm.googleapis.com/x", keys })).toBeNull();
    expect(validSubscription({ endpoint: "https://fcm.googleapis.com/x", keys: { ...keys, auth: "short" } })).toBeNull();
    expect(validSubscription(null)).toBeNull();
  });
});
