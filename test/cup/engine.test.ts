import { describe, it, expect } from "vitest";
import {
  simulate, publishProblems, validateConfig, tableSizes, advanceFrom, playersAfter, gfPrizes, planSecondChanceBase, rng,
  DEFAULT_CONFIG, LIMITS, type EngineConfig, type SimResult,
} from "../../src/cup/engine";

const rows = (m: SimResult, d: "W" | "L") => m.slots.map(s => s[d]).filter(x => x).map(x => [x!.n, x!.advance, x!.pay1, x!.pay2]);

/* Golden: the published payout model (docs/whot-cup-prd.md, "Payout model") at its recommended settings, 1,024
   players, 60% Second Chance take-up, seed 7. These figures were produced by the model itself, before the port. */
describe("golden: matches the published model", () => {
  const m = simulate(DEFAULT_CONFIG, { N: 1024, takeUp: 0.6, seed: 7 });
  it("main draw pay, round by round", () => {
    expect(rows(m, "W")).toEqual([
      [1024, 512, 450, 220], [512, 256, 640, 320], [256, 128, 910, 450], [128, 64, 1290, 640], [64, 32, 1830, 910],
      [32, 16, 2580, 1290], [16, 8, 3660, 1830], [8, 4, 5170, 2580], [4, 2, 7320, 3660]]);
  });
  it("Second Chance field and pay", () => {
    expect(m.slots.map(s => s.open ? [s.lost, s.bought] : null).filter(Boolean)).toEqual([[512, 307], [256, 154], [128, 77]]);
    expect(rows(m, "L")).toEqual([[307, 77, 410, 200], [231, 58, 470, 230], [135, 34, 620, 310], [34, 9, 1210, 600], [9, 3, 2090, 1040], [3, 2, 2560, 1280]]);
  });
  it("Grand Final, platform and outcomes", () => {
    expect(m.prizes).toEqual([159626, 79812, 47887, 31925]);
    expect(m.gfPot).toBe(319250);
    expect(m.platform).toBe(258600);
    expect(m.champion).toBe(179606);
    expect([m.rounds, m.winners, m.breakEven, m.maxLGames]).toEqual([10, 666, 161, 5]);
    expect(m.balanced).toBe(true);
  });
});

/* Pinned: the port's own output at the other sizes, so any change to the rules shows up here first. */
describe("pinned sizes", () => {
  const pin: Record<number, { rounds: number; platform: number; prizes: number[]; champion: number; winners: number; W1: number[]; L1: number[] }> = {
    16: { rounds: 6, platform: 4000, prizes: [2496, 1247, 748, 499], champion: 4216, winners: 12, W1: [16, 8, 670, 330], L1: [5, 2, 290, 140] },
    128: { rounds: 7, platform: 32300, prizes: [19986, 9992, 5995, 3997], champion: 23416, winners: 84, W1: [128, 64, 490, 240], L1: [38, 10, 380, 190] },
    10000: { rounds: 11, platform: 2581300, prizes: [1583016, 791507, 474904, 316603], champion: 1660896, winners: 6516, W1: [10000, 2500, 710, 350], L1: [4500, 1125, 380, 190] },
    20000: { rounds: 12, platform: 5162600, prizes: [3157386, 1578692, 947215, 631477], champion: 3263156, winners: 13026, W1: [20000, 5000, 710, 350], L1: [9000, 2250, 380, 190] },
  };
  for (const [N, p] of Object.entries(pin)) it(`${N} players`, () => {
    const m = simulate(DEFAULT_CONFIG, { N: Number(N) });
    expect({ rounds: m.rounds, platform: m.platform, prizes: m.prizes, champion: m.champion, winners: m.winners, W1: rows(m, "W")[0], L1: rows(m, "L")[0] }).toEqual(p);
    expect(m.balanced).toBe(true);
  });
});

describe("table rules", () => {
  it("tables are 3 or 4 seats, and 5 is the only field that makes a table of 2", () => {
    for (let n = 6; n <= 500; n++) { const t = tableSizes(n); expect(t.reduce((a, b) => a + b, 0)).toBe(n); expect(Math.min(...t)).toBeGreaterThanOrEqual(3); expect(Math.max(...t)).toBeLessThanOrEqual(4); }
    expect(tableSizes(5)).toEqual([3, 2]);
  });
  it("top 2 at a table of 4, the winner only at a table of 3, the winner only above the threshold", () => {
    const c = DEFAULT_CONFIG;
    expect(advanceFrom(c, "W", 100, 4, false)).toBe(2);
    expect(advanceFrom(c, "W", 100, 3, false)).toBe(1);
    expect(advanceFrom(c, "W", 3000, 4, false)).toBe(1);
    expect(advanceFrom(c, "L", 100, 4, false)).toBe(1);                           // Second Chance: winner only
    expect(advanceFrom({ ...c, scWinnerOnly: false }, "L", 100, 4, false)).toBe(2);
    expect(advanceFrom(c, "W", 4, 4, true)).toBe(2);                               // a final table sends its top 2
    expect(playersAfter(c, "W", 7)).toBe(3);                                       // 4 + 3 seats: 2 + 1
  });
  it("Grand Final prizes add up to the pot exactly, and a short final pays only who is there", () => {
    expect(gfPrizes(DEFAULT_CONFIG, 1001, 4).reduce((a, b) => a + b, 0)).toBe(1001);
    expect(gfPrizes(DEFAULT_CONFIG, 900, 3)).toEqual([500, 250, 150]);   // 50/25/15, scaled up to the whole pot
    expect(gfPrizes(DEFAULT_CONFIG, 900, 0)).toEqual([]);
  });
});

describe("config checks", () => {
  it("the defaults are valid", () => expect(validateConfig(DEFAULT_CONFIG)).toEqual([]));
  it("the default cup passes the publish checks at every size", () => {
    for (const N of [16, 128, 1024, 10000, 20000]) expect(publishProblems(simulate(DEFAULT_CONFIG, { N }))).toEqual([]);
  });
  it("catches a Second Chance that pays better than staying in the main draw", () => {
    const m = simulate(DEFAULT_CONFIG, { N: 1024 });
    const rigged = { ...m, slots: m.slots.map(s => s.L && s.W ? { ...s, L: { ...s.L, pay1: s.W.pay1 + DEFAULT_CONFIG.scFee } } : s) };
    expect(publishProblems(rigged).join(" ")).toContain("losing on purpose");
  });
  it("names every problem", () => {
    const bad: EngineConfig = { ...DEFAULT_CONFIG, platformCut: 45, scFee: 2000, gfSplit: [40, 40, 30], secondShare: 10 };
    const errs = validateConfig(bad).join(" | ");
    for (const w of ["platformCut", "scFee", "gfSplit", "secondShare"]) expect(errs).toContain(w);
  });
});

/* Properties over random configs inside the allowed ranges (PRD 5.1). */
function randomConfig(r: () => number): EngineConfig {
  const pick = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const entryFee = pick(1, 100) * 100;
  const a = pick(40, 60), b = pick(10, Math.min(30, 100 - a - 10)), c3 = pick(5, Math.min(15, 100 - a - b - 5));
  const gfSplit = [a, b, c3, 100 - a - b - c3].sort((x, y) => y - x);
  return {
    entryFee, platformCut: pick(LIMITS.platformCut[0], LIMITS.platformCut[1]), guaranteedPool: r() < 0.2 ? pick(0, 50) * 1000 : 0,
    top1Threshold: [0, 64, 512, 2048, 1e9][pick(0, 4)], advancePerTable: r() < 0.85 ? 2 : 1, tableOfThreeAdvance: r() < 0.8 ? 1 : 2,
    secondShare: pick(25, 90), growthPerHalving: pick(25, 60), roundTo: [1, 5, 10, 50, 100][pick(0, 4)],
    scEnabled: r() < 0.85, scFee: Math.floor(entryFee * pick(0, 100) / 100), scCutoffRound: pick(1, 6), scWinnerOnly: r() < 0.7,
    gfShare: pick(10, 60), gfSplit,
  };
}

describe("properties over 2,000 random configs", () => {
  const r = rng(2026);
  const cases = Array.from({ length: 2000 }, (_, i) => ({ c: randomConfig(r), N: i % 50 === 0 ? 4 + Math.floor(r() * 5000) : 4 + Math.floor(r() * 600), takeUp: r(), seed: i }));
  it("every config is valid by our own checks", () => { for (const k of cases) expect(validateConfig(k.c)).toEqual([]); });
  it("money balances to the unit, nobody loses more than twice, and the cup ends", () => {
    for (const k of cases) {
      const m = simulate(k.c, k);
      if (!m.balanced || m.maxLosses > 2 || m.rounds > 40 || m.gfPot < 0) throw new Error(`failed: ${JSON.stringify({ ...k, gfPot: m.gfPot, maxLosses: m.maxLosses, rounds: m.rounds })}`);
    }
  });
  it("a cup that passes the publish checks pays every player who advances; one that doesn't is caught", () => {
    let caught = 0;
    for (const k of cases.slice(0, 500)) {
      const m = simulate(k.c, k), problems = publishProblems(m);
      const unpaid = m.slots.some(s => [s.W, s.L].some(x => x && x.advance > 0 && (x.pay1 <= 0 || x.pay2 <= 0)));
      if (unpaid && !problems.length) throw new Error(`unpaid winner slipped past the checks: ${JSON.stringify(k)}`);
      if (problems.length) caught++;
    }
    expect(caught).toBeGreaterThan(0);                           // the random configs do reach the bad corners
  });
});

describe("Second Chance pay frozen before anyone buys in", () => {
  it("balances at any real take-up; a shortfall only nibbles the Grand Final", () => {
    for (const N of [16, 64, 256, 1024, 4096]) for (const takeUp of [0.01, 0.05, 0.15, 0.35, 0.6, 0.85, 1]) for (const scCutoffRound of [1, 3, 6]) {
      const c = { ...DEFAULT_CONFIG, scCutoffRound };
      const m = simulate(c, { N, takeUp, scBase: "frozen" });
      expect(m.balanced).toBe(true);
      // Measured worst case: 99.2% (4,096 players, 1% take-up). The Grand Final keeps at least 95% of the main pot's share.
      expect(m.gfPot).toBeGreaterThanOrEqual(0.95 * m.mainPool * c.gfShare / 100);
    }
  });
  it("inside the planning range, Second Chance tables stay within their own pot", () => {
    for (const N of [64, 256, 1024, 4096]) for (const takeUp of [0.1, 0.3, 0.6, 1]) {
      const m = simulate(DEFAULT_CONFIG, { N, takeUp, scBase: "frozen" });
      expect(m.lPay).toBeLessThanOrEqual(m.scPool);
    }
  });
  it("the frozen base is never above the exact one", () => {
    for (const N of [64, 1024]) expect(planSecondChanceBase(DEFAULT_CONFIG, N)).toBeLessThanOrEqual(simulate(DEFAULT_CONFIG, { N, takeUp: 0.6 }).baseL + 1e-9);
  });
});
