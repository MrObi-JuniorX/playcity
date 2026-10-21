import { describe, it, expect } from "vitest";
import { decrypt, hmac } from "../../src/auth/crypto";
import { cleanup } from "../../src/auth/routes";
import { call, sendCode, lastCode, signIn, E } from "./helpers";

/* Phase 1 identity (docs/whot-cup-prd.md): sign-in by SMS code, sessions, the profile, and the abuse limits
   (S-7 one number one player, S-8 limits, S-9 revocation). Runs in dev mode: codes land in dev_sms_outbox. */

describe("sign in with a code", () => {
  it("sends a code, signs in, and sets a locked-down session cookie", async () => {
    const s = await signIn("NG", "0803 000 0001", "203.0.113.10");
    expect(s.created).toBe(true);
    const sess = s.setCookies.find(c => c.startsWith("__Host-pc_s="))!;
    for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) expect(sess).toContain(flag);
    expect(s.setCookies.some(c => c.startsWith("__Host-pc_d="))).toBe(true);           // device id
    const me = await call("GET", "/api/me", { cookie: s.cookie });
    expect(me.status).toBe(200);
    expect(me.json.player.phone).toBe("+234 ••• ••• ••01");
    expect(me.json.player.complete).toBe(false);
  });

  it("S-7: one number is one player, however it is typed", async () => {
    const a = await signIn("NG", "0803 000 0002", "203.0.113.11");
    const b = await signIn("NG", "+234 803 000 0002", "203.0.113.11");
    const c = await signIn("NG", "2348030000002", "203.0.113.12");
    expect(b.created).toBe(false); expect(c.created).toBe(false);
    expect(b.player.id).toBe(a.player.id); expect(c.player.id).toBe(a.player.id);
    const other = await signIn("NG", "0803 000 0003", "203.0.113.12");
    expect(other.player.id).not.toBe(a.player.id);
  });

  it("stores the number only as an HMAC and an encrypted copy", async () => {
    await signIn("GB", "07700 900123", "203.0.113.13");
    const h = await hmac(E.PHONE_HMAC_KEY, "phone", "447700900123");
    const row = await E.DB.prepare("SELECT * FROM players WHERE phone_hmac = ?").bind(h).first<any>();
    expect(JSON.stringify(row)).not.toContain("7700900123");
    expect(await decrypt(E.PHONE_ENC_KEY, row.phone_enc)).toBe("447700900123");
  });

  it("refuses numbers that can't be mobiles and countries not on the list", async () => {
    expect((await sendCode("NG", "12345")).json.error).toBe("bad-number");
    expect((await sendCode("NG", "+44 7700 900123")).json.error).toBe("bad-number");      // wrong country code
    expect((await sendCode("BR", "11987654321")).json.error).toBe("country-not-supported");
  });

  it("the answer to a code request never says whether the number has an account", async () => {
    await signIn("NG", "0803 000 0004", "203.0.113.14");
    const known = await sendCode("NG", "0803 000 0004", "203.0.113.14");
    const unknown = await sendCode("NG", "0803 000 0005", "203.0.113.14");
    expect(known.status).toBe(unknown.status);
    expect(known.json).toEqual(unknown.json);
  });
});

describe("codes", () => {
  it("expire after their time", async () => {
    await sendCode("NG", "0803 000 0010", "203.0.113.20");
    const code = await lastCode("NG", "0803 000 0010");
    await E.DB.prepare("UPDATE otp_requests SET expires_at = ? WHERE phone_hmac = ?").bind(Date.now() - 1, await hmac(E.PHONE_HMAC_KEY, "phone", "2348030000010")).run();
    const v = await call("POST", "/api/auth/otp/verify", { body: { country: "NG", phone: "0803 000 0010", code }, ip: "203.0.113.20" });
    expect(v.json.error).toBe("code-expired");
  });

  it("lock after 5 wrong guesses, even for the right code", async () => {
    await sendCode("NG", "0803 000 0011", "203.0.113.21");
    const code = await lastCode("NG", "0803 000 0011");
    const wrong = code === "000000" ? "111111" : "000000";
    const left: number[] = [];
    for (let i = 0; i < 5; i++) left.push((await call("POST", "/api/auth/otp/verify", { body: { country: "NG", phone: "0803 000 0011", code: wrong }, ip: "203.0.113.21" })).json.attemptsLeft);
    expect(left).toEqual([4, 3, 2, 1, 0]);
    const v = await call("POST", "/api/auth/otp/verify", { body: { country: "NG", phone: "0803 000 0011", code }, ip: "203.0.113.21" });
    expect(v.json.error).toBe("code-locked");
  });

  it("work once, and a newer code replaces an older one", async () => {
    await sendCode("NG", "0803 000 0012", "203.0.113.22");
    const first = await lastCode("NG", "0803 000 0012");
    await sendCode("NG", "0803 000 0012", "203.0.113.22");
    const second = await lastCode("NG", "0803 000 0012");
    if (first !== second) {
      const old = await call("POST", "/api/auth/otp/verify", { body: { country: "NG", phone: "0803 000 0012", code: first }, ip: "203.0.113.22" });
      expect(old.status).toBe(400);
    }
    const ok = await call("POST", "/api/auth/otp/verify", { body: { country: "NG", phone: "0803 000 0012", code: second }, ip: "203.0.113.22" });
    expect(ok.status).toBe(200);
    const again = await call("POST", "/api/auth/otp/verify", { body: { country: "NG", phone: "0803 000 0012", code: second }, ip: "203.0.113.22" });
    expect(again.json.error).toBe("code-expired");
  });
});

describe("S-8: limits on sending codes", () => {
  it("Turnstile must pass", async () => {
    const r = await sendCode("NG", "0803 000 0020", "203.0.113.30", "forged");
    expect([r.status, r.json.error]).toEqual([403, "turnstile"]);
  });

  it("3 codes per number in 15 minutes", async () => {
    for (let i = 0; i < 3; i++) expect((await sendCode("NG", "0803 000 0021", "203.0.113.31")).status).toBe(200);
    const r = await sendCode("NG", "0803 000 0021", "203.0.113.31");
    expect([r.status, r.json.error]).toEqual([429, "too-many-for-number"]);
    expect(r.json.retryAfter).toBeGreaterThan(0);
  });

  it("10 codes per network in an hour", async () => {
    for (let i = 0; i < 10; i++) expect((await sendCode("NG", `0803 000 01${String(i).padStart(2, "0")}`, "198.51.100.7")).status).toBe(200);
    const r = await sendCode("NG", "0803 000 0199", "198.51.100.7");
    expect([r.status, r.json.error]).toEqual([429, "too-many-from-network"]);
  });

  it("a daily cap per country", async () => {
    expect((await sendCode("ZA", "082 123 4567", "198.51.100.8")).status).toBe(200);
    expect((await sendCode("ZA", "082 123 4568", "198.51.100.9")).status).toBe(200);
    const r = await sendCode("ZA", "082 123 4569", "198.51.100.10");
    expect([r.status, r.json.error]).toEqual([503, "busy"]);
  });

  it("a daily cap on all codes: the SMS spend cap", async () => {
    const now = Date.now();
    const fill = Array.from({ length: 400 }, (_, i) => E.DB.prepare("INSERT INTO otp_requests (phone_hmac, ip_hash, country, code_hmac, created_at, expires_at, used_at) VALUES (?, 'x', 'XX', 'x', ?, ?, ?)").bind(`fill${i}`, now, now, now));
    await E.DB.batch(fill);
    const r = await sendCode("NG", "0803 000 0030", "198.51.100.11");
    expect([r.status, r.json.error]).toEqual([503, "busy"]);
    await E.DB.prepare("DELETE FROM otp_requests WHERE country = 'XX'").run();
  });
});

describe("S-9: sessions", () => {
  it("sign out ends this device only; sign out everywhere ends them all", async () => {
    const a = await signIn("NG", "0803 000 0040", "203.0.113.40");
    const b = await signIn("NG", "0803 000 0040", "203.0.113.41");
    const c = await signIn("NG", "0803 000 0040", "203.0.113.42");
    expect((await call("POST", "/api/auth/signout", { body: {}, cookie: a.cookie })).status).toBe(200);
    expect((await call("GET", "/api/me", { cookie: a.cookie })).status).toBe(401);
    expect((await call("GET", "/api/me", { cookie: b.cookie })).status).toBe(200);
    expect((await call("POST", "/api/auth/signout-all", { body: {}, cookie: b.cookie })).status).toBe(200);
    expect((await call("GET", "/api/me", { cookie: b.cookie })).status).toBe(401);
    expect((await call("GET", "/api/me", { cookie: c.cookie })).status).toBe(401);
  });

  it("expired sessions and made-up cookies are signed out", async () => {
    const a = await signIn("NG", "0803 000 0041", "203.0.113.43");
    await E.DB.prepare("UPDATE sessions SET expires_at = ? WHERE player_id = ?").bind(Date.now() - 1, a.player.id).run();
    expect((await call("GET", "/api/me", { cookie: a.cookie })).status).toBe(401);
    expect((await call("GET", "/api/me", { cookie: "__Host-pc_s=made-up" })).status).toBe(401);
  });

  it("writes need our own origin and a JSON body", async () => {
    const a = await signIn("NG", "0803 000 0042", "203.0.113.44");
    expect((await call("PATCH", "/api/me", { body: { name: "Ada" }, cookie: a.cookie, origin: "https://evil.example" })).status).toBe(403);
    expect((await call("PATCH", "/api/me", { body: { name: "Ada" }, cookie: a.cookie, origin: null })).status).toBe(403);
    expect((await call("PATCH", "/api/me", { body: { name: "Ada" }, cookie: a.cookie, type: "text/plain" })).status).toBe(403);
  });
});

describe("profile", () => {
  it("name, avatar and the 18+ declaration complete it", async () => {
    const a = await signIn("NG", "0803 000 0050", "203.0.113.50");
    const r = await call("PATCH", "/api/me", { cookie: a.cookie, body: { name: "  Tunde  O ", avatar: { shape: "star", color: "gold" }, adult: true } });
    expect(r.status).toBe(200);
    expect(r.json.player).toMatchObject({ name: "Tunde O", avatar: { shape: "star", color: "gold" }, adult: true, complete: true });
  });

  it("rejects bad names, avatars and declarations", async () => {
    const a = await signIn("NG", "0803 000 0051", "203.0.113.51");
    for (const body of [{ name: "A" }, { name: "x".repeat(15) }, { name: "<>\u0000\u0001" }, { avatar: { shape: "hex", color: "gold" } }, { avatar: { shape: "star", color: "#fff" } }, { adult: false }])
      expect((await call("PATCH", "/api/me", { cookie: a.cookie, body })).status).toBe(400);
    const r = await call("PATCH", "/api/me", { cookie: a.cookie, body: { name: "<b>Ada</b>" } });
    expect(r.json.player.name).toBe("bAda/b");                   // markup characters never get stored
  });

  it("RP-2: a lower weekly limit applies at once; a raise waits 24 hours", async () => {
    const a = await signIn("NG", "0803 000 0052", "203.0.113.52");
    let r = await call("PATCH", "/api/me", { cookie: a.cookie, body: { weeklyLimit: 5000 } });
    expect(r.json.player.weeklyLimit).toBe(5000);
    r = await call("PATCH", "/api/me", { cookie: a.cookie, body: { weeklyLimit: 2000 } });
    expect([r.json.player.weeklyLimit, r.json.player.weeklyLimitNext]).toEqual([2000, null]);
    r = await call("PATCH", "/api/me", { cookie: a.cookie, body: { weeklyLimit: 9000 } });
    expect(r.json.player.weeklyLimit).toBe(2000);
    expect(r.json.player.weeklyLimitNext.value).toBe(9000);
    r = await call("PATCH", "/api/me", { cookie: a.cookie, body: { weeklyLimit: null } });   // removing the limit is a raise too
    expect(r.json.player.weeklyLimit).toBe(2000);
    await E.DB.prepare("UPDATE players SET weekly_limit_next_at = ? WHERE id = ?").bind(Date.now() - 1, a.player.id).run();
    r = await call("GET", "/api/me", { cookie: a.cookie });
    expect([r.json.player.weeklyLimit, r.json.player.weeklyLimitNext]).toEqual([null, null]);
  });

  it("RP-2: a cool-off only ever gets longer", async () => {
    const a = await signIn("NG", "0803 000 0053", "203.0.113.53");
    const week = (await call("PATCH", "/api/me", { cookie: a.cookie, body: { coolOff: "7d" } })).json.player.coolOffUntil;
    const day = (await call("PATCH", "/api/me", { cookie: a.cookie, body: { coolOff: "24h" } })).json.player.coolOffUntil;
    expect(day).toBe(week);
    expect((await call("PATCH", "/api/me", { cookie: a.cookie, body: { coolOff: "forever" } })).status).toBe(400);
  });
});

describe("housekeeping and config", () => {
  it("the daily cleanup deletes code rows after 24 hours", async () => {
    await sendCode("NG", "0803 000 0060", "203.0.113.60");
    const h = await hmac(E.PHONE_HMAC_KEY, "phone", "2348030000060");
    await cleanup(E as never, Date.now() + 25 * 3600_000);
    expect(await E.DB.prepare("SELECT COUNT(*) AS n FROM otp_requests WHERE phone_hmac = ?").bind(h).first("n")).toBe(0);
  });

  it("config lists the countries and says sign-in is available", async () => {
    const r = await call("GET", "/api/auth/config");
    expect(r.json.available).toBe(true);
    expect(r.json.countries.map((c: { iso: string }) => c.iso)).toContain("NG");
  });
});
