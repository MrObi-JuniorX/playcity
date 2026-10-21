import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { advanceFrom, simulate, type Draw } from "../../src/cup/engine";
import { seatTables } from "../../src/cup/seating";
import { resultSig } from "../../src/cup/director";
import { reconcileAll, reconcileCup, playerAccount } from "../../src/wallet/ledger";
import { DB, director, makeCup, bulkPlayers, bulkEnter, balance } from "./cupkit";
import type { CupConfig } from "../../src/cup/config";

/* Phase 5 (docs/whot-cup-prd.md): the CupDirector runs whole cups. Computer tables ("simulate" mode) finish at
   random from each table's seed; a Second Chance buyer harness buys exactly round(losers x take-up) per round, as
   the engine's simulation does, so every table count and every payout must match simulate() exactly. */

const KEY = (env as unknown as { PHONE_HMAC_KEY: string }).PHONE_HMAC_KEY;

/** Drive a cup from registration close to the end. Returns the times used. */
async function run(cup: { id: string; c: CupConfig }, takeUp: number, stopAtSlot = Infinity) {
  const d = director(cup.id), c = cup.c;
  let now = c.registrationClosesAt;
  await d.tick(now);                                                     // closes; check-in is already open
  now = c.startsAt - c.checkInCloseBeforeStartSec * 1000;
  await d.tick(now);                                                     // check-in closes: running
  now = c.startsAt;
  await d.tick(now);                                                     // slot 1 seated and finished
  for (let i = 0; i < 80; i++) {
    const snap = (await d.snapshot())!;
    if (snap.phase !== "running" || snap.slot >= stopAtSlot) break;
    const offers = (await d.openOffers()).filter(o => o.slot === snap.slot);
    for (const o of offers.slice(0, Math.round(offers.length * takeUp))) expect((await d.buySecondChance(o.player, now)).ok).toBe(true);
    now += (c.breakSec + 1) * 1000;
    await d.tick(now);
  }
  return now;
}

/** One row per slot per draw, shaped like the engine's. */
async function rows(cup: { id: string; c: CupConfig }) {
  const d = director(cup.id), out: { W: number[] | null; L: number[] | null }[] = [];
  for (let slot = 1; ; slot++) {
    const t = await d.tables(slot);
    if (!t.length || t[0].draw === "GF") break;
    const shape = (draw: Draw) => {
      const ts = t.filter(x => x.draw === draw);
      if (!ts.length) return null;
      const adv = ts.reduce((a, x) => a + advanceFrom(cup.c, draw, x.n, x.players.length, x.final), 0);
      return [ts[0].n, ts.length, adv, ts[0].pay1, ts[0].pay2];
    };
    out.push({ W: shape("W"), L: shape("L") });
  }
  return out;
}

const engineRows = (m: ReturnType<typeof simulate>) => m.slots.map(s => ({
  W: s.W ? [s.W.n, s.W.tables, s.W.advance, s.W.pay1, s.W.pay2] : null,
  L: s.L ? [s.L.n, s.L.tables, s.L.advance, s.L.pay1, s.L.pay2] : null,
}));

describe("a whole cup, computer players", () => {
  for (const N of [64, 103]) it(`${N} players: every table and every payout matches the engine`, async () => {
    const cup = await makeCup({ capacity: N, minEntries: 16, expectedEntries: N });
    const ids = await bulkPlayers(N, 10_000);
    await bulkEnter(cup, ids);
    await run(cup, 0.6);
    const snap = (await director(cup.id).snapshot())!;
    expect(snap.phase).toBe("settled");

    const sim = simulate(cup.c, { N, takeUp: 0.6, scBase: "frozen" });
    expect(await rows(cup)).toEqual(engineRows(sim));
    expect(snap.scBuyers).toBe(sim.bought);

    const gf = await DB.prepare("SELECT amount FROM ledger WHERE cup_id = ? AND kind = 'gf_prize' ORDER BY idem_key").bind(cup.id).all<{ amount: number }>();
    expect(gf.results.map(r => r.amount)).toEqual(sim.prizes.filter(x => x > 0));
    const cut = await DB.prepare("SELECT SUM(amount) AS s FROM ledger WHERE cup_id = ? AND kind = 'platform_cut'").bind(cup.id).first<number>("s");
    expect(cut).toBe(sim.platform);

    // The pot is empty, the books are clean, every registration is finished.
    expect(await reconcileCup(DB, cup.id, true)).toEqual([]);
    expect(await reconcileAll(DB)).toEqual([]);
    const states = await DB.prepare("SELECT state, COUNT(*) AS n FROM registrations WHERE cup_id = ? GROUP BY state").bind(cup.id).all<{ state: string; n: number }>();
    expect(states.results).toEqual([{ state: "finished", n: N }]);
    const champ = await DB.prepare("SELECT player_id FROM registrations WHERE cup_id = ? AND finish = 'champion'").bind(cup.id).all();
    expect(champ.results.length).toBe(1);
    expect((await DB.prepare("SELECT state FROM cups WHERE id = ?").bind(cup.id).first("state"))).toBe("settled");
  });

  it("seating is reproducible from the revealed seed", async () => {
    const cup = await makeCup({ capacity: 48, minEntries: 16, expectedEntries: 48 });
    const ids = await bulkPlayers(48, 10_000);
    await bulkEnter(cup, ids);
    await run(cup, 0.5, 1);
    const seed = await DB.prepare("SELECT seed FROM seeds WHERE cup_id = ? AND slot = 1").bind(cup.id).first<string>("seed");
    expect(seed).toMatch(/^[0-9a-f]{64}$/);
    const recomputed = seatTables(ids, seed!).tables.map(t => [...t].sort().join()).sort();
    const actual = (await director(cup.id).tables(1)).map(t => [...t.players].sort().join()).sort();
    expect(actual).toEqual(recomputed);
    // And the commitment published before seating is the seed's hash.
    const c = await DB.prepare("SELECT commitment FROM seeds WHERE cup_id = ? AND slot = 1").bind(cup.id).first<string>("commitment");
    const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed!)))].map(b => b.toString(16).padStart(2, "0")).join("");
    expect(c).toBe(h);
  });

  it("keeps players on a shared device apart", async () => {
    const cup = await makeCup({ capacity: 40, minEntries: 16, expectedEntries: 40 });
    const ids = await bulkPlayers(40, 10_000);
    await bulkEnter(cup, ids);
    await DB.prepare("UPDATE registrations SET device_id = 'dev-shared-' || (seq % 8) WHERE cup_id = ?").bind(cup.id).run();   // 8 devices, 5 players each
    await run(cup, 0.5, 1);
    const dev = new Map((await DB.prepare("SELECT player_id, device_id FROM registrations WHERE cup_id = ?").bind(cup.id).all<{ player_id: string; device_id: string }>()).results.map(r => [r.player_id, r.device_id]));
    for (const t of await director(cup.id).tables(1)) expect(new Set(t.players.map(p => dev.get(p))).size).toBe(t.players.length);
  });

  it("a cancel mid-cup refunds everyone at least their stake and empties the pot", async () => {
    const cup = await makeCup({ capacity: 32, minEntries: 16, expectedEntries: 32 });
    const ids = await bulkPlayers(32, 10_000);
    await bulkEnter(cup, ids);
    await run(cup, 0.6, 3);
    expect((await director(cup.id).snapshot())!.slot).toBe(3);
    await director(cup.id).cancel("Test: venue flooded");
    for (const p of ids) expect(await balance(playerAccount(p))).toBeGreaterThanOrEqual(10_000);
    expect(await balance(`cup:${cup.id}:COIN`)).toBe(0);
    expect(await reconcileAll(DB)).toEqual([]);
    expect(await DB.prepare("SELECT cancel_reason FROM cups WHERE id = ?").bind(cup.id).first("cancel_reason")).toBe("Test: venue flooded");
    expect((await DB.prepare("SELECT COUNT(*) AS n FROM registrations WHERE cup_id = ? AND state <> 'refunded'").bind(cup.id).first("n"))).toBe(0);
  });

  it("pause holds the next round; resume carries on", async () => {
    const cup = await makeCup({ capacity: 16, minEntries: 16, expectedEntries: 16 });
    await bulkEnter(cup, await bulkPlayers(16, 10_000));
    const d = director(cup.id), c = cup.c;
    await d.tick(c.registrationClosesAt); await d.tick(c.startsAt - 300_000); await d.tick(c.startsAt);
    await d.pause(true);
    await d.tick(c.startsAt + 3_600_000);
    expect((await d.snapshot())!.slot).toBe(1);
    await d.pause(false);
    await d.tick(c.startsAt + 3_600_000);
    expect((await d.snapshot())!.slot).toBe(2);
  });

  it("Second Chance: only first-time losers, only while the offer is open, and the stake moves once", async () => {
    const cup = await makeCup({ capacity: 16, minEntries: 16, expectedEntries: 16 });
    const ids = await bulkPlayers(16, 10_000);
    await bulkEnter(cup, ids);
    const d = director(cup.id), c = cup.c;
    await d.tick(c.registrationClosesAt); await d.tick(c.startsAt - 300_000); await d.tick(c.startsAt);
    const offers = await d.openOffers();
    expect(offers.length).toBe(8);                                            // 16 → 8: eight first-time losers
    const winners = ids.filter(p => !offers.some(o => o.player === p));
    expect((await d.buySecondChance(winners[0], c.startsAt)).error).toBe("no-offer");
    expect((await d.buySecondChance(offers[0].player, offers[0].expires + 1)).error).toBe("offer-closed");
    expect((await d.buySecondChance(offers[1].player, c.startsAt)).ok).toBe(true);
    expect((await d.buySecondChance(offers[1].player, c.startsAt)).ok).toBe(true);   // a retry is fine
    expect(await balance(playerAccount(offers[1].player))).toBe(10_000 - c.entryFee - c.scFee + 0);
  });

  it("refuses to start below the minimum and refunds everyone", async () => {
    const cup = await makeCup({ capacity: 64, minEntries: 20, expectedEntries: 64 });
    const ids = await bulkPlayers(12, 10_000);
    await bulkEnter(cup, ids);
    await director(cup.id).tick(cup.c.registrationClosesAt);
    expect((await director(cup.id).snapshot())!.phase).toBe("cancelled");
    for (const p of ids) expect(await balance(playerAccount(p))).toBe(10_000);
    expect(await reconcileCup(DB, cup.id, true)).toEqual([]);
  });
});

describe("tables that report (external mode)", () => {
  it("accepts a signed result once, refuses forgeries, and finishes overdue tables from their seed as late", async () => {
    const cup = await makeCup({ capacity: 16, minEntries: 16, expectedEntries: 16 }, "external");
    await bulkEnter(cup, await bulkPlayers(16, 10_000));
    const d = director(cup.id), c = cup.c;
    await d.tick(c.registrationClosesAt); await d.tick(c.startsAt - 300_000); await d.tick(c.startsAt);
    const t = await d.tables(1);
    expect(t.length).toBe(4);
    expect(t.every(x => x.result === null)).toBe(true);
    const places = [...t[0].players].reverse();
    expect((await d.report(t[0].code, places, "forged")).error).toBe("bad-signature");
    expect((await d.report(t[0].code, [...places.slice(1), "intruder"], await resultSig(KEY, cup.id, t[0].code, places))).error).toBe("bad-places");
    expect((await d.report(t[0].code, places, await resultSig(KEY, cup.id, t[0].code, places))).ok).toBe(true);
    expect((await d.report(t[0].code, places, await resultSig(KEY, cup.id, t[0].code, places))).ok).toBe(true);    // a retry
    expect(await balance(playerAccount(places[0]))).toBe(10_000 - c.entryFee + t[0].pay1);
    // The clock runs out on the other three.
    await d.tick(c.startsAt + (c.tableClockSec + c.disconnectGraceSec + 61) * 1000);
    const after = await d.tables(1);
    expect(after.filter(x => x.late).length).toBe(3);
    expect(after.every(x => x.result)).toBe(true);
    expect(((await d.status()) as unknown as { late: number }).late).toBe(3);
  });

  it("issues a seat token only to the seated player", async () => {
    const cup = await makeCup({ capacity: 16, minEntries: 16, expectedEntries: 16 }, "external");
    const ids = await bulkPlayers(16, 10_000);
    await bulkEnter(cup, ids);
    const d = director(cup.id), c = cup.c;
    await d.tick(c.registrationClosesAt); await d.tick(c.startsAt - 300_000); await d.tick(c.startsAt);
    const w = await d.whereIs(ids[0]) as { table: { code: string; seat: number; token: string } };
    expect(w.table.token).toMatch(/^\d+\.[0-9a-f]{64}$/);
    const t = (await d.tables(1)).find(x => x.code === w.table.code)!;
    expect(t.players[w.table.seat]).toBe(ids[0]);
  });
});

/* T2 cost (cost protocol): rows written per player and the slowest slot transition. 4,096 players in every run;
   the full 16,384 with CUP_T2_FULL=1 (npm run test:t2), which takes several minutes on a laptop. */
async function t2(N: number) {
  const cup = await makeCup({ capacity: N, minEntries: 16, expectedEntries: N });
  const ids = await bulkPlayers(N, 10_000);
  await bulkEnter(cup, ids);
  const d = director(cup.id), c = cup.c;
  await d.tick(c.registrationClosesAt); await d.tick(c.startsAt - 300_000);
  await d.rowsWritten();
  let now = c.startsAt, slowest = 0, totalDO = 0, totalD1 = 0;
  const perSlot: { slot: number; ms: number; do: number; d1: number }[] = [];
  for (let i = 0; i < 40; i++) {
    const t0 = Date.now();
    await d.tick(now);
    const ms = Date.now() - t0, w = await d.rowsWritten(), snap = (await d.snapshot())!;
    perSlot.push({ slot: snap.slot, ms, ...w }); totalDO += w.do; totalD1 += w.d1; slowest = Math.max(slowest, ms);
    if (snap.phase !== "running") break;
    const offers = (await d.openOffers()).filter(o => o.slot === snap.slot);
    for (const o of offers.slice(0, Math.round(offers.length * 0.6))) await d.buySecondChance(o.player, now);
    now += (c.breakSec + 1) * 1000;
  }
  console.log(JSON.stringify({ N, slowestTickMs: slowest, rowsPerPlayer: { do: +(totalDO / N).toFixed(2), d1Payouts: +(totalD1 / N).toFixed(2) }, perSlot }));
  expect((await d.snapshot())!.phase).toBe("settled");
  expect(await reconcileCup(DB, cup.id, true)).toEqual([]);
  expect(totalDO / N).toBeLessThanOrEqual(5);                              // the director's own storage
  expect(totalD1 / N).toBeLessThanOrEqual(10);                             // payouts and table records in D1
}

describe("T2 cost", () => {
  it("4,096 players: rows written per player stay in budget", () => t2(4096), 300_000);
  it.skipIf(!(env as unknown as { CUP_T2_FULL?: string }).CUP_T2_FULL)("16,384 players (CUP_T2_FULL=1)", () => t2(16_384), 900_000);
});
