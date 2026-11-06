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
export interface FieldSpec {
  key: keyof CupConfig;
  /** Which part of the cup page the setting sits in (SECTIONS), and its heading there. */
  section: string; group: string;
  label: string;
  /** The field's i tag: what the setting does, in the words of what the code really does. */
  info: string;
  /** Shown beside the input, e.g. "seconds". "currency" means the cup's own currency. */
  unit?: string;
  /** Friendly names for a choice's values. The stored values never change. */
  labels?: Record<string, string>;
  /** A number with only a few sensible values, shown as a dropdown. */
  pick?: [number, string][];
  /** Stored as 0 to 1, shown as a percentage. */
  asPct?: boolean;
  /** Only relevant while another setting has this value. */
  showIf?: { key: keyof CupConfig; is: unknown };
  /** Has no effect today, so the form lists it under "Not in use" rather than offering it. */
  inactive?: boolean;
  type: Num | Choice | { kind: "bool" } | { kind: "text"; max: number; pattern?: string } | { kind: "time" } | { kind: "countries" } | { kind: "split" };
}

/** The parts of a cup's settings page, in the order an admin decides them. */
export const SECTIONS = [
  { id: "basics", title: "Basics", blurb: "What players see first, and the cup's link." },
  { id: "dates", title: "Dates", blurb: "The cup's timeline, in order. Settings freeze the moment registration opens." },
  { id: "entry", title: "Entry and seats", blurb: "What it costs, how many can play, and who can enter." },
  { id: "format", title: "Format and clocks", blurb: "Who moves on from each table, and how long everything takes." },
  { id: "prizes", title: "Prize money", blurb: "How the stakes are shared out across the tables and the Grand Final." },
  { id: "second", title: "Second Chance", blurb: "The buy-back after a first loss. It has its own pot and pays its own tables." },
  { id: "table", title: "Table and fair play", blurb: "What players can do at a table, who can watch, and who never sits together." },
] as const;

export const FIELDS: FieldSpec[] = [
  { key: "name", section: "basics", group: "Name and link", label: "Name", info: "The cup's name everywhere players meet it: the cup page, the home page banner, notifications and share cards.", type: { kind: "text", max: 60 } },
  { key: "slug", section: "basics", group: "Name and link", label: "Web address", info: "The last part of the cup's link, /cup/?c=<this>. Use 3 to 48 lowercase letters, digits and dashes. No two cups can share one.", type: { kind: "text", max: 48, pattern: "^[a-z0-9][a-z0-9-]{2,47}$" } },
  { key: "description", section: "basics", group: "Name and link", label: "Description", info: "Saved with the cup, but the cup page doesn't show it yet. Players won't see this text for now.", type: { kind: "text", max: 280 } },
  { key: "sponsor", section: "basics", group: "Sponsor", label: "Sponsor name", info: "Shown on the cup page. Leave it empty for no sponsor. To add sponsor money to the prizes, use Sponsor top-up under Prize money.", type: { kind: "text", max: 60 } },

  { key: "registrationOpensAt", section: "dates", group: "Registration", label: "Registration opens", info: "Players can start entering from this moment. Every setting on this page freezes at the same moment and can't be changed afterwards.", type: { kind: "time" } },
  { key: "registrationClosesAt", section: "dates", group: "Registration", label: "Registration closes", info: "The last moment to enter. With a random draw, seats are drawn now. If entries are below the minimum, the cup is cancelled and everyone is refunded.", type: { kind: "time" } },
  { key: "checkInOpensAt", section: "dates", group: "Check-in", label: "Check-in opens", info: "Players with a seat or a waitlist place can tap \"I'm here\" from this moment. They're notified when it opens.", type: { kind: "time" } },
  { key: "checkInCloseBeforeStartSec", section: "dates", group: "Check-in", label: "Check-in closes before round 1", unit: "seconds", info: "How long before round 1 check-in ends. At that point no-shows lose their seat, waitlisted players take the free seats, and the pay for every round is fixed.", type: { kind: "int", min: 60, max: 900 } },
  { key: "startsAt", section: "dates", group: "Play", label: "Round 1 starts", info: "When the first tables are seated.", type: { kind: "time" } },
  { key: "mustEndBy", section: "dates", group: "Play", label: "Must end by", info: "The latest you want the cup to finish. Publishing is refused if a full field would need longer. It doesn't stop a cup that's running late, and it's also the end time in the calendar invite.", type: { kind: "time" } },

  { key: "currency", section: "entry", group: "Stake", label: "Currency", labels: { COIN: "Coins", NGN: "Naira" }, info: "What players stake and win. Coins have no cash value. Naira can't be published until the cash phase is on and finance has countersigned the cup.", type: { kind: "choice", options: ["COIN", "NGN"] } },
  { key: "entryFee", section: "entry", group: "Stake", label: "Entry fee", unit: "currency", info: "What each player pays to enter. It's taken when they enter and refunded if they don't get a seat. It also sets the size of the main pot.", type: { kind: "int", min: 100, max: 100_000, step: 100 } },
  { key: "capacity", section: "entry", group: "Seats", label: "Seats", unit: "players", info: "The most players who can play. Publishing also checks that a cup this full finishes before Must end by.", type: { kind: "int", min: 16, max: MAX_FIELD } },
  { key: "minEntries", section: "entry", group: "Seats", label: "Minimum entries", unit: "players", info: "The fewest players the cup will run with. Below this when registration closes, or when check-in closes, the cup is cancelled and everyone is refunded.", type: { kind: "int", min: 8, max: MAX_FIELD } },
  { key: "expectedEntries", section: "entry", group: "Seats", label: "Expected entries", unit: "players", info: "Your best guess, used only for the preview and the publish checks. It doesn't change the real cup or what it pays.", type: { kind: "int", min: 8, max: MAX_FIELD } },
  { key: "oversubscription", section: "entry", group: "Too many or too few", label: "More entries than seats", labels: { "random-draw": "Random draw at close", "first-come": "First come, first served" }, info: "Random draw takes up to 5 times the seats, then draws who plays when registration closes, from a published seed. First come fills the seats in order, then the waitlist, then refuses entries.", type: { kind: "choice", options: ["random-draw", "first-come"] } },
  { key: "waitlist", section: "entry", group: "Too many or too few", label: "Waitlist for free seats", info: "On: players without a seat can wait, check in, and take a no-show's seat in line order. Those left over are refunded. Off: a random draw refunds them at close, first come refuses them once the seats are full, and no-show seats stay empty.", type: { kind: "bool" } },
  { key: "noShowRefund", section: "entry", group: "Too many or too few", label: "If a player misses check-in", labels: { full: "Refund their entry", none: "Keep their entry" }, info: "What happens to the entry fee of a seated player who doesn't check in. Either way, they lose their seat.", type: { kind: "choice", options: ["full", "none"] } },
  { key: "phoneCountries", section: "entry", group: "Who can enter", label: "Countries", info: "Only players whose phone number is from a ticked country can enter. Tick none to allow every country that can sign in.", type: { kind: "countries" } },
  { key: "minAccountAgeHours", section: "entry", group: "Who can enter", label: "Minimum account age", unit: "hours", info: "New accounts must be at least this old to enter. It makes throwaway accounts less useful. 0 lets anyone enter.", type: { kind: "int", min: 0, max: 720 } },

  { key: "advancePerTable", section: "format", group: "Who moves on", label: "Advance from a table of 4", pick: [[2, "Top 2"], [1, "Winner only"]], info: "How many move on from a full table. Winner only shortens the cup a lot, and 2nd is still paid. It applies to Second Chance tables too.", type: { kind: "int", min: 1, max: 2 } },
  { key: "tableOfThreeAdvance", section: "format", group: "Who moves on", label: "Advance from a table of 3", pick: [[1, "Winner only"], [2, "Top 2"]], info: "Fields that don't divide by 4 get up to three tables of 3. Winner only stops those players having an easier route. 2nd is still paid.", type: { kind: "int", min: 1, max: 2 } },
  { key: "top1Threshold", section: "format", group: "Who moves on", label: "Winner only while more than this are left", unit: "players", info: "While the draw has more players than this, only table winners advance, so big fields finish on time. 0 means winner only all the way.", type: { kind: "int", min: 0, max: 1_000_000 } },
  { key: "tableClockSec", section: "format", group: "Clocks", label: "Table clock", unit: "seconds", info: "The longest one table can last. When it runs out, players rank by fewest card points, then fewest cards, then seat order. Longer clocks make the whole cup longer.", type: { kind: "int", min: 300, max: 1200 } },
  { key: "turnClockSec", section: "format", group: "Clocks", label: "Turn clock", unit: "seconds", info: "How long a player has for each move. When it runs out, the computer makes one fair move for them.", type: { kind: "int", min: 15, max: 60 } },
  { key: "breakSec", section: "format", group: "Clocks", label: "Break between rounds", unit: "seconds", info: "The gap between rounds. It counts towards how long the cup runs. Longer breaks give players more time to decide on a Second Chance.", type: { kind: "int", min: 60, max: 600 } },
  { key: "disconnectGraceSec", section: "format", group: "Clocks", label: "Disconnect grace", unit: "seconds", info: "How long a player can be away before they forfeit the table and rank last. The computer plays their turns meanwhile, after holding each one for 10 seconds.", type: { kind: "int", min: 15, max: 120 } },

  { key: "platformCut", section: "prizes", group: "Money in", label: "Platform cut", unit: "%", info: "What the platform keeps from every entry fee and Second Chance stake. The rest becomes prize money.", type: { kind: "pct", min: 0, max: 30 } },
  { key: "guaranteedPool", section: "prizes", group: "Money in", label: "Sponsor top-up", unit: "currency", info: "Extra money added to the main pot, with no platform cut taken from it. It raises main-draw pay and the Grand Final. 0 means none.", type: { kind: "int", min: 0, max: 100_000_000, step: 1000 } },
  { key: "secondShare", section: "prizes", group: "Table pay", label: "2nd place earns", unit: "% of 1st", info: "At every table, 1st and 2nd are paid. This sets 2nd's pay as a share of 1st's. Higher means more players win something, and a smaller gap for winning.", type: { kind: "pct", min: 25, max: 90 } },
  { key: "growthPerHalving", section: "prizes", group: "Table pay", label: "Pay rises each time the field halves", unit: "%", info: "How steeply pay climbs through the rounds. Higher rewards going deep but pays less in the early rounds. The total paid doesn't change, only where it goes.", type: { kind: "num", min: 25, max: 60, step: 0.01 } },
  { key: "roundTo", section: "prizes", group: "Table pay", label: "Round payouts down to", unit: "currency", info: "Every table payout is rounded down to a multiple of this, so amounts look tidy. The leftovers go to the Grand Final, so nothing is lost.", type: { kind: "int", min: 1, max: 100 } },
  { key: "gfShare", section: "prizes", group: "Grand Final", label: "Grand Final share", unit: "% of each pot", info: "The share of each pot, after the platform cut, kept back for the Grand Final. A bigger jackpot means less pay at the tables.", type: { kind: "pct", min: 10, max: 60 } },
  { key: "gfSplit", section: "prizes", group: "Grand Final", label: "Prizes for 1st / 2nd / 3rd / 4th", unit: "%", info: "How the Grand Final pot is shared. The four must add up to 100, and a lower place can't earn more than a higher one.", type: { kind: "split" } },
  { key: "gfEdge", section: "prizes", group: "Grand Final", label: "Edge for main-draw finalists", labels: { none: "None", "lead-first": "They play first", "seat-choice": "They pick seats (not built yet)" }, info: "A small reward for reaching the final without a loss. They play first seats the main-draw finalists so that one of them leads. They pick seats isn't built yet, so it currently gives no edge.", type: { kind: "choice", options: ["none", "lead-first", "seat-choice"] } },

  { key: "scEnabled", section: "second", group: "Offer", label: "Offer Second Chance", info: "On: a player who loses in the early main-draw rounds can pay to play on in a second draw. Off: the first loss ends their cup, and there's no second pot.", type: { kind: "bool" } },
  { key: "scFee", section: "second", group: "Offer", label: "Stake", unit: "currency", showIf: { key: "scEnabled", is: true }, info: "What a player pays to buy back in. It can't be more than the entry fee. It goes into the Second Chance pot, after the same platform cut. If a table win pays too much for this stake, publishing is refused so that losing on purpose never pays.", type: { kind: "int", min: 0, max: 100_000, step: 50 } },
  { key: "scCutoffRound", section: "second", group: "Offer", label: "Open for losses up to round", unit: "main-draw round", showIf: { key: "scEnabled", is: true }, info: "A first loss up to this main-draw round can be bought back. After it, a first loss ends the cup. Closing early keeps the draw short.", type: { kind: "int", min: 1, max: 99 } },
  { key: "scBuyWindowSec", section: "second", group: "Offer", label: "Time to decide", unit: "seconds", showIf: { key: "scEnabled", is: true }, info: "How long a player has to buy in once their table ends. The offer also closes when the next round is seated, if that comes first.", type: { kind: "int", min: 30, max: 180 } },
  { key: "scPayFromWinnings", section: "second", group: "Offer", label: "Pay from this cup's winnings", labels: { off: "No, wallet money only", allowed: "Yes", "default-on": "Yes (default)" }, showIf: { key: "scEnabled", is: true }, info: "No means the stake must come from money they didn't win in this cup. Both Yes options work the same way today: their wallet pays, including what they've just won.", type: { kind: "choice", options: ["off", "allowed", "default-on"] } },
  { key: "scWinnerOnly", section: "second", group: "Second Chance tables", label: "Only table winners advance", showIf: { key: "scEnabled", is: true }, info: "On: only the winner moves on from a Second Chance table, which keeps this draw short. 2nd is still paid. Not advancing here is a second loss, which ends the cup.", type: { kind: "bool" } },
  { key: "scTakeUpEstimate", section: "second", group: "Second Chance tables", label: "Expected take-up", unit: "%", asPct: true, showIf: { key: "scEnabled", is: true }, info: "Your guess at how many first-time losers will buy in. It's used only for the preview. Real cups fix Second Chance pay so its tables stay within their pot at any take-up from 10% to 100%.", type: { kind: "num", min: 0, max: 1, step: 0.05 } },

  { key: "chat", section: "table", group: "At the table", label: "Chat", labels: { off: "Off", presets: "Preset phrases only" }, info: "Preset phrases are the only chat allowed at cup tables. Free text is never available, so players can't pass cards to each other in writing.", type: { kind: "choice", options: ["off", "presets"] } },
  { key: "voice", section: "table", group: "At the table", label: "Voice", labels: { off: "Off", seated: "Seated players" }, info: "Lets seated players talk during a table. Watchers can never speak. Leave it off unless you accept the collusion risk.", type: { kind: "choice", options: ["off", "seated"] } },
  { key: "spectators", section: "table", group: "Watching", label: "Spectators", labels: { off: "Off", delayed: "On, with a delay" }, info: "On: anyone with the link can watch, a few moves behind and with hands hidden, so a friend watching can't help a player. Off: no one can watch.", type: { kind: "choice", options: ["off", "delayed"] } },
  { key: "spectatorDelayMoves", section: "table", group: "Watching", label: "Spectator delay", unit: "moves", showIf: { key: "spectators", is: "delayed" }, info: "How many moves behind the live table watchers are. A bigger delay is safer but less exciting to watch.", type: { kind: "int", min: 2, max: 10 } },
  { key: "revealHands", section: "table", group: "Watching", label: "Show hands when a table ends", labels: { never: "Never", "after-table": "After the table" }, info: "Whether watchers get to see the final hands once the table has finished. Hands are never shown while it's being played.", type: { kind: "choice", options: ["never", "after-table"] } },
  { key: "separateDevices", section: "table", group: "Who never sits together", label: "Accounts on the same device", info: "On: two accounts that entered from one device are never seated at the same table, in any round.", type: { kind: "bool" } },
  { key: "separateNetworks", section: "table", group: "Who never sits together", label: "Accounts on the same network", labels: { off: "Allow it", "rounds-1-3": "Keep apart in rounds 1 to 3", always: "Keep apart in every round" }, info: "Keeps accounts on the same internet connection apart. Families and cafes share networks, so Always can be stricter than you need.", type: { kind: "choice", options: ["off", "rounds-1-3", "always"] } },
  { key: "separateInviteLinks", section: "table", group: "Who never sits together", label: "Inviter and the friend they invited", info: "On: a player and the friend who came through their invite link aren't seated together in rounds 1 to 3.", type: { kind: "bool" } },

  { key: "cheers", section: "table", group: "Not in use", label: "Cheers", inactive: true, info: "The cheers feature was dropped from the plan.", type: { kind: "bool" } },
  { key: "cheerPlayerShare", section: "table", group: "Not in use", label: "Cheer share to the player", inactive: true, info: "The cheers feature was dropped from the plan.", type: { kind: "pct", min: 0, max: 100 } },
  { key: "payoutHoldHours", section: "table", group: "Not in use", label: "Payout hold", inactive: true, info: "Not built yet. Winnings are paid as tables report, whatever this says.", type: { kind: "int", min: 0, max: 168 } },
  { key: "maxEntriesPerPlayer", section: "entry", group: "Not in use", label: "Entries per player", inactive: true, info: "Fixed at 1. Each player can enter a cup once.", type: { kind: "int", min: 1, max: 1 } },
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
      if (v < t.min || v > t.max) { const k = f.asPct ? 100 : 1; bad(`must be between ${t.min * k} and ${t.max * k}`); }
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

export { DEFAULT_GROWTH_PCT, publishProblems, simulate };
