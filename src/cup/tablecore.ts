import * as W from "../../public/whot/engine.js";
import type { Game } from "../../public/whot/engine.js";

/* A cup table, as pure state and functions (docs/whot-cup-prd.md 6.5, Phase 6). No sockets, no storage, no clock of
   its own: the CupTable Durable Object (src/cup/table.ts) feeds it connections, moves and the time, then saves the
   state as one row and sends what this returns. Keeping the rules here means the tests can play thousands of cup
   games in plain Node and look at every message each seat, the watchers and the director would have received.

   The rules engine (public/whot/engine.js) is unchanged. What a cup table adds around it:
     waiting   the table is seated by the director; the cards are dealt when every player is here, or JOIN_MS after
               seating, whichever comes first (TB-1: the server deals, nothing is ever handed in by a browser).
     playing   a person's turn runs on the turn clock; when it runs out the computer makes one fair move for them
               (aiMoveFair: it sees only that seat's view). A player who drops is held for HOLD_MS on their own turn
               (a reload costs nothing), then the computer plays their cards; after disconnectGraceSec away they
               forfeit and rank last (TB-3, TB-4). The turn's deadline belongs to the turn, so dropping and coming
               back never buys a fresh clock. With nobody left at the table to play against, the table waits: the
               computer never plays a whole game out by itself while people are reconnecting.
     done      someone checked up, the market ran dry (stalemate), the table clock ran out, or forfeits left one
               player or none. Places: those who didn't forfeit first; the check-up (or stalemate) winner first;
               then fewest card points, then fewest cards, then seat order (section 4, rule 8). The table reports
               once to the director, keeps its row through the reveal window, and is deleted (TB-5).

   Hidden cards (8.2): seats get seatView(seat); watchers get a public view built when each move happened and sent
   spectatorDelayMoves moves later (TB-7), with hands only at the end and only when revealHands is after-table. The
   result for the director carries ids, points and counts, never a card. */

export interface TableRules {
  turnClockSec: number; tableClockSec: number; disconnectGraceSec: number;
  voice: "off" | "seated"; chat: "off" | "presets"; spectators: "off" | "delayed"; spectatorDelayMoves: number; revealHands: "never" | "after-table";
}
/** What the director tells a table about itself. It never contains a seed: the deck is shuffled here (T3). */
export interface TableSpec {
  cupId: string; code: string; slot: number; draw: "W" | "L" | "GF"; final: boolean;
  players: string[]; names: string[]; pay1: number; pay2: number;
  seatedAt: number; deadline: number; rules: TableRules;
}
interface SeatState { conn: boolean; joined: boolean; away: number; forfeit: number; timeouts: number }
export type How = "checkup" | "stalemate" | "clock" | "forfeit" | "walkover";
export interface TableState {
  spec: TableSpec; names: string[];
  phase: "waiting" | "playing" | "done";
  g: Game | null; seats: SeatState[];
  dealAt: number; dealtAt: number; endAt: number;
  dl: number; dlTurn: number;          // the current turn's deadline, and the turn it belongs to
  steps: number;                       // moves made so far
  pub: { n: number; m: string }[];     // watchers' views, built as each move happened; sent spectatorDelayMoves later
  pubFront: number;                    // the latest view watchers have been sent
  pubFinal: string | null; pubFinalSent: boolean;
  places: number[] | null; how: How | null; endedAt: number;
  report: { state: "none" | "pending" | "sent" | "failed"; tries: number; next: number; error?: string };
  closeAt: number;                     // end of the reveal window: then the row is deleted
}
/** One move, as each seat may see it: views[i] is the body of seat i's message (a JSON object without its braces). */
export interface Step { kind: string; actor: number | null; cpu: boolean; n: number; views: string[] }

export const JOIN_MS = 60_000;         // the deal waits at most this long after seating for everyone to arrive
export const HOLD_MS = 10_000;         // a dropped player's own turn waits this long for them
export const REVEAL_MS = 90_000;       // the finished table stays up this long, so everyone sees the hands and places
export const END_MARGIN_MS = 15_000;   // the table clock always ends this long before the director's backstop
const ANIM_MS = 1_500, PACE_MS = 1_200, ANIM_MAX_MS = 8_000;   // browsers animate the moves before yours: a little extra time, capped
const PUB_LOG = 12;                    // log lines in a watcher's view
export const PRESETS = ["Good luck!", "Nice one!", "Well played", "Unlucky", "Oops", "Thinking…", "Good game", "Thanks"];

const DONE_FRONT = Number.MAX_SAFE_INTEGER;
const label = (d: string) => d === "W" ? "Main draw table" : d === "L" ? "Second Chance table" : "The Grand Final";

/* ---------- audit hook (tests only): every captured move, with the live game it came from ---------- */
type Audit = (step: Step, pub: string | null, g: Game, t: TableState) => void;
let audit: Audit | null = null;
export function setAudit(fn: Audit | null) { audit = fn; }

/* ---------- setting up ---------- */

export function newTable(spec: TableSpec): TableState {
  const names: string[] = [];
  for (const raw of spec.names) {
    const base = cleanName(raw);
    let name = base;
    for (let k = 2; names.includes(name); k++) name = `${base} ${k}`;   // "Tunde", "Tunde 2" (ID-3)
    names.push(name);
  }
  return {
    spec, names, phase: "waiting", g: null,
    seats: spec.players.map(() => ({ conn: false, joined: false, away: 0, forfeit: 0, timeouts: 0 })),
    dealAt: spec.seatedAt + JOIN_MS, dealtAt: 0, endAt: 0, dl: 0, dlTurn: -1, steps: 0,
    pub: [], pubFront: -1, pubFinal: null, pubFinalSent: false,
    places: null, how: null, endedAt: 0, report: { state: "none", tries: 0, next: 0 }, closeAt: 0,
  };
}
export const cleanName = (v: unknown) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 14) : "") || "Player";

/* ---------- who is here ---------- */

/** A person is playing this seat: connected and not forfeited. */
export const person = (t: TableState, i: number) => t.seats[i].conn && !t.seats[i].forfeit;
/** Dropped a moment ago: their turn waits for them. */
export const held = (t: TableState, i: number, now: number) => { const s = t.seats[i]; return !s.conn && !s.forfeit && s.joined && now < s.away + HOLD_MS; };
const forfeitAt = (t: TableState, i: number) => Math.max(t.seats[i].away, t.dealtAt) + t.spec.rules.disconnectGraceSec * 1000;

export function setConn(t: TableState, i: number, on: boolean, now: number) {
  const s = t.seats[i];
  if (on === s.conn) return;
  s.conn = on;
  if (on) {
    s.joined = true; s.away = 0;
    if (t.g && t.phase === "playing") W.say(t.g, s.forfeit ? `${t.names[i]} is back, but forfeited this table.` : `${t.names[i]} is back.`, "ok");
  } else {
    s.away = now;
    if (t.g && t.phase === "playing" && !s.forfeit) W.say(t.g, `${t.names[i]} lost connection. The computer holds their seat for ${t.spec.rules.disconnectGraceSec}s.`, "warn");
  }
}

/* ---------- the clock: everything due by `now` ---------- */

/** Do whatever is due: the deal, forfeits, the table clock, a timed-out turn, the computer's moves. Returns the moves. */
export function settle(t: TableState, now: number): Step[] {
  const steps: Step[] = [];
  if (t.phase === "waiting") {
    if (!t.seats.every(s => s.conn) && now < t.dealAt) return steps;
    deal(t, now, steps);
  }
  if (t.phase !== "playing") return steps;
  const g = t.g!, rules = t.spec.rules;
  t.seats.forEach((s, i) => {
    if (!s.conn && !s.forfeit && now >= forfeitAt(t, i)) {
      s.forfeit = now;
      W.say(g, `${t.names[i]} was away too long and forfeits this table. The computer plays their cards.`, "warn");
    }
  });
  types(t);
  if (t.seats.filter(s => !s.forfeit).length <= 1) return end(t, "forfeit", now, steps), steps;
  if (now >= t.endAt) return end(t, "clock", now, steps), steps;
  // The turn clock ran out on a person (or a held seat): the computer makes one fair move for them.
  if (!g.over && t.dl && now >= t.dl - 250 && g.turns === t.dlTurn && (person(t, g.current) || held(t, g.current, now))) {
    const i = g.current;
    t.seats[i].timeouts++;
    W.say(g, `${t.names[i]} ran out of time, so the computer moved for them.`, "warn");
    g.events = [];
    W.applyMove(g, W.aiMoveFair(g));
    steps.push(capture(t, "auto", i, false));
  }
  drive(t, now, steps);
  if (g.over) end(t, g.stalemate ? "stalemate" : "checkup", now, steps);
  else if (g.turns !== t.dlTurn) {
    const cpu = steps.filter(s => s.cpu).length;
    t.dl = now + rules.turnClockSec * 1000 + Math.min(ANIM_MAX_MS, ANIM_MS + PACE_MS * cpu);
    t.dlTurn = g.turns;
  }
  return steps;
}

function deal(t: TableState, now: number, steps: Step[]) {
  const n = t.names.length, rules = t.spec.rules;
  t.dealtAt = now;
  t.endAt = Math.min(now + rules.tableClockSec * 1000, t.spec.deadline - END_MARGIN_MS);
  t.seats.forEach(s => { if (!s.conn && !s.away) s.away = now; });     // never arrived: their grace runs from the deal
  if (n < 2) { t.phase = "done"; t.places = [0]; t.how = "walkover"; t.endedAt = now; afterEnd(t, now); return; }
  t.phase = "playing";
  t.g = W.newGame(t.names.map((name, i) => ({ name, type: t.seats[i].conn ? "human" as const : "cpu" as const })), 0);
  W.say(t.g, `${label(t.spec.draw)}. ${Math.round(rules.tableClockSec / 60)} minutes on the table clock.`);
  steps.push(capture(t, "deal", null, false));
}

/** Seats a person is playing are "human"; the rest are the computer's for now. */
function types(t: TableState) { t.g!.players.forEach((p, i) => { p.type = person(t, i) ? "human" : "cpu"; }); }

/** The computer plays the seats nobody is playing, up to the next person (or a held seat). With nobody at the
    table to play against, it waits. */
function drive(t: TableState, now: number, steps: Step[]) {
  const g = t.g!;
  if (!t.seats.some((_, i) => person(t, i))) return;
  for (let guard = 0; !g.over && guard < 500; guard++) {
    const i = g.current;
    if (person(t, i) || held(t, i, now)) break;
    g.events = [];
    W.applyMove(g, W.aiMoveFair(g));
    steps.push(capture(t, "cpu", i, true));
  }
}

/* ---------- a person's move ---------- */

export type MoveMsg = { t: "play"; ids: number[]; shape?: string; turn: number } | { t: "market"; turn: number };

/** A seated person's move. Refused moves change nothing. */
export function move(t: TableState, seat: number, m: MoveMsg, now: number): { ok: true; steps: Step[] } | { ok: false; reason: string } {
  if (t.phase !== "playing" || !t.g) return { ok: false, reason: t.phase === "waiting" ? "not-started" : "over" };
  const g = t.g;
  if (t.seats[seat].forfeit) return { ok: false, reason: "forfeited" };
  if (g.over || g.current !== seat || !t.seats[seat].conn) return { ok: false, reason: "not-your-turn" };
  if (now >= t.endAt) return { ok: false, reason: "time" };
  if (m.turn !== g.turns) return { ok: false, reason: "stale" };
  g.events = [];
  const r = m.t === "play" ? W.play(g, m.ids, m.shape) : W.market(g);
  if (!r.ok) { g.events = []; return { ok: false, reason: r.reason || "illegal" }; }
  t.seats[seat].timeouts = 0;
  return { ok: true, steps: [capture(t, m.t, seat, false)] };
}

/* ---------- views ---------- */

function capture(t: TableState, kind: string, actor: number | null, cpu: boolean): Step {
  const g = t.g!;
  if (kind !== "deal") t.steps++;
  const n = t.steps;
  const views = g.players.map((_, i) => JSON.stringify({ v: W.seatView(g, i), ev: kind === "deal" ? [] : W.seatEvents(g.events, i, g.over) }).slice(1, -1));
  let pub: string | null = null;
  if (t.spec.rules.spectators === "delayed" && !g.over) {
    const v = W.seatView(g, null);
    v.log = (v.log as unknown[]).slice(-PUB_LOG);
    pub = JSON.stringify({ kind, actor, cpu, n, v, ev: kind === "deal" ? [] : W.seatEvents(g.events, null, false) }).slice(1, -1);
    t.pub.push({ n, m: pub });
  }
  const step = { kind, actor, cpu, n, views };
  if (audit) audit(step, pub, g, t);
  g.events = [];
  return step;
}

/** What watchers get now: delayed moves as they come due, and the final view (with or without the hands) at the end. */
export function spectatorUpdate(t: TableState): { steps: string[]; sync: string | null } {
  if (t.spec.rules.spectators !== "delayed") return { steps: [], sync: null };
  if (t.phase === "done") {
    if (t.pubFinalSent || !t.pubFinal) return { steps: [], sync: null };
    t.pubFinalSent = true; t.pub = []; t.pubFront = DONE_FRONT;
    return { steps: [], sync: t.pubFinal };
  }
  const front = t.phase === "playing" ? t.steps - t.spec.rules.spectatorDelayMoves : -1;
  const out = t.pub.filter(p => p.n > t.pubFront && p.n <= front);
  if (out.length) t.pubFront = out[out.length - 1].n;
  t.pub = t.pub.filter(p => p.n >= t.pubFront);
  return { steps: out.map(p => p.m), sync: null };
}
/** A watcher arriving now: the latest delayed view, or null while the game is too young to show any. */
export function watchView(t: TableState): string | null {
  if (t.spec.rules.spectators !== "delayed") return null;
  if (t.phase === "done") return t.pubFinal;
  return t.pub.find(p => p.n === t.pubFront)?.m ?? null;
}
/** A seat's current view (after a reconnect, or when nothing moved). */
export function seatSync(t: TableState, seat: number): string | null {
  return t.g ? JSON.stringify({ kind: "sync", n: t.steps, v: W.seatView(t.g, seat), ev: [] }).slice(1, -1) : null;
}

/** The part of every message that isn't the game: who is where, the clocks, the cup. JSON without braces. */
export function meta(t: TableState, seat: number | null, now: number, extra: { watching: number; voice: unknown }): string {
  const g = t.g, cur = g && !g.over ? g.current : -1;
  const hold = cur >= 0 && held(t, cur, now) ? { seat: cur, name: t.names[cur], left: Math.max(0, Math.min(t.seats[cur].away + HOLD_MS, t.dl || Infinity) - now) } : null;
  const o: Record<string, unknown> = {
    you: seat, seats: t.names.map((name, i) => ({ name, human: person(t, i), me: i === seat })),
    // the shape the free tables use, so one client draws both
    listed: false, lister: false, tally: null, round: 1, watching: extra.watching, out: [], grace: hold,
    asks: [], asking: null, trusted: false, mine: null, voice: extra.voice,
    cup: {
      phase: t.phase, draw: t.spec.draw, final: t.spec.final, pay1: t.spec.pay1, pay2: t.spec.pay2, slot: t.spec.slot,
      dealIn: t.phase === "waiting" ? Math.max(0, t.dealAt - now) : null,
      endsIn: t.phase === "playing" ? Math.max(0, t.endAt - now) : null,
      here: t.seats.map(s => s.conn), forfeit: t.seats.map(s => !!s.forfeit),
      places: t.places, how: t.how, watch: seat === null, delay: t.spec.rules.spectatorDelayMoves,
      chat: t.spec.rules.chat === "presets" && seat !== null ? PRESETS : [],
    },
  };
  if (seat !== null && g && !g.over && t.dl && t.dlTurn === g.turns) { o.left = Math.max(0, t.dl - now); o.dlTurn = t.dlTurn; }
  return JSON.stringify(o).slice(1, -1);
}

/* ---------- the end ---------- */

function end(t: TableState, how: How, now: number, steps: Step[]) {
  const g = t.g!;
  const forced = how === "clock" || how === "forfeit";
  const order = rank(t, forced ? null : g.winner);
  if (forced) {
    // The engine didn't end it: we do. Hands are shown to the table, as at the end of any round.
    Object.assign(g, { over: true, pending: null, checkup: null, hold: false, stalemate: false, winner: order[0], losers: [order[order.length - 1]] });
    W.say(g, how === "clock" ? `Time! ${t.names[order[0]]} has the fewest points and wins the table.` : `${t.names[order[0]]} wins the table: the others forfeited.`, "ok");
    g.events = [];
    steps.push(capture(t, "end", null, false));
  }
  t.places = order; t.how = how; t.phase = "done"; t.endedAt = now; t.dl = 0; t.dlTurn = -1;
  const v = W.seatView(g, null);                       // over: every hand is in it
  if (t.spec.rules.revealHands !== "after-table") v.players = (v.players as { name: string; type: string; count: number }[]).map(p => ({ name: p.name, type: p.type, count: p.count }));
  v.log = (v.log as unknown[]).slice(-PUB_LOG);
  t.pubFinal = JSON.stringify({ kind: "sync", n: t.steps, v, ev: [] }).slice(1, -1);
  afterEnd(t, now);
}
function afterEnd(t: TableState, now: number) {
  t.report = { state: "pending", tries: 0, next: now };
  t.closeAt = now + REVEAL_MS;
}

/** Seat indices, 1st first. Not forfeited before forfeited; the winner first; then fewest points, fewest cards, seat. */
export function rank(t: TableState, winner: number | null): number[] {
  const g = t.g!;
  const pts = (i: number) => g.players[i].hand.reduce((a, c) => a + c.n, 0);
  return g.players.map((_, i) => i).sort((a, b) =>
    (+!!t.seats[a].forfeit - +!!t.seats[b].forfeit) || (+(b === winner) - +(a === winner)) || (pts(a) - pts(b)) ||
    (g.players[a].hand.length - g.players[b].hand.length) || (a - b));
}

/** What the director gets: player ids in place order and the stats. Never a card (8.2 rule 3). */
export function resultOf(t: TableState): { places: string[]; stats: string } {
  const order = t.places!, g = t.g;
  const ids = order.map(i => t.spec.players[i]);
  return {
    places: ids,
    stats: JSON.stringify({
      how: t.how, moves: t.steps, durationMs: t.endedAt - t.dealtAt,
      points: order.map(i => g ? g.players[i].hand.reduce((a, c) => a + c.n, 0) : 0),
      cards: order.map(i => g ? g.players[i].hand.length : 0),
      timeouts: order.map(i => t.seats[i].timeouts),
      forfeits: order.filter(i => t.seats[i].forfeit).map(i => t.spec.players[i]),
    }),
  };
}

/** After a report attempt. Errors that won't change on a retry stop the retries. */
export function reported(t: TableState, r: { ok: boolean; error?: string } | null, now: number) {
  if (r?.ok) { t.report = { ...t.report, state: "sent" }; return; }
  const final = r && ["not-running", "no-table", "bad-places", "bad-signature"].includes(r.error ?? "");
  const tries = t.report.tries + 1;
  t.report = final ? { state: "failed", tries, next: 0, error: r!.error } : { state: "pending", tries, next: now + Math.min(60_000, 1000 * 2 ** tries), error: r?.error ?? "unreachable" };
}

/** Delete the table now? After the reveal window, once the director has the result (or it is past the backstop). */
export const closing = (t: TableState, now: number) =>
  t.phase === "done" && now >= t.closeAt && (t.report.state !== "pending" || now > t.spec.deadline + 60_000);

/** When the table next needs waking. */
export function wakeAt(t: TableState, now: number): number | null {
  const times: number[] = [];
  if (t.phase === "waiting") times.push(t.dealAt);
  if (t.phase === "playing") {
    times.push(t.endAt);
    if (t.dl) times.push(t.dl);
    t.seats.forEach((s, i) => { if (!s.conn && !s.forfeit) { times.push(forfeitAt(t, i)); if (s.joined) times.push(s.away + HOLD_MS); } });
  }
  if (t.phase === "done") {
    times.push(t.closeAt);
    if (t.report.state === "pending") times.push(t.report.next, t.spec.deadline + 60_001);
  }
  // Only what is still to come: everything due by now was done before this is asked (a report due now is sent first).
  const due = times.filter(x => x > now);
  return due.length ? Math.min(...due) : null;
}
