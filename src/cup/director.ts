import { DurableObject } from "cloudflare:workers";
import { advanceFrom, cutOf, gfPrizes, isFinal, isTop1, mainBase, planSecondChanceBase, playersAfter, rung, tableSizes, type Draw } from "./engine";
import { type CupConfig } from "./config";
import { commitment, newSeed, seatTables, seededOrder } from "./seating";
import { cupAccount, cupSpec, ISSUER, issuerSpec, LedgerError, PLATFORM, platformSpec, playerAccount, transferAll, transferStatements, type Transfer } from "../wallet/ledger";
import { resultSig, seatToken } from "./tokens";
import type { TableSpec } from "./tablecore";
import type { AuthEnv } from "../auth/env";

/* CupDirector: one per cup (docs/whot-cup-prd.md, section 7, Phases 4-5). It owns the cup's clock and its rounds.

   Time: an alarm wakes it at the next thing due; tick(now) does everything due by `now` (tests pass their own now).
     scheduled -> registration (opens) -> closed (the random draw, refunds past capacity) -> check-in
     -> running (no-shows, waitlist, payout bases frozen, then slot after slot) -> settled.  Plus paused, cancelled.

   Rounds follow the engine's pass() step for step, so table counts and pay match simulate() exactly:
     each slot seats the main draw (W) and Second Chance (L) together; first-time losers in rounds 1..scCutoffRound
     get an offer; buyers join L in the next slot; L waits while it is 4 or fewer and more may come; the finals' top
     2 go to the Grand Final, which is one more table; then GF prizes, the platform's Second Chance cut, and a
     reconciliation of the cup's pot.

   Tables: in "external" mode real cup tables (CupTable, src/cup/table.ts) play the games: each one asks for its
   record here (tableSpec) when its first player arrives, and reports a signed result with its stats. The deadline
   is the backstop: a table that hasn't reported by then is finished at random from its seed and marked late. In
   "simulate" mode (rehearsals and the cost tests) each table finishes at random from its seed the moment it is seated.

   Money moves through the ledger with idempotency keys, so a retried step never pays twice.
   Storage: a few SQL tables in this object; nothing here is written per move, only per table and per slot. */

type Phase = "scheduled" | "registration" | "closed" | "check-in" | "running" | "settled" | "cancelled";
type Mode = "simulate" | "external";

interface State {
  cupId: string; phase: Phase; paused: boolean; mode: Mode;
  N: number; baseW: number; baseL: number;
  slot: number; wRound: number;
  W: string[];            // main draw pool seated in the current slot (empty once its final is seated)
  heldL: string[] | null; // Second Chance pool held back this slot (4 or fewer, more may come)
  GF: string[];           // Grand Finalists, in the order they qualified
  gfCode: string | null;
  slotDoneAt: number | null;
  scBuyers: number;
  late: number;
}

interface TableRow { code: string; slot: number; draw: Draw | "GF"; players: string; n: number; final: number; pay1: number; pay2: number; deadline: number; result: string | null; late: number }

const KEY_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const tableCode = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), b => KEY_CHARS[b & 31]).join("");
const RETAIN_MS = 7 * 24 * 3600_000;      // keep the object's own tables a week after settling; D1 keeps the record
const BATCH = 100;                        // ledger transfers per D1 batch

export type DirectorEnv = AuthEnv & { CUP_TABLE_MODE?: string };

export class CupDirector extends DurableObject<DirectorEnv> {
  private sqlStore = this.ctx.storage.sql;
  /** Rows this object and D1 wrote, for the cost tests (cost protocol T2). */
  private written = { do: 0, d1: 0 };
  private sql = { exec: (q: string, ...args: unknown[]) => { const cur = this.sqlStore.exec(q, ...args); const rows = cur.toArray(); this.written.do += cur.rowsWritten; return { toArray: () => rows }; } };

  constructor(ctx: DurableObjectState, env: DirectorEnv) {
    super(ctx, env);
    // WITHOUT ROWID: each row lives in its primary-key tree, so a write is one row, not a row plus an index entry.
    // A slot's table codes sit in one kv record instead of an index on tbl. Offers are never deleted mid-cup (the
    // slot tells them apart); everything goes with deleteAll a week after the cup.
    this.sqlStore.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS tbl (code TEXT PRIMARY KEY, slot INTEGER, draw TEXT, players TEXT, n INTEGER, final INTEGER, pay1 INTEGER, pay2 INTEGER, deadline INTEGER, result TEXT, late INTEGER DEFAULT 0) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS offer (player TEXT PRIMARY KEY, slot INTEGER, expires INTEGER, bought INTEGER DEFAULT 0) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS sig (player TEXT PRIMARY KEY, device TEXT, ip TEXT, inviter TEXT) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS finish (player TEXT PRIMARY KEY, how TEXT) WITHOUT ROWID;`);
  }

  /* ---------- small storage helpers ---------- */
  private get<T>(k: string): T | null { const r = this.sql.exec("SELECT v FROM kv WHERE k = ?", k).toArray()[0]; return r ? JSON.parse(String(r.v)) as T : null; }
  private put(k: string, v: unknown) { this.sql.exec("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, JSON.stringify(v)); }
  private state(): State | null { return this.get<State>("state"); }
  private save(s: State) { this.put("state", s); }
  private cfg(): CupConfig { return this.get<CupConfig>("cfg")!; }
  private out(player: string, how: string) { this.sql.exec("INSERT OR IGNORE INTO finish (player, how) VALUES (?, ?)", player, how); }

  /* ---------- RPC: arming and safety switches ---------- */

  /** Called when a cup is published: remember its settings and wake at registration open. */
  async arm(cupId: string, mode?: Mode): Promise<void> {
    const row = await this.env.DB.prepare("SELECT config_json, state FROM cups WHERE id = ?").bind(cupId).first<{ config_json: string; state: string }>();
    if (!row || row.state !== "scheduled") throw new Error("only a scheduled cup can be armed");
    const c = JSON.parse(row.config_json) as CupConfig;
    this.put("cfg", c);
    const s: State = { cupId, phase: "scheduled", paused: false, mode: mode ?? (this.env.CUP_TABLE_MODE === "external" ? "external" : "simulate"), N: 0, baseW: 0, baseL: 0, slot: 0, wRound: 0, W: [], heldL: null, GF: [], gfCode: null, slotDoneAt: null, scBuyers: 0, late: 0 };
    this.save(s);
    const cap = c.oversubscription === "random-draw" ? c.capacity * 5 : c.capacity;
    await this.env.DB.prepare("INSERT INTO cup_seats (cup_id, capacity) VALUES (?, ?) ON CONFLICT(cup_id) DO UPDATE SET capacity = excluded.capacity, taken = 0").bind(cupId, cap).run();
    await this.ctx.storage.setAlarm(c.registrationOpensAt);
  }

  /** Unpublished before registration opened: forget everything. */
  async disarm(): Promise<void> {
    const s = this.state();
    if (s && s.phase !== "scheduled") throw new Error("too late to disarm");
    if (s) await this.env.DB.prepare("DELETE FROM cup_seats WHERE cup_id = ?").bind(s.cupId).run();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async pause(on: boolean): Promise<void> {
    const s = this.state();
    if (!s || s.phase === "settled" || s.phase === "cancelled") throw new Error("nothing to pause");
    s.paused = on; this.save(s);
    await this.publishLive(s);
    if (!on) await this.tick(Date.now());
  }

  /* ---------- the clock ---------- */

  async alarm(): Promise<void> { await this.tick(Date.now()); }

  /** Do everything that is due by `now`, then set the alarm for the next thing. */
  async tick(now: number): Promise<{ phase: Phase; slot: number }> {
    let s = this.state();
    if (!s) return { phase: "cancelled", slot: 0 };
    const c = this.cfg();
    for (let guard = 0; guard < 200; guard++) {
      const before = `${s.phase}:${s.slot}:${s.gfCode}`;
      if (s.phase === "scheduled" && now >= c.registrationOpensAt) await this.openRegistration(s, c, now);
      else if (s.phase === "registration" && now >= c.registrationClosesAt) await this.closeRegistration(s, c, now);
      else if (s.phase === "closed" && now >= c.checkInOpensAt) { s.phase = "check-in"; this.save(s); await this.setCupState(s, "check-in"); }
      else if (s.phase === "check-in" && now >= c.startsAt - c.checkInCloseBeforeStartSec * 1000) await this.closeCheckIn(s, c, now);
      else if (s.phase === "running") await this.runRounds(s, c, now);
      s = this.state()!;
      if (`${s.phase}:${s.slot}:${s.gfCode}` === before) break;
    }
    await this.setNextAlarm(s, c, now);
    return { phase: s.phase, slot: s.slot };
  }

  private async setNextAlarm(s: State, c: CupConfig, now: number) {
    const due: number[] = [];
    if (s.phase === "scheduled") due.push(c.registrationOpensAt);
    if (s.phase === "registration") due.push(c.registrationClosesAt);
    if (s.phase === "closed") due.push(c.checkInOpensAt);
    if (s.phase === "check-in") due.push(c.startsAt - c.checkInCloseBeforeStartSec * 1000);
    if (s.phase === "running") {
      if (s.slot === 0) due.push(c.startsAt);
      const open = this.sql.exec("SELECT MIN(deadline) AS d FROM tbl WHERE result IS NULL").toArray()[0];
      if (open?.d) due.push(Number(open.d));
      if (s.slotDoneAt) due.push(s.slotDoneAt + c.breakSec * 1000);
    }
    if (s.phase === "settled") due.push(now + RETAIN_MS);
    const next = due.filter(t => Number.isFinite(t)).sort((a, b) => a - b)[0];
    if (s.phase === "settled" && this.get<number>("settledAt") && now >= this.get<number>("settledAt")! + RETAIN_MS) { await this.ctx.storage.deleteAll(); return; }
    if (next !== undefined) await this.ctx.storage.setAlarm(Math.max(next, now + 1));
  }

  /* ---------- registration ---------- */

  private async openRegistration(s: State, c: CupConfig, now: number) {
    s.phase = "registration"; this.save(s);
    if (c.oversubscription === "random-draw") await this.commitSeed(s.cupId, 0, now);   // the draw's seed, fixed before any entry
    await this.setCupState(s, "registration");
  }

  private async closeRegistration(s: State, c: CupConfig, now: number) {
    const DB = this.env.DB;
    const rows = (await DB.prepare("SELECT player_id, state, seq FROM registrations WHERE cup_id = ? AND state IN ('entered', 'waitlist') ORDER BY seq").bind(s.cupId).all<{ player_id: string; state: string; seq: number }>()).results;
    if (rows.length < c.minEntries) return this.cancel(`Only ${rows.length} entries: the cup needed ${c.minEntries}.`, now);
    if (c.oversubscription === "random-draw") {
      const seed = await this.revealSeed(s.cupId, 0, now);
      const order = seededOrder(rows.map(r => r.player_id), seed);
      const seated = order.slice(0, c.capacity), rest = order.slice(c.capacity);
      const stmts: D1PreparedStatement[] = [DB.prepare("UPDATE registrations SET state = 'seated' WHERE cup_id = ? AND state = 'entered' AND player_id IN (SELECT value FROM json_each(?))").bind(s.cupId, JSON.stringify(seated))];
      rest.forEach((pid, i) => stmts.push(DB.prepare("UPDATE registrations SET state = 'waitlist', draw_rank = ? WHERE cup_id = ? AND player_id = ?").bind(i + 1, s.cupId, pid)));
      await batched(DB, stmts);
      if (!c.waitlist) await this.refund(s, rest, "Not drawn for a seat", "refunded");
    } else {
      await DB.prepare("UPDATE registrations SET state = 'seated' WHERE cup_id = ? AND state = 'entered'").bind(s.cupId).run();
    }
    s.phase = "closed"; this.save(s);
    await this.setCupState(s, "closed");
  }

  private async closeCheckIn(s: State, c: CupConfig, now: number) {
    const DB = this.env.DB;
    const rows = (await DB.prepare("SELECT player_id, state, seq, draw_rank, checked_in_at, device_id, ip_hash, invited_by FROM registrations WHERE cup_id = ? AND state IN ('seated', 'waitlist')").bind(s.cupId).all<{ player_id: string; state: string; seq: number; draw_rank: number | null; checked_in_at: number | null; device_id: string; ip_hash: string; invited_by: string | null }>()).results;
    const here = rows.filter(r => r.state === "seated" && r.checked_in_at);
    const noShows = rows.filter(r => r.state === "seated" && !r.checked_in_at);
    const queue = rows.filter(r => r.state === "waitlist" && r.checked_in_at).sort((a, b) => (a.draw_rank ?? a.seq) - (b.draw_rank ?? b.seq));
    const promoted = c.waitlist ? queue.slice(0, Math.max(0, c.capacity - here.length)) : [];
    const leftOver = rows.filter(r => r.state === "waitlist" && !promoted.includes(r));
    const field = [...here, ...promoted];

    if (c.noShowRefund === "full") await this.refund(s, noShows.map(r => r.player_id), "You missed check-in", "no-show");
    else await batched(DB, noShows.map(r => DB.prepare("UPDATE registrations SET state = 'no-show' WHERE cup_id = ? AND player_id = ?").bind(s.cupId, r.player_id)));
    await this.refund(s, leftOver.map(r => r.player_id), "No seat came free", "refunded");
    if (field.length < Math.max(4, c.minEntries)) return this.cancel(`Only ${field.length} players checked in: the cup needed ${c.minEntries}.`, now);

    // The field is fixed: freeze the payout bases (CL-4) and take the platform's cut of the entries.
    const N = field.length;
    s.N = N; s.baseW = mainBase(c, N); s.baseL = planSecondChanceBase(c, N);
    s.W = field.map(r => r.player_id); s.phase = "running";
    for (const r of field) this.sql.exec("INSERT OR REPLACE INTO sig (player, device, ip, inviter) VALUES (?, ?, ?, ?)", r.player_id, r.device_id, r.ip_hash, r.invited_by);
    await batched(DB, [DB.prepare("UPDATE registrations SET state = 'playing' WHERE cup_id = ? AND player_id IN (SELECT value FROM json_each(?))").bind(s.cupId, JSON.stringify(s.W))]);
    const pot = cupAccount(s.cupId, c.currency), t: Transfer[] = [];
    const cut = cutOf(c, N * c.entryFee);
    if (cut > 0) t.push({ idem: `cut:${s.cupId}:main`, from: pot, to: PLATFORM(c.currency), amount: cut, currency: c.currency, kind: "platform_cut", cupId: s.cupId });
    if (c.guaranteedPool > 0) t.push({ idem: `sponsor:${s.cupId}`, from: ISSUER(c.currency), to: pot, amount: c.guaranteedPool, currency: c.currency, kind: "sponsor", cupId: s.cupId, memo: c.sponsor || "Sponsor" });
    await transferAll(DB, t, [platformSpec(c.currency), issuerSpec(c.currency), cupSpec(s.cupId, c.currency)]);
    this.save(s);
    await this.commitSeed(s.cupId, 1, now);
    await DB.prepare("UPDATE cups SET schedule_json = ? WHERE id = ?").bind(JSON.stringify(scheduleOf(c, s)), s.cupId).run();
    await this.setCupState(s, "running");
  }

  /* ---------- rounds ---------- */

  private tablesOf(slot: number): TableRow[] {
    const codes = this.get<string[]>(`codes:${slot}`) ?? [];
    if (!codes.length) return [];
    return this.sql.exec("SELECT * FROM tbl WHERE code IN (SELECT value FROM json_each(?))", JSON.stringify(codes)).toArray() as unknown as TableRow[];
  }

  private async runRounds(s: State, c: CupConfig, now: number) {
    // Tables that blew their clock are finished from their seed and marked late (the backstop).
    const overdue = this.sql.exec("SELECT * FROM tbl WHERE result IS NULL AND deadline <= ?", now).toArray() as unknown as TableRow[];
    if (overdue.length) {
      const items = [];
      for (const t of overdue) items.push({ t, places: await this.randomOrder(t), late: true });
      await this.finishTables(s, c, items, now);
      s = this.state()!;
    }
    if (s.gfCode) {                                                    // the Grand Final is the last table
      const gf = this.sql.exec("SELECT * FROM tbl WHERE code = ?", s.gfCode).toArray()[0] as unknown as TableRow;
      if (gf?.result) await this.settle(s, c, now);
      return;
    }
    if (s.paused) return;
    if (s.slot === 0) { if (now >= c.startsAt) await this.seatSlot(s, c, now); return; }
    const open = this.tablesOf(s.slot).filter(t => !t.result).length;
    if (open) return;
    if (!s.slotDoneAt) { s.slotDoneAt = now; this.save(s); await this.publishLive(s); return; }
    if (now >= s.slotDoneAt + c.breakSec * 1000) await this.seatSlot(s, c, now);
  }

  /** Seat the next slot, mirroring one iteration of the engine's pass(). */
  private async seatSlot(s: State, c: CupConfig, now: number) {
    const prev = s.slot ? this.tablesOf(s.slot) : [];
    const adv = (t: TableRow) => (JSON.parse(t.result!) as string[]).slice(0, advanceFrom(c, t.draw as Draw, t.n, JSON.parse(t.players).length, !!t.final));
    // Main draw: winners of last slot's W tables; a W final sends its winners to the Grand Final.
    if (s.slot) {
      const w = prev.filter(t => t.draw === "W");
      if (w.some(t => t.final)) { s.GF.push(...w.flatMap(adv)); s.W = []; } else s.W = w.flatMap(adv);
    }
    const lPrev = prev.filter(t => t.draw === "L");
    let L = s.heldL ?? lPrev.filter(t => !t.final).flatMap(adv);
    if (lPrev.some(t => t.final)) { s.GF.push(...lPrev.flatMap(adv)); L = []; }
    s.heldL = null;
    // Last slot's buyers join Second Chance; unanswered offers expire, and those players are out.
    const offers = this.sql.exec("SELECT player, bought FROM offer WHERE slot = ?", s.slot).toArray();
    const drops = offers.filter(o => o.bought).map(o => String(o.player));
    for (const o of offers) if (!o.bought) this.out(String(o.player), `main-r${s.wRound}`);
    const Lpool = [...L, ...drops];

    if (!s.W.length && !Lpool.length) {                                 // both draws done: the Grand Final
      if (!s.GF.length) return this.settle(s, c, now);
      s.slot++; s.slotDoneAt = null;
      const seed = await this.revealSeed(s.cupId, s.slot, now, true);
      const players = seededOrder(s.GF, seed);
      if (c.gfEdge === "lead-first") players.sort((a, b) => Number(!this.isMainFinalist(s, b)) - Number(!this.isMainFinalist(s, a)));
      s.gfCode = this.addTable(s, c, s.slot, "GF", players, players.length, true, 0, 0, now);
      this.save(s);
      await this.afterSeating(s, c, now);
      return;
    }

    s.slot++; s.slotDoneAt = null;
    const seed = await this.revealSeed(s.cupId, s.slot, now, true);
    if (s.W.length) {
      s.wRound++;
      await this.seatDraw(s, c, "W", s.W, seed, now);
    }
    const cutoff = c.scEnabled ? c.scCutoffRound : 0;
    const inflow = s.W.length > 0 && s.wRound <= cutoff;               // this slot's main-draw losers may still buy in
    if (Lpool.length) {
      if (Lpool.length <= 4 && inflow) s.heldL = Lpool;                // wait for more players
      else await this.seatDraw(s, c, "L", Lpool, seed, now);
    }
    this.save(s);
    await this.commitSeed(s.cupId, s.slot + 1, now);
    await this.afterSeating(s, c, now);
  }

  private mainFinalists: Set<string> | null = null;
  private newCodes: string[] | null = null;
  /** Store the slot's table codes in one record, once seating is done. */
  private flushCodes(slot: number) { if (this.newCodes?.length) { this.put(`codes:${slot}`, [...(this.get<string[]>(`codes:${slot}`) ?? []), ...this.newCodes]); this.newCodes = null; } }
  private isMainFinalist(s: State, p: string) {
    if (!this.mainFinalists) {
      const w = this.sql.exec("SELECT result, n, players, final FROM tbl WHERE draw = 'W' AND final = 1").toArray()[0];
      this.mainFinalists = new Set(w ? (JSON.parse(String(w.result)) as string[]).slice(0, 2) : []);
    }
    return this.mainFinalists.has(p);
  }

  /** Seat one draw. The main draw uses the slot's seed; Second Chance uses sha256(seed + ":L"), so both are verifiable. */
  private async seatDraw(s: State, c: CupConfig, draw: Draw, pool: string[], seed: string, now: number) {
    const n = pool.length, final = isFinal(n);
    const nAfter = playersAfter(c, draw, n);
    const pay = rung(c, s.N, draw === "L" ? s.baseL : s.baseW, nAfter);
    const early = s.wRound <= 3;
    const sig = (p: string) => this.sql.exec("SELECT device, ip, inviter FROM sig WHERE player = ?", p).toArray()[0] as { device: string; ip: string; inviter: string | null } | undefined;
    const cache = new Map<string, ReturnType<typeof sig>>();
    const get = (p: string) => { if (!cache.has(p)) cache.set(p, sig(p)); return cache.get(p); };
    const apart = (a: string, b: string) => {
      const x = get(a), y = get(b);
      if (!x || !y) return false;
      if (c.separateDevices && x.device === y.device) return true;
      if ((c.separateNetworks === "always" || (c.separateNetworks === "rounds-1-3" && early)) && x.ip === y.ip) return true;
      if (c.separateInviteLinks && early && (x.inviter === b || y.inviter === a)) return true;
      return false;
    };
    const sizes = final ? [n] : tableSizes(n);
    const drawSeed = draw === "W" ? seed : await commitment(`${seed}:L`);
    const { tables, unresolved } = seatTables(pool, drawSeed, apart, sizes);
    if (unresolved) console.warn(JSON.stringify({ msg: "seating constraints unresolved", cup: s.cupId, slot: s.slot, draw, unresolved }));
    for (const t of tables) this.addTable(s, c, s.slot, draw, t, n, final, pay.first, pay.second, now);
  }

  private addTable(s: State, c: CupConfig, slot: number, draw: Draw | "GF", players: string[], n: number, final: boolean, pay1: number, pay2: number, now: number): string {
    const code = tableCode();
    this.sql.exec("INSERT INTO tbl (code, slot, draw, players, n, final, pay1, pay2, deadline) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      code, slot, draw, JSON.stringify(players), n, final ? 1 : 0, pay1, pay2, now + backstopMs(c));
    (this.newCodes ??= []).push(code);
    return code;
  }

  /** After seating: in simulate mode every table finishes at once; then publish progress. */
  private async afterSeating(s: State, c: CupConfig, now: number) {
    this.flushCodes(s.slot);
    if (s.mode === "simulate") {
      const items = [];
      for (const t of this.tablesOf(s.slot)) items.push({ t, places: await this.randomOrder(t), late: false });
      await this.finishTables(this.state()!, c, items, now);
    }
    await this.publishLive(this.state()!);
  }

  private async randomOrder(t: TableRow): Promise<string[]> {
    const seed = await this.revealSeed(this.state()!.cupId, t.slot, Date.now(), false);
    return seededOrder(JSON.parse(t.players), (await commitment(`${seed}:${t.code}`)));
  }

  /* ---------- results ---------- */

  /** What a cup table needs to know about itself (Phase 6): its players, their names, its pay and its clocks.
      Only a table this cup seated, still unfinished, gets an answer. No seed: the table shuffles its own deck. */
  async tableSpec(code: string): Promise<{ spec?: TableSpec; error?: string }> {
    const s = this.state();
    if (!s || s.phase !== "running") return { error: "not-running" };
    const t = this.sql.exec("SELECT * FROM tbl WHERE code = ?", code).toArray()[0] as unknown as TableRow | undefined;
    if (!t) return { error: "no-table" };
    if (t.result) return { error: "finished" };
    const c = this.cfg(), players = JSON.parse(t.players) as string[];
    const rows = await this.env.DB.prepare("SELECT id, name FROM players WHERE id IN (SELECT value FROM json_each(?))").bind(t.players).all<{ id: string; name: string | null }>();
    const nameOf = new Map(rows.results.map(r => [r.id, r.name ?? ""]));
    return { spec: {
      cupId: s.cupId, code, slot: t.slot, draw: t.draw, final: !!t.final, players, names: players.map(p => nameOf.get(p) || "Player"),
      pay1: t.pay1, pay2: t.pay2, deadline: t.deadline, seatedAt: t.deadline - backstopMs(c),
      rules: { turnClockSec: c.turnClockSec, tableClockSec: c.tableClockSec, disconnectGraceSec: c.disconnectGraceSec, voice: c.voice, chat: c.chat, spectators: c.spectators, spectatorDelayMoves: c.spectatorDelayMoves, revealHands: c.revealHands },
    } };
  }

  /** A table's signed result. `places` lists every seated player, 1st first; `stats` (from cup tables) is the
      JSON the table signed: how it ended, moves, duration, points and cards per place, forfeits. Never cards. */
  async report(code: string, places: string[], sig: string, stats?: string): Promise<{ ok: boolean; error?: string }> {
    const s = this.state();
    if (!s || s.phase !== "running") return { ok: false, error: "not-running" };
    const t = this.sql.exec("SELECT * FROM tbl WHERE code = ?", code).toArray()[0] as unknown as TableRow | undefined;
    if (!t) return { ok: false, error: "no-table" };
    if (t.result) return { ok: true };                                   // already in: a retry is fine
    const seated = JSON.parse(t.players) as string[];
    if (places.length !== seated.length || [...places].sort().join() !== [...seated].sort().join()) return { ok: false, error: "bad-places" };
    if (stats !== undefined && (typeof stats !== "string" || stats.length > 4096)) return { ok: false, error: "bad-stats" };
    if (!this.env.PHONE_HMAC_KEY || sig !== await resultSig(this.env.PHONE_HMAC_KEY, s.cupId, code, places, stats)) return { ok: false, error: "bad-signature" };
    const now = Date.now();
    await this.finishTables(s, this.cfg(), [{ t, places, late: false, stats: stats ?? null }], now);
    await this.tick(now);
    return { ok: true };
  }

  /** Record results, pay 1st and 2nd, open Second Chance offers to eligible losers, mark the rest out.
      Money and the D1 record go in batches, so a whole slot of computer tables costs a handful of round trips. */
  private async finishTables(s: State, c: CupConfig, items: { t: TableRow; places: string[]; late: boolean; stats?: string | null }[], now: number) {
    const DB = this.env.DB, pot = cupAccount(s.cupId, c.currency);
    const transfers: Transfer[] = [], records: D1PreparedStatement[] = [];
    const label = (d: string) => (d === "W" ? "Main draw" : "Second Chance");
    for (const { t, places, late, stats } of items) {
      this.sql.exec("UPDATE tbl SET result = ?, late = ? WHERE code = ?", JSON.stringify(places), late ? 1 : 0, t.code);
      if (late) s.late++;
      if (t.draw !== "GF") {
        const size = places.length;
        if (t.pay1 > 0) transfers.push({ idem: `pay:${s.cupId}:${t.code}:1`, from: pot, to: playerAccount(places[0], c.currency), amount: t.pay1, currency: c.currency, kind: "table_pay", playerId: places[0], cupId: s.cupId, memo: `${label(t.draw)} table, 1st` });
        if (size > 1 && t.pay2 > 0) transfers.push({ idem: `pay:${s.cupId}:${t.code}:2`, from: pot, to: playerAccount(places[1], c.currency), amount: t.pay2, currency: c.currency, kind: "table_pay", playerId: places[1], cupId: s.cupId, memo: `${label(t.draw)} table, 2nd` });
        const losers = places.slice(advanceFrom(c, t.draw as Draw, t.n, size, !!t.final));
        if (t.draw === "W" && c.scEnabled && s.wRound <= c.scCutoffRound) {
          const expires = now + c.scBuyWindowSec * 1000;
          for (const p of losers) this.sql.exec("INSERT OR IGNORE INTO offer (player, slot, expires) VALUES (?, ?, ?)", p, t.slot, expires);
        } else for (const p of losers) this.out(p, t.draw === "W" ? `main-r${s.wRound}` : `sc-slot${t.slot}`);
      }
      records.push(DB.prepare("INSERT OR IGNORE INTO table_results (cup_id, slot, draw, table_code, places_json, pay1, pay2, late, reported_at, stats_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(s.cupId, t.slot, t.draw, t.code, JSON.stringify(places), t.pay1, t.pay2, late ? 1 : 0, now, stats ?? null));
    }
    this.save(s);
    for (let i = 0; i < transfers.length; i += BATCH) this.written.d1 += (await transferAll(DB, transfers.slice(i, i + BATCH))).rowsWritten;
    this.written.d1 += await batched(DB, records);
  }

  /* ---------- Second Chance ---------- */

  /** A first-time loser buys back in (RD-3). The stake moves at once; the player joins Second Chance next slot. */
  async buySecondChance(player: string, now = Date.now()): Promise<{ ok: boolean; error?: string; fromWinnings?: boolean }> {
    const s = this.state(), c = this.cfg();
    if (!s || s.phase !== "running") return { ok: false, error: "not-running" };
    const o = this.sql.exec("SELECT slot, expires, bought FROM offer WHERE player = ?", player).toArray()[0];
    if (!o) return { ok: false, error: "no-offer" };
    if (o.bought) return { ok: true };
    if (Number(o.expires) < now || Number(o.slot) !== s.slot) return { ok: false, error: "offer-closed" };
    // Pay from winnings: with "off", this cup's winnings can't be used for the stake.
    const won = await this.wonInCup(s.cupId, player);
    const bal = (await this.env.DB.prepare("SELECT balance FROM accounts WHERE id = ?").bind(playerAccount(player, c.currency)).first<number>("balance")) ?? 0;
    if (c.scPayFromWinnings === "off" && bal - won < c.scFee) return { ok: false, error: "insufficient-funds" };
    try {
      if (c.scFee > 0) await transferAll(this.env.DB, [{ idem: `sc:${s.cupId}:${player}`, from: playerAccount(player, c.currency), to: cupAccount(s.cupId, c.currency), amount: c.scFee, currency: c.currency, kind: "sc_stake", playerId: player, cupId: s.cupId, memo: won >= c.scFee ? "Second Chance, from winnings" : "Second Chance" }]);
    } catch (e) { if (e instanceof LedgerError && e.code === "insufficient-funds") return { ok: false, error: "insufficient-funds" }; throw e; }
    this.sql.exec("UPDATE offer SET bought = 1 WHERE player = ?", player);
    s.scBuyers++; this.save(s);
    await this.env.DB.prepare("UPDATE registrations SET sc_bought = 1 WHERE cup_id = ? AND player_id = ?").bind(s.cupId, player).run();
    return { ok: true, fromWinnings: won >= c.scFee };
  }

  private async wonInCup(cupId: string, player: string): Promise<number> {
    return (await this.env.DB.prepare("SELECT COALESCE(SUM(amount), 0) AS w FROM ledger WHERE cup_id = ? AND player_id = ? AND kind IN ('table_pay', 'gf_prize')").bind(cupId, player).first<number>("w")) ?? 0;
  }

  /* ---------- settlement (RD-6) ---------- */

  private async settle(s: State, c: CupConfig, now: number) {
    const DB = this.env.DB, pot = cupAccount(s.cupId, c.currency);
    const t: Transfer[] = [];
    const scStakes = s.scBuyers * c.scFee, scCut = cutOf(c, scStakes);
    if (scCut > 0) t.push({ idem: `cut:${s.cupId}:sc`, from: pot, to: PLATFORM(c.currency), amount: scCut, currency: c.currency, kind: "platform_cut", cupId: s.cupId });
    await transferAll(DB, t);
    const gfPot = (await DB.prepare("SELECT balance FROM accounts WHERE id = ?").bind(pot).first<number>("balance")) ?? 0;
    const gf = s.gfCode ? this.sql.exec("SELECT result FROM tbl WHERE code = ?", s.gfCode).toArray()[0] : null;
    const places: string[] = gf?.result ? JSON.parse(String(gf.result)) : [];
    const prizes = gfPrizes(c, gfPot, places.length);
    const pays: Transfer[] = places.map((p, i) => ({ idem: `gf:${s.cupId}:${i + 1}`, from: pot, to: playerAccount(p, c.currency), amount: prizes[i], currency: c.currency, kind: "gf_prize" as const, playerId: p, cupId: s.cupId, memo: `Grand Final, ${["1st", "2nd", "3rd", "4th"][i]}` })).filter(x => x.amount > 0);
    await transferAll(DB, pays);
    places.forEach((p, i) => this.out(p, i === 0 ? "champion" : `grand-final-${i + 1}`));
    // Everyone still unplaced finished where they last played.
    await this.writeFinishes(s);
    s.phase = "settled"; this.save(s); this.put("settledAt", now);
    await this.setCupState(s, "settled");
  }

  private async writeFinishes(s: State) {
    const DB = this.env.DB;
    const rows = this.sql.exec("SELECT player, how FROM finish").toArray();
    const won = (await DB.prepare("SELECT player_id, SUM(amount) AS w FROM ledger WHERE cup_id = ? AND kind IN ('table_pay', 'gf_prize') GROUP BY player_id").bind(s.cupId).all<{ player_id: string; w: number }>()).results;
    const wonBy = new Map(won.map(r => [r.player_id, r.w]));
    await batched(DB, rows.map(r => DB.prepare("UPDATE registrations SET state = 'finished', finish = ?, won = ? WHERE cup_id = ? AND player_id = ?").bind(String(r.how), wonBy.get(String(r.player)) ?? 0, s.cupId, String(r.player))));
    await DB.prepare("UPDATE registrations SET state = 'finished' WHERE cup_id = ? AND state = 'playing'").bind(s.cupId).run();
  }

  /* ---------- refunds and cancelling (CL-5) ---------- */

  /** Refund each listed player's stakes in this cup (entry and Second Chance), once. */
  private async refund(s: State, players: string[], memo: string, newState: string) {
    if (!players.length) return;
    const c = this.cfg(), DB = this.env.DB, pot = cupAccount(s.cupId, c.currency);
    const staked = await this.stakedBy(s.cupId);
    const t: Transfer[] = players.map(p => ({ idem: `refund:${s.cupId}:${p}`, from: pot, to: playerAccount(p, c.currency), amount: staked.get(p) ?? 0, currency: c.currency, kind: "refund" as const, playerId: p, cupId: s.cupId, memo })).filter(x => x.amount > 0);
    for (let i = 0; i < t.length; i += BATCH) await transferAll(DB, t.slice(i, i + BATCH));
    await batched(DB, players.map(p => DB.prepare("UPDATE registrations SET state = ? WHERE cup_id = ? AND player_id = ?").bind(newState, s.cupId, p)));
    if (newState !== "no-show") await DB.prepare("UPDATE cup_seats SET taken = MAX(0, taken - ?) WHERE cup_id = ?").bind(players.length, s.cupId).run();
  }

  private async stakedBy(cupId: string): Promise<Map<string, number>> {
    const r = await this.env.DB.prepare("SELECT player_id, SUM(CASE WHEN kind IN ('stake', 'sc_stake') THEN amount ELSE 0 END) - SUM(CASE WHEN kind = 'refund' THEN amount ELSE 0 END) AS s FROM ledger WHERE cup_id = ? AND player_id IS NOT NULL GROUP BY player_id").bind(cupId).all<{ player_id: string; s: number }>();
    return new Map(r.results.map(x => [x.player_id, x.s]));
  }

  /** Cancel at any point before settling: everyone gets back at least what they staked; nobody hands back winnings.
      Any shortfall is covered by the coin issuer (the platform, for naira); any sponsor money left goes back. */
  async cancel(reason: string, now = Date.now()): Promise<void> {
    const s = this.state();
    if (!s || s.phase === "settled" || s.phase === "cancelled") throw new Error("nothing to cancel");
    const c = this.cfg(), DB = this.env.DB, pot = cupAccount(s.cupId, c.currency), cur = c.currency;
    // Undo the platform's cut, if it was taken.
    const cut = (await DB.prepare("SELECT COALESCE(SUM(amount), 0) AS a FROM ledger WHERE cup_id = ? AND kind = 'platform_cut'").bind(s.cupId).first<number>("a")) ?? 0;
    if (cut > 0) await transferAll(DB, [{ idem: `uncut:${s.cupId}`, from: PLATFORM(cur), to: pot, amount: cut, currency: cur, kind: "adjust", cupId: s.cupId, memo: "Cup cancelled: platform cut returned" }]);
    const staked = await this.stakedBy(s.cupId);
    const won = await DB.prepare("SELECT player_id, SUM(amount) AS w FROM ledger WHERE cup_id = ? AND kind IN ('table_pay', 'gf_prize') GROUP BY player_id").bind(s.cupId).all<{ player_id: string; w: number }>();
    const wonBy = new Map(won.results.map(r => [r.player_id, r.w]));
    const owed = [...staked.entries()].map(([p, st]) => [p, Math.max(0, st - (wonBy.get(p) ?? 0))] as const).filter(([, a]) => a > 0);
    const total = owed.reduce((a, [, x]) => a + x, 0);
    const bal = (await DB.prepare("SELECT balance FROM accounts WHERE id = ?").bind(pot).first<number>("balance")) ?? 0;
    const coverFrom = cur === "COIN" ? ISSUER(cur) : PLATFORM(cur);
    if (total > bal) await transferAll(DB, [{ idem: `cover:${s.cupId}`, from: coverFrom, to: pot, amount: total - bal, currency: cur, kind: "adjust", cupId: s.cupId, memo: "Cup cancelled: refunds covered" }], [issuerSpec(cur), platformSpec(cur), cupSpec(s.cupId, cur)]);
    const t: Transfer[] = owed.map(([p, a]) => ({ idem: `refund:${s.cupId}:${p}`, from: pot, to: playerAccount(p, cur), amount: a, currency: cur, kind: "refund" as const, playerId: p, cupId: s.cupId, memo: `Cup cancelled: ${reason}`.slice(0, 120) }));
    for (let i = 0; i < t.length; i += BATCH) await transferAll(DB, t.slice(i, i + BATCH));
    const left = (await DB.prepare("SELECT balance FROM accounts WHERE id = ?").bind(pot).first<number>("balance")) ?? 0;
    if (left > 0) await transferAll(DB, [{ idem: `return:${s.cupId}`, from: pot, to: coverFrom, amount: left, currency: cur, kind: "adjust", cupId: s.cupId, memo: "Cup cancelled: sponsor money returned" }]);
    await DB.batch([
      DB.prepare("UPDATE registrations SET state = 'refunded' WHERE cup_id = ? AND state NOT IN ('refunded', 'no-show')").bind(s.cupId),
      DB.prepare("UPDATE cups SET cancel_reason = ? WHERE id = ?").bind(reason.slice(0, 280), s.cupId),
    ]);
    this.sql.exec("DELETE FROM offer");
    s.phase = "cancelled"; this.save(s); this.put("settledAt", now);
    await this.setCupState(s, "cancelled");
    await this.ctx.storage.setAlarm(now + RETAIN_MS);
  }

  /* ---------- seeds (SE-1) ---------- */

  private async commitSeed(cupId: string, slot: number, now: number) {
    if (this.get<string>(`seed:${slot}`)) return;
    const seed = newSeed();
    this.put(`seed:${slot}`, seed);
    await this.env.DB.prepare("INSERT OR IGNORE INTO seeds (cup_id, slot, commitment, committed_at) VALUES (?, ?, ?, ?)").bind(cupId, slot, await commitment(seed), now).run();
  }
  /** The seed for a slot; publishing reveals it (after it has been used to seat). */
  private async revealSeed(cupId: string, slot: number, now: number, publish = true): Promise<string> {
    let seed = this.get<string>(`seed:${slot}`);
    if (!seed) { await this.commitSeed(cupId, slot, now); seed = this.get<string>(`seed:${slot}`)!; }
    if (publish) await this.env.DB.prepare("UPDATE seeds SET seed = ?, revealed_at = ? WHERE cup_id = ? AND slot = ? AND seed IS NULL").bind(seed, now, cupId, slot).run();
    return seed;
  }

  /* ---------- what players and admins see ---------- */

  private async setCupState(s: State, state: string) {
    await this.env.DB.prepare("UPDATE cups SET state = ?, live_json = ?, updated_at = ? WHERE id = ?").bind(state, JSON.stringify(this.liveOf(s)), Date.now(), s.cupId).run();
  }
  private async publishLive(s: State) {
    await this.env.DB.prepare("UPDATE cups SET live_json = ? WHERE id = ?").bind(JSON.stringify(this.liveOf(s)), s.cupId).run();
  }
  private liveOf(s: State) {
    const t = s.slot ? this.tablesOf(s.slot) : [];
    return { phase: s.phase, paused: s.paused, slot: s.slot, field: s.N, mainLeft: s.W.length, tables: t.length, finished: t.filter(x => x.result).length, late: s.late, grandFinal: !!s.gfCode, scBuyers: s.scBuyers };
  }

  /** For the console: everything about the cup right now, including late tables. */
  async status(): Promise<Record<string, unknown> | null> {
    const s = this.state();
    if (!s) return null;
    const t = s.slot ? this.tablesOf(s.slot) : [];
    const now = Date.now();
    return {
      ...this.liveOf(s), mode: s.mode, baseW: s.baseW, baseL: s.baseL,
      lateTables: this.sql.exec("SELECT code, slot, draw FROM tbl WHERE late = 1 ORDER BY slot DESC LIMIT 50").toArray(),
      overdue: t.filter(x => !x.result && x.deadline < now).map(x => x.code),
      offersOpen: Number(this.sql.exec("SELECT COUNT(*) AS n FROM offer WHERE bought = 0 AND slot = ? AND expires > ?", s.slot, now).toArray()[0]?.n ?? 0),
    };
  }

  /** A player's own place in the cup right now: their table and seat token when seated, or their offer. */
  async whereIs(player: string): Promise<Record<string, unknown>> {
    const s = this.state();
    if (!s) return { phase: "none" };
    const c = this.cfg();
    const fin = this.sql.exec("SELECT how FROM finish WHERE player = ?", player).toArray()[0];
    const offer = this.sql.exec("SELECT slot, expires, bought FROM offer WHERE player = ?", player).toArray()[0];
    let table: Record<string, unknown> | null = null;
    if (s.slot) for (const t of this.tablesOf(s.slot)) {
      const seats = JSON.parse(t.players) as string[], seat = seats.indexOf(player);
      if (seat < 0) continue;
      const exp = t.deadline;
      table = { code: t.code, draw: t.draw, seat, players: seats.length, pay1: t.pay1, pay2: t.pay2, done: !!t.result, place: t.result ? (JSON.parse(t.result) as string[]).indexOf(player) + 1 : null,
        token: this.env.PHONE_HMAC_KEY ? await seatToken(this.env.PHONE_HMAC_KEY, s.cupId, s.slot, t.code, seat, player, exp) : null, expires: exp };
    }
    return {
      phase: s.phase, paused: s.paused, slot: s.slot, mode: s.mode, table,
      offer: offer && (offer.bought || Number(offer.slot) === s.slot) ? { slot: offer.slot, expires: offer.expires, bought: !!offer.bought, fee: c.scFee, payFromWinnings: c.scPayFromWinnings } : null,
      finish: fin ? fin.how : null,
    };
  }

  /** Tests and rehearsals: the full table list for a slot. */
  async tables(slot: number): Promise<{ code: string; draw: string; players: string[]; result: string[] | null; pay1: number; pay2: number; n: number; final: boolean; late: boolean }[]> {
    return this.tablesOf(slot).map(t => ({ code: t.code, draw: t.draw, players: JSON.parse(t.players), result: t.result ? JSON.parse(t.result) : null, pay1: t.pay1, pay2: t.pay2, n: t.n, final: !!t.final, late: !!t.late }));
  }
  async snapshot(): Promise<State | null> { return this.state(); }
  /** Players holding an open Second Chance offer (tests, rehearsals and the console). */
  async openOffers(): Promise<{ player: string; slot: number; expires: number }[]> {
    const s = this.state();
    return this.sql.exec("SELECT player, slot, expires FROM offer WHERE bought = 0 AND slot = ? ORDER BY player", s?.slot ?? -1).toArray() as unknown as { player: string; slot: number; expires: number }[];
  }
  /** Rows written by this object since it woke, and by its D1 calls: read and reset (cost tests). */
  async rowsWritten(): Promise<{ do: number; d1: number }> { const w = { ...this.written }; this.written = { do: 0, d1: 0 }; return w; }
}

/* ---------- helpers shared with the tables (src/cup/tokens.ts) ---------- */
export { seatToken, resultSig };

/** From seating to the backstop: the table clock, plus the disconnect grace, plus a minute (the deal waits up to a
    minute for everyone, src/cup/tablecore.ts JOIN_MS). A cup table always ends before it. */
const backstopMs = (c: CupConfig) => (c.tableClockSec + c.disconnectGraceSec + 60) * 1000;

/** What the cup page shows once the field is fixed: exact main-draw pay by round, Second Chance's base. */
function scheduleOf(c: CupConfig, s: State) {
  const rows: { round: number; players: number; rule: string; pay1: number; pay2: number }[] = [];
  let n = s.N;
  for (let r = 1; n > 0 && r < 60; r++) {
    const nAfter = playersAfter(c, "W", n), p = rung(c, s.N, s.baseW, nAfter);
    rows.push({ round: r, players: n, rule: isFinal(n) ? "final" : isTop1(c, "W", n) ? "top 1" : "top 2", pay1: p.first, pay2: p.second });
    if (isFinal(n)) break;
    n = nAfter;
  }
  return { field: s.N, main: rows, scBase: s.baseL, mainPot: s.N * c.entryFee - cutOf(c, s.N * c.entryFee) + c.guaranteedPool };
}

async function batched(DB: D1Database, stmts: D1PreparedStatement[], size = 500): Promise<number> {
  let rows = 0;
  for (let i = 0; i < stmts.length; i += size) for (const r of await DB.batch(stmts.slice(i, i + size))) rows += r.meta?.rows_written ?? 0;
  return rows;
}

export { transferStatements };
