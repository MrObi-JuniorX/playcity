/* A cup's settings (docs/whot-cup-prd.md, section 5.1) and the publish checks (5.2).

   Shared by the Worker, which is the authority on what may be published, and the console page, which bundles this
   file (npm run build:console) so its live preview runs the very same engine and checks. */

import { DEFAULT_CONFIG, DEFAULT_GROWTH_PCT, MAX_FIELD, publishProblems, simulate, validateConfig, type EngineConfig, type SimResult } from "./engine";

export type Currency = "COIN" | "NGN";

export interface CupConfig extends EngineConfig {
  // Identity
  name: string; slug: string; description: string; sponsor: string;
  // Currency
  currency: Currency;
  // Field
  capacity: number; minEntries: number; expectedEntries: number;
  oversubscription: "random-draw" | "first-come"; waitlist: boolean;
  // Schedule: Unix milliseconds
  registrationOpensAt: number; registrationClosesAt: number; checkInOpensAt: number; startsAt: number; mustEndBy: number;
  checkInCloseBeforeStartSec: number; noShowRefund: "full" | "none";
  // Rounds
  tableClockSec: number; turnClockSec: number; breakSec: number; disconnectGraceSec: number;
  // Second Chance, beyond the engine's settings
  scBuyWindowSec: number; scPayFromWinnings: "off" | "allowed" | "default-on"; scTakeUpEstimate: number;
  // Grand Final
  gfEdge: "none" | "lead-first" | "seat-choice";
  // Table
  voice: "off" | "seated"; chat: "off" | "presets"; spectators: "off" | "delayed"; spectatorDelayMoves: number;
  revealHands: "never" | "after-table"; cheers: boolean; cheerPlayerShare: number;
  // Integrity
  separateDevices: boolean; separateNetworks: "off" | "rounds-1-3" | "always"; separateInviteLinks: boolean; payoutHoldHours: number;
  // Eligibility
  phoneCountries: string[]; minAccountAgeHours: number; maxEntriesPerPlayer: number;
}

const HOUR = 3600_000, DAY = 24 * HOUR;

/** The default start: Saturday 16:00 Lagos time (15:00 UTC), at least 6 days away so that registration, which
    opens 4 days before, is still at least 2 days off. */
export function nextSaturdayStart(now = Date.now()): number {
  const d = new Date(now + 6 * DAY);
  const add = (6 - d.getUTCDay() + 7) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + add, 15, 0, 0);
}

export function defaultCupConfig(now = Date.now()): CupConfig {
  const startsAt = nextSaturdayStart(now);
  return {
    ...DEFAULT_CONFIG,
    name: "Saturday Whot Cup", slug: "", description: "", sponsor: "",
    currency: "COIN",
    capacity: 1024, minEntries: 16, expectedEntries: 1024, oversubscription: "random-draw", waitlist: true,
    registrationOpensAt: startsAt - 4 * DAY, registrationClosesAt: startsAt - HOUR, checkInOpensAt: startsAt - 15 * 60_000, startsAt,
    mustEndBy: startsAt + 6 * HOUR,
    checkInCloseBeforeStartSec: 300, noShowRefund: "full",
    tableClockSec: 600, turnClockSec: 30, breakSec: 240, disconnectGraceSec: 60,
    scBuyWindowSec: 60, scPayFromWinnings: "default-on", scTakeUpEstimate: 0.6,
    gfEdge: "none",
    voice: "off", chat: "presets", spectators: "delayed", spectatorDelayMoves: 3, revealHands: "after-table", cheers: true, cheerPlayerShare: 50,
    separateDevices: true, separateNetworks: "rounds-1-3", separateInviteLinks: true, payoutHoldHours: 0,
    phoneCountries: [], minAccountAgeHours: 0, maxEntriesPerPlayer: 1,
  };
}

/* ---------- describing every setting: the console draws its form from this, the server validates with it ---------- */

type Num = { kind: "int" | "pct" | "num"; min: number; max: number; step?: number };
type Choice = { kind: "choice"; options: readonly string[] };
export interface FieldSpec { key: keyof CupConfig; group: string; label: string; help?: string; type: Num | Choice | { kind: "bool" } | { kind: "text"; max: number; pattern?: string } | { kind: "time" } | { kind: "countries" } | { kind: "split" } }

export const FIELDS: FieldSpec[] = [
  { key: "name", group: "Identity", label: "Name", type: { kind: "text", max: 60 } },
  { key: "slug", group: "Identity", label: "Web address", help: "playcity.ng/cup/<this>. Lowercase letters, digits and dashes.", type: { kind: "text", max: 48, pattern: "^[a-z0-9][a-z0-9-]{2,47}$" } },
  { key: "description", group: "Identity", label: "Description", type: { kind: "text", max: 280 } },
  { key: "sponsor", group: "Identity", label: "Sponsor", help: "Shown on the cup page. Leave empty for none.", type: { kind: "text", max: 60 } },

  { key: "currency", group: "Money", label: "Currency", help: "Naira needs the cash phase and a finance countersign.", type: { kind: "choice", options: ["COIN", "NGN"] } },
  { key: "entryFee", group: "Money", label: "Entry fee", type: { kind: "int", min: 100, max: 100_000, step: 100 } },
  { key: "platformCut", group: "Money", label: "Platform cut %", type: { kind: "pct", min: 0, max: 30 } },
  { key: "guaranteedPool", group: "Money", label: "Sponsor top-up", help: "Added to the main pot, no cut.", type: { kind: "int", min: 0, max: 100_000_000, step: 1000 } },

  { key: "capacity", group: "Field", label: "Seats", type: { kind: "int", min: 16, max: MAX_FIELD } },
  { key: "minEntries", group: "Field", label: "Minimum entries", help: "Fewer at close: the cup is cancelled and refunded.", type: { kind: "int", min: 8, max: MAX_FIELD } },
  { key: "expectedEntries", group: "Field", label: "Expected entries", help: "Only for the preview and checks.", type: { kind: "int", min: 8, max: MAX_FIELD } },
  { key: "oversubscription", group: "Field", label: "More entries than seats", type: { kind: "choice", options: ["random-draw", "first-come"] } },
  { key: "waitlist", group: "Field", label: "Waitlist for no-shows", type: { kind: "bool" } },

  { key: "registrationOpensAt", group: "Schedule", label: "Registration opens", help: "Settings freeze at this moment.", type: { kind: "time" } },
  { key: "registrationClosesAt", group: "Schedule", label: "Registration closes", type: { kind: "time" } },
  { key: "checkInOpensAt", group: "Schedule", label: "Check-in opens", type: { kind: "time" } },
  { key: "startsAt", group: "Schedule", label: "Round 1 starts", type: { kind: "time" } },
  { key: "mustEndBy", group: "Schedule", label: "Must end by", type: { kind: "time" } },
  { key: "checkInCloseBeforeStartSec", group: "Schedule", label: "Check-in closes (seconds before start)", type: { kind: "int", min: 60, max: 900 } },
  { key: "noShowRefund", group: "Schedule", label: "No-show refund", type: { kind: "choice", options: ["full", "none"] } },

  { key: "tableClockSec", group: "Rounds", label: "Table clock (s)", type: { kind: "int", min: 300, max: 1200 } },
  { key: "turnClockSec", group: "Rounds", label: "Turn clock (s)", type: { kind: "int", min: 15, max: 60 } },
  { key: "breakSec", group: "Rounds", label: "Break between rounds (s)", type: { kind: "int", min: 60, max: 600 } },
  { key: "disconnectGraceSec", group: "Rounds", label: "Disconnect grace (s)", type: { kind: "int", min: 15, max: 120 } },

  { key: "advancePerTable", group: "Advancing", label: "Advance from a table of 4", type: { kind: "int", min: 1, max: 2 } },
  { key: "tableOfThreeAdvance", group: "Advancing", label: "Advance from a table of 3", type: { kind: "int", min: 1, max: 2 } },
  { key: "top1Threshold", group: "Advancing", label: "Winner only while more than this many are left", help: "0 = always winner only.", type: { kind: "int", min: 0, max: 1_000_000 } },

  { key: "secondShare", group: "Pay", label: "2nd earns, % of 1st", type: { kind: "pct", min: 25, max: 90 } },
  { key: "growthPerHalving", group: "Pay", label: "Pay rises each time the field halves, %", type: { kind: "num", min: 25, max: 60, step: 0.01 } },
  { key: "roundTo", group: "Pay", label: "Round payouts down to", type: { kind: "int", min: 1, max: 100 } },

  { key: "scEnabled", group: "Second Chance", label: "Second Chance on", type: { kind: "bool" } },
  { key: "scFee", group: "Second Chance", label: "Stake", type: { kind: "int", min: 0, max: 100_000, step: 50 } },
  { key: "scCutoffRound", group: "Second Chance", label: "Open for losses up to round", type: { kind: "int", min: 1, max: 99 } },
  { key: "scBuyWindowSec", group: "Second Chance", label: "Time to decide (s)", type: { kind: "int", min: 30, max: 180 } },
  { key: "scPayFromWinnings", group: "Second Chance", label: "Pay from winnings", type: { kind: "choice", options: ["off", "allowed", "default-on"] } },
  { key: "scWinnerOnly", group: "Second Chance", label: "Only table winners advance", type: { kind: "bool" } },
  { key: "scTakeUpEstimate", group: "Second Chance", label: "Expected take-up (preview only)", type: { kind: "num", min: 0, max: 1, step: 0.05 } },

  { key: "gfShare", group: "Grand Final", label: "Share of each pot, %", type: { kind: "pct", min: 10, max: 60 } },
  { key: "gfSplit", group: "Grand Final", label: "Split 1st / 2nd / 3rd / 4th, %", type: { kind: "split" } },
  { key: "gfEdge", group: "Grand Final", label: "Edge for main-draw finalists", type: { kind: "choice", options: ["none", "lead-first", "seat-choice"] } },

  { key: "voice", group: "Table", label: "Voice", type: { kind: "choice", options: ["off", "seated"] } },
  { key: "chat", group: "Table", label: "Chat", type: { kind: "choice", options: ["off", "presets"] } },
  { key: "spectators", group: "Table", label: "Spectators", type: { kind: "choice", options: ["off", "delayed"] } },
  { key: "spectatorDelayMoves", group: "Table", label: "Spectator delay (moves)", type: { kind: "int", min: 2, max: 10 } },
  { key: "revealHands", group: "Table", label: "Reveal hands", type: { kind: "choice", options: ["never", "after-table"] } },
  { key: "cheers", group: "Table", label: "Cheers", type: { kind: "bool" } },
  { key: "cheerPlayerShare", group: "Table", label: "Cheer share to the player, %", type: { kind: "pct", min: 0, max: 100 } },

  { key: "separateDevices", group: "Integrity", label: "Never seat shared devices together", type: { kind: "bool" } },
  { key: "separateNetworks", group: "Integrity", label: "Keep shared networks apart", type: { kind: "choice", options: ["off", "rounds-1-3", "always"] } },
  { key: "separateInviteLinks", group: "Integrity", label: "Keep inviter and invitee apart early", type: { kind: "bool" } },
  { key: "payoutHoldHours", group: "Integrity", label: "Payout hold (hours)", type: { kind: "int", min: 0, max: 168 } },

  { key: "phoneCountries", group: "Eligibility", label: "Countries", help: "Empty = every country that can sign in.", type: { kind: "countries" } },
  { key: "minAccountAgeHours", group: "Eligibility", label: "Minimum account age (hours)", type: { kind: "int", min: 0, max: 720 } },
  { key: "maxEntriesPerPlayer", group: "Eligibility", label: "Entries per player", help: "Always 1.", type: { kind: "int", min: 1, max: 1 } },
];

/* ---------- validation ---------- */

/** Rebuild a config from untrusted JSON: known keys only, defaults for anything missing, nothing else carried. */
export function coerceConfig(raw: unknown, base: CupConfig = defaultCupConfig()): CupConfig {
  const src = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const out = { ...base } as Record<string, unknown>;
  for (const f of FIELDS) if (f.key in src) out[f.key] = src[f.key];
  for (const k of ["platformCut", "guaranteedPool"] as const) if (k in src) out[k] = src[k];
  return out as unknown as CupConfig;
}

/** Problems with a config's values and schedule, in plain words. Empty when it can be saved. */
export function validateCupConfig(c: CupConfig): string[] {
  const out: string[] = [];
  for (const f of FIELDS) {
    const v = c[f.key] as unknown, t = f.type;
    const bad = (why: string) => out.push(`${f.label}: ${why}`);
    if (t.kind === "int" || t.kind === "pct" || t.kind === "num") {
      if (typeof v !== "number" || !Number.isFinite(v)) { bad("must be a number"); continue; }
      if ((t.kind === "int" || t.kind === "pct") && !Number.isInteger(v)) bad("must be a whole number");
      if (v < t.min || v > t.max) bad(`must be between ${t.min} and ${t.max}`);
    } else if (t.kind === "choice") { if (!t.options.includes(v as string)) bad(`must be one of ${t.options.join(", ")}`); }
    else if (t.kind === "bool") { if (typeof v !== "boolean") bad("must be on or off"); }
    else if (t.kind === "text") {
      if (typeof v !== "string" || v.length > t.max || /[\u0000-\u001f<>]/.test(v)) bad(`must be text up to ${t.max} characters, no < or >`);
      else if (t.pattern && !new RegExp(t.pattern).test(v)) bad("isn't in the right form");
      else if (f.key === "name" && v.trim().length < 3) bad("needs at least 3 characters");
    } else if (t.kind === "time") { if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) bad("must be a date and time"); }
    else if (t.kind === "countries") { if (!Array.isArray(v) || v.some(x => typeof x !== "string" || !/^[A-Z]{2}$/.test(x))) bad("must be a list of country codes"); }
  }
  out.push(...validateConfig(c));
  if (c.minEntries > c.capacity) out.push("Minimum entries can't be more than the seats");
  if (c.expectedEntries < c.minEntries || c.expectedEntries > c.capacity) out.push("Expected entries must be between the minimum and the seats");
  const t = [c.registrationOpensAt, c.registrationClosesAt, c.checkInOpensAt, c.startsAt - c.checkInCloseBeforeStartSec * 1000, c.mustEndBy];
  if (!(t[0] < t[1] && t[1] <= t[2] && t[2] < t[3] && c.startsAt < t[4])) out.push("Schedule must run in order: registration opens, closes, check-in opens, check-in closes, round 1, must end by");
  return [...new Set(out)];
}

/* ---------- the preview and the publish checks ---------- */

export interface Preview { size: "minimum" | "expected" | "seats"; N: number; sim: SimResult; problems: string[]; minutes: number }

/** Run the engine at the three sizes the admin must plan for, with Second Chance pay frozen the way a real cup freezes it. */
export function previewCup(c: CupConfig): Preview[] {
  const sizes: [Preview["size"], number][] = [["minimum", c.minEntries], ["expected", c.expectedEntries], ["seats", c.capacity]];
  return sizes.map(([size, N]) => {
    const sim = simulate(c, { N, takeUp: c.scTakeUpEstimate, scBase: "frozen" });
    return { size, N, sim, problems: publishProblems(sim), minutes: Math.ceil(sim.rounds * (c.tableClockSec + c.breakSec) / 60) };
  });
}

export interface PublishContext { now: number; cashEnabled: boolean; countersigned: boolean }

/** Everything that blocks publishing (PRD 5.2). Empty means publish. */
export function publishChecks(c: CupConfig, ctx: PublishContext, previews = previewCup(c)): string[] {
  const out = [...validateCupConfig(c)];
  if (out.length) return out;
  for (const p of previews) for (const x of p.problems) out.push(`At ${p.N.toLocaleString("en-NG")} players (${p.size}): ${x}`);
  const longest = previews.reduce((a, p) => Math.max(a, p.minutes), 0);
  if (c.startsAt + longest * 60_000 > c.mustEndBy)
    out.push(`At ${c.capacity.toLocaleString("en-NG")} players the cup needs about ${Math.round(longest / 6) / 10} hours and would run past "must end by". Move it later, shorten the clocks, or lower the seats.`);
  if (c.registrationOpensAt <= ctx.now) out.push("Registration must open in the future.");
  if (c.currency === "NGN" && !ctx.cashEnabled) out.push("Naira cups are off until the cash phase is switched on.");
  if (c.currency === "NGN" && !ctx.countersigned) out.push("A naira cup needs a finance countersign before it can be published.");
  return out;
}

/** True once the settings can no longer change (PRD 5: they freeze when registration opens). */
export function isFrozen(state: string, c: CupConfig, now: number): boolean {
  return !(state === "draft" || state === "scheduled") || now >= c.registrationOpensAt;
}

/** A stable fingerprint of a config: SHA-256 of its JSON with sorted keys. */
export async function configHash(c: CupConfig): Promise<string> {
  const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v as object).sort().map(k => [k, canon((v as Record<string, unknown>)[k])])) : v;
  const bytes = new TextEncoder().encode(JSON.stringify(canon(c)));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
}

export { DEFAULT_GROWTH_PCT };
