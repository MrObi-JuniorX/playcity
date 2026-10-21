/* Whot Cup engine: the rules for who advances and what every table pays (docs/whot-cup-prd.md, sections 4 and 5).

   One engine for three users: the CupDirector runs real cups with it, the admin console previews a cup with it,
   and the tests pin it. Nothing here touches cards: only seats, places and money.

   Shape of a cup
   - Main draw (W): tables of 4. The top `advancePerTable` advance; at a table of 3 only `tableOfThreeAdvance`;
     while more than `top1Threshold` players are left, only the winner. Not advancing is the first loss.
   - Second Chance (L): after a first loss in main-draw rounds 1..scCutoffRound a player may stake `scFee` to play
     on. With `scWinnerOnly`, only table winners advance. Not advancing here is the second loss: out.
   - Each draw ends with a final table of 4 or fewer; its top 2 go to the Grand Final (2 from W, 2 from L).

   Money
   - Two pots: entry fees pay main-draw tables, Second Chance stakes pay Second Chance tables. Each pot gives the
     platform `platformCut`%, and `gfShare`% of what is left goes to the Grand Final. A sponsor's
     `guaranteedPool` joins the main pot after the cut.
   - 1st at a table earns base * growth^(log2(depth) - 1), depth = field / players left after the round; 2nd earns
     `secondShare`% of that. Each draw's base is solved so its tables use exactly their share of their pot. Every
     payout is floored to `roundTo`, and the leftovers go to the Grand Final, so the books always balance.

   All money is in whole units of the cup's currency (coins or naira). */

export type Draw = "W" | "L";

/** The cup settings this engine reads. Names match the admin settings in the PRD, section 5.1. Percentages are 0-100. */
export interface EngineConfig {
  entryFee: number;
  platformCut: number;
  guaranteedPool: number;
  top1Threshold: number;
  advancePerTable: 1 | 2;
  tableOfThreeAdvance: 1 | 2;
  secondShare: number;
  growthPerHalving: number;
  roundTo: number;
  scEnabled: boolean;
  scFee: number;
  scCutoffRound: number;
  scWinnerOnly: boolean;
  gfShare: number;
  gfSplit: number[];
}

/** Pay rises by √2 each time the field halves: 41.42%. Kept exact so the engine matches the published model. */
export const DEFAULT_GROWTH_PCT = (Math.SQRT2 - 1) * 100;

export const DEFAULT_CONFIG: EngineConfig = {
  entryFee: 1000, platformCut: 20, guaranteedPool: 0,
  top1Threshold: 2048, advancePerTable: 2, tableOfThreeAdvance: 1,
  secondShare: 50, growthPerHalving: DEFAULT_GROWTH_PCT, roundTo: 10,
  scEnabled: true, scFee: 500, scCutoffRound: 3, scWinnerOnly: true,
  gfShare: 30, gfSplit: [50, 25, 15, 10],
};

/** Allowed ranges for the engine's settings (PRD 5.1). The admin console and the property tests both use these. */
export const LIMITS = {
  entryFee: [100, 100_000], platformCut: [0, 30], guaranteedPool: [0, 100_000_000],
  top1Threshold: [0, Number.MAX_SAFE_INTEGER], secondShare: [25, 90], growthPerHalving: [25, 60],
  roundTo: [1, 100], scCutoffRound: [1, 99], gfShare: [10, 60],
} as const;
export const MAX_FIELD = 20_000;

/** Problems with a config, in plain words. Empty when the engine can run it. */
export function validateConfig(c: EngineConfig): string[] {
  const out: string[] = [];
  const within = (k: keyof typeof LIMITS) => {
    const v = c[k] as number, [lo, hi] = LIMITS[k];
    if (!Number.isFinite(v) || v < lo || v > hi) out.push(`${k} must be between ${lo} and ${hi}`);
  };
  (Object.keys(LIMITS) as (keyof typeof LIMITS)[]).forEach(within);
  for (const k of ["entryFee", "guaranteedPool", "roundTo", "scFee", "scCutoffRound", "top1Threshold"] as const)
    if (!Number.isInteger(c[k])) out.push(`${k} must be a whole number`);
  if (c.advancePerTable !== 1 && c.advancePerTable !== 2) out.push("advancePerTable must be 1 or 2");
  if (c.tableOfThreeAdvance !== 1 && c.tableOfThreeAdvance !== 2) out.push("tableOfThreeAdvance must be 1 or 2");
  if (c.scFee < 0 || c.scFee > c.entryFee) out.push("scFee must be between 0 and the entry fee");
  if (c.gfSplit.length < 1 || c.gfSplit.length > 4 || c.gfSplit.some(x => !Number.isFinite(x) || x < 0))
    out.push("gfSplit needs 1 to 4 shares, none negative");
  else if (Math.abs(c.gfSplit.reduce((a, b) => a + b, 0) - 100) > 1e-9) out.push("gfSplit must add up to 100");
  else if (c.gfSplit.some((x, i) => i > 0 && x > c.gfSplit[i - 1])) out.push("gfSplit must not pay a lower place more");
  return out;
}

/* ---------- the rules the director uses for every round ---------- */

/** Split n players into ceil(n/4) tables as evenly as possible: sizes 3-4 (only n = 5 makes a table of 2). */
export function tableSizes(n: number): number[] {
  if (n <= 0) return [];
  const t = Math.ceil(n / 4), base = Math.floor(n / t), extra = n % t;
  return Array.from({ length: t }, (_, i) => base + (i < extra ? 1 : 0));
}

/** How many advance from one table of `size` in a round of this draw with `n` players at the start. */
export function advanceFrom(c: EngineConfig, draw: Draw, n: number, size: number, final: boolean): number {
  if (final) return Math.min(2, size);
  const k = isTop1(c, draw, n) ? 1 : c.advancePerTable;
  if (size >= 4) return k;
  if (size === 3) return Math.min(k, c.tableOfThreeAdvance);
  return 1;
}

/** True when only the table winner advances this round. */
export function isTop1(c: EngineConfig, draw: Draw, n: number): boolean {
  return n > c.top1Threshold || (draw === "L" && c.scWinnerOnly) || c.advancePerTable === 1;
}

/** A draw's round is its final table when 4 or fewer players are left. */
export const isFinal = (n: number) => n <= 4;

/** Players left after a round of this draw starts with n. */
export function playersAfter(c: EngineConfig, draw: Draw, n: number): number {
  if (isFinal(n)) return Math.min(2, n);
  return tableSizes(n).reduce((s, z) => s + advanceFrom(c, draw, n, z, false), 0);
}

/** Pay for 1st and 2nd at every table of a round, given that draw's base and the players left after it. */
export function rung(c: EngineConfig, field: number, base: number, nAfter: number, round = true): { first: number; second: number } {
  const depth = field / Math.max(nAfter, 1);
  const first = base * Math.pow(1 + c.growthPerHalving / 100, Math.log2(depth) - 1);
  const fl = (x: number) => round ? Math.floor(x / c.roundTo) * c.roundTo : x;
  return { first: fl(first), second: fl(first * c.secondShare / 100) };
}

/** The platform's cut of a stake total, floored so the players keep any fraction. */
export const cutOf = (c: EngineConfig, stakes: number) => Math.floor(stakes * c.platformCut / 100);

/** Grand Final prizes for the players seated there (fewer than 4 when a draw ran short). Sums to the pot exactly. */
export function gfPrizes(c: EngineConfig, pot: number, seated: number): number[] {
  const split = c.gfSplit.slice(0, Math.max(0, Math.min(seated, c.gfSplit.length)));
  if (!split.length) return [];
  const tot = split.reduce((a, b) => a + b, 0);
  const prizes = split.map(x => Math.floor(pot * x / tot));
  prizes[0] += pot - prizes.reduce((a, b) => a + b, 0);
  return prizes;
}

/* ---------- simulation: the admin preview, the model and the tests ---------- */

/** Seeded PRNG (mulberry32) for simulations only. Real cups seat players from a committed seed (PRD SE-1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffle<T>(arr: T[], r: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}

export interface RoundRow { draw: Draw; n: number; tables: number; mode: "top 1" | "top 2" | "final"; advance: number; pay1: number; pay2: number; paid: number }
export interface Slot { W: RoundRow | null; L: RoundRow | null; lost: number; open: boolean; offered: number; bought: number }

export interface SimOptions {
  /** Players who check in. */
  N: number;
  /** Share of first-time losers (0-1) who buy a Second Chance. An estimate in previews; measured in real cups. */
  takeUp?: number;
  seed?: number;
  /** How the Second Chance base is set. "exact" solves it knowing the take-up (the published model). "frozen" uses
      the conservative base a real cup must freeze before anyone has bought in (see planSecondChanceBase). */
  scBase?: "exact" | "frozen";
}

interface Pass {
  slots: Slot[]; tables: number; wPay: number; lPay: number; GF: number[];
  won: Float64Array; wonL: Float64Array; staked: Float64Array; games: Uint16Array; losses: Uint8Array;
  offered: number; bought: number; wRounds: number; lRounds: number; maxLGames: number;
}

/* One pass over a whole cup. With bases of 1 and no rounding it measures each draw's cost per unit of base; the
   real pass pays real money. Both passes make the same random calls, so they seat, finish and buy in identically. */
function pass(c: EngineConfig, N: number, takeUp: number, seed: number, baseW: number, baseL: number, round: boolean): Pass {
  const r = rng(seed), buy = rng(seed + 2);
  const won = new Float64Array(N), wonL = new Float64Array(N), staked = new Float64Array(N).fill(c.entryFee);
  const games = new Uint16Array(N), losses = new Uint8Array(N), lGames = new Uint16Array(N);
  const cutoff = c.scEnabled ? c.scCutoffRound : 0;

  function play(draw: Draw, pool: number[]) {
    const n = pool.length, final = isFinal(n);
    const sizes = final ? [n] : tableSizes(n);
    const nAfter = playersAfter(c, draw, n);
    const pay = rung(c, N, draw === "L" ? baseL : baseW, nAfter, round);
    shuffle(pool, r);                                    // random seating every round
    const up: number[] = [], down: number[] = [];
    let at = 0, paid = 0;
    for (const z of sizes) {
      const table = pool.slice(at, at + z); at += z;
      shuffle(table, r);                                 // finishing order: equal skill, random result
      const adv = advanceFrom(c, draw, n, z, final);
      table.forEach((p, place) => {
        games[p]++;
        const amt = place === 0 ? pay.first : place === 1 && z > 1 ? pay.second : 0;
        won[p] += amt; paid += amt; if (draw === "L") wonL[p] += amt;
        if (place < adv) up.push(p); else { down.push(p); losses[p]++; }
      });
    }
    const mode: RoundRow["mode"] = final ? "final" : isTop1(c, draw, n) ? "top 1" : "top 2";
    return { row: { draw, n, tables: sizes.length, mode, advance: up.length, pay1: pay.first, pay2: pay.second, paid }, up, down, final };
  }

  let W = Array.from({ length: N }, (_, i) => i), L: number[] = [], drops: number[] = [];
  const GF: number[] = [], slots: Slot[] = [];
  let tables = 0, wPay = 0, lPay = 0, offered = 0, bought = 0, wRound = 0, lRounds = 0;
  for (let s = 1; s < 500; s++) {
    if (!W.length && !L.length && !drops.length) break;
    const slot: Slot = { W: null, L: null, lost: 0, open: false, offered: 0, bought: 0 };
    const Lpool = L.concat(drops); drops = [];
    if (W.length) {
      wRound++;
      const res = play("W", W);
      slot.W = res.row; tables += res.row.tables; wPay += res.row.paid;
      if (res.final) { GF.push(...res.up); W = []; } else W = res.up;
      slot.lost = res.down.length; slot.open = wRound <= cutoff;
      if (slot.open) {                                   // first loss: exactly takeUp of them stake again, the rest go home
        const want = Math.round(res.down.length * takeUp);
        shuffle(res.down, buy).forEach((p, i) => { slot.offered++; if (i < want) { drops.push(p); staked[p] += c.scFee; slot.bought++; } });
      }
      offered += slot.offered; bought += slot.bought;
    }
    const inflow = drops.length > 0 || (W.length > 0 && wRound < cutoff);
    if (Lpool.length) {
      if (Lpool.length <= 4 && inflow) L = Lpool;        // wait for the main draw to send more players
      else {
        for (const p of Lpool) lGames[p]++;
        lRounds++;
        const res = play("L", Lpool);
        slot.L = res.row; tables += res.row.tables; lPay += res.row.paid;
        if (res.final) { GF.push(...res.up); L = []; } else L = res.up;
      }
    } else L = [];
    if (slot.W || slot.L) slots.push(slot);
  }
  let maxLGames = 0; for (const g of lGames) if (g > maxLGames) maxLGames = g;
  return { slots, tables, wPay, lPay, GF, won, wonL, staked, games, losses, offered, bought, wRounds: wRound, lRounds, maxLGames };
}

/** Pots for a field of N with `scBuyers` Second Chance stakes. */
export function pots(c: EngineConfig, N: number, scBuyers: number) {
  const mainEntries = N * c.entryFee, scEntries = c.scEnabled ? scBuyers * c.scFee : 0;
  const mainCut = cutOf(c, mainEntries), scCut = cutOf(c, scEntries);
  return {
    mainEntries, scEntries, entries: mainEntries + scEntries + c.guaranteedPool,
    platform: mainCut + scCut,
    mainPool: mainEntries - mainCut + c.guaranteedPool,
    scPool: scEntries - scCut,
  };
}

/** The main-draw base for a field of N. Exact: the main draw's shape depends only on N and the settings. */
export function mainBase(c: EngineConfig, N: number): number {
  const unit = pass(c, N, 0, 1, 1, 1, false);
  return pots(c, N, 0).mainPool * (1 - c.gfShare / 100) / unit.wPay;
}

/* A real cup must publish Second Chance pay before anyone buys in, but the right base depends on how many do.
   Freeze the smallest base across take-ups from 10% to 100%, so Second Chance tables never pay out more than their
   share of their pot at any of those take-ups; whatever they leave goes to the Grand Final. */
export const SC_PLANNING_TAKEUPS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
export function planSecondChanceBase(c: EngineConfig, N: number, seed = 7): number {
  if (!c.scEnabled || c.scFee === 0) return 0;
  let best = Infinity;
  for (const t of SC_PLANNING_TAKEUPS) {
    const unit = pass(c, N, t, seed, 1, 1, false);
    if (!unit.lPay) continue;
    best = Math.min(best, pots(c, N, unit.bought).scPool * (1 - c.gfShare / 100) / unit.lPay);
  }
  return Number.isFinite(best) ? best : 0;
}

export interface SimResult {
  config: EngineConfig; N: number; takeUp: number;
  mainEntries: number; scEntries: number; entries: number; platform: number; mainPool: number; scPool: number;
  baseW: number; baseL: number; wPay: number; lPay: number; gfPot: number; prizes: number[];
  slots: Slot[]; rounds: number; tables: number; wRounds: number; lRounds: number; maxLGames: number;
  offered: number; bought: number; scAny: number; scStakeBack: number;
  winners: number; breakEven: number; medianWin: number; champion: number;
  maxGames: number; avgGames: number; maxLosses: number;
  buckets: { label: string; n: number }[];
  /** Per player: total won and total staked, in seat-id order. */
  won: number[]; staked: number[];
  balanced: boolean;
}

/** Run a whole cup with equally skilled players and random results. */
export function simulate(config: EngineConfig, opts: SimOptions): SimResult {
  const c = config, N = Math.max(4, Math.min(MAX_FIELD, Math.floor(opts.N)));
  const takeUp = c.scEnabled ? Math.max(0, Math.min(1, opts.takeUp ?? 0.6)) : 0, seed = opts.seed ?? 7;
  const unit = pass(c, N, takeUp, seed, 1, 1, false);
  const p = pots(c, N, unit.bought);
  const baseW = p.mainPool * (1 - c.gfShare / 100) / unit.wPay;
  const baseL = (opts.scBase ?? "exact") === "frozen" ? planSecondChanceBase(c, N, seed)
    : unit.lPay ? p.scPool * (1 - c.gfShare / 100) / unit.lPay : 0;
  const res = pass(c, N, takeUp, seed, baseW, baseL, true);
  const gfPot = p.mainPool + p.scPool - res.wPay - res.lPay;  // gfShare of both pots, plus rounding leftovers

  const gf = shuffle(res.GF.slice(), rng(seed + 1));
  const prizes = gfPrizes(c, gfPot, gf.length);
  gf.forEach((pl, i) => { res.won[pl] += prizes[i]; res.games[pl]++; });

  const won = Array.from(res.won), staked = Array.from(res.staked);
  const ratio = won.map((w, i) => w / staked[i]);
  const count = (f: (x: number) => boolean) => ratio.filter(f).length;
  const winners = won.filter(w => w > 0).sort((a, b) => a - b);
  const buyers: number[] = []; for (let i = 0; i < N; i++) if (staked[i] > c.entryFee) buyers.push(i);
  const scWon = (i: number) => res.wonL[i] + (gf.includes(i) ? prizes[gf.indexOf(i)] : 0);   // only ever called for buyers
  let maxGames = 0, sumGames = 0, maxLosses = 0;
  for (let i = 0; i < N; i++) { maxGames = Math.max(maxGames, res.games[i]); sumGames += res.games[i]; maxLosses = Math.max(maxLosses, res.losses[i]); }
  const paidOut = won.reduce((a, b) => a + b, 0);
  return {
    config: c, N, takeUp, ...p, baseW, baseL, wPay: res.wPay, lPay: res.lPay, gfPot, prizes,
    slots: res.slots, rounds: res.slots.length + 1, tables: res.tables + 1, wRounds: res.wRounds, lRounds: res.lRounds,
    maxLGames: res.maxLGames, offered: res.offered, bought: res.bought,
    scAny: buyers.filter(i => scWon(i) > 0).length, scStakeBack: buyers.filter(i => scWon(i) >= c.scFee).length,
    winners: winners.length, breakEven: count(x => x >= 1), medianWin: winners.length ? winners[Math.floor(winners.length / 2)] : 0,
    champion: Math.max(...won), maxGames, avgGames: sumGames / N, maxLosses,
    buckets: [
      { label: "Nothing", n: count(x => x === 0) },
      { label: "Something, under their stake", n: count(x => x > 0 && x < 1) },
      { label: "1-2x their stake", n: count(x => x >= 1 && x < 2) },
      { label: "2-10x", n: count(x => x >= 2 && x < 10) },
      { label: "10x or more", n: count(x => x >= 10) },
    ],
    won, staked,
    balanced: gfPot >= 0 && paidOut + p.platform === p.entries,
  };
}

/* ---------- publish checks (PRD 5.2): run on the model at the sizes the admin expects ---------- */

/** Problems that block publishing, in plain words. Empty when this simulated cup is fit to publish. */
export function publishProblems(m: SimResult): string[] {
  const out: string[] = [];
  if (!m.balanced) out.push("The money does not balance: stakes, payouts and the platform cut differ.");
  for (const [i, s] of m.slots.entries()) for (const x of [s.W, s.L]) {
    if (!x || x.advance === 0) continue;
    const where = `${x.draw === "W" ? "Main draw" : "Second Chance"} round ${i + 1}`;
    if (x.pay1 < m.config.roundTo || x.pay2 < m.config.roundTo)
      out.push(`${where} pays ${x.pay1} / ${x.pay2}: 1st and 2nd must each get at least ${m.config.roundTo}. Raise the stake or lower the rounding.`);
  }
  // Losing on purpose must never pay: in the same round, winning a main-draw table must beat buying back in
  // and winning a Second Chance table.
  const both = m.slots.find(s => s.W && s.L && s.W.mode !== "final");
  if (both && both.L!.pay1 - m.config.scFee >= both.W!.pay1)
    out.push(`Second Chance pays ${both.L!.pay1} to a table winner, which after its ${m.config.scFee} stake still beats the main draw's ${both.W!.pay1}: losing on purpose could pay. Raise the Second Chance stake.`);
  return out;
}
