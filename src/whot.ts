import { DurableObject } from "cloudflare:workers";
import * as W from "../public/whot/engine.js";
import type { Game, WhotEvent } from "../public/whot/engine.js";

/* One WhotTable per table code: 2 to 4 seats, each held by a person or by the computer.
   The table is the only authority. Browsers send moves; the table checks them against its own state, runs the
   computer's turns, and sends every connection its own view (seatView), so nobody's browser ever holds another
   player's cards or the market order. Whot is turn based: a few messages a minute, not 60 a second, so a server
   round trip costs nothing anyone can feel, and there is no host whose tab can leave or peek.

   Seats change hands, with consent. Watching is free for anyone. Sitting in a computer's seat (and taking its cards)
   needs the table's say-so: someone with the invite link (it carries the table's key) sits at once, and anyone else
   asks. The request waits in their own connection's attachment (so the table stays storage-free for it), every
   seated person is told, any of them can accept or decline, and with no answer it is accepted after ASK_MS so an
   idle player cannot block a table. With nobody seated there is no one to ask, so it is accepted at once.

   Leaving and losing the connection are different things, and a poor network should cost as little as possible:
   - Leaving on purpose (Leave, or Watch instead, which send "stand") hands the seat to the computer at once, under
     the computer's name, with no claim kept.
   - Losing the connection (a tunnel, a weak signal, a reload, a phone switching apps) HOLDS the seat for HOLD_MS: the
     seat keeps the person's name and is shown as reconnecting, nobody else can take it, and the computer covers
     their turns. The first of their turns while they are away waits GRACE_MS for them first. The same browser
     (the id kept in its storage) takes the seat back the moment it reconnects, without asking anyone. After HOLD_MS
     the seat takes the computer's name, but the claim stays: it is still theirs on return unless someone else sat.
   - A connection that has gone quiet (no ping for STALE_MS: a phone that lost signal often leaves a socket that
     never says it closed) is treated as lost, not as a player ignoring the clock, so it never costs them strikes.
   - Reconnecting while the table still thinks the old connection is open replaces that connection at once: the new
     one takes the seat, the old one is closed (4011), and nobody sees a thing.
   A player who is connected but sits idle past the turn clock has a move made for them, and after two in a row their
   seat goes back to the computer; they are asked before taking it back.

   Cost: the table hibernates between messages. Because hibernation drops memory, the table keeps ONE small row
   (the game, about 5 KB) in its SQLite storage, rewritten once per human move. Computer turns run at once in the
   same invocation, and the browsers pace them for display, so no timers run here. One alarm covers the turn clock
   (only when two or more people are seated) and the clean-up: ten minutes after the last person leaves, the row is
   deleted. That is long enough for a host who switched apps to send the invite link (a phone drops the connection
   within seconds) to come back to their table, and for the friend's link to still find it. */

interface Ask { seat: number; until: number; rid: string }   // seat -1: any open seat; rid is public, the connection id is not
interface Seat {
  cpuName: string; id: string | null; prev: string | null; strikes: number;
  prevName?: string;   // the name they had
  away?: boolean;      // they stopped answering while connected (so no automatic seat back)
  hold?: number;       // lost connection: the seat is kept for them, under their name, until this time
  wait?: boolean;      // lost connection: their next turn waits GRACE_MS for them, once
}   // prev: who sat here last
interface Gone { orig: number; seat: Seat; name: string; tally: { w: number; l: number } }   // knocked out of a tournament: kept to bring back
interface Table {
  g: Game; seats: Seat[]; listed: boolean; key: string; tally: { w: number; l: number }[];
  owner: string; voiceAll: boolean;   // owner: the creator's connection id; voiceAll: the walkie-talkie is open to watchers too
  out: Gone[]; ord: number[];   // out: knocked out so far; ord: each current seat's place in the full field

  round: number; scored: number; dl: number; dlTurn: number; emptyAt: number;
  grace: { seat: number; until: number; name: string } | null;   // a dropped player's turn, held briefly
}
interface Conn { id: string; name: string; seat: number | null; vid: string; at: number; trusted?: boolean; ask?: Ask | null }   // vid: this connection's public voice id; at: when it connected
interface Captured { kind: string; actor: number | null; cpu: boolean; views: Map<number | null, string> }

const TURN_MS = 45_000;       // turn clock for a person
const PACE_MS = 1_200;        // browsers show each computer turn for about this long
const ANIM_MS = 1_500;        // allowance for the animation of the move before yours
const EMPTY_MS = 600_000;     // keep an empty table this long, for a reload, a dropped connection or a host away sending the link
const STRIKES = 2;            // turns timed out in a row before the seat goes back to the computer
const GRACE_MS = 15_000;      // a dropped player's next turn waits this long for them before the computer moves
const HOLD_MS = 60_000;       // a dropped player's seat is kept for them, under their name, this long
const STALE_MS = 40_000;      // no ping for this long: the connection is gone, whatever the socket says (browsers ping every 10 s; older ones 25 s)
const ASK_MS = 15_000;        // a seat request is accepted on its own after this, unless someone declines
const ASK_COOLDOWN_MS = 30_000; // after a "not now", the same person waits this long to ask again
const MAX_ASKS = 4;           // requests waiting at once
const MAX_CONN = 40;          // players plus watchers
const VOICE_MAX = 8;          // people on the walkie-talkie at once (every pair is a direct link): seated people first
const MAX_MSG = 32 * 1024;    // a seeded game is about 6 KB
const ID = /^[A-Za-z0-9_-]{8,40}$/;

const KEY_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newKey = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), b => KEY_CHARS[b & 31]).join("");
const cleanName = (v: unknown, fallback: string) => {
  const s = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 14) : "";
  return s || fallback;
};

export class WhotTable extends DurableObject<Env> {
  private t: Table | null | undefined;   // undefined: not read yet since waking
  private denied = new Map<string, number>();   // connection id -> may ask again at. In memory only: losing it on hibernation is harmless

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const url = new URL(request.url);
    const qid = url.searchParams.get("id") || "";
    const conn: Conn = {
      id: ID.test(qid) ? qid : crypto.randomUUID(),
      name: cleanName(url.searchParams.get("name"), "Guest"),
      seat: null, vid: crypto.randomUUID().slice(0, 8), at: Date.now()
    };
    const create = url.searchParams.get("create") === "1";
    const t = this.load();
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(conn);

    if (create && t) server.close(4009, "taken");
    else if (!create && !t) server.close(4004, "no-table");
    else if (this.open().length > MAX_CONN) server.close(4010, "full");
    else if (create) this.send(server, { t: "empty" });   // the creator answers with {t:"create"}
    else {
      const tb = t as Table;
      tb.emptyAt = 0;
      const now = Date.now();
      this.sweep(tb, now, server);
      this.reconcile(tb);
      this.expire(tb, now);
      const k = url.searchParams.get("k") || "";
      conn.trusted = k.length > 0 && k === tb.key;                 // arrived by the invite link
      server.serializeAttachment(conn);
      // Back after a dropped connection the table had not noticed yet: this connection replaces the old one.
      const old = this.open().find(w => { const c = w.deserializeAttachment() as Conn; return w !== server && c.id === conn.id && c.seat !== null; });
      // Back after a reload or a dropped connection: take your seat again if the computer still has it.
      const mine = tb.seats.findIndex(s => s.id === null && s.prev === conn.id && !s.away);
      if (old) this.replace(tb, old, server, conn);
      else if (mine >= 0) this.take(tb, mine, server, conn);
      else if (url.searchParams.get("sit") === "1") this.requestSeat(tb, server, conn, -1);   // sits at once, or asks
      this.settleAsks(tb, Date.now());
      const steps: Captured[] = [];
      this.drive(tb, steps);
      await this.commit(tb, steps);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || raw.length > MAX_MSG) return;
    let m: Record<string, unknown>;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== "object") return;
    const conn = ws.deserializeAttachment() as Conn;
    let t = this.load();

    if (m.t === "create") {
      if (t) return this.nope(ws, "exists");
      t = this.create(m, ws, conn);
      if (!t) return this.nope(ws, "bad-create");
      const steps: Captured[] = [];
      if (!m.seed) steps.push(this.capture(t, "deal", null, false));   // a seeded game carries on where it was
      this.drive(t, steps);
      return this.commit(t, steps);
    }
    if (!t) return;
    // Walkie-talkie signalling: passed straight through between SEATED people only. Watchers can neither send
    // nor receive it, so they are never connected to anyone's microphone. No state changes, nothing stored.
    if (m.t === "rtc" || m.t === "talk") return this.voice(t, ws, conn, m);
    this.sweep(t, Date.now(), ws);
    this.reconcile(t);
    this.expire(t, Date.now());
    this.settleAsks(t, Date.now());
    const g = t.g, seat = (ws.deserializeAttachment() as Conn).seat;
    const steps: Captured[] = [];

    switch (m.t) {
      case "play":
      case "market": {
        if (seat === null || g.over || g.current !== seat) return this.nope(ws, "not-your-turn");
        if (m.turn !== g.turns) return this.nope(ws, "stale");
        g.events = [];
        const r = m.t === "play"
          ? W.play(g, Array.isArray(m.ids) ? (m.ids as unknown[]).filter(Number.isInteger).slice(0, 8) as number[] : [], typeof m.shape === "string" ? m.shape : undefined)
          : W.market(g);
        if (!r.ok) return this.nope(ws, r.reason || "illegal");
        t.seats[seat].strikes = 0;
        steps.push(this.capture(t, m.t, seat, false));
        break;
      }
      case "sit": {
        if (seat !== null) return this.nope(ws, "seated");
        if (conn.ask) return this.nope(ws, "asking");
        if (typeof m.name === "string") { conn.name = cleanName(m.name, conn.name); ws.serializeAttachment(conn); }      // a watcher gives their name as they sit
        const why = this.requestSeat(t, ws, conn, Number.isInteger(m.seat) ? m.seat as number : -1);
        if (why) return this.nope(ws, why);
        break;
      }
      case "cancel": {
        if (conn.ask) ws.serializeAttachment({ ...conn, ask: null });
        break;
      }
      case "answer": {   // a seated person accepts or declines someone's request
        if (seat === null) return;
        const hit = this.asks().find(x => x.c.ask!.rid === m.rid);
        if (!hit) break;                                   // already answered by someone else
        if (m.ok === true) this.grant(t, hit.w, hit.c);
        else {
          this.denied.set(hit.c.id, Date.now() + ASK_COOLDOWN_MS);
          hit.w.serializeAttachment({ ...hit.c, ask: null });
          this.send(hit.w, { t: "denied", by: conn.name, reason: "declined" });
        }
        break;
      }
      case "stand": {   // leaving on purpose: no hold, no claim
        if (seat === null) return;
        this.release(t, seat, "stood up", "gone");
        t.seats[seat].prev = null;
        ws.serializeAttachment({ ...(ws.deserializeAttachment() as Conn), seat: null });   // this connection watches now
        break;
      }
      case "again": {
        if (seat === null || !g.over) return;
        t.round++;
        this.nextRound(t, m.all === true);
        steps.push(this.capture(t, "deal", null, false));
        break;
      }
      case "list": {
        if (seat === null) return;
        t.listed = !!m.on;
        break;
      }
      case "voiceall": {   // the owner opens the walkie-talkie to everyone, watchers included
        if (!this.isOwner(t, conn.id)) return;
        t.voiceAll = !!m.on;
        break;
      }
      default: return;
    }
    this.settleAsks(t, Date.now());      // this move may have left nobody to answer
    this.drive(t, steps);
    await this.commit(t, steps);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try { ws.close(code === 1005 ? 1000 : code, reason); } catch { /* already closed */ }
    await this.left(ws);
  }
  async webSocketError(ws: WebSocket): Promise<void> { await this.left(ws); }

  /* One alarm: the turn clock of the person whose turn it is, or the clean-up of an empty table. */
  async alarm(): Promise<void> {
    const t = this.load();
    if (!t) return;
    const now = Date.now();
    if (!this.open().length) {
      if (t.emptyAt && now >= t.emptyAt - 500) { await this.ctx.storage.deleteAll(); this.t = null; return; }
      return this.schedule(t);
    }
    this.sweep(t, now);          // a silent connection is a lost one, not an idle player: no strikes for it
    this.reconcile(t);
    this.expire(t, now);
    this.settleAsks(t, now);
    const g = t.g, steps: Captured[] = [];
    if (t.grace && now >= t.grace.until - 250) t.grace = null;      // not back in time: the computer plays on
    if (!g.over && t.dl && now >= t.dl - 500 && g.turns === t.dlTurn && g.players[g.current].type === "human") {
      const i = g.current, seat = t.seats[i];
      W.say(g, g.players[i].name + " ran out of time, so the computer moved for them.", "warn");
      g.events = [];
      W.applyMove(g, W.aiMoveFair(g));
      steps.push(this.capture(t, "auto", i, false));
      if (++seat.strikes >= STRIKES && t.seats[i].id) {
        const ws = this.open().find(w => (w.deserializeAttachment() as Conn).seat === i);
        this.release(t, i, "is away", "gone");
        seat.away = true;       // the seat stays theirs to take back, but only when they say so (they are asked when they return)
        if (ws) ws.serializeAttachment({ ...(ws.deserializeAttachment() as Conn), seat: null });
      }
    }
    this.drive(t, steps);
    await this.commit(t, steps);
  }

  /* ---------------- table state ---------------- */

  private load(): Table | null {
    if (this.t === undefined) this.t = this.ctx.storage.kv.get<Table>("t") ?? null;
    if (this.t && !this.t.key) this.t.key = newKey();
    if (this.t && this.t.voiceAll === undefined) { this.t.voiceAll = false; this.t.owner = this.t.owner || ''; }
    if (this.t && !this.t.out) { this.t.out = []; this.t.ord = this.t.seats.map((_, i) => i); }   // a table saved before knock-out rounds
    return this.t;
  }

  private create(m: Record<string, unknown>, ws: WebSocket, conn: Conn): Table | null {
    const list = m.seats;
    if (!Array.isArray(list) || list.length < 2 || list.length > 4) return null;
    const me = Number.isInteger(m.me) && (m.me as number) >= 0 && (m.me as number) < list.length ? m.me as number : 0;
    // Every seat has a computer name, used whenever nobody is sitting there. Other people's seats from a
    // same-screen game become open seats online: the computer holds them until someone sits.
    const cpuNames: string[] = list.map(() => "");
    const order = [...list.keys()].filter(i => i !== me).concat(me);   // the creator's seat is named last
    for (const i of order) {
      const s = list[i];
      const given = i !== me && s && typeof s === "object" && (s as { type?: unknown }).type === "cpu" ? (s as { name?: unknown }).name : null;
      let name = cleanName(given, "Computer");
      for (let k = 2; cpuNames.includes(name); k++) name = "Computer " + k;
      cpuNames[i] = name;
    }
    const names = list.map((_, i) => i === me ? conn.name : cpuNames[i]);
    if (names.some((n, i) => i !== me && n === conn.name)) names[me] = conn.name + " 2";
    const seats: Seat[] = list.map((_, i) => ({ cpuName: cpuNames[i], id: null, prev: null, strikes: 0 }));
    const players = names.map((name, i) => ({ name, type: (i === me ? "human" : "cpu") as "human" | "cpu" }));
    const g = m.seed ? W.adoptState(m.seed, players) : W.newGame(players, W.rand(list.length));
    if (!g) return null;
    const tally = Array.isArray(m.tally) && m.tally.length === list.length
      ? m.tally.map(x => ({ w: Number.isInteger(x?.w) ? Math.min(x.w, 999) : 0, l: Number.isInteger(x?.l) ? Math.min(x.l, 999) : 0 }))
      : list.map(() => ({ w: 0, l: 0 }));
    const t: Table = { g, seats, listed: m.listed === true, key: newKey(), tally, owner: conn.id, voiceAll: false, out: [], ord: seats.map((_, i) => i), round: 1, scored: 0, dl: 0, dlTurn: -1, emptyAt: 0, grace: null };
    seats[me].id = conn.id;
    ws.serializeAttachment({ ...conn, seat: me });
    this.t = t;
    return t;
  }

  /* Deal the next round. With three or more players and at least two of them people, whoever lost the last round is
     out (tourPlan); the last two play for the title, and after that, or when someone asks for "everyone", all the
     seats come back. Otherwise it is an ordinary rematch. */
  private nextRound(t: Table, all: boolean) {
    const g = t.g, plan = W.tourPlan(g, t.out.length);
    const bring = all || plan.mode === "final";
    const drop = all ? [] : plan.elim;
    const n = g.players.length;
    type Row = { orig: number; seat: Seat; name: string; type: "human" | "cpu"; tally: { w: number; l: number }; old: number | null };
    const rows: Row[] = [];
    t.seats.forEach((seat, i) => {
      if (drop.includes(i)) {
        // Out. A person's connection stays open and watches; their seat id is kept so they get it back with the field.
        t.out.push({ orig: t.ord[i], seat: { ...seat, prev: seat.id ?? seat.prev, id: null, strikes: 0, hold: undefined, wait: undefined }, name: g.players[i].name, tally: t.tally[i] });
      } else rows.push({ orig: t.ord[i], seat, name: g.players[i].name, type: g.players[i].type, tally: t.tally[i], old: i });
    });
    const back: Row[] = [];
    if (bring) {
      for (const o of t.out) { const r: Row = { orig: o.orig, seat: o.seat, name: o.seat.cpuName, type: "cpu", tally: o.tally, old: null }; rows.push(r); back.push(r); }
      t.out = [];
    }
    rows.sort((a, b) => a.orig - b.orig);
    const at = (old: number) => rows.findIndex(r => r.old === old);          // -1: not at the table any more
    // First to play: the next seat after last round's first player who is still in.
    let starter = 0;
    for (let k = 1; k <= n; k++) { const j = at((g.starter + k) % n); if (j >= 0) { starter = j; break; } }

    t.seats = rows.map(r => r.seat); t.ord = rows.map(r => r.orig); t.tally = rows.map(r => r.tally); t.grace = null;
    for (const w of this.open()) {          // connections follow their seats; anyone knocked out watches
      const c = w.deserializeAttachment() as Conn;
      const seatNow = c.seat === null ? -1 : at(c.seat);
      const want = c.ask && c.ask.seat >= 0 ? at(c.ask.seat) : -1;
      w.serializeAttachment({ ...c, seat: seatNow >= 0 ? seatNow : null, ...(c.ask ? { ask: want >= 0 || c.ask.seat < 0 ? { ...c.ask, seat: want } : null } : {}) });
    }
    const names = new Set<string>();
    const players = rows.map(r => { let name = r.name; for (let k = 2; names.has(name); k++) name = `${r.name} ${k}`; names.add(name); return { name, type: r.type }; });
    t.g = W.newGame(players, starter);
    // Anyone who was knocked out and is still connected sits back down in their own seat.
    for (const r of back) {
      if (!r.seat.prev) continue;
      const i = rows.indexOf(r), w = this.open().find(x => { const c = x.deserializeAttachment() as Conn; return c.id === r.seat.prev && c.seat === null; });
      if (w) this.take(t, i, w, w.deserializeAttachment() as Conn);
    }
  }

  /* Who is on the walkie-talkie: every seated person, and when the owner has opened it to all, watchers too, up to
     VOICE_MAX with seated people first. Each is known to the others only by a public voice id (vid) that belongs
     to one connection, so a seat changing hands or a reload always means fresh links. */
  private voiceGroup(t: Table, open: WebSocket[]): { ws: WebSocket; vid: string; name: string; seat: number | null }[] {
    const rows = open.map(ws => ({ ws, c: ws.deserializeAttachment() as Conn }))
      .filter(x => (x.c.seat !== null && !!t.seats[x.c.seat]?.id) || t.voiceAll)
      .sort((a, b) => ((a.c.seat === null ? 1 : 0) - (b.c.seat === null ? 1 : 0)) || (a.c.seat ?? 0) - (b.c.seat ?? 0) || a.c.at - b.c.at);
    return rows.slice(0, VOICE_MAX).map(x => ({ ws: x.ws, vid: x.c.vid, name: x.c.seat !== null ? t.g.players[x.c.seat].name : x.c.name, seat: x.c.seat }));
  }

  /* The creator, or while the creator is away, the lowest seated person. */
  private isOwner(t: Table, id: string): boolean {
    const open = this.open().map(w => w.deserializeAttachment() as Conn);
    if (open.some(c => c.id === t.owner)) return id === t.owner;
    const seated = open.filter(c => c.seat !== null).sort((a, b) => (a.seat as number) - (b.seat as number));
    return seated.length > 0 && seated[0].id === id;
  }

  /* Walkie-talkie signalling: passed straight through between people in the group. Nobody outside it can send or
     receive any of it. No state changes, nothing stored. */
  private voice(t: Table, ws: WebSocket, conn: Conn, m: Record<string, unknown>) {
    const group = this.voiceGroup(t, this.open());
    if (!group.some(g => g.ws === ws)) return;
    if (m.t === "rtc") {
      const d = m.d;
      if (typeof m.to !== "string" || m.to === conn.vid || !d || typeof d !== "object") return;
      const target = group.find(g => g.vid === m.to);
      if (target) this.sendRaw(target.ws, JSON.stringify({ t: "rtc", from: conn.vid, d }));
      return;
    }
    const msg = JSON.stringify({ t: "talk", vid: conn.vid, on: m.on === true });
    for (const g of group) if (g.ws !== ws) this.sendRaw(g.ws, msg);
  }

  /* Sit at once (the invite link, or nobody here to ask), or put a request on this connection. Returns why not. */
  private requestSeat(t: Table, ws: WebSocket, conn: Conn, want: number): string | null {
    const own = t.seats.findIndex(s => s.id === null && s.prev === conn.id);      // your own seat, left a while ago: no need to ask anyone
    if (own >= 0 && (want < 0 || want === own)) { this.take(t, own, ws, conn); return null; }
    if (want >= 0 && t.seats[want] && this.held(t.seats[want], Date.now())) return "seat-held";   // kept for someone reconnecting
    const free = want >= 0 ? (t.seats[want]?.id === null ? want : -1) : this.freeSeat(t);
    if (free < 0) return "seat-taken";
    if (conn.trusted || !t.seats.some(s => s.id)) { this.take(t, free, ws, conn); return null; }
    if ((this.denied.get(conn.id) ?? 0) > Date.now()) return "cooldown";
    if (this.asks().length >= MAX_ASKS) return "busy";
    ws.serializeAttachment({ ...conn, ask: { seat: want, until: Date.now() + ASK_MS, rid: crypto.randomUUID().slice(0, 8) } });
    return null;
  }

  private asks(): { w: WebSocket; c: Conn }[] {
    return this.open().map(w => ({ w, c: w.deserializeAttachment() as Conn }))
      .filter(x => x.c.ask && x.c.seat === null)
      .sort((a, b) => a.c.ask!.until - b.c.ask!.until);
  }

  /* Seat the requested (else first open) seat for someone whose request was accepted. */
  private grant(t: Table, w: WebSocket, c: Conn) {
    const want = c.ask!.seat;
    const i = want >= 0 && t.seats[want]?.id === null && !this.held(t.seats[want], Date.now()) ? want : this.freeSeat(t);
    if (i < 0) { w.serializeAttachment({ ...c, ask: null }); this.send(w, { t: "denied", reason: "full" }); return; }
    this.take(t, i, w, c);
  }

  /* A computer seat for someone who asked for any seat. Seats nobody has a claim on come first, so a friend arriving
     by link while the host is away (sending that link) gets a computer's cards, not the host's own seat. A seat held
     for someone reconnecting is never handed out. */
  private freeSeat(t: Table): number {
    const now = Date.now();
    const fresh = t.seats.findIndex(s => s.id === null && !s.prev);
    return fresh >= 0 ? fresh : t.seats.findIndex(s => s.id === null && !this.held(s, now));
  }
  private held(s: Seat, now: number): boolean { return s.id === null && !!s.hold && s.hold > now; }

  /* Accept requests nobody answered in time, and all of them when nobody is left to answer. */
  private settleAsks(t: Table, now: number) {
    for (const { w, c } of this.asks()) {
      if (c.ask!.until - 250 <= now || !t.seats.some(s => s.id)) this.grant(t, w, c);
    }
  }

  /* Seats whose person is no longer connected go back to the computer (a deploy or an eviction can drop sockets
     without a close event). */
  private reconcile(t: Table) {
    const held = new Set(this.open().map(w => w.deserializeAttachment() as Conn).filter(c => c.seat !== null).map(c => `${c.seat}:${c.id}`));
    t.seats.forEach((s, i) => { if (s.id && !held.has(`${i}:${s.id}`)) this.release(t, i, "lost connection"); });
  }

  /* When this connection was last heard from: it opened, or the runtime answered its ping (pings never wake the table). */
  private heard(ws: WebSocket): number {
    const c = ws.deserializeAttachment() as Conn;
    return Math.max(c.at, this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0);
  }

  /* Seated connections that have gone quiet are lost connections: close them and hold the seat. They have been gone
     for STALE_MS already, so their turn does not wait for them as well. `except`: the connection that just spoke. */
  private sweep(t: Table, now: number, except?: WebSocket) {
    for (const w of this.open()) {
      const c = w.deserializeAttachment() as Conn;
      if (w === except || c.seat === null || now - this.heard(w) < STALE_MS) continue;
      const i = c.seat;
      w.serializeAttachment({ ...c, seat: null });
      try { w.close(4008, "stale"); } catch { /* already gone */ }
      if (t.seats[i]?.id === c.id) { this.release(t, i, "lost connection"); t.seats[i].wait = false; }
    }
  }

  /* The same browser is back on a new connection while the old one still looks open: hand the seat across quietly. */
  private replace(t: Table, old: WebSocket, ws: WebSocket, conn: Conn) {
    const c = old.deserializeAttachment() as Conn;
    old.serializeAttachment({ ...c, seat: null, ask: null });
    try { old.close(4011, "replaced"); } catch { /* already gone */ }
    if (c.seat !== null && t.seats[c.seat]?.id === conn.id) {
      ws.serializeAttachment({ ...conn, seat: c.seat, ask: null });
      t.seats[c.seat].strikes = 0;
    }
  }

  /* Held seats whose person did not come back in time take the computer's name. The claim stays (prev). */
  private expire(t: Table, now: number) {
    t.seats.forEach((s, i) => {
      if (!s.hold || s.hold > now) return;
      delete s.hold; delete s.wait;
      if (s.id !== null) return;
      const p = t.g.players[i], who = p.name;
      p.name = this.freeName(t, i, s.cpuName);
      if (!t.g.over) W.say(t.g, who + " has not come back yet, so " + p.name + " plays on in their seat.", "warn");
    });
  }

  private take(t: Table, i: number, ws: WebSocket, conn: Conn) {
    const s = t.seats[i], p = t.g.players[i], was = p.name;
    const back = s.prev === conn.id;
    // the same person in a second tab: move them, the old tab becomes a watcher
    for (const w of this.open()) {
      const c = w.deserializeAttachment() as Conn;
      if (w !== ws && c.id === conn.id && c.seat !== null) { this.release(t, c.seat, "moved", "gone"); t.seats[c.seat].prev = null; w.serializeAttachment({ ...c, seat: null }); }
    }
    s.id = conn.id; s.prev = null; s.strikes = 0; delete s.prevName; delete s.away; delete s.hold; delete s.wait;
    if (t.grace?.seat === i) t.grace = null;
    p.type = "human";
    p.name = this.freeName(t, i, conn.name);
    ws.serializeAttachment({ ...conn, seat: i, ask: null });
    W.say(t.g, back ? p.name + " is back." : p.name + " took " + was + "'s seat.", "ok");
  }

  /* The computer takes over a seat. "drop": the connection was lost, so the seat is held for them under their name
     and their next turn waits a little (see drive). "gone": they left or stopped answering, so the computer sits down. */
  private release(t: Table, i: number, why: string, how: "drop" | "gone" = "drop") {
    const s = t.seats[i], p = t.g.players[i];
    if (!s.id) return;
    const who = p.name;
    s.prev = s.id; s.id = null; s.strikes = 0; s.prevName = who;
    p.type = "cpu";
    if (how === "drop") {
      s.hold = Date.now() + HOLD_MS; s.wait = !t.g.over;
      if (!t.g.over) W.say(t.g, who + " " + why + ". Their seat is kept for them.", "warn");
      return;
    }
    delete s.hold; delete s.wait;
    if (t.grace?.seat === i) t.grace = null;
    p.name = this.freeName(t, i, s.cpuName);
    if (!t.g.over) W.say(t.g, who + " " + why + ". " + p.name + " plays their cards.", "warn");
  }

  /* A name nobody else at the table is using: Ada, then Ada 2, Ada 3. */
  private freeName(t: Table, i: number, base: string): string {
    const taken = new Set(t.g.players.filter((_, j) => j !== i).map(p => p.name));
    let name = base;
    for (let k = 2; taken.has(name); k++) name = `${base} ${k}`;
    return name;
  }

  /* Computer turns, played at once while at least one person is seated. With nobody seated the table waits. */
  private drive(t: Table, steps: Captured[]) {
    const g = t.g, now = Date.now();
    let guard = 0;
    if (t.grace && (now >= t.grace.until || t.grace.seat !== g.current || g.over)) t.grace = null;
    while (!g.over && g.players[g.current].type === "cpu" && t.seats.some(s => s.id) && !t.grace && guard++ < 400) {
      const actor = g.current, s = t.seats[actor];
      // Someone who lost their connection: their turn waits a few seconds for them, once, before the computer covers it.
      if (s.wait && this.held(s, now)) {
        s.wait = false;
        t.grace = { seat: actor, until: now + GRACE_MS, name: g.players[actor].name };
        W.say(g, "Holding " + g.players[actor].name + "'s turn for a few seconds.", "warn");
        break;
      }
      g.events = [];
      W.applyMove(g, W.aiMoveFair(g));
      steps.push(this.capture(t, "cpu", actor, true));
    }
  }

  /* The state after one action, as each seat (and the watchers) may see it. */
  private capture(t: Table, kind: string, actor: number | null, cpu: boolean): Captured {
    const g = t.g, views = new Map<number | null, string>();
    const events: WhotEvent[] = g.events;
    for (const seat of [null, ...g.players.map((_, i) => i)]) {
      views.set(seat, JSON.stringify({ v: W.seatView(g, seat), ev: kind === "deal" ? [] : W.seatEvents(events, seat, g.over) }));
    }
    g.events = [];
    return { kind, actor, cpu, views };
  }

  /* Score a finished round, set the clock, save, and tell everyone. */
  private async commit(t: Table, steps: Captured[]) {
    const g = t.g, now = Date.now();
    if (g.over && t.scored !== t.round && g.winner !== null) {
      t.scored = t.round;
      t.tally[g.winner].w++;
      for (const l of g.losers) t.tally[l].l++;
    }
    const cpuSteps = steps.filter(s => s.cpu).length;
    // The clock only runs when someone is waiting on you: two or more people seated.
    if (!g.over && g.players[g.current].type === "human" && t.seats.filter(s => s.id).length >= 2) {
      if (g.turns !== t.dlTurn || steps.length) { t.dl = now + TURN_MS + ANIM_MS + PACE_MS * cpuSteps; t.dlTurn = g.turns; }
    } else { t.dl = 0; t.dlTurn = -1; }
    this.ctx.storage.kv.put("t", t);
    await this.schedule(t);

    const open = this.open();
    const lister = this.listerSeat(t, open);
    const asks = this.asks();
    const group = this.voiceGroup(t, open);
    const watching = open.filter(w => (w.deserializeAttachment() as Conn).seat === null).length;
    for (const ws of open) {
      const c = ws.deserializeAttachment() as Conn;
      const meta = this.meta(t, c, lister, watching, now, asks, group, this.isOwner(t, c.id));
      const msgs: string[] = steps.map((s, k) => {
        const last = k === steps.length - 1;
        return `{"t":"step","kind":"${s.kind}","actor":${s.actor},"cpu":${s.cpu},${s.views.get(c.seat)!.slice(1, -1)},${meta(last)}}`;
      });
      if (!steps.length) msgs.push(`{"t":"sync",${this.capture(t, "sync", null, false).views.get(c.seat)!.slice(1, -1)},${meta(true)}}`);
      for (const msg of msgs) this.sendRaw(ws, msg);
    }
  }

  private meta(t: Table, c: Conn, lister: number | null, watching: number, now: number, asks: { c: Conn }[], group: { vid: string; name: string; seat: number | null }[], owner: boolean) {
    const base = JSON.stringify({
      you: c.seat, seats: t.seats.map((s, i) => ({ name: t.g.players[i].name, human: !!s.id, me: s.id === c.id, ...(this.held(s, now) ? { held: s.hold! - now } : {}) })),
      listed: t.listed, lister: c.seat !== null && c.seat === lister, tally: t.tally, round: t.round, watching, out: t.out.map(o => o.name),
      grace: t.grace ? { seat: t.grace.seat, name: t.grace.name, left: Math.max(0, t.grace.until - now) } : null,
      // Only seated people see who is asking (by a public request id) and the invite key. Watchers see neither.
      asks: c.seat !== null ? asks.map(a => ({ rid: a.c.ask!.rid, name: a.c.name, seat: a.c.ask!.seat, left: Math.max(0, a.c.ask!.until - now) })) : [],
      asking: c.ask ? { seat: c.ask.seat, left: Math.max(0, c.ask.until - now) } : null,
      invite: c.seat !== null ? t.key : undefined, trusted: !!c.trusted,
      // A person who left their seat and still has a claim on it is told, so the page can ask whether to carry on.
      mine: c.seat === null && !t.g.over ? (() => { const i = t.seats.findIndex(x => x.id === null && x.prev === c.id); return i >= 0 ? { seat: i, name: t.seats[i].prevName ?? c.name } : null; })() : null,
      // Walkie-talkie: who you can talk to (empty when you are not in the group), and whether the owner has opened it to all
      voice: { all: t.voiceAll, owner, me: group.some(g => g.vid === c.vid) ? c.vid : null, peers: group.some(g => g.vid === c.vid) ? group.filter(g => g.vid !== c.vid).map(g => ({ vid: g.vid, name: g.name, seat: g.seat })) : [] }
    }).slice(1, -1);
    return (last: boolean) => last && t.dl ? `${base},"left":${Math.max(0, t.dl - now)},"dlTurn":${t.dlTurn}` : base;
  }

  /* The lowest seated person keeps the table listed in the lobby, through their browser (the lobby is socket based
     and storage free; a Durable Object holding outbound sockets would never hibernate). */
  private listerSeat(t: Table, open: WebSocket[]): number | null {
    const seated = open.map(w => (w.deserializeAttachment() as Conn).seat).filter((s): s is number => s !== null);
    return seated.length ? Math.min(...seated) : null;
  }

  private async schedule(t: Table) {
    const someone = this.open().length > 0;
    const times = [t.dl, t.grace?.until ?? 0, !someone ? t.emptyAt : 0, ...(someone ? t.seats.map(s => s.hold ?? 0) : []), ...this.asks().map(a => a.c.ask!.until)].filter(x => x > 0);
    if (times.length) await this.ctx.storage.setAlarm(Math.min(...times));
    else await this.ctx.storage.deleteAlarm();
  }

  private async left(ws: WebSocket) {
    const t = this.load();
    if (!t) return;
    const c = ws.deserializeAttachment() as Conn;
    if (c.seat !== null && t.seats[c.seat]?.id === c.id) this.release(t, c.seat, "lost connection");   // a deliberate leave sends "stand" first
    if (!this.open().length) t.emptyAt = Date.now() + EMPTY_MS;
    this.settleAsks(t, Date.now());
    const steps: Captured[] = [];
    this.drive(t, steps);
    await this.commit(t, steps);
  }

  private open(): WebSocket[] { return this.ctx.getWebSockets().filter(w => w.readyState === WebSocket.OPEN); }
  private send(ws: WebSocket, o: unknown) { this.sendRaw(ws, JSON.stringify(o)); }
  private sendRaw(ws: WebSocket, s: string) { try { ws.send(s); } catch { /* closing */ } }
  private nope(ws: WebSocket, reason: string) { this.send(ws, { t: "nope", reason }); }
}
