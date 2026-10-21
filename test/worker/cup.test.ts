import { describe, it, expect } from "vitest";
import { call, signIn } from "./helpers";
import { DB, director, makeCup, balance } from "./cupkit";
import { seededOrder } from "../../src/cup/seating";
import { playerAccount, reconcileAll, reconcileCup } from "../../src/wallet/ledger";
import type { CupConfig } from "../../src/cup/config";

/* Phase 4 (docs/whot-cup-prd.md): the public cup API, entering with a stake, the waitlist and random draw,
   check-in, no-shows, and the refunds that go with them. Players sign in through the real code flow. */

let seq = 0;
/** A signed-in player with a complete profile and an opened wallet (5,000 welcome coins). */
async function player() {
  const i = seq++;
  const p = await signIn("NG", `0806 ${String(100 + i).padStart(3, "0")} 0000`, `198.18.${Math.floor(i / 200)}.${(i % 200) + 1}`);
  await call("PATCH", "/api/me", { cookie: p.cookie, body: { name: `Player ${i}`, avatar: { shape: "circle", color: "blue" }, adult: true } });
  await call("GET", "/api/wallet", { cookie: p.cookie });
  return p;
}
const enter = (slug: string, cookie: string, body: object = {}) => call("POST", `/api/cups/${slug}/enter`, { cookie, body });
const openCup = async (over: Partial<CupConfig> = {}) => { const cup = await makeCup(over); await director(cup.id).tick(Date.now()); return cup; };

describe("entering a cup", () => {
  it("stakes the entry once; a second try is refused and costs nothing", async () => {
    const cup = await openCup({ capacity: 16, minEntries: 4, expectedEntries: 16 });
    const p = await player();
    const r = await enter(cup.slug, p.cookie);
    expect(r.status).toBe(201);
    expect(r.json.entry).toMatchObject({ state: "entered", seq: 1 });
    expect(await balance(playerAccount(p.player.id))).toBe(4000);
    expect((await enter(cup.slug, p.cookie)).json.error).toBe("already-entered");
    expect(await balance(playerAccount(p.player.id))).toBe(4000);
    expect((await call("GET", `/api/cups/${cup.slug}/me`, { cookie: p.cookie })).json.entry.state).toBe("entered");
  });

  it("refuses an incomplete profile, a cool-off, a weekly limit and an empty wallet, before any money moves", async () => {
    const cup = await openCup({ capacity: 16, minEntries: 4, expectedEntries: 16 });
    const fresh = await signIn("NG", "0806 999 0001", "198.18.250.1");
    expect((await enter(cup.slug, fresh.cookie)).json.error).toBe("profile-incomplete");
    const a = await player();
    await call("PATCH", "/api/me", { cookie: a.cookie, body: { coolOff: "24h" } });
    expect((await enter(cup.slug, a.cookie)).json.error).toBe("cooling-off");
    const b = await player();
    await call("PATCH", "/api/me", { cookie: b.cookie, body: { weeklyLimit: 500 } });
    expect((await enter(cup.slug, b.cookie)).json.error).toBe("weekly-limit");
    const rich = await openCup({ capacity: 16, minEntries: 4, expectedEntries: 16, entryFee: 9000 });
    const c = await player();
    const r = await enter(rich.slug, c.cookie);
    expect([r.status, r.json.error]).toEqual([402, "insufficient-funds"]);
    expect(await balance(playerAccount(c.player.id))).toBe(5000);
    expect(await DB.prepare("SELECT COUNT(*) AS n FROM registrations WHERE cup_id = ?").bind(rich.id).first("n")).toBe(0);
  });

  it("capacity race: 8 players at once for 5 first-come seats, no waitlist: exactly 5 pay", async () => {
    const cup = await openCup({ capacity: 5, minEntries: 4, expectedEntries: 5, oversubscription: "first-come", waitlist: false });
    const ps = await Promise.all(Array.from({ length: 8 }, () => player()));
    const rs = await Promise.all(ps.map(p => enter(cup.slug, p.cookie)));
    expect(rs.filter(r => r.status === 201).length).toBe(5);
    expect(rs.filter(r => r.json.error === "full").length).toBe(3);
    const charged = (await Promise.all(ps.map(p => balance(playerAccount(p.player.id))))).filter(b => b === 4000).length;
    expect(charged).toBe(5);
    expect(await balance(`cup:${cup.id}:COIN`)).toBe(5000);
  });

  it("first-come with a waitlist: entries past capacity wait, staked", async () => {
    const cup = await openCup({ capacity: 4, minEntries: 4, expectedEntries: 4, oversubscription: "first-come", waitlist: true });
    const ps = [];
    for (let i = 0; i < 6; i++) ps.push(await player());
    const states = [];
    for (const p of ps) states.push((await enter(cup.slug, p.cookie)).json.entry.state);
    expect(states).toEqual(["entered", "entered", "entered", "entered", "waitlist", "waitlist"]);
  });

  it("only while registration is open", async () => {
    const t = Date.now();
    const cup = await makeCup({ capacity: 16, minEntries: 4, expectedEntries: 16, registrationOpensAt: t + 3_600_000, registrationClosesAt: t + 7_200_000, checkInOpensAt: t + 7_200_000, startsAt: t + 10_800_000 });
    const p = await player();
    expect((await enter(cup.slug, p.cookie)).json.error).toBe("not-open-yet");
    expect((await call("POST", `/api/cups/${cup.slug}/enter`, { cookie: p.cookie, body: {}, origin: "https://evil.example" })).status).toBe(403);
  });
});

describe("the random draw and check-in", () => {
  it("draws seats reproducibly from the published seed; check-in, no-shows and the waitlist settle with exact refunds", async () => {
    const cup = await openCup({ capacity: 4, minEntries: 4, expectedEntries: 4, oversubscription: "random-draw", waitlist: true });
    const ps = [];
    for (let i = 0; i < 8; i++) { const p = await player(); expect((await enter(cup.slug, p.cookie)).status).toBe(201); ps.push(p); }
    const commit = await DB.prepare("SELECT commitment, seed FROM seeds WHERE cup_id = ? AND slot = 0").bind(cup.id).first<{ commitment: string; seed: string | null }>();
    expect(commit!.seed).toBe(null);                                     // committed at opening, secret until the draw

    await director(cup.id).tick(cup.c.registrationClosesAt);              // the draw; check-in is already open
    const seed = (await DB.prepare("SELECT seed FROM seeds WHERE cup_id = ? AND slot = 0").bind(cup.id).first<string>("seed"))!;
    const drawn = seededOrder(ps.map(p => p.player.id), seed).slice(0, 4);
    const seated = (await DB.prepare("SELECT player_id FROM registrations WHERE cup_id = ? AND state = 'seated'").bind(cup.id).all<{ player_id: string }>()).results.map(r => r.player_id);
    expect(seated.sort()).toEqual([...drawn].sort());

    // Three seated players check in, one doesn't; two waitlisted players check in, two don't.
    const byId = new Map(ps.map(p => [p.player.id, p]));
    const waiting = seededOrder(ps.map(p => p.player.id), seed).slice(4);
    for (const id of [...drawn.slice(0, 3), ...waiting.slice(0, 2)]) expect((await call("POST", `/api/cups/${cup.slug}/checkin`, { cookie: byId.get(id)!.cookie, body: {} })).status).toBe(200);
    await director(cup.id).tick(cup.c.startsAt - cup.c.checkInCloseBeforeStartSec * 1000);

    const state = async (id: string) => DB.prepare("SELECT state FROM registrations WHERE cup_id = ? AND player_id = ?").bind(cup.id, id).first<string>("state");
    expect(await state(drawn[3])).toBe("no-show");
    expect(await state(waiting[0])).toBe("playing");                     // first in the draw order gets the seat
    expect(await state(waiting[1])).toBe("refunded");
    for (const id of [drawn[3], waiting[1], waiting[2], waiting[3]]) expect(await balance(playerAccount(id))).toBe(5000);
    // Four players at 1,000: the pot holds their stakes less the platform's 20%.
    expect(await balance(`cup:${cup.id}:COIN`)).toBe(4000 - 800);
    expect(await reconcileCup(DB, cup.id, false)).toEqual([]);
  });

  it("check-in is only for seated or waitlisted players, inside the window", async () => {
    const cup = await openCup({ capacity: 8, minEntries: 4, expectedEntries: 8 });
    const p = await player(), outsider = await player();
    await enter(cup.slug, p.cookie);
    expect((await call("POST", `/api/cups/${cup.slug}/checkin`, { cookie: p.cookie, body: {} })).json.error).toBe("check-in-closed");   // still registration
    await director(cup.id).tick(cup.c.registrationClosesAt);
    // Fewer than the minimum entered, so the cup was called off and the stake came back.
    expect((await DB.prepare("SELECT state FROM cups WHERE id = ?").bind(cup.id).first("state"))).toBe("cancelled");
    expect(await balance(playerAccount(p.player.id))).toBe(5000);
    expect((await call("POST", `/api/cups/${cup.slug}/checkin`, { cookie: outsider.cookie, body: {} })).json.error).toBe("check-in-closed");
    expect(await reconcileAll(DB)).toEqual([]);
  });
});

describe("public cup pages", () => {
  it("lists cups and shows one with its seats and seed commitments; drafts stay hidden", async () => {
    const cup = await openCup({ capacity: 16, minEntries: 4, expectedEntries: 16, name: "Public Cup" });
    const p = await player();
    await enter(cup.slug, p.cookie);
    const one = await call("GET", `/api/cups/${cup.slug}`);
    expect(one.json.cup).toMatchObject({ name: "Public Cup", state: "registration", entryFee: 1000 });
    expect(one.json.entries).toBe(1);
    expect(one.json.seeds[0]).toMatchObject({ slot: 0, seed: null });
    expect(JSON.stringify(one.json)).not.toMatch(/separateDevices|payoutHoldHours/);   // internal settings stay internal
    const list = await call("GET", "/api/cups");
    expect(list.json.cups.some((c: { slug: string }) => c.slug === cup.slug)).toBe(true);
    await DB.prepare("INSERT INTO cups (id, slug, name, state, config_json, created_by, created_at, updated_by, updated_at) VALUES ('draft-x', 'secret-draft', 'Secret', 'draft', '{}', 't', 0, 't', 0)").run();
    expect((await call("GET", "/api/cups/secret-draft")).status).toBe(404);
  });
});
