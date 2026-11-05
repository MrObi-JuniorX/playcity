import { env, exports } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import * as W from "../../public/whot/engine.js";
import { seatToken } from "../../src/cup/tokens";
import { reconcileAll, reconcileCup } from "../../src/wallet/ledger";
import { DB, director, makeCup, bulkPlayers, bulkEnter, sessionsFor } from "./cupkit";
import type { CupConfig } from "../../src/cup/config";

/* Phase 6 on the wire (docs/whot-cup-prd.md 6.5, 8.1): real CupTable Durable Objects behind the Worker route, real
   sessions and seat tokens, bots that play their own seat from what the table sends them. The rules themselves are
   fuzzed in test/cup/table.test.ts. */

const ORIGIN = "https://play.test";
const KEY = (env as unknown as { PHONE_HMAC_KEY: string }).PHONE_HMAC_KEY;
const tableStub = (code: string) => (env as unknown as { CUP_TABLE: DurableObjectNamespace }).CUP_TABLE.getByName(code) as unknown as DurableObjectStub & { rowsWritten(): Promise<number> };
const peek = runInDurableObject as unknown as (stub: unknown, f: (inst: any, state: DurableObjectState) => unknown) => Promise<any>;

type Sock = Awaited<ReturnType<typeof sock>>;
async function sock(slug: string, code: string, o: { cookie?: string; token?: string; origin?: string | null; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { Upgrade: "websocket", ...o.headers };
  if (o.origin !== null) headers.Origin = o.origin ?? ORIGIN;
  if (o.cookie) headers.Cookie = o.cookie;
  const res = await exports.default.fetch(`${ORIGIN}/ws/cup/${slug}/${code}${o.token !== undefined ? `?token=${encodeURIComponent(o.token)}` : ""}`, { headers });
  const ws = res.webSocket;
  if (!ws) return { status: res.status, ws: null as unknown as WebSocket, got: [] as any[], raw: [] as string[], closed: () => null as any, until: async () => {}, send: (_: unknown) => {}, last: () => null as any };
  ws.accept();
  const got: any[] = [], raw: string[] = [];
  let closed: { code: number; reason: string } | null = null;
  const waiters: (() => void)[] = [];
  const wake = () => waiters.splice(0).forEach(f => f());
  ws.addEventListener("message", e => { raw.push(String(e.data)); got.push(JSON.parse(String(e.data))); wake(); });
  ws.addEventListener("close", e => { closed = { code: e.code, reason: e.reason }; wake(); });
  const until = async (pred: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (!pred()) { if (Date.now() > end) throw new Error("timed out; last " + raw.at(-1)?.slice(0, 300) + " closed " + JSON.stringify(closed)); await new Promise<void>(r => { waiters.push(r); setTimeout(r, 50); }); }
  };
  return { status: res.status, ws, got, raw, until, closed: () => closed, send: (m: unknown) => ws.send(typeof m === "string" ? m : JSON.stringify(m)), last: () => [...got].reverse().find(m => m.cup) };
}

/** Play this seat: on every view where it's our turn, the move a person might make. Counts the moves sent.
    `before` runs ahead of each move (the cost test wipes the table's memory there). */
function bot(s: Sock, before?: () => Promise<void>) {
  let sent = -1, lastView: any = null;
  const stats = { moves: 0 };
  const act = (m: any) => {
    if (m.you == null || !m.v || m.v.over || m.v.current !== m.you || m.v.turns === sent) return;
    sent = m.v.turns;
    const mv = W.aiMove(W.hydrate(m.v));
    stats.moves++;
    const msg = mv.type === "play" ? { t: "play", ids: ([] as number[]).concat(mv.cardId), shape: mv.shape, turn: m.v.turns } : { t: "market", turn: m.v.turns };
    if (before) void before().then(() => s.send(msg)); else s.send(msg);
  };
  s.ws.addEventListener("message", e => {
    const m = JSON.parse(String(e.data));
    if (m.t === "nope") { sent = -1; if (lastView) act(lastView); return; }
    if (m.v) { lastView = m; act(m); }
  });
  const had = s.got.findLast(m => m.v);       // views that arrived before the bot sat down
  if (had) { lastView = had; act(had); }
  return stats;
}

async function poll<T>(f: () => Promise<T>, ok: (x: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const x = await f(); if (ok(x)) return x; if (Date.now() > end) throw new Error("poll timed out: " + JSON.stringify(x).slice(0, 300)); await new Promise(r => setTimeout(r, 30)); }
}

/** A running cup in external mode with slot 1 seated: its tables, players and their cookies. */
async function seatedCup(over: Partial<CupConfig> = {}, N = 16) {
  const cup = await makeCup({ capacity: N, minEntries: 4, expectedEntries: N, scEnabled: false, ...over }, "external");
  const ids = await bulkPlayers(N, 10_000);
  await bulkEnter(cup, ids);
  const cookies = await sessionsFor(ids);
  const d = director(cup.id), c = cup.c;
  await d.tick(c.registrationClosesAt); await d.tick(c.startsAt - 300_000); await d.tick(c.startsAt);
  const tables = await d.tables(1);
  const token = async (p: string) => ((await d.whereIs(p)) as { table: { token: string } }).table.token;
  /** Everyone at a table, connected with their own token. */
  const sitAll = async (t: { code: string; players: string[] }) => Promise.all(t.players.map(async p => sock(cup.slug, t.code, { cookie: cookies.get(p), token: await token(p) })));
  return { cup, ids, cookies, d, c, tables, token, sitAll };
}

const done = (s: Sock) => s.got.some(m => m.cup?.phase === "done" && m.cup.places);

describe("a whole cup on real tables", () => {
  it("16 players: every game played to the end, every result signed and in, the books clean", async () => {
    const { cup, cookies, d, c } = await seatedCup();
    const played: string[] = [];
    for (let i = 0; i < 12; i++) {
      const snap = (await d.snapshot())!;
      if (snap.phase !== "running") break;
      const open = (await d.tables(snap.slot)).filter(t => !t.result);
      if (open.length) {
        const finals = await Promise.all(open.map(async t => {
          const socks = await Promise.all(t.players.map(async p => {
            const w = await d.whereIs(p) as { table: { code: string; token: string } };
            expect(w.table.code).toBe(t.code);
            const s = await sock(cup.slug, t.code, { cookie: cookies.get(p), token: w.table.token });
            bot(s);
            return s;
          }));
          await Promise.all(socks.map(s => s.until(() => done(s), 30_000)));
          const m = socks[0].last();
          socks.forEach(s => s.ws.close(1000, "done"));
          return { code: t.code, places: (m.cup.places as number[]).map(i => t.players[i]) };
        }));
        // Each table's own ranking is exactly what the director paid on.
        const after = await poll(() => d.tables(snap.slot), ts => ts.every(t => t.result));
        for (const f of finals) {
          const t = after.find(x => x.code === f.code)!;
          expect(t.result).toEqual(f.places);
          expect(t.late).toBe(false);
          played.push(t.draw);
        }
      }
      await d.tick(Date.now() + (c.breakSec + 1) * 1000);
    }
    expect((await d.snapshot())!.phase).toBe("settled");
    expect(played).toEqual(["W", "W", "W", "W", "W", "W", "W", "GF"]);      // 16 → 8 → 4 → final → Grand Final
    expect(await reconcileCup(DB, cup.id, true)).toEqual([]);
    expect(await reconcileAll(DB)).toEqual([]);
    const rows = await DB.prepare("SELECT stats_json, late FROM table_results WHERE cup_id = ?").bind(cup.id).all<{ stats_json: string; late: number }>();
    expect(rows.results.length).toBe(8);
    for (const r of rows.results) {
      expect(r.late).toBe(0);
      const s = JSON.parse(r.stats_json);
      expect(["checkup", "stalemate"]).toContain(s.how);
      expect(s.moves).toBeGreaterThan(0);
      expect(r.stats_json).not.toMatch(/"id"|"shape"|"hand"/);            // 8.2 rule 3: never a card
    }
  }, 180_000);
});

describe("S-5: seat tokens", () => {
  it("wrong, expired, reused and someone else's tokens are refused; only the holder sits", async () => {
    const { cup, cookies, tables, token } = await seatedCup();
    const [t0, t1] = tables, a = t0.players[0], b = t0.players[1];
    const ta = await token(a), tb = await token(b);
    const closeOf = async (o: Parameters<typeof sock>[2], code = t0.code) => { const s = await sock(cup.slug, code, o); await s.until(() => !!s.closed()); return s.closed()!; };

    expect(await closeOf({ token: ta })).toEqual({ code: 4001, reason: "signed-out" });                           // no session
    expect(await closeOf({ token: ta, headers: { "X-Cup-Player": a } })).toEqual({ code: 4001, reason: "signed-out" }); // a forged header is dropped
    expect(await closeOf({ cookie: cookies.get(a), token: "123.abc" })).toEqual({ code: 4003, reason: "bad-token" });
    expect(await closeOf({ cookie: cookies.get(a), token: tb })).toEqual({ code: 4003, reason: "bad-token" });     // another seat's token
    expect(await closeOf({ cookie: cookies.get(b), token: ta })).toEqual({ code: 4003, reason: "bad-token" });     // someone else using mine
    expect(await closeOf({ cookie: cookies.get(a), token: ta }, t1.code)).toEqual({ code: 4003, reason: "not-your-seat" });   // another table
    const exp = Date.now() - 1000;
    expect(await closeOf({ cookie: cookies.get(a), token: await seatToken(KEY, cup.id, 1, t0.code, 0, a, exp) })).toEqual({ code: 4003, reason: "token-expired" });
    const later = Date.now() + 3_600_000;
    expect(await closeOf({ cookie: cookies.get(a), token: await seatToken(KEY, cup.id, 2, t0.code, 0, a, later) })).toEqual({ code: 4003, reason: "bad-token" });   // a token for another round
    // Not from our pages: no WebSocket at all.
    expect((await sock(cup.slug, t0.code, { cookie: cookies.get(a), token: ta, origin: null })).status).toBe(403);
    expect((await sock(cup.slug, t0.code, { cookie: cookies.get(a), token: ta, origin: "https://evil.test" })).status).toBe(403);
    expect((await sock("no-such-cup", t0.code, { cookie: cookies.get(a), token: ta })).status).toBe(404);
    // A table code the cup never seated: refused, and nothing is stored for it.
    expect(await closeOf({}, "ZZZZZZZZZZ")).toEqual({ code: 4004, reason: "no-table" });
    expect(await peek(tableStub("ZZZZZZZZZZ"), async (_i, st) => st.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 't'").toArray().length ? st.storage.sql.exec("SELECT COUNT(*) AS n FROM t").toArray()[0].n : 0)).toBe(0);
    // The holder sits.
    const ok = await sock(cup.slug, t0.code, { cookie: cookies.get(a), token: ta });
    await ok.until(() => ok.got.some(m => m.t === "wait"));
    expect(ok.got.find(m => m.t === "wait")).toMatchObject({ you: 0, cup: { phase: "waiting", draw: "W" } });
  });

  it("a second device takes the seat over; the first one watches", async () => {
    const { cup, cookies, tables, token } = await seatedCup();
    const t = tables[0], a = t.players[0];
    const one = await sock(cup.slug, t.code, { cookie: cookies.get(a), token: await token(a) });
    await one.until(() => one.got.some(m => m.you === 0));
    const two = await sock(cup.slug, t.code, { cookie: cookies.get(a), token: await token(a) });
    await two.until(() => two.got.some(m => m.you === 0));
    await one.until(() => one.got.some(m => m.t === "moved"));
    await one.until(() => one.got.some(m => m.cup && m.you === null));
  });
});

describe("S-4: junk never changes a table", () => {
  it("malformed, oversized, out-of-turn, replayed and free-table messages are refused, and nothing is written", async () => {
    const { cup, tables, sitAll, cookies } = await seatedCup();
    const t = tables[0], socks = await sitAll(t);
    await Promise.all(socks.map(s => s.until(() => s.got.some(m => m.v))));
    const v = socks[0].got.findLast(m => m.v).v, cur = v.current, me = socks[cur], other = socks[(cur + 1) % socks.length];
    const stub = tableStub(t.code);
    await stub.rowsWritten();
    const row = async () => peek(stub, async (_i, st) => String(st.storage.sql.exec("SELECT v FROM t").toArray()[0].v));
    const before = await row();
    const hand = me.got.findLast(m => m.v).v.players[cur].hand.map((c: any) => c.id);
    const junk: [Sock, unknown][] = [
      [me, "not json"], [me, "[]"], [me, "null"], [me, { t: "play" }], [me, "x".repeat(3000)],
      [me, { t: "play", ids: [999], turn: v.turns }], [me, { t: "play", ids: [hand[0], hand[0]], turn: v.turns }], [me, { t: "play", ids: ["1"], turn: v.turns }],
      [me, { t: "market", turn: v.turns - 1 }], [me, { t: "market", turn: v.turns + 1 }], [me, { t: "market" }],
      [other, { t: "market", turn: v.turns }], [other, { t: "market", turn: v.turns, seat: cur }],
      // The free table's ways in: none of them exist here (TB-1, TB-2).
      [me, { t: "create", seats: [{ name: "x", type: "human" }, { name: "y", type: "cpu" }], me: 0, seed: { players: [] } }],
      [other, { t: "sit", seat: cur }], [me, { t: "again" }], [me, { t: "stand" }], [me, { t: "answer", rid: "x", ok: true }], [me, { t: "voiceall", on: true }],
    ];
    const nopes = () => socks.reduce((a, s) => a + s.got.filter(m => m.t === "nope").length, 0);
    const n0 = nopes();
    for (const [s, m] of junk) s.send(m);
    await poll(async () => nopes(), n => n >= n0 + junk.length);
    // A watcher can't move either.
    const w = await sock(cup.slug, t.code, {});
    await w.until(() => w.got.length > 0);
    w.send({ t: "market", turn: v.turns });
    await w.until(() => w.got.some(m => m.t === "nope" && m.reason === "watching"));
    expect(await row()).toBe(before);
    expect(await stub.rowsWritten()).toBe(0);                              // not even the watcher's arrival: nothing changed
    expect(cookies.size).toBe(16);
  });
});

describe("S-2 and TB-6 on the wire: watchers, chat, voice", () => {
  it("a watcher never gets a hidden card, starts spectatorDelayMoves behind, and sees the hands at the end", async () => {
    const { cup, tables, sitAll } = await seatedCup();
    const t = tables[0];
    const w = await sock(cup.slug, t.code, {});
    await w.until(() => w.got.some(m => m.t === "wait"));
    const socks = await sitAll(t);
    socks.forEach(s => bot(s));
    await Promise.all(socks.map(s => s.until(() => done(s), 30_000)));
    await w.until(() => w.got.some(m => m.v?.over));
    const views = w.raw.filter(r => r.includes('"v":'));
    const live = views.filter(r => !JSON.parse(r).v.over);
    expect(live.length).toBeGreaterThan(0);
    for (const r of live) { expect(r).not.toMatch(/"hand":|"market":/); expect(JSON.parse(r).you).toBe(null); }
    const ns = live.map(r => JSON.parse(r).n);
    expect(ns[0]).toBe(0);                                                  // the deal, shown once 3 moves were made
    expect([...ns].sort((a, b) => a - b)).toEqual(ns);
    const seatN = socks[0].got.filter(m => m.n !== undefined).map(m => m.n);
    expect(Math.max(...ns)).toBeLessThanOrEqual(Math.max(...seatN) - 3);
    const fin = JSON.parse(views.at(-1)!);
    expect(fin.v.players.every((p: any) => Array.isArray(p.hand))).toBe(true);   // revealHands: after-table
  }, 60_000);

  it("preset chat reaches the seats only, slowly; voice is off unless the cup allows it; watchers can be turned off", async () => {
    const { cup, tables, sitAll } = await seatedCup();
    const socks = await sitAll(tables[0]);
    const w = await sock(cup.slug, tables[0].code, {});
    await Promise.all([...socks, w].map(s => s.until(() => s.got.length > 0)));
    socks[0].send({ t: "chat", id: 1 });
    await Promise.all(socks.map(s => s.until(() => s.got.some(m => m.t === "chat" && m.text === "Nice one!" && m.seat === 0))));
    socks[0].send({ t: "chat", id: 2 });
    await socks[0].until(() => socks[0].got.some(m => m.t === "nope" && m.reason === "slow-down"));
    socks[1].send({ t: "chat", text: "free text is never allowed" });
    await socks[1].until(() => socks[1].got.some(m => m.t === "nope" && m.reason === "no-chat"));
    socks[1].send({ t: "rtc", to: "x", d: {} });
    await socks[1].until(() => socks[1].got.some(m => m.t === "nope" && m.reason === "no-voice"));
    expect(w.got.some(m => m.t === "chat")).toBe(false);
    expect(socks[0].last().voice.me).toBe(null);

    const v = await seatedCup({ voice: "seated", spectators: "off" });
    const vs = await v.sitAll(v.tables[0]);
    await Promise.all(vs.map(s => s.until(() => s.last()?.voice?.peers?.length === 3)));
    const me = vs[0].last().voice.me, to = vs[1].last().voice.me;
    vs[0].send({ t: "rtc", to, d: { sdp: "offer" } });
    await vs[1].until(() => vs[1].got.some(m => m.t === "rtc" && m.from === me));
    const nw = await sock(v.cup.slug, v.tables[0].code, {});
    await nw.until(() => !!nw.closed());
    expect(nw.closed()).toEqual({ code: 4011, reason: "no-watchers" });
  });
});

describe("T2: cup table cost", () => {
  it("one row per move, a game that survives losing its memory between moves, and nothing left after the reveal", async () => {
    const { cup, tables, sitAll } = await seatedCup();
    const t = tables[0], stub = tableStub(t.code);
    const socks = await sitAll(t);
    await Promise.all(socks.map(s => s.until(() => s.got.some(m => m.v))));
    await stub.rowsWritten();
    // Hibernation drops memory between messages: here it is dropped before every single move, and the table must
    // carry on from its one row each time.
    let evictions = 0;
    const evict = async () => { await peek(stub, async (inst: any) => { inst.t = undefined; inst.ready = false; inst.saved = ""; }); evictions++; };
    const stats = socks.map(s => bot(s, evict));
    await Promise.all(socks.map(s => s.until(() => done(s), 60_000)));
    const moves = stats.reduce((a, s) => a + s.moves, 0), rows = await stub.rowsWritten();
    console.log(JSON.stringify({ moves, rows, evictions }));
    expect(evictions).toBe(moves);
    expect(rows).toBeLessThanOrEqual(moves + 1);                            // one per move, plus the report's
    // The director has the result, so after the reveal window the row and the alarm go, and every socket is told.
    await poll(() => director(cup.id).tables(1), ts => !!ts.find(x => x.code === t.code)?.result);
    await peek(stub, async (inst: any) => { inst.load().closeAt = Date.now() - 1; });
    expect(await runDurableObjectAlarm(stub as unknown as DurableObjectStub)).toBe(true);
    await Promise.all(socks.map(s => s.until(() => s.closed()?.code === 4005)));
    expect(await peek(stub, async (_i, st) => [st.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 't'").toArray().length, await st.storage.getAlarm()])).toEqual([0, null]);
    // And it can't be brought back: the director says the table is finished.
    const again = await sock(cup.slug, t.code, {});
    await again.until(() => !!again.closed());
    expect(again.closed()).toEqual({ code: 4004, reason: "finished" });
  }, 120_000);
});
