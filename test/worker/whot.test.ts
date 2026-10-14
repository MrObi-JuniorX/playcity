import { env, exports } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import * as W from "../../public/whot/engine.js";

/* A WebSocket to a Whot table through the Worker, collecting what arrives. */
async function open(path: string) {
  const res = await exports.default.fetch(`https://play.test${path}`, { headers: { Upgrade: "websocket" } });
  const ws = res.webSocket;
  if (!ws) throw new Error(`no websocket: ${res.status}`);
  ws.accept();
  const got: any[] = [], raw: string[] = [];
  let closed: { code: number; reason: string } | null = null;
  const waiters: (() => void)[] = [];
  const wake = () => waiters.splice(0).forEach(f => f());
  ws.addEventListener("message", e => { raw.push(String(e.data)); got.push(JSON.parse(String(e.data))); wake(); });
  ws.addEventListener("close", e => { closed = { code: e.code, reason: e.reason }; wake(); });
  const until = async (pred: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!pred()) { if (Date.now() > end) throw new Error("timed out; last " + JSON.stringify(got.at(-1)) + " closed " + JSON.stringify(closed)); await new Promise<void>(r => { waiters.push(r); setTimeout(r, 50); }); }
  };
  const last = () => [...got].reverse().find(m => m.v);
  return {
    ws, got, raw, until, last,
    closed: () => closed,
    next: async (t: string) => { const from = got.length; await until(() => got.slice(from).some(m => m.t === t)); return got.slice(from).find(m => m.t === t); },
    /* wait for a state where it is my turn (or the round is over) */
    myTurn: async () => { await until(() => { const m = last(); return !!m && (m.v.over || (m.you !== null && m.v.current === m.you)); }); return last(); },
    send: (m: unknown) => ws.send(JSON.stringify(m))
  };
}
const seats3 = [{ name: "Ada", type: "human" }, { name: "Computer", type: "cpu" }, { name: "Computer 2", type: "cpu" }];
async function create(code: string, name = "Ada", extra: Record<string, unknown> = {}) {
  const c = await open(`/ws/whot/${code}?create=1&name=${name}&id=creator-${code}`);
  await c.next("empty");
  c.send({ t: "create", seats: seats3, me: 0, ...extra });
  await c.until(() => c.got.some(m => m.v));
  return c;
}
const table = (code: string) => env.WHOT.getByName(code) as unknown as DurableObjectStub;
// Untyped on purpose: the tests read the table's private state, and the RPC stub types are too deep for tsc.
const peek = runInDurableObject as unknown as (stub: DurableObjectStub, f: (inst: any, state: DurableObjectState) => unknown) => Promise<any>;

describe("whot table", () => {
  it("deals a fresh table and plays the computer seats until it is the person's turn", async () => {
    const ada = await create("WAAAA");
    expect(ada.got.find(m => m.v).kind).toBe("deal");
    const m = await ada.myTurn();
    expect(m.you).toBe(0);
    expect(m.v.players[0].hand.length).toBeGreaterThan(0);
    expect(m.left).toBeUndefined();                    // alone with the computer: no clock
    expect(m.seats.map((s: any) => s.human)).toEqual([true, false, false]);
    const sam = await open("/ws/whot/WAAAA?name=Sam&id=sam-id-0000&sit=1&k=" + ada.last().invite);
    await ada.until(() => ada.last().seats[1].human && ada.last().left !== undefined);
    expect(ada.last().left).toBeGreaterThan(40_000);     // someone is waiting now: the clock runs
    sam.ws.close();
  });

  it("never sends anyone another player's cards or the market order", async () => {
    const ada = await create("WBBBB");
    await ada.myTurn();
    const sam = await open("/ws/whot/WBBBB?name=Sam&id=sam-id-0001&sit=1&k=" + ada.last().invite);
    await sam.until(() => sam.last()?.you === 1);
    ada.send({ t: "market", turn: ada.last().v.turns });
    await sam.until(() => sam.got.filter(m => m.t === "step").length > 0);
    await new Promise(r => setTimeout(r, 200));
    const real = await peek(table("WBBBB"), async inst => inst.t.g);
    const adaIds = new Set(real.players[0].hand.map((c: any) => c.id));
    const marketIds = real.market.map((c: any) => c.id);
    for (const m of sam.got.filter(m => m.v)) {
      expect(m.v.players[0].hand).toBeUndefined();                 // counts only
      expect(m.v.market).toBeUndefined();
      expect(typeof m.v.mk).toBe("number");
      for (const e of m.ev || []) if (e.type === "draw" && e.player !== 1) expect(e.id).toBeLessThan(0);
    }
    // Sam's own draws do arrive face up, and none of Ada's current cards show up in anything Sam received
    const samSeen = new Set(sam.got.filter(m => m.v?.players[1].hand).flatMap(m => m.v.players[1].hand.map((c: any) => c.id)));
    for (const id of adaIds) expect(samSeen.has(id)).toBe(false);
    expect(marketIds.length).toBeGreaterThan(0);
  });

  it("refuses moves out of turn, stale moves and illegal cards", async () => {
    const ada = await create("WCCCC");
    const m = await ada.myTurn();
    const sam = await open("/ws/whot/WCCCC?name=Sam&id=sam-id-0002&sit=1&k=" + ada.last().invite);
    await sam.until(() => sam.last()?.you === 1);
    sam.send({ t: "market", turn: m.v.turns });
    expect((await sam.next("nope")).reason).toBe("not-your-turn");
    ada.send({ t: "market", turn: m.v.turns - 1 });
    expect((await ada.next("nope")).reason).toBe("stale");
    ada.send({ t: "play", ids: [999], turn: m.v.turns });
    expect((await ada.next("nope")).reason).toBe("nocard");
  });

  it("someone joining takes a computer's seat, mid-round, with its cards", async () => {
    const ada = await create("WDDDD");
    await ada.myTurn();
    const before = await peek(table("WDDDD"), async (inst: any) => inst.t.g.players[1].hand.map((c: any) => c.id));
    const sam = await open("/ws/whot/WDDDD?name=Sam&id=sam-id-0003&sit=1&k=" + ada.last().invite);
    const mine = await sam.until(() => sam.last()?.you === 1).then(() => sam.last());
    expect(mine.v.players[1].hand.map((c: any) => c.id)).toEqual(before);
    expect(mine.v.players[1].name).toBe("Sam");
    await ada.until(() => ada.last().seats[1].human === true);
    expect(ada.last().v.log.at(-1).msg).toBe("Sam took Computer's seat.");
  });

  it("a player who leaves hands the seat back to the computer, and gets it back on reconnect", async () => {
    const ada = await create("WEEEE");
    await ada.myTurn();
    const sam = await open("/ws/whot/WEEEE?name=Sam&id=sam-id-0004&sit=1&k=" + ada.last().invite);
    await sam.until(() => sam.last()?.you === 1);
    sam.ws.close(1000, "bye");
    await ada.until(() => ada.last().seats[1].human === false);
    expect(ada.last().v.players[1].type).toBe("cpu");
    const back = await open("/ws/whot/WEEEE?name=Sam&id=sam-id-0004");   // same browser, no sit flag
    await back.until(() => back.last()?.you === 1);
    await ada.until(() => ada.last().v.log.some((l: any) => l.msg === "Sam is back."));
  });

  it("holds a dropped player's turn for a few seconds, so a reload does not cost the turn", async () => {
    const ada = await create("WPPPP");
    await ada.myTurn();
    const sam = await open("/ws/whot/WPPPP?name=Sam&id=sam-id-0006&sit=1&k=" + ada.last().invite);
    await sam.until(() => sam.last()?.you === 1 && sam.last().v.current === 0);
    const turns = sam.last().v.turns;
    ada.ws.close(1000, "reload");
    await sam.until(() => sam.last().grace?.seat === 0);
    expect(sam.last().v.current).toBe(0);
    expect(sam.last().v.turns).toBe(turns);                         // nobody moved for Ada
    const back = await open("/ws/whot/WPPPP?name=Ada&id=creator-WPPPP");
    await back.until(() => back.last()?.you === 0);
    expect(back.last().grace).toBe(null);
    expect(back.last().v.turns).toBe(turns);                        // still Ada's turn, untouched

    back.ws.close(1000, "gone");                                    // this time Ada does not come back
    await sam.until(() => sam.last().grace?.seat === 0);
    await peek(table("WPPPP"), async inst => { inst.t.grace.until = Date.now() - 1; });
    const n = sam.got.length;
    await runDurableObjectAlarm(table("WPPPP"));
    await sam.until(() => sam.got.slice(n).some(m => m.kind === "cpu" && m.actor === 0));
  });

  it("standing up hands the turn over at once", async () => {
    const ada = await create("WQQQQ");
    await ada.myTurn();
    const sam = await open("/ws/whot/WQQQQ?name=Sam&id=sam-id-0007&sit=1&k=" + ada.last().invite);
    await sam.until(() => sam.last()?.you === 1 && sam.last().v.current === 0);
    ada.send({ t: "stand" });
    await sam.until(() => sam.got.some(m => m.kind === "cpu" && m.actor === 0));
    expect(sam.last().grace).toBe(null);
  });

  it("someone from the public list asks; seated players are told, and accepting seats them", async () => {
    const ada = await create("WRRRR");
    await ada.myTurn();
    const eve = await open("/ws/whot/WRRRR?name=Eve&id=stranger-id-01&sit=1");          // no key: has to ask
    await eve.until(() => eve.last()?.asking);
    expect(eve.last().you).toBe(null);                          // still watching while they wait
    expect(eve.last().asking.left).toBeGreaterThan(10_000);
    await ada.until(() => ada.last().asks?.length === 1);
    const ask = ada.last().asks[0];
    expect(ask).toMatchObject({ name: "Eve", seat: -1 });
    expect(ada.raw.join("")).not.toContain("stranger-id-01");   // the reclaim id never leaks, only the public request id
    ada.send({ t: "answer", rid: ask.rid, ok: true });
    await eve.until(() => eve.last()?.you === 1);
    expect(eve.last().asking).toBe(null);
    await ada.until(() => ada.last().asks.length === 0 && ada.last().seats[1].human);
    expect(ada.last().v.log.some((l: any) => l.msg === "Eve took Computer's seat.")).toBe(true);
  });

  it("a decline means not now, with a cooldown before asking again", async () => {
    const ada = await create("WSSSS");
    await ada.myTurn();
    const eve = await open("/ws/whot/WSSSS?name=Eve&id=stranger-id-02&sit=1");
    await ada.until(() => ada.last().asks?.length === 1);
    ada.send({ t: "answer", rid: ada.last().asks[0].rid, ok: false });
    const d = await eve.next("denied");
    expect(d).toMatchObject({ by: "Ada", reason: "declined" });
    await eve.until(() => eve.last().asking === null);
    expect(eve.last().you).toBe(null);
    eve.send({ t: "sit", seat: -1 });
    expect((await eve.next("nope")).reason).toBe("cooldown");
  });

  it("an unanswered request is accepted after the wait, so an idle player cannot block the table", async () => {
    const ada = await create("WTTTT");
    await ada.myTurn();
    const eve = await open("/ws/whot/WTTTT?name=Eve&id=stranger-id-03&sit=1");
    await eve.until(() => eve.last()?.asking);
    expect(await peek(table("WTTTT"), async (_i, state) => await state.storage.getAlarm())).not.toBe(null);
    await peek(table("WTTTT"), async inst => {                   // wind the request's clock back
      for (const w of inst.ctx.getWebSockets()) { const c = w.deserializeAttachment(); if (c?.ask) w.serializeAttachment({ ...c, ask: { ...c.ask, until: Date.now() - 1 } }); }
    });
    await runDurableObjectAlarm(table("WTTTT"));
    await eve.until(() => eve.last()?.you === 1);
  });

  it("when nobody is seated there is no one to ask, so a request is accepted at once", async () => {
    const ada = await create("WUUUU");
    await ada.myTurn();
    ada.send({ t: "stand" });
    await ada.until(() => ada.last().you === null);
    const eve = await open("/ws/whot/WUUUU?name=Eve&id=stranger-id-04&sit=1");
    await eve.until(() => eve.last()?.you === 0);                  // Ada's old seat, the first open one
    expect(eve.last().asking).toBe(null);
  });

  it("if every seated person leaves while someone is asking, the request is accepted", async () => {
    const ada = await create("WVVVV");
    await ada.myTurn();
    const eve = await open("/ws/whot/WVVVV?name=Eve&id=stranger-id-05&sit=1");
    await eve.until(() => eve.last()?.asking);
    ada.send({ t: "stand" });
    await eve.until(() => eve.last()?.you === 0);
    await ada.until(() => ada.last().you === null && ada.last().seats[0].me === false);
  });

  it("asking can be cancelled, and watchers never see requests or the invite key", async () => {
    const ada = await create("WWWWW");
    await ada.myTurn();
    const key = ada.last().invite;
    expect(key).toMatch(/^[A-Z2-9]{8}$/);
    const eve = await open("/ws/whot/WWWWW?name=Eve&id=stranger-id-06");                // watching only
    await eve.until(() => !!eve.last());
    eve.send({ t: "sit", seat: 1 });
    await ada.until(() => ada.last().asks?.length === 1);
    expect(ada.last().asks[0].seat).toBe(1);
    eve.send({ t: "cancel" });
    await ada.until(() => ada.last().asks.length === 0);
    await new Promise(r => setTimeout(r, 100));
    expect(eve.got.every((m: any) => !m.asks?.length && m.invite === undefined)).toBe(true);
    expect(eve.raw.join("")).not.toContain(key);
  });

  it("the invite key is checked: a wrong key still has to ask", async () => {
    const ada = await create("WXXXX");
    await ada.myTurn();
    const eve = await open("/ws/whot/WXXXX?name=Eve&id=stranger-id-07&sit=1&k=WRONGKEY");
    await eve.until(() => eve.last()?.asking);
    expect(eve.last().trusted).toBe(false);
    const sam = await open("/ws/whot/WXXXX?name=Sam&id=link-friend-01&sit=1&k=" + ada.last().invite);
    await sam.until(() => sam.last()?.you !== undefined && sam.last().you !== null);
    expect(sam.last().trusted).toBe(true);
  });

  it("an accepted request for a seat that has since gone to someone else falls back to another open seat, or is told the table is full", async () => {
    const ada = await create("WYYYY");
    await ada.myTurn();
    const eve = await open("/ws/whot/WYYYY?name=Eve&id=stranger-id-08&sit=1");
    const fay = await open("/ws/whot/WYYYY?name=Fay&id=stranger-id-09&sit=1");
    await ada.until(() => ada.last().asks?.length === 2);
    const [a, b] = ada.last().asks;
    ada.send({ t: "answer", rid: a.rid, ok: true });
    await ada.until(() => ada.last().asks.length === 1);
    ada.send({ t: "answer", rid: b.rid, ok: true });
    await ada.until(() => ada.last().seats.every((s: any) => s.human));
    expect([eve, fay].map(x => x.last().you).sort()).toEqual([1, 2]);
  });

  it("watchers see the table and can ask for any computer seat", async () => {
    const ada = await create("WFFFF");
    await ada.myTurn();
    const eve = await open("/ws/whot/WFFFF?name=Eve&id=eve-id-0001");
    await eve.until(() => !!eve.last());
    expect(eve.last().you).toBe(null);
    eve.send({ t: "sit", seat: 0 });
    expect((await eve.next("nope")).reason).toBe("seat-taken");
    eve.send({ t: "sit", seat: 2 });
    await ada.until(() => ada.last().asks?.length === 1);
    ada.send({ t: "answer", rid: ada.last().asks[0].rid, ok: true });
    await eve.until(() => eve.last()?.you === 2);
    await ada.until(() => ada.last().watching === 0);
  });

  it("carries on a game seeded from someone's computer match, and refuses a tampered one", async () => {
    const g = W.newGame([{ name: "Ada", type: "human" }, { name: "Computer", type: "cpu" }], 0);
    W.market(g); W.market(g);
    const c = await open("/ws/whot/WGGGG?create=1&name=Ada&id=creator-WGGGG");
    await c.next("empty");
    c.send({ t: "create", seats: seats3.slice(0, 2), me: 0, seed: g, tally: [{ w: 2, l: 0 }, { w: 0, l: 2 }] });
    const m = await c.next("sync");
    expect(m.v.players[0].hand.map((x: any) => x.id).sort()).toEqual(g.players[0].hand.map(x => x.id).sort());
    expect(m.v.turns).toBe(g.turns);
    expect(m.tally[0].w).toBe(2);

    const bad = structuredClone(g);
    bad.players[0].hand.push(bad.market[0]);                         // a card in two places
    const d = await open("/ws/whot/WHHHH?create=1&name=Ada&id=creator-WHHHH");
    await d.next("empty");
    d.send({ t: "create", seats: seats3.slice(0, 2), me: 0, seed: bad });
    expect((await d.next("nope")).reason).toBe("bad-create");
  });

  it("moves for an idle player when the clock runs out, then gives the seat back to the computer", async () => {
    const ada = await create("WJJJJ");
    const sam = await open("/ws/whot/WJJJJ?name=Sam&id=sam-id-0005&sit=1&k=" + ada.last().invite);
    await sam.until(() => sam.last()?.you === 1);
    // Sam plays his turns at once; Ada never does
    sam.ws.addEventListener("message", e => { const m = JSON.parse(String(e.data)); if (m.v && !m.v.over && m.v.current === 1 && m.you === 1) sam.send({ t: "market", turn: m.v.turns }); });
    for (let round = 1; round <= 2; round++) {
      const m = await ada.myTurn();
      if (m.v.over) return;
      await peek(table("WJJJJ"), async (inst: any) => { inst.t.dl = Date.now() - 1000; });
      const n = ada.got.length;
      await runDurableObjectAlarm(table("WJJJJ"));
      await ada.until(() => ada.got.slice(n).some(x => x.kind === "auto"));
    }
    await ada.until(() => ada.last().you === null);
    expect(ada.last().seats[0].human).toBe(false);
    expect(ada.last().v.log.some((l: any) => /ran out of time/.test(l.msg))).toBe(true);
  });

  it("tells a player who went away about their seat, and gives it straight back when they say so", async () => {
    const ada = await create("WJJJA");
    const sam = await open("/ws/whot/WJJJA?name=Sam&id=sam-id-0105&sit=1&k=" + ada.last().invite);
    await sam.until(() => sam.last()?.you === 1);
    expect(sam.last().mine).toBeNull();
    // Ada plays her turns at once; Sam never does
    ada.ws.addEventListener("message", e => { const m = JSON.parse(String(e.data)); if (m.v && !m.v.over && m.v.current === 0 && m.you === 0) ada.send({ t: "market", turn: m.v.turns }); });
    const first = ada.last(); if (first.v.current === 0) ada.send({ t: "market", turn: first.v.turns });
    for (let round = 1; round <= 2; round++) {
      const m = await sam.myTurn();
      if (m.v.over) return;
      await peek(table("WJJJA"), async (inst: any) => { inst.t.dl = Date.now() - 1000; });
      const n = sam.got.length;
      await runDurableObjectAlarm(table("WJJJA"));
      await sam.until(() => sam.got.slice(n).some(x => x.kind === "auto"));
    }
    await sam.until(() => sam.last().you === null);
    // Sam is still connected, now watching, and the table remembers whose seat it was and what he was called
    await sam.until(() => sam.last().mine !== null);
    expect(sam.last().mine).toEqual({ seat: 1, name: "Sam" });
    expect(ada.last().mine).toBeNull();
    // Coming back by reload does not quietly put him back in: he is asked first
    const again = await open("/ws/whot/WJJJA?name=Sam&id=sam-id-0105");
    await again.until(() => again.last());
    expect(again.last().you).toBeNull();
    expect(again.last().mine).toEqual({ seat: 1, name: "Sam" });
    // He says yes: the seat is his again at once, without asking Ada
    again.send({ t: "sit", seat: 1 });
    await again.until(() => again.last().you === 1);
    expect(again.last().seats[1]).toMatchObject({ human: true, me: true, name: "Sam" });
    expect(again.last().mine).toBeNull();
  });

  it("lets a watcher give their name as they sit down", async () => {
    const ada = await create("WJJJB");
    const eve = await open("/ws/whot/WJJJB?name=Player&id=stranger-id-33&sit=1&k=" + ada.last().invite);
    await eve.until(() => eve.last()?.you === 1);
    expect(eve.last().seats[1].name).toBe("Player");
    const fay = await open("/ws/whot/WJJJB?name=Player&id=stranger-id-34");              // watching, no seat yet
    await fay.until(() => fay.last());
    expect(fay.last().you).toBeNull();
    fay.send({ t: "sit", seat: 2, name: "Fay <b>Okoro</b> the very long" });
    await ada.until(() => ada.last().asks?.length > 0);                                  // a stranger still has to ask
    expect(ada.last().asks[0].name.length).toBeLessThanOrEqual(14);
    expect(ada.last().asks[0].name).not.toMatch(/[<>]/);
    expect(ada.last().asks[0].name).toMatch(/^Fay /);
  });

  it("deletes the table two minutes after the last person leaves", async () => {
    const ada = await create("WKKKK");
    await ada.myTurn();
    ada.ws.close(1000, "bye");
    await new Promise(r => setTimeout(r, 150));
    await peek(table("WKKKK"), async (inst: any, state) => {
      expect(inst.t.emptyAt).toBeGreaterThan(Date.now() + 60_000);
      inst.t.emptyAt = Date.now() - 1;
      expect(await state.storage.getAlarm()).not.toBe(null);
    });
    await runDurableObjectAlarm(table("WKKKK"));
    await peek(table("WKKKK"), async (_inst, state) => {
      expect(state.storage.kv.get("t")).toBeUndefined();
    });
    const late = await open("/ws/whot/WKKKK?name=Sam");
    await late.until(() => late.closed() !== null);
    expect(late.closed()!.code).toBe(4004);
  });

  it("refuses a second creator on the same code, and a join to a code with no table", async () => {
    await create("WLLLL");
    const again = await open("/ws/whot/WLLLL?create=1&name=Bo");
    await again.until(() => again.closed() !== null);
    expect(again.closed()!.code).toBe(4009);
    const nobody = await open("/ws/whot/WMMMM?name=Bo");
    await nobody.until(() => nobody.closed() !== null);
    expect(nobody.closed()!.code).toBe(4004);
  });

  it("starts the next round when a seated player asks, and keeps the tally", async () => {
    const ada = await create("WNNNN");
    await ada.myTurn();
    await peek(table("WNNNN"), async (inst: any) => {
      const g = inst.t.g; g.discard.push(...g.players[0].hand.splice(0)); g.over = true; g.winner = 0; g.losers = [1];
      inst.t.tally[0].w = 1; inst.t.scored = inst.t.round;
    });
    const n = ada.got.length;
    ada.send({ t: "again" });
    await ada.until(() => ada.got.slice(n).some(x => x.kind === "deal"));
    const m = await ada.myTurn();
    expect(m.round).toBe(2);
    expect(m.tally[0].w).toBe(1);
    expect(m.v.players[0].hand.length).toBeGreaterThan(0);
  });
});

describe("knock-out rounds", () => {
  /* Three people at a three-seat table: Ada (0), Sam (1), Eve (2). */
  async function three(code: string) {
    const ada = await create(code);
    await ada.myTurn();
    const key = ada.last().invite;
    const sam = await open(`/ws/whot/${code}?name=Sam&id=sam-ko-${code}&sit=1&k=${key}`);
    const eve = await open(`/ws/whot/${code}?name=Eve&id=eve-ko-${code}&sit=1&k=${key}`);
    await ada.until(() => ada.last().seats.every((x: any) => x.human));
    return { ada, sam, eve, code };
  }
  const endRound = (code: string, winner: number, losers: number[]) => peek(table(code), async (inst: any) => {
    const g = inst.t.g; g.over = true; g.winner = winner; g.losers = losers; inst.t.scored = inst.t.round;
  });

  it("puts the loser out, asks the rest to carry on without them, and crowns a champion at the end", async () => {
    const { ada, sam, eve, code } = await three("WKQAA");
    await endRound(code, 0, [2]);
    let n = ada.got.length;
    ada.send({ t: "again" });
    await ada.until(() => ada.got.slice(n).some(x => x.kind === "deal"));
    expect(ada.last().v.players.map((p: any) => p.name)).toEqual(["Ada", "Sam"]);
    expect(ada.last().out).toEqual(["Eve"]);
    expect(ada.last().you).toBe(0);
    await sam.until(() => sam.last()?.v.players.length === 2);
    expect(sam.last().you).toBe(1);
    await eve.until(() => eve.last()?.v.players.length === 2);
    expect(eve.last().you).toBe(null);                    // out: watching

    // the final: two left, the loser goes out too, but the title is decided, so the next game brings everyone back
    await endRound(code, 1, [0]);
    n = sam.got.length;
    sam.send({ t: "again" });
    await sam.until(() => sam.got.slice(n).some(x => x.kind === "deal"));
    const m = sam.last();
    expect(m.v.players.map((p: any) => p.name)).toEqual(["Ada", "Sam", "Eve"]);
    expect(m.out).toEqual([]);
    expect(m.you).toBe(1);
    await eve.until(() => eve.last()?.you === 2);          // knocked out earlier, still connected: back in her own seat
    await ada.until(() => ada.last()?.you === 0 && ada.last().v.players.length === 3);
  });

  it("keeps everyone when the loser ties with the other for the most points, or when only one person is playing", async () => {
    const { ada, code } = await three("WKQBB");
    await endRound(code, 0, [1, 2]);                     // a tie that would leave only the winner
    const n = ada.got.length;
    ada.send({ t: "again" });
    await ada.until(() => ada.got.slice(n).some(x => x.kind === "deal"));
    expect(ada.last().v.players.length).toBe(3);
    expect(ada.last().out).toEqual([]);

    const solo = await create("WKQCC");                  // one person and two computers: an ordinary rematch
    await solo.myTurn();
    await endRound("WKQCC", 1, [0]);
    const k = solo.got.length;
    solo.send({ t: "again" });
    await solo.until(() => solo.got.slice(k).some(x => x.kind === "deal"));
    expect(solo.last().v.players.length).toBe(3);
  });

  it("brings everyone back on request, and survives a knocked-out player's seat index shifting", async () => {
    const { ada, sam, eve, code } = await three("WKQDD");
    await endRound(code, 2, [0]);                        // Ada loses: Sam becomes seat 0, Eve seat 1
    let n = sam.got.length;
    eve.send({ t: "again" });
    await sam.until(() => sam.got.slice(n).some(x => x.kind === "deal"));
    expect(sam.last().you).toBe(0);
    expect(sam.last().v.players.map((p: any) => p.name)).toEqual(["Sam", "Eve"]);
    await eve.until(() => eve.last()?.you === 1);
    await ada.until(() => ada.last()?.you === null);
    n = sam.got.length;
    sam.send({ t: "again", all: true });                 // not before a round is over
    await new Promise(r => setTimeout(r, 100));
    expect(sam.got.slice(n).some(x => x.kind === "deal")).toBe(false);
    await endRound(code, 0, [1]);
    n = sam.got.length;
    sam.send({ t: "again", all: true });
    await sam.until(() => sam.got.slice(n).some(x => x.kind === "deal"));
    expect(sam.last().v.players.map((p: any) => p.name)).toEqual(["Ada", "Sam", "Eve"]);
    await ada.until(() => ada.last()?.you === 0);
    expect(sam.last().you).toBe(1);
    expect(eve.last().you).toBe(2);
  });
});

describe("walkie-talkie signalling", () => {
  const voiceOf = (c: any) => c.last().voice;
  it("passes connection setup and talking signals between seated players, and never to or from watchers", async () => {
    const ada = await create("WZZZZ");
    await ada.myTurn();
    const sam = await open("/ws/whot/WZZZZ?name=Sam&id=sam-voice-01&sit=1&k=" + ada.last().invite);
    await sam.until(() => sam.last()?.you === 1);
    const eve = await open("/ws/whot/WZZZZ?name=Eve&id=eve-voice-01");                 // watching
    await eve.until(() => !!eve.last());
    await ada.until(() => voiceOf(ada).peers.length === 1);
    const samVid = voiceOf(ada).peers[0].vid, adaVid = voiceOf(ada).me;
    expect(samVid).toMatch(/^[0-9a-f]{8}$/);
    expect(voiceOf(ada).peers[0]).toMatchObject({ name: "Sam", seat: 1 });
    expect(voiceOf(eve)).toMatchObject({ me: null, peers: [], all: false, owner: false });   // watchers are not in the group

    ada.send({ t: "rtc", to: samVid, d: { sdp: { type: "offer", sdp: "v=0 fake" } } });
    expect(await sam.next("rtc")).toMatchObject({ from: adaVid, d: { sdp: { type: "offer" } } });
    ada.send({ t: "talk", on: true });
    expect(await sam.next("talk")).toMatchObject({ vid: adaVid, on: true });

    eve.send({ t: "rtc", to: adaVid, d: { sdp: { type: "offer", sdp: "sneaky" } } });  // a watcher tries to connect
    eve.send({ t: "talk", on: true });
    ada.send({ t: "rtc", to: "nobody00", d: { ice: {} } });                           // to nobody
    await new Promise(r => setTimeout(r, 200));
    expect(ada.got.filter(m => m.t === "rtc" || m.t === "talk")).toEqual([]);          // Ada heard nothing from Eve
    expect(eve.got.filter(m => m.t === "rtc" || m.t === "talk")).toEqual([]);          // and Eve never heard the table

    sam.ws.close();                                                                   // the seat changes hands
    await ada.until(() => voiceOf(ada).peers.length === 0);
    const bo = await open("/ws/whot/WZZZZ?name=Bo&id=bo-voice-01&sit=1&k=" + ada.last().invite);
    await bo.until(() => bo.last()?.you === 1);
    await ada.until(() => voiceOf(ada).peers.length === 1);
    expect(voiceOf(ada).peers[0].vid).not.toBe(samVid);                                // a new id: links are rebuilt for Bo
  });

  it("lets only the owner open it to watchers, who then join the group both ways", async () => {
    const ada = await create("WZZZY");
    await ada.myTurn();
    expect(voiceOf(ada)).toMatchObject({ owner: true, all: false });
    const sam = await open("/ws/whot/WZZZY?name=Sam&id=sam-voice-02&sit=1&k=" + ada.last().invite);
    await sam.until(() => sam.last()?.you === 1);
    const eve = await open("/ws/whot/WZZZY?name=Eve&id=eve-voice-02");
    await eve.until(() => !!eve.last());
    expect(voiceOf(sam).owner).toBe(false);

    sam.send({ t: "voiceall", on: true });                                             // not the owner: ignored
    eve.send({ t: "voiceall", on: true });
    await new Promise(r => setTimeout(r, 200));
    expect(voiceOf(ada).all).toBe(false);

    ada.send({ t: "voiceall", on: true });
    await eve.until(() => voiceOf(eve).me !== null);
    expect(voiceOf(eve)).toMatchObject({ all: true, owner: false });
    expect(voiceOf(eve).peers.map((x: any) => x.name).sort()).toEqual(["Ada", "Sam"]);
    expect(voiceOf(eve).peers.find((x: any) => x.name === "Ada").seat).toBe(0);
    await ada.until(() => voiceOf(ada).peers.some((x: any) => x.name === "Eve" && x.seat === null));

    const eveVid = voiceOf(eve).me, adaVid = voiceOf(ada).me;
    eve.send({ t: "talk", on: true });                                                 // a watcher can talk to the table...
    expect(await ada.next("talk")).toMatchObject({ vid: eveVid, on: true });
    ada.send({ t: "rtc", to: eveVid, d: { ice: {} } });                                // ...and the table can set up a link to them
    expect(await eve.next("rtc")).toMatchObject({ from: adaVid });

    ada.send({ t: "voiceall", on: false });                                            // closed again: watchers drop out
    await eve.until(() => voiceOf(eve).me === null);
    expect(voiceOf(eve).peers).toEqual([]);
  });

  it("takes the group no larger than eight, seated people first", async () => {
    const ada = await create("WZZZX");
    await ada.myTurn();
    ada.send({ t: "voiceall", on: true });
    const watchers = [];
    for (let i = 0; i < 9; i++) watchers.push(await open(`/ws/whot/WZZZX?name=W${i}&id=watcher-voice-${i}0`));
    await ada.until(() => voiceOf(ada).peers.length === 7);
    await new Promise(r => setTimeout(r, 150));
    expect(voiceOf(ada).peers.length).toBe(7);                                         // Ada plus seven watchers
    expect(watchers.filter(w => voiceOf(w)?.me).length).toBe(7);
  });
});

describe("landing page: /api/open", () => {
  const get = async (q = "") => (await exports.default.fetch(`https://play.test/api/open${q}`)).json() as Promise<any>;

  it("lists Whot tables with open seats and Flick players waiting, and serves repeats from the edge cache", async () => {
    const empty = await get();
    expect(empty.whot).toEqual({ tables: [], seats: 0 });
    expect(empty.flick.waiting).toEqual([]);

    const t1 = await open("/ws/lobby?code=LKAAA&game=whot&live=1&free=2&name=" + encodeURIComponent("Ada’s table · 3 seats"));
    const t2 = await open("/ws/lobby?code=LKBBB&game=whot&live=1&free=0&name=Full%20table");          // full: not offered
    const fl = await open("/ws/lobby?code=LKCCC&game=flick&name=Sam");                                    // waiting for an opponent
    await new Promise(r => setTimeout(r, 100));

    const cached = await get("?bust=" + Math.random());          // a query string does not get around the cache
    expect(cached.whot.tables).toEqual([]);                      // still the first answer: the lobby was not asked again
    await caches.default.delete(new Request("https://play.test/api/open"));

    const fresh = await get();
    expect(fresh.whot.seats).toBe(2);
    // tables with a seat come first; full tables stay listed so people can watch them
    expect(fresh.whot.tables.map((t: any) => [t.code, t.free])).toEqual([["LKAAA", 2], ["LKBBB", 0]]);
    expect(fresh.flick.waiting.map((w: any) => [w.code, w.name])).toEqual([["LKCCC", "Sam"]]);
    expect(fresh.flick.matches).toEqual([]);
    const live = await open("/ws/lobby?code=LKDDD&game=flick&live=1&name=" + encodeURIComponent("Ada v Sam"));   // a public match
    await new Promise(r => setTimeout(r, 100));
    await caches.default.delete(new Request("https://play.test/api/open"));
    const watch = await get();
    expect(watch.flick.live).toBe(1);
    expect(watch.flick.matches.map((m: any) => [m.code, m.title])).toEqual([["LKDDD", "Ada v Sam"]]);
    [t1, t2, fl, live].forEach(x => x.ws.close());
  });
});
