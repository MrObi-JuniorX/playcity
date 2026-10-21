/* A software passkey for tests: a real P-256 key that answers WebAuthn registration and sign-in the way a phone
   or laptop authenticator does (attestation "none", user present and verified), so the console's real passkey
   verification runs end to end. */

const enc = new TextEncoder();
const b64url = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const cat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { out.set(p, i); i += p.length; } return out; };
const sha = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b));

/* Just enough CBOR: unsigned and negative integers, byte strings, text, and maps. */
function head(major: number, n: number): Uint8Array {
  if (n < 24) return new Uint8Array([(major << 5) | n]);
  if (n < 256) return new Uint8Array([(major << 5) | 24, n]);
  return new Uint8Array([(major << 5) | 25, n >> 8, n & 255]);
}
function cbor(v: unknown): Uint8Array {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") { const b = enc.encode(v); return cat(head(3, b.length), b); }
  if (v instanceof Uint8Array) return cat(head(2, v.length), v);
  const entries = v instanceof Map ? [...v.entries()] : Object.entries(v as object);
  return cat(head(5, entries.length), ...entries.flatMap(([k, x]) => [cbor(k), cbor(x)]));
}

function der(raw: Uint8Array): Uint8Array {
  const int = (x: Uint8Array) => { let i = 0; while (i < x.length - 1 && x[i] === 0) i++; let y = x.slice(i); if (y[0] & 0x80) y = cat(new Uint8Array([0]), y); return cat(new Uint8Array([2, y.length]), y); };
  const body = cat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return cat(new Uint8Array([0x30, body.length]), body);
}

export class SoftPasskey {
  private constructor(private keys: CryptoKeyPair, readonly credId: Uint8Array, private origin: string, private rpId: string, private counter = 0) {}

  static async create(origin = "https://play.test") {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    return new SoftPasskey(keys, crypto.getRandomValues(new Uint8Array(16)), origin, new URL(origin).hostname);
  }
  get id() { return b64url(this.credId); }

  async register(options: { challenge: string }) {
    const jwk = await crypto.subtle.exportKey("jwk", this.keys.publicKey) as JsonWebKey;
    const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, unb64url(jwk.x!)], [-3, unb64url(jwk.y!)]]));
    const authData = cat(await sha(enc.encode(this.rpId)), new Uint8Array([0x45, 0, 0, 0, 0]), new Uint8Array(16), new Uint8Array([0, this.credId.length]), this.credId, cose);
    const clientData = enc.encode(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    return {
      id: this.id, rawId: this.id, type: "public-key", clientExtensionResults: {}, authenticatorAttachment: "platform",
      response: { clientDataJSON: b64url(clientData), attestationObject: b64url(cbor({ fmt: "none", attStmt: new Map(), authData })), transports: ["internal"] },
    };
  }

  /** Answer a sign-in challenge. `tamper` flips a bit in the signature. */
  async login(options: { challenge: string }, tamper = false) {
    this.counter++;
    const c = this.counter;
    const authData = cat(await sha(enc.encode(this.rpId)), new Uint8Array([0x05, c >>> 24, (c >>> 16) & 255, (c >>> 8) & 255, c & 255]));
    const clientData = enc.encode(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, cat(authData, await sha(clientData))));
    if (tamper) raw[10] ^= 1;
    return {
      id: this.id, rawId: this.id, type: "public-key", clientExtensionResults: {}, authenticatorAttachment: "platform",
      response: { clientDataJSON: b64url(clientData), authenticatorData: b64url(authData), signature: b64url(der(raw)) },
    };
  }
}
