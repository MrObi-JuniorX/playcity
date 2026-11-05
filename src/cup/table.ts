import { DurableObject } from "cloudflare:workers";
import * as C from "./tablecore";
import { checkSeatToken, resultSig } from "./tokens";
import type { DirectorEnv } from "./director";

/* CupTable: one per cup table (docs/whot-cup-prd.md 6.5, Phase 6). The rules live in tablecore.ts; this object holds
   the sockets, checks seat tokens, keeps the state in ONE row while the table runs, reports the result to the
   director and deletes itself after the reveal window.

   A separate class from the free WhotTable on purpose. The free table's seat requests, invite keys, computer-seat
   takeovers, rematches and adoptState (a game handed in by a browser) don't exist here at all, rather than being
   switched off, so no setting or bug can turn them on at a cup table (TB-1, TB-2). The rules engine and the message
   shapes are the same, so the same browser client draws both.

   Who connects (the Worker route, src/cup/routes.ts, has already checked the cup and the session):
     a player   ?token=…, signed in as the player the token names. Wrong, expired or someone else's tokens are
                refused (SE-4, S-5). A second device with the same seat takes it over and the first one watches.
     a watcher  no token: the public view only, spectatorDelayMoves behind (TB-7), when the cup allows watchers.
   The table is created by its first connection, from the director's own record of it (tableSpec): nobody can
   invent a table, choose its players or hand it a deck.

   Cost: hibernatable sockets, no timers (one alarm: the deal, the clocks, the report, the clean-up), one row
   written per move, deleted REVEAL_MS after the table ends. */

interface Conn { seat: number | null; vid: string; at: number; chatAt: number }
const MAX_WATCH = 200;      // watchers per table; the Grand Final's big audience is Phase 8's job
const MAX_MSG = 2048;       // a move is under 100 bytes
const CHAT_GAP_MS = 2500;   // one preset phrase per player every 2.5 s
const att = (w: WebSocket) => w.deserializeAttachment() as Conn;

export class CupTable extends DurableObject<DirectorEnv> {
  private t: C.TableState | null | undefined;      // undefined: not read since waking
  private ready = false;
  private reporting = false;
  private written = 0;
  private saved = "";                               // the row as last read or written: an unchanged table writes nothing

  constructor(ctx: DurableObjectState, env: DirectorEnv) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /* ---------- one row ---------- */
  private ensure() { if (!this.ready) { this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS t (k INTEGER PRIMARY KEY, v TEXT NOT NULL)"); this.ready = true; } }
  private load(): C.TableState | null {
    if (this.t === undefined) {
      this.ensure();
      const r = this.ctx.storage.sql.exec("SELECT v FROM t WHERE k = 1").toArray()[0];
      this.saved = r ? String(r.v) : "";
      this.t = r ? JSON.parse(this.saved) as C.TableState : null;
    }
    return this.t;
  }
  private save(t: C.TableState) {
    const row = JSON.stringify(t);   // cf-lint-allow: storage, never a message
    if (row === this.saved) return;
    this.ensure();
    const cur = this.ctx.storage.sql.exec("INSERT INTO t (k, v) VALUES (1, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", row);
    cur.toArray();
    this.saved = row;
    this.written += cur.rowsWritten;
  }

  /* ---------- connections ---------- */

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const code = req.headers.get("X-Cup-Table") || "", cupId = req.headers.get("X-Cup-Id") || "";
    const player = req.headers.get("X-Cup-Player") || null;
    const tok = new URL(req.url).searchParams.get("token");
    // The first connection creates the table from the director's record; others wait for that, then find it.
    const initError = await this.ctx.blockConcurrencyWhile(async (): Promise<string | null> => {
      if (this.load() || !cupId || !code) return null;
      const r = await this.env.CUP.getByName(cupId).tableSpec(code);
      if (!r.spec) return r.error ?? "no-table";
      this.t = C.newTable(r.spec);
      this.save(this.t);
      return null;
    });
    const t = this.load(), now = Date.now();
    let refuse: [number, string] | null = initError ? [4004, initError] : null;
    if (!refuse && (!t || t.spec.code !== code || t.spec.cupId !== cupId)) refuse = [4004, "no-table"];

    let seat: number | null = null;
    if (!refuse && t) {
      if (tok !== null) {
        const i = player ? t.spec.players.indexOf(player) : -1;
        if (!player) refuse = [4001, "signed-out"];
        else if (i < 0 || !this.env.PHONE_HMAC_KEY) refuse = [4003, "not-your-seat"];
        else {
          const ok = await checkSeatToken(this.env.PHONE_HMAC_KEY, tok, cupId, t.spec.slot, code, i, player, now);
          if (ok === "ok") seat = i; else refuse = [4003, ok === "expired" ? "token-expired" : "bad-token"];
        }
      } else if (t.spec.rules.spectators !== "delayed") refuse = [4011, "no-watchers"];
      else if (this.open().filter(w => att(w).seat === null).length >= MAX_WATCH) refuse = [4010, "full"];
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ seat, vid: crypto.randomUUID().slice(0, 8), at: now, chatAt: 0 } satisfies Conn);
    if (refuse) { server.close(refuse[0], refuse[1]); return new Response(null, { status: 101, webSocket: client }); }

    // One connection per seat (ID-5): a second device takes the seat; the first one watches, or goes if nobody may.
    const fresh = [server];
    if (seat !== null) for (const w of this.open()) {
      const c = att(w);
      if (w === server || c.seat !== seat) continue;
      w.serializeAttachment({ ...c, seat: null });
      this.sendRaw(w, JSON.stringify({ t: "moved" }));
      if (t!.spec.rules.spectators !== "delayed") w.close(4012, "moved"); else fresh.push(w);
    }
    await this.commit([], Date.now(), fresh);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || raw.length > MAX_MSG) return this.nope(ws, "bad-message");
    let m: Record<string, unknown>;
    try { m = JSON.parse(raw); } catch { return this.nope(ws, "bad-message"); }
    if (!m || typeof m !== "object" || Array.isArray(m)) return this.nope(ws, "bad-message");
    const t = this.load(), c = att(ws);
    if (!t) return;
    if (c.seat === null) return this.nope(ws, "watching");          // watchers can't send anything
    const now = Date.now(), seat = c.seat;

    if (m.t === "play" || m.t === "market") {
      const mv = parseMove(m);
      if (!mv) return this.nope(ws, "bad-move");
      this.reconcile(t, now);
      const due = C.settle(t, now);                                      // anything already due comes first (the clock)
      const r = C.move(t, seat, mv, now);
      if (!r.ok) { this.nope(ws, r.reason); if (due.length) await this.commit(due, now); return; }
      return this.commit([...due, ...r.steps], now);
    }
    if (m.t === "chat") {
      const id = m.id;
      if (t.spec.rules.chat !== "presets" || !Number.isInteger(id) || (id as number) < 0 || (id as number) >= C.PRESETS.length) return this.nope(ws, "no-chat");
      if (now - c.chatAt < CHAT_GAP_MS) return this.nope(ws, "slow-down");
      ws.serializeAttachment({ ...c, chatAt: now });
      const msg = JSON.stringify({ t: "chat", seat, name: t.names[seat], id, text: C.PRESETS[id as number] });
      for (const w of this.open()) if (att(w).seat !== null) this.sendRaw(w, msg);
      return;
    }
    if (m.t === "rtc" || m.t === "talk") return this.voice(t, ws, c, m);
    return this.nope(ws, "unknown");
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try { ws.close(code === 1005 ? 1000 : code, reason); } catch { /* already closed */ }
    await this.commit([], Date.now());
  }
  async webSocketError(): Promise<void> { await this.commit([], Date.now()); }
  async alarm(): Promise<void> { if (this.load()) await this.commit([], Date.now()); }

  /* ---------- the heart: settle, save, tell everyone ---------- */

  private reconcile(t: C.TableState, now: number) {
    const here = new Set(this.open().map(w => att(w).seat));
    t.seats.forEach((_, i) => C.setConn(t, i, here.has(i), now));
  }

  /** `fresh`: sockets that just arrived (or just became watchers) and need the whole picture, not just what changed. */
  private async commit(pre: C.Step[], now: number, fresh: WebSocket[] = []) {
    const t = this.load();
    if (!t) return;
    this.reconcile(t, now);
    const steps = [...pre, ...C.settle(t, now)];
    if (C.closing(t, now)) return this.close();
    const spect = C.spectatorUpdate(t);
    this.save(t);
    await this.schedule(t, now);
    this.broadcast(t, steps, spect, now, fresh);
    if (t.phase === "done" && t.report.state === "pending" && now >= t.report.next) await this.report(t);
  }

  private broadcast(t: C.TableState, steps: C.Step[], spect: { steps: string[]; sync: string | null }, now: number, fresh: WebSocket[]) {
    const open = this.open();
    const watching = open.filter(w => att(w).seat === null).length;
    const group = t.spec.rules.voice === "seated" ? open.filter(w => { const s = att(w).seat; return s !== null && C.person(t, s); }) : [];
    for (const ws of open) {
      const c = att(ws);
      if (c.seat !== null) {
        const m = C.meta(t, c.seat, now, { watching, voice: this.voiceOf(t, c, group) });
        const seat = c.seat;
        if (!t.g) { this.sendRaw(ws, `{"t":"wait",${m}}`); continue; }
        if (!steps.length) { this.sendRaw(ws, `{"t":"sync",${C.seatSync(t, seat)},${m}}`); continue; }
        for (const s of steps) this.sendRaw(ws, `{"t":"step","kind":"${s.kind}","actor":${s.actor},"cpu":${s.cpu},"n":${s.n},${s.views[seat]},${m}}`);
      } else {
        const m = C.meta(t, null, now, { watching, voice: NO_VOICE });
        if (fresh.includes(ws)) { const v = C.watchView(t); this.sendRaw(ws, v ? `{"t":"sync",${v},${m}}` : `{"t":"wait",${m}}`); continue; }
        for (const s of spect.steps) this.sendRaw(ws, `{"t":"step",${s},${m}}`);
        if (spect.sync) this.sendRaw(ws, `{"t":"sync",${spect.sync},${m}}`);
      }
    }
  }

  /** The result, signed, to the director (TB-5). Retried with backoff until it lands or can never land. */
  private async report(t: C.TableState) {
    if (this.reporting) return;
    this.reporting = true;
    let r: { ok: boolean; error?: string } | null = null;
    try {
      const { places, stats } = C.resultOf(t);
      const sig = this.env.PHONE_HMAC_KEY ? await resultSig(this.env.PHONE_HMAC_KEY, t.spec.cupId, t.spec.code, places, stats) : "";
      r = await this.env.CUP.getByName(t.spec.cupId).report(t.spec.code, places, sig, stats);
    } catch (e) {
      console.warn(JSON.stringify({ msg: "cup table report failed", cup: t.spec.cupId, table: t.spec.code, error: String(e) }));
    } finally { this.reporting = false; }
    const now = Date.now();
    C.reported(t, r, now);
    if (r && !r.ok) console.warn(JSON.stringify({ msg: "cup table report refused", cup: t.spec.cupId, table: t.spec.code, error: r.error }));
    this.save(t);
    await this.schedule(t, now);
  }

  private async schedule(t: C.TableState, now: number) {
    const at = C.wakeAt(t, now);
    if (at) await this.ctx.storage.setAlarm(at);
    else await this.ctx.storage.deleteAlarm();
  }

  /** The reveal window is over: everyone is told, and the row goes. */
  private async close() {
    for (const w of this.open()) { try { w.close(4005, "table-closed"); } catch { /* gone */ } }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.t = null; this.ready = false; this.saved = "";
  }

  /* ---------- voice (TB-6): signalling passed between seated people only, never stored ---------- */

  private voiceOf(t: C.TableState, c: Conn, group: WebSocket[]) {
    const mine = c.seat !== null && group.some(w => att(w).vid === c.vid);
    return { all: false, owner: false, me: mine ? c.vid : null, peers: mine ? group.map(att).filter(x => x.vid !== c.vid).map(x => ({ vid: x.vid, name: t.names[x.seat!], seat: x.seat })) : [] };
  }
  private voice(t: C.TableState, ws: WebSocket, c: Conn, m: Record<string, unknown>) {
    if (t.spec.rules.voice !== "seated") return this.nope(ws, "no-voice");
    const group = this.open().filter(w => { const s = att(w).seat; return s !== null && C.person(t, s); });
    if (!group.includes(ws)) return;
    if (m.t === "rtc") {
      if (typeof m.to !== "string" || m.to === c.vid || !m.d || typeof m.d !== "object") return;
      const target = group.find(w => att(w).vid === m.to);
      if (target) this.sendRaw(target, JSON.stringify({ t: "rtc", from: c.vid, d: m.d }));
      return;
    }
    const msg = JSON.stringify({ t: "talk", vid: c.vid, on: m.on === true });
    for (const w of group) if (w !== ws) this.sendRaw(w, msg);
  }

  /** Rows written since the last call (cost tests). */
  async rowsWritten(): Promise<number> { const n = this.written; this.written = 0; return n; }

  private open(): WebSocket[] { return this.ctx.getWebSockets().filter(w => w.readyState === WebSocket.OPEN); }
  private sendRaw(ws: WebSocket, s: string) { try { ws.send(s); } catch { /* closing */ } }
  private nope(ws: WebSocket, reason: string) { this.sendRaw(ws, JSON.stringify({ t: "nope", reason })); }
}

const NO_VOICE = { all: false, owner: false, me: null, peers: [] };

/** A move as the table accepts it: anything else is refused before it reaches the engine (S-4). */
export function parseMove(m: Record<string, unknown>): C.MoveMsg | null {
  if (!Number.isInteger(m.turn) || (m.turn as number) < 0) return null;
  if (m.t === "market") return { t: "market", turn: m.turn as number };
  if (!Array.isArray(m.ids) || m.ids.length < 1 || m.ids.length > 8 || !m.ids.every(x => Number.isInteger(x) && x >= 0 && x < 54)) return null;
  if (m.shape !== undefined && (typeof m.shape !== "string" || m.shape.length > 10)) return null;
  return { t: "play", ids: m.ids as number[], shape: m.shape as string | undefined, turn: m.turn as number };
}
