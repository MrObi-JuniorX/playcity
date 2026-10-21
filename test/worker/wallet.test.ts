import { describe, it, expect } from "vitest";
import {
  transfer, transferAll, balanceOf, reconcileAll, reconcileCup, LedgerError,
  playerAccount, cupAccount, PLATFORM, ISSUER, playerSpec, cupSpec, platformSpec, issuerSpec, type Transfer,
} from "../../src/wallet/ledger";
import { openWallet, topUpDay, DEFAULT_ECONOMY, forgetEconomyCache } from "../../src/wallet/wallet";
import { call, signIn, E } from "./helpers";

/* Phase 2 (docs/whot-cup-prd.md): the double-entry ledger, coins, and the wallet endpoint.
   S-12: retries never pay twice. Overdrafts are refused by the database, even under concurrency. */

const db = () => E.DB;
let n = 0;
const pid = () => `test-player-${Date.now()}-${n++}`;
const stake = (p: string, cup: string, amount: number, idem: string): Transfer =>
  ({ idem, from: playerAccount(p), to: cupAccount(cup), amount, currency: "COIN", kind: "stake", playerId: p, cupId: cup });

/** A player with exactly `coins`, through a normal welcome grant plus an adjustment. */
async function fund(coins: number) {
  const p = pid();
  await transfer(db(), { idem: `fund:${p}`, from: ISSUER(), to: playerAccount(p), amount: coins, currency: "COIN", kind: "adjust", playerId: p }, [issuerSpec(), playerSpec(p)]);
  return p;
}

describe("ledger", () => {
  it("moves money and keeps every balance equal to the sum of its entries", async () => {
    const p = await fund(5000), cup = `cup-${p}`;
    await transfer(db(), stake(p, cup, 1000, `stake:${cup}:${p}`), [cupSpec(cup)]);
    expect(await balanceOf(db(), playerAccount(p))).toBe(4000);
    expect(await balanceOf(db(), cupAccount(cup))).toBe(1000);
    expect(await reconcileAll(db())).toEqual([]);
  });

  it("S-12: a retried transfer is applied once", async () => {
    const p = await fund(5000), cup = `cup-${p}`;
    const t = stake(p, cup, 1000, `stake:${cup}:${p}`);
    expect((await transfer(db(), t, [cupSpec(cup)])).applied).toBe(true);
    expect((await transfer(db(), t, [cupSpec(cup)])).applied).toBe(false);
    expect((await transfer(db(), t, [cupSpec(cup)])).applied).toBe(false);
    expect(await balanceOf(db(), playerAccount(p))).toBe(4000);
  });

  it("S-12: reusing a key for a different transfer is refused", async () => {
    const p = await fund(5000), cup = `cup-${p}`;
    await transfer(db(), stake(p, cup, 1000, `k:${p}`), [cupSpec(cup)]);
    await expect(transfer(db(), stake(p, cup, 2000, `k:${p}`), [cupSpec(cup)])).rejects.toMatchObject({ code: "idem-conflict" });
    expect(await balanceOf(db(), playerAccount(p))).toBe(4000);
  });

  it("refuses an overdraft and writes nothing", async () => {
    const p = await fund(500), cup = `cup-${p}`;
    await expect(transfer(db(), stake(p, cup, 1000, `s:${p}`), [cupSpec(cup)])).rejects.toMatchObject({ code: "insufficient-funds" });
    expect(await balanceOf(db(), playerAccount(p))).toBe(500);
    expect(await db().prepare("SELECT COUNT(*) AS n FROM ledger WHERE idem_key = ?").bind(`s:${p}`).first("n")).toBe(0);
  });

  it("concurrent stakes can't overdraw: 10 at once against room for 5", async () => {
    const p = await fund(5000), cup = `cup-${p}`;
    await transfer(db(), { idem: `open:${cup}`, from: ISSUER(), to: cupAccount(cup), amount: 1, currency: "COIN", kind: "adjust", cupId: cup }, [cupSpec(cup)]);
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => transfer(db(), stake(p, cup, 1000, `c:${p}:${i}`))));
    const ok = results.filter(r => r.status === "fulfilled").length;
    expect(ok).toBe(5);
    for (const r of results) if (r.status === "rejected") expect((r.reason as LedgerError).code).toBe("insufficient-funds");
    expect(await balanceOf(db(), playerAccount(p))).toBe(0);
    expect(await balanceOf(db(), cupAccount(cup))).toBe(5001);
    expect(await reconcileAll(db())).toEqual([]);
  });

  it("a batch is all or nothing", async () => {
    const a = await fund(1000), b = await fund(100), cup = `cup-${a}`;
    await expect(transferAll(db(), [stake(a, cup, 1000, `x:${a}`), stake(b, cup, 1000, `x:${b}`)], [cupSpec(cup)])).rejects.toMatchObject({ code: "insufficient-funds" });
    expect(await balanceOf(db(), playerAccount(a))).toBe(1000);                    // the good half was rolled back too
    expect(await balanceOf(db(), cupAccount(cup))).toBe(null);                     // even the pot it would have created
  });

  it("refuses unknown accounts, bad amounts and self-transfers", async () => {
    const p = await fund(1000);
    await expect(transfer(db(), stake(p, "nowhere", 100, `u:${p}`))).rejects.toMatchObject({ code: "unknown-account" });
    for (const amount of [0, -5, 1.5, Number.NaN]) await expect(transfer(db(), stake(p, "c", amount, `b:${p}`))).rejects.toMatchObject({ code: "bad-transfer" });
    await expect(transfer(db(), { ...stake(p, "c", 10, `self:${p}`), to: playerAccount(p) })).rejects.toMatchObject({ code: "bad-transfer" });
    expect(await balanceOf(db(), playerAccount(p))).toBe(1000);
  });

  it("a whole cup: stakes in, cut and payouts out, pot empty, books zero-sum", async () => {
    const cup = `cup-whole-${Date.now()}`, players = await Promise.all([1, 2, 3, 4].map(() => fund(1000)));
    await transferAll(db(), players.map(p => stake(p, cup, 1000, `stake:${cup}:${p}`)), [cupSpec(cup), platformSpec()]);
    await transferAll(db(), [
      { idem: `cut:${cup}`, from: cupAccount(cup), to: PLATFORM(), amount: 800, currency: "COIN", kind: "platform_cut", cupId: cup },
      { idem: `pay:${cup}:1`, from: cupAccount(cup), to: playerAccount(players[0]), amount: 2200, currency: "COIN", kind: "table_pay", playerId: players[0], cupId: cup },
      { idem: `pay:${cup}:2`, from: cupAccount(cup), to: playerAccount(players[1]), amount: 1000, currency: "COIN", kind: "table_pay", playerId: players[1], cupId: cup },
    ]);
    expect(await reconcileCup(db(), cup, true)).toEqual([]);
    // Overpaying from the pot is impossible: the pot can't go below zero.
    await expect(transfer(db(), { idem: `pay:${cup}:3`, from: cupAccount(cup), to: playerAccount(players[2]), amount: 1, currency: "COIN", kind: "table_pay", playerId: players[2], cupId: cup }))
      .rejects.toMatchObject({ code: "insufficient-funds" });
    expect(await reconcileAll(db())).toEqual([]);
  });

  it("reconciliation catches a balance edited behind the ledger's back", async () => {
    const p = await fund(700);
    await db().prepare("UPDATE accounts SET balance = balance + 50 WHERE id = ?").bind(playerAccount(p)).run();
    const m = await reconcileAll(db());
    expect(m).toContainEqual({ kind: "account", id: playerAccount(p), expected: 700, found: 750 });
    expect(m.some(x => x.kind === "currency")).toBe(true);
    await db().prepare("UPDATE accounts SET balance = balance - 50 WHERE id = ?").bind(playerAccount(p)).run();
    expect(await reconcileAll(db())).toEqual([]);
  });

  it("T2 cost: one stake writes at most 6 rows, indexes included", async () => {
    const p = await fund(1000), cup = `cup-${p}`;
    await transfer(db(), { idem: `open:${cup}`, from: ISSUER(), to: cupAccount(cup), amount: 1, currency: "COIN", kind: "adjust", cupId: cup }, [cupSpec(cup)]);
    const r = await transfer(db(), stake(p, cup, 1000, `t2:${p}`));
    console.log(JSON.stringify({ rowsWrittenPerStake: r.rowsWritten }));
    expect(r.rowsWritten).toBeLessThanOrEqual(6);
  });
});

describe("coins", () => {
  it("a new wallet gets the welcome grant once, and the first top-up comes the next day", async () => {
    const p = pid(), now = Date.now();
    expect((await openWallet(db(), p, now)).balance).toBe(5000);
    expect((await openWallet(db(), p, now)).balance).toBe(5000);
    expect((await openWallet(db(), p, now + 86_400_000)).balance).toBe(6000);
    expect((await openWallet(db(), p, now + 86_400_000 + 1000)).balance).toBe(6000);  // once a day
  });

  it("the daily top-up stops at the balance cap", async () => {
    const p = pid(), now = Date.now();
    await openWallet(db(), p, now);
    await transfer(db(), { idem: `adj:${p}`, from: ISSUER(), to: playerAccount(p), amount: 14_600, currency: "COIN", kind: "adjust", playerId: p });   // 19,600
    expect((await openWallet(db(), p, now + 86_400_000)).balance).toBe(20_000);
    expect((await openWallet(db(), p, now + 2 * 86_400_000)).balance).toBe(20_000);
  });

  it("the day turns over at 8am Lagos time (07:00 UTC)", () => {
    const at = (iso: string) => topUpDay(Date.parse(iso), DEFAULT_ECONOMY);
    expect(at("2026-10-20T06:59:00Z")).toBe(at("2026-10-19T07:00:00Z"));
    expect(at("2026-10-20T07:00:00Z")).toBe(at("2026-10-19T07:00:00Z") + 1);
  });

  it("economy settings come from the settings table", async () => {
    await db().prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('economy', ?, ?)").bind(JSON.stringify({ coinWelcomeGrant: 2500 }), Date.now()).run();
    forgetEconomyCache();
    expect((await openWallet(db(), pid())).balance).toBe(2500);
    await db().prepare("DELETE FROM settings WHERE key = 'economy'").run();
    forgetEconomyCache();
  });

  it("two tabs opening a new wallet together still grant once", async () => {
    const p = pid(), now = Date.now();
    await Promise.all([openWallet(db(), p, now), openWallet(db(), p, now), openWallet(db(), p, now)]);
    expect(await balanceOf(db(), playerAccount(p))).toBe(5000);
  });
});

describe("GET /api/wallet", () => {
  it("needs a session", async () => {
    expect((await call("GET", "/api/wallet")).status).toBe(401);
  });

  it("shows the balance, the next top-up and signed history", async () => {
    const s = await signIn("NG", "0803 000 0070", "203.0.113.70");
    const r = await call("GET", "/api/wallet", { cookie: s.cookie });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ currency: "COIN", balance: 5000, cap: 20000, dailyTopUp: 1000 });
    expect(r.json.nextTopUpAt).toBeGreaterThan(Date.now());
    expect(r.json.entries[0]).toMatchObject({ kind: "welcome", amount: 5000 });
    const cup = `cup-api-${Date.now()}`;
    await transfer(db(), stake(s.player.id, cup, 1000, `stake:${cup}:${s.player.id}`), [cupSpec(cup)]);
    const after = await call("GET", "/api/wallet", { cookie: s.cookie });
    expect(after.json.balance).toBe(4000);
    expect(after.json.entries[0]).toMatchObject({ kind: "stake", amount: -1000, cupId: cup });
  });

  it("pages through history", async () => {
    const s = await signIn("NG", "0803 000 0071", "203.0.113.71");
    await call("GET", "/api/wallet", { cookie: s.cookie });
    const cup = `cup-page-${Date.now()}`;
    for (let i = 0; i < 35; i++) await transfer(db(), stake(s.player.id, cup, 10, `pg:${cup}:${i}`), [cupSpec(cup)]);
    const first = await call("GET", "/api/wallet", { cookie: s.cookie });
    expect(first.json.entries.length).toBe(30);
    expect(first.json.more).toBe(true);
    const second = await call("GET", `/api/wallet?before=${first.json.entries.at(-1).id}`, { cookie: s.cookie });
    expect(second.json.entries.length).toBe(6);                 // 5 stakes and the welcome grant
    expect(second.json.more).toBe(false);
  });
});
