import { describe, it, expect } from "vitest";
import { call, signIn, E } from "./helpers";
import { SoftPasskey } from "./passkey";
import { configHash, defaultCupConfig, type CupConfig } from "../../src/cup/config";
import { auditStatement, rolesOf } from "../../src/console/access";
import { openWallet, forgetEconomyCache } from "../../src/wallet/wallet";

/* Phase 3 (docs/whot-cup-prd.md): the admin console. Passkey unlock (AD-1), cups and publish checks (AD-2, 5.2),
   freezing (S-11), templates, economy (AD-7), audit (AD-6) and staff. Passkeys are real WebAuthn, from SoftPasskey. */

let seq = 0;
async function player() {
  const i = seq++;
  return signIn("NG", `0805 ${String(100 + i).padStart(3, "0")} 0000`, `192.0.2.${10 + i}`);
}
const addStaff = (playerId: string, roles: string) =>
  E.DB.prepare("INSERT INTO staff (player_id, roles, added_by, created_at) VALUES (?, ?, 'test', ?) ON CONFLICT(player_id) DO UPDATE SET roles = excluded.roles").bind(playerId, roles, Date.now()).run();

/** A staff member with a registered passkey and an unlocked console. */
async function unlocked(roles = "cup-admin") {
  const p = await player();
  await addStaff(p.player.id, roles);
  const key = await SoftPasskey.create();
  const ro = await call("POST", "/api/console/passkey/register/options", { cookie: p.cookie, body: {} });
  expect(ro.status).toBe(200);
  expect((await call("POST", "/api/console/passkey/register/verify", { cookie: p.cookie, body: { response: await key.register(ro.json.options), name: "Laptop" } })).status).toBe(200);
  const cookie = await unlock(p.cookie, key);
  return { ...p, key, cookie };
}
async function unlock(cookie: string, key: SoftPasskey) {
  const lo = await call("POST", "/api/console/passkey/login/options", { cookie, body: {} });
  const lv = await call("POST", "/api/console/passkey/login/verify", { cookie, body: { response: await key.login(lo.json.options) } });
  expect(lv.status).toBe(200);
  return `${cookie}; ${lv.setCookies.find(c => c.startsWith("__Host-pc_c="))!.split(";")[0]}`;
}

describe("unlocking the console", () => {
  it("players who aren't staff get nothing", async () => {
    const p = await player();
    expect((await call("GET", "/api/console/me", { cookie: p.cookie })).json.staff).toBe(null);
    expect((await call("POST", "/api/console/passkey/register/options", { cookie: p.cookie, body: {} })).status).toBe(403);
    expect((await call("GET", "/api/console/cups", { cookie: p.cookie })).status).toBe(401);
  });

  it("staff register a passkey, then unlock with it; the console cookie is strict", async () => {
    const p = await player();
    await addStaff(p.player.id, "cup-admin");
    expect((await call("GET", "/api/console/cups", { cookie: p.cookie })).status).toBe(401);            // staff, but locked
    const key = await SoftPasskey.create();
    const ro = await call("POST", "/api/console/passkey/register/options", { cookie: p.cookie, body: {} });
    expect(ro.json.options.authenticatorSelection.userVerification).toBe("required");
    expect((await call("POST", "/api/console/passkey/register/verify", { cookie: p.cookie, body: { response: await key.register(ro.json.options) } })).status).toBe(200);
    const lo = await call("POST", "/api/console/passkey/login/options", { cookie: p.cookie, body: {} });
    const lv = await call("POST", "/api/console/passkey/login/verify", { cookie: p.cookie, body: { response: await key.login(lo.json.options) } });
    const set = lv.setCookies.find(c => c.startsWith("__Host-pc_c="))!;
    for (const f of ["HttpOnly", "Secure", "SameSite=Strict"]) expect(set).toContain(f);
    const cookie = `${p.cookie}; ${set.split(";")[0]}`;
    expect((await call("GET", "/api/console/cups", { cookie })).status).toBe(200);
    expect((await call("GET", "/api/console/me", { cookie })).json).toMatchObject({ unlocked: true, passkeys: 1 });
  });

  it("a forged signature, a replayed answer and someone else's key all fail", async () => {
    const s = await unlocked();
    const lo = await call("POST", "/api/console/passkey/login/options", { cookie: s.cookie, body: {} });
    expect((await call("POST", "/api/console/passkey/login/verify", { cookie: s.cookie, body: { response: await s.key.login(lo.json.options, true) } })).status).toBe(400);
    const lo2 = await call("POST", "/api/console/passkey/login/options", { cookie: s.cookie, body: {} });
    const answer = await s.key.login(lo2.json.options);
    expect((await call("POST", "/api/console/passkey/login/verify", { cookie: s.cookie, body: { response: answer } })).status).toBe(200);
    expect((await call("POST", "/api/console/passkey/login/verify", { cookie: s.cookie, body: { response: answer } })).status).toBe(400);   // challenge used up
    const other = await unlocked();
    const lo3 = await call("POST", "/api/console/passkey/login/options", { cookie: s.cookie, body: {} });
    expect((await call("POST", "/api/console/passkey/login/verify", { cookie: s.cookie, body: { response: await other.key.login(lo3.json.options) } })).status).toBe(400);
  });

  it("a second passkey needs an unlocked console", async () => {
    const s = await unlocked();
    const locked = s.cookie.split("; ").filter(c => !c.startsWith("__Host-pc_c=")).join("; ");
    expect((await call("POST", "/api/console/passkey/register/options", { cookie: locked, body: {} })).status).toBe(401);
    expect((await call("POST", "/api/console/passkey/register/options", { cookie: s.cookie, body: {} })).status).toBe(200);
  });

  it("a console cookie only works with the same player's session, and sign-out locks it", async () => {
    const a = await unlocked(), b = await unlocked();
    const aConsole = a.cookie.split("; ").find(c => c.startsWith("__Host-pc_c="))!;
    const bPlayer = b.cookie.split("; ").filter(c => !c.startsWith("__Host-pc_c=")).join("; ");
    expect((await call("GET", "/api/console/cups", { cookie: `${bPlayer}; ${aConsole}` })).status).toBe(401);
    await call("POST", "/api/console/signout", { cookie: a.cookie, body: {} });
    expect((await call("GET", "/api/console/cups", { cookie: a.cookie })).status).toBe(401);
  });

  it("the first owner can come from OWNER_PLAYER_IDS", async () => {
    const p = await player();
    expect(await rolesOf({ ...E, OWNER_PLAYER_IDS: `x, ${p.player.id}` } as never, p.player.id)).toEqual(["owner"]);
  });

  it("console writes need our own origin", async () => {
    const s = await unlocked();
    expect((await call("POST", "/api/console/cups", { cookie: s.cookie, body: {}, origin: "https://evil.example" })).status).toBe(403);
  });
});

describe("cups", () => {
  it("create a draft with defaults and a unique address; edit with the version you read", async () => {
    const s = await unlocked();
    const a = await call("POST", "/api/console/cups", { cookie: s.cookie, body: { name: "Saturday Whot Cup" } });
    const b = await call("POST", "/api/console/cups", { cookie: s.cookie, body: { name: "Saturday Whot Cup" } });
    expect(a.status).toBe(201);
    expect(a.json.cup).toMatchObject({ state: "draft", version: 1, frozen: false });
    expect(b.json.cup.slug).not.toBe(a.json.cup.slug);
    const cup = a.json.cup;
    const ok = await call("PUT", `/api/console/cups/${cup.id}`, { cookie: s.cookie, body: { version: 1, config: { ...cup.config, entryFee: 2000 } } });
    expect(ok.json.cup).toMatchObject({ version: 2, config: { entryFee: 2000 } });
    const stale = await call("PUT", `/api/console/cups/${cup.id}`, { cookie: s.cookie, body: { version: 1, config: { ...cup.config, entryFee: 3000 } } });
    expect([stale.status, stale.json.error]).toEqual([409, "stale"]);
  });

  it("refuses invalid settings with every reason, and ignores unknown keys", async () => {
    const s = await unlocked();
    const cup = (await call("POST", "/api/console/cups", { cookie: s.cookie, body: {} })).json.cup;
    const r = await call("PUT", `/api/console/cups/${cup.id}`, { cookie: s.cookie, body: { version: 1, config: { ...cup.config, platformCut: 50, capacity: 5, startsAt: cup.config.registrationOpensAt - 1 } } });
    expect(r.status).toBe(400);
    expect(r.json.errors.join(" ")).toMatch(/Platform cut.*Seats|Seats.*Platform cut/);
    expect(r.json.errors.join(" ")).toContain("Schedule must run in order");
    const extra = await call("PUT", `/api/console/cups/${cup.id}`, { cookie: s.cookie, body: { version: 1, config: { ...cup.config, isAdmin: true } } });
    expect(extra.json.cup.config.isAdmin).toBeUndefined();
  });

  it("publish runs the checks, fingerprints the settings, and blocks edits until unpublished", async () => {
    const s = await unlocked();
    const cup = (await call("POST", "/api/console/cups", { cookie: s.cookie, body: { name: "Big cup" } })).json.cup as { id: string; config: CupConfig };
    // Too short a window for 20,000 seats: the duration check fails.
    let r = await call("PUT", `/api/console/cups/${cup.id}`, { cookie: s.cookie, body: { version: 1, config: { ...cup.config, capacity: 20000, expectedEntries: 20000, mustEndBy: cup.config.startsAt + 3600_000 } } });
    let p = await call("POST", `/api/console/cups/${cup.id}/publish`, { cookie: s.cookie, body: { version: r.json.cup.version } });
    expect(p.status).toBe(400);
    expect(p.json.problems.join(" ")).toContain("must end by");
    r = await call("PUT", `/api/console/cups/${cup.id}`, { cookie: s.cookie, body: { version: r.json.cup.version, config: { ...r.json.cup.config, mustEndBy: cup.config.startsAt + 8 * 3600_000 } } });
    p = await call("POST", `/api/console/cups/${cup.id}/publish`, { cookie: s.cookie, body: { version: r.json.cup.version } });
    expect(p.status).toBe(200);
    expect(p.json.cup.state).toBe("scheduled");
    expect(p.json.cup.configHash).toBe(await configHash(r.json.cup.config));
    const edit = await call("PUT", `/api/console/cups/${cup.id}`, { cookie: s.cookie, body: { version: p.json.cup.version, config: p.json.cup.config } });
    expect(edit.json.error).toBe("unpublish-first");
    const un = await call("POST", `/api/console/cups/${cup.id}/unpublish`, { cookie: s.cookie, body: { version: p.json.cup.version } });
    expect(un.json.cup).toMatchObject({ state: "draft", configHash: null });
  });

  it("S-11: once registration opens, settings are frozen", async () => {
    const s = await unlocked();
    const cup = (await call("POST", "/api/console/cups", { cookie: s.cookie, body: {} })).json.cup;
    const p = await call("POST", `/api/console/cups/${cup.id}/publish`, { cookie: s.cookie, body: { version: 1 } });
    expect(p.status).toBe(200);
    // Time passes: registration is now open.
    const opened = { ...p.json.cup.config, registrationOpensAt: Date.now() - 1000 };
    await E.DB.prepare("UPDATE cups SET config_json = ? WHERE id = ?").bind(JSON.stringify(opened), cup.id).run();
    const v = p.json.cup.version;
    expect((await call("GET", `/api/console/cups/${cup.id}`, { cookie: s.cookie })).json.cup.frozen).toBe(true);
    expect((await call("POST", `/api/console/cups/${cup.id}/unpublish`, { cookie: s.cookie, body: { version: v } })).json.error).toBe("frozen");
    expect((await call("PUT", `/api/console/cups/${cup.id}`, { cookie: s.cookie, body: { version: v, config: { ...opened, entryFee: 100 } } })).json.error).toBe("frozen");
    // Cancelling is still possible: it goes through the director, which refunds every stake.
    const c = await call("POST", `/api/console/cups/${cup.id}/cancel`, { cookie: s.cookie, body: { version: v, reason: "Test" } });
    expect(c.json.cup.state).toBe("cancelled");
  });

  it("duplicate a cup, save a template, and start a cup from the template, with fresh dates", async () => {
    const s = await unlocked();
    const src = (await call("POST", "/api/console/cups", { cookie: s.cookie, body: { name: "Ladies' Cup" } })).json.cup;
    await call("PUT", `/api/console/cups/${src.id}`, { cookie: s.cookie, body: { version: 1, config: { ...src.config, entryFee: 700, scFee: 300 } } });
    const dup = await call("POST", "/api/console/cups", { cookie: s.cookie, body: { from: { cup: src.id } } });
    expect(dup.json.cup.config).toMatchObject({ entryFee: 700, scFee: 300 });
    const t = await call("POST", "/api/console/templates", { cookie: s.cookie, body: { name: `Ladies ${Date.now()}`, fromCup: src.id } });
    expect(t.status).toBe(201);
    const fromT = await call("POST", "/api/console/cups", { cookie: s.cookie, body: { name: "Ladies' Cup II", from: { template: t.json.id } } });
    expect(fromT.json.cup.config).toMatchObject({ entryFee: 700, scFee: 300, name: "Ladies' Cup II" });
    expect(fromT.json.cup.config.startsAt).toBeGreaterThanOrEqual(defaultCupConfig().startsAt);
  });

  it("delete a draft; cancel a scheduled cup before it opens", async () => {
    const s = await unlocked();
    const a = (await call("POST", "/api/console/cups", { cookie: s.cookie, body: {} })).json.cup;
    expect((await call("DELETE", `/api/console/cups/${a.id}`, { cookie: s.cookie })).status).toBe(200);
    expect((await call("GET", `/api/console/cups/${a.id}`, { cookie: s.cookie })).status).toBe(404);
    const b = (await call("POST", "/api/console/cups", { cookie: s.cookie, body: {} })).json.cup;
    const p = await call("POST", `/api/console/cups/${b.id}/publish`, { cookie: s.cookie, body: { version: 1 } });
    const c = await call("POST", `/api/console/cups/${b.id}/cancel`, { cookie: s.cookie, body: { version: p.json.cup.version, reason: "Sponsor pulled out" } });
    expect(c.json.cup.state).toBe("cancelled");
    expect((await call("DELETE", `/api/console/cups/${b.id}`, { cookie: s.cookie })).status).toBe(409);
  });

  it("a naira cup needs the cash phase and a countersign from a different finance person; an edit clears it", async () => {
    const admin = await unlocked("cup-admin,finance"), fin = await unlocked("finance");
    const cup = (await call("POST", "/api/console/cups", { cookie: admin.cookie, body: {} })).json.cup;
    let r = await call("PUT", `/api/console/cups/${cup.id}`, { cookie: admin.cookie, body: { version: 1, config: { ...cup.config, currency: "NGN" } } });
    let p = await call("POST", `/api/console/cups/${cup.id}/publish`, { cookie: admin.cookie, body: { version: r.json.cup.version } });
    expect(p.json.problems.join(" ")).toContain("cash phase");
    expect(p.json.problems.join(" ")).toContain("countersign");
    expect((await call("POST", `/api/console/cups/${cup.id}/countersign`, { cookie: admin.cookie, body: { version: r.json.cup.version } })).json.error).toBe("not-your-own");
    const cs = await call("POST", `/api/console/cups/${cup.id}/countersign`, { cookie: fin.cookie, body: { version: r.json.cup.version } });
    expect(cs.json.cup.countersignedBy).toBe(fin.player.id);
    r = await call("PUT", `/api/console/cups/${cup.id}`, { cookie: admin.cookie, body: { version: cs.json.cup.version, config: { ...cs.json.cup.config, entryFee: 1500 } } });
    expect(r.json.cup.countersignedBy).toBe(null);
  });

  it("finance can't edit cups; integrity can't see them", async () => {
    const fin = await unlocked("finance"), integ = await unlocked("integrity"), admin = await unlocked();
    const cup = (await call("POST", "/api/console/cups", { cookie: admin.cookie, body: {} })).json.cup;
    expect((await call("PUT", `/api/console/cups/${cup.id}`, { cookie: fin.cookie, body: { version: 1, config: cup.config } })).status).toBe(403);
    expect((await call("GET", "/api/console/cups", { cookie: integ.cookie })).status).toBe(403);
  });
});

describe("economy, audit and staff", () => {
  it("owners and finance change the economy; the wallet follows; cup admins can't", async () => {
    const admin = await unlocked(), owner = await unlocked("owner");
    expect((await call("PUT", "/api/console/economy", { cookie: admin.cookie, body: { coinWelcomeGrant: 100 } })).status).toBe(403);
    const bad = await call("PUT", "/api/console/economy", { cookie: owner.cookie, body: { coinWelcomeGrant: 50_000, coinBalanceCap: 20_000 } });
    expect(bad.json.errors.join(" ")).toContain("welcome grant");
    const ok = await call("PUT", "/api/console/economy", { cookie: owner.cookie, body: { coinWelcomeGrant: 3000 } });
    expect(ok.json.economy).toMatchObject({ coinWelcomeGrant: 3000, coinDailyTopUp: 1000 });
    forgetEconomyCache();
    expect((await openWallet(E.DB, `econ-${Date.now()}`)).balance).toBe(3000);
    await call("PUT", "/api/console/economy", { cookie: owner.cookie, body: { coinWelcomeGrant: 5000 } });
    forgetEconomyCache();
  });

  it("every console write is audited with who, before and after", async () => {
    const s = await unlocked();
    const cup = (await call("POST", "/api/console/cups", { cookie: s.cookie, body: {} })).json.cup;
    await call("PUT", `/api/console/cups/${cup.id}`, { cookie: s.cookie, body: { version: 1, config: { ...cup.config, entryFee: 900 } } });
    const log = await call("GET", `/api/console/audit?target=cup:${cup.id}`, { cookie: s.cookie });
    expect(log.json.entries.map((e: { action: string }) => e.action)).toEqual(["cup.edit", "cup.create"]);
    expect(log.json.entries[0]).toMatchObject({ actor: s.player.id, before: { entryFee: 1000 }, after: { entryFee: 900 } });
    const mine = await call("GET", "/api/console/audit", { cookie: s.cookie });
    expect(mine.json.entries.some((e: { action: string; actor: string }) => e.action === "console.unlock" && e.actor === s.player.id)).toBe(true);
  });

  it("a guarded change that loses a race leaves no audit row", async () => {
    const before = await E.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE target = 'race'").first<number>("n");
    await E.DB.batch([
      E.DB.prepare("UPDATE cups SET name = name WHERE id = 'no-such-cup'"),
      auditStatement(E as never, "x", "cup.edit", "race", null, null, true),
    ]);
    expect(await E.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE target = 'race'").first<number>("n")).toBe(before);
  });

  it("owners add and remove staff; removal locks them out at once", async () => {
    const owner = await unlocked("owner"), other = await unlocked("cup-admin"), newcomer = await player();
    expect((await call("PUT", "/api/console/staff", { cookie: other.cookie, body: { playerId: newcomer.player.id, roles: ["finance"] } })).status).toBe(403);
    const r = await call("PUT", "/api/console/staff", { cookie: owner.cookie, body: { playerId: newcomer.player.id, roles: ["finance", "made-up"] } });
    expect(r.json.staff.find((x: { playerId: string }) => x.playerId === newcomer.player.id).roles).toEqual(["finance"]);
    await call("DELETE", `/api/console/staff/${other.player.id}`, { cookie: owner.cookie });
    expect((await call("GET", "/api/console/cups", { cookie: other.cookie })).status).toBe(401);
    expect((await call("DELETE", `/api/console/staff/${owner.player.id}`, { cookie: owner.cookie })).json.error).toBe("not-yourself");
  });
});
