import { describe, it, expect, afterEach } from "vitest";
import * as W from "../../public/whot/engine.js";
import * as C from "../../src/cup/tablecore";
import { rng } from "../../src/cup/engine";

/* Phase 6 (docs/whot-cup-prd.md 6.5, 8): the cup table's rules, played in plain Node with a fake clock. The CupTable
   Durable Object only adds sockets and storage around this core, so every message a seat, a watcher or the director
   could ever receive is built here, and these tests see all of them. The wire itself is tested in
   test/worker/cuptable.test.ts. */

const T0 = 1_800_000_000_000;
const NAMES = ["Ada", "Bola", "Chidi", "Dayo"];

function spec(n = 4, rules: Partial<C.TableRules> = {}, over: Partial<C.TableSpec> = {}): C.TableSpec {
  const r: C.TableRules = { turnClockSec: 30, tableClockSec: 600, disconnectGraceSec: 60, voice: "off", chat: "presets", spectators: "delayed", spectatorDelayMoves: 3, revealHands: "after-table", ...rules };
  const players = Array.from({ length: n }, (_, i) => `p${i}`);
  return { cupId: "cup-1", code: "ABCDEFGHJK", slot: 1, draw: "W", final: false, players, names: players.map((_, i) => NAMES[i]), pay1: 450, pay2: 220,
    seatedAt: T0, deadline: T0 + (r.tableClockSec + r.disconnectGraceSec + 60) * 1000, rules: r, ...over };
}
/** A table with everyone connected and the cards dealt. */
function dealt(n = 4, rules: Partial<C.TableRules> = {}) {
  const t = C.newTable(spec(n, rules));
  t.seats.forEach((_, i) => C.setConn(t, i, true, T0));
  C.settle(t, T0);
  return t;
}
/** The seat's own legal move, as a person would send it. */
function personMove(t: C.TableState): C.MoveMsg {
  const g = t.g!, mv = W.aiMove(W.hydrate(W.seatView(g, g.current)));
  return mv.type === "play" ? { t: "play", ids: ([] as number[]).concat(mv.cardId), shape: mv.shape, turn: g.turns } : { t: "market", turn: g.turns };
}

afterEach(() => C.setAudit(null));

/* ---------- the leak fuzz: random cup games with people arriving late, dropping, idling and sending junk ---------- */

const ID = /"id":(\d+)/g;
const idsIn = (s: string) => [...s.matchAll(ID)].map(m => Number(m[1]));

interface Fuzz { leaks: string[]; games: number; moves: number; refused: number; timeouts: number; forfeits: number; hows: Record<string, number>; worstGapOverBound: number }

function fuzz(games: number, seed0: number): Fuzz {
  const out: Fuzz = { leaks: [], games: 0, moves: 0, refused: 0, timeouts: 0, forfeits: 0, hows: {}, worstGapOverBound: -Infinity };
  const leak = (s: string) => { if (out.leaks.length < 20) out.leaks.push(s); };
  // S-1: every view of every move, checked against the live game it was built from.
  C.setAudit((step, pub, g) => {
    const played = new Set(g.events.flatMap(e => e.type === "play" ? e.cards!.map(c => c.id) : []));
    const discard = new Set(g.discard.map(c => c.id));
    if (!g.over) step.views.forEach((v, i) => {
      const mine = new Set(g.players[i].hand.map(c => c.id));
      for (const id of idsIn(v)) if (!mine.has(id) && !discard.has(id) && !played.has(id)) leak(`seat ${i} saw card ${id} (${step.kind})`);
      if (/"market":/.test(v)) leak(`seat ${i} got the market`);
      if ((v.match(/"hand":/g) || []).length !== 1) leak(`seat ${i} got another hand`);
    });
    if (pub !== null) {
      if (/"hand":|"market":/.test(pub)) leak("a watcher got a hand or the market");
      for (const id of idsIn(pub)) if (!discard.has(id) && !played.has(id)) leak(`a watcher saw card ${id}`);
    }
  });

  for (let k = 0; k < games; k++) {
    const r = rng(seed0 + k), R = (n: number) => Math.floor(r() * n);
    const n = 2 + R(3);
    const rules: Partial<C.TableRules> = { turnClockSec: 15 + R(46), tableClockSec: 300 + R(901), disconnectGraceSec: 15 + R(106), spectatorDelayMoves: 2 + R(9), revealHands: r() < 0.5 ? "never" : "after-table" };
    const t = C.newTable(spec(n, rules)), D = rules.spectatorDelayMoves!;
    const bound = (rules.disconnectGraceSec! + rules.turnClockSec!) * 1000 + 8000 + 1000;     // S-10: grace plus one turn
    const arrive = t.seats.map(() => r() < 0.06 ? Infinity : T0 + R(70_000));
    const conn = t.seats.map(() => false);
    let now = T0, last = 0, lastN = -1, fin: string | null = null;
    for (let iter = 0; iter < 50_000 && t.phase !== "done"; iter++) {
      // The next moment: a short random step, or now and then a long one, but never past the table's own next wake-up.
      const wake = C.wakeAt(t, now) ?? Infinity, next = Math.min(...arrive.filter(a => a > now), Infinity);
      now = Math.min(now + (r() < 0.04 ? 20_000 + R(60_000) : 200 + R(6000)), wake, next);
      t.seats.forEach((_, i) => {
        if (!conn[i] && now >= arrive[i]) conn[i] = true;
        else if (conn[i] && r() < 0.012) { conn[i] = false; arrive[i] = r() < 0.3 ? Infinity : now + R(rules.disconnectGraceSec! * 1500); }
        C.setConn(t, i, conn[i], now);
      });
      const before = t.steps, phase = t.phase;
      C.settle(t, now);
      if (t.phase === "playing" && t.g && !t.g.over && C.person(t, t.g.current) && r() < 0.7) {
        const cur = t.g.current;
        if (r() < 0.2) {                                             // S-4 in the core: junk changes nothing
          const snap = JSON.stringify(t);
          const other = (cur + 1) % n;
          const bad: [number, C.MoveMsg][] = [
            [cur, { t: "play", ids: [R(54)], turn: t.g.turns - 1 }],                  // replayed
            [cur, { t: "market", turn: t.g.turns + 1 }],                              // from the future
            [other, { t: "market", turn: t.g.turns }],                                // out of turn
            [cur, { t: "play", ids: [53, 53], turn: t.g.turns }],                     // the same card twice
            [cur, { t: "play", ids: t.g.players[other].hand.slice(0, 1).map(c => c.id), turn: t.g.turns }], // someone else's card
          ];
          for (const [s, m] of bad) { const res = C.move(t, s, m, now); if (res.ok) leak(`junk accepted: ${JSON.stringify(m)}`); else out.refused++; }
          if (JSON.stringify(t) !== snap) leak("a refused move changed the table");
        }
        const res = C.move(t, cur, personMove(t), now);
        if (!res.ok) leak(`a legal move was refused: ${res.reason}`); else out.moves++;
        C.settle(t, now);
      }
      if (t.phase === "playing") {
        if (t.steps !== before || phase !== "playing") last = now;
        out.worstGapOverBound = Math.max(out.worstGapOverBound, now - last - bound);
      }
      // S-2: watchers are never closer than spectatorDelayMoves to the live game, and never go backwards.
      const su = C.spectatorUpdate(t);
      if (su.sync) fin = su.sync;
      for (const m of su.steps) {
        const sn = Number(/"n":(\d+)/.exec(m)![1]);
        if (t.phase === "playing" && sn > t.steps - D) leak(`a watcher was ${t.steps - sn} moves behind, under ${D}`);
        if (sn <= lastN) leak("a watcher went backwards");
        lastN = sn;
      }
    }
    if (t.phase !== "done") { leak(`game ${k} never ended`); continue; }
    out.games++;
    out.hows[t.how!] = (out.hows[t.how!] ?? 0) + 1;
    out.timeouts += t.seats.reduce((a, s) => a + s.timeouts, 0);
    out.forfeits += t.seats.filter(s => s.forfeit).length;
    // The director's copy: ids, points and counts only.
    const res = C.resultOf(t);
    if (/"id"|"shape"|"hand"|"market"/.test(res.stats)) leak("the result carries cards");
    if ([...res.places].sort().join() !== [...t.spec.players].sort().join()) leak("the places are not the seated players");
    // The watchers' last view: hands only with revealHands after-table.
    fin ??= C.spectatorUpdate(t).sync;
    if (t.how !== "walkover" && fin === null) leak("watchers got no final view");
    if (fin && (rules.revealHands === "never") === /"hand":/.test(fin)) leak(`final view and revealHands ${rules.revealHands} disagree`);
    // Forfeited players rank below everyone who stayed.
    const fIdx = t.places!.map(i => !!t.seats[i].forfeit);
    if (fIdx.some((f, j) => f && fIdx.slice(j).some(x => !x))) leak("a forfeit ranked above someone who stayed");
  }
  return out;
}

describe("S-1, S-2, S-4, S-10: the leak fuzz", () => {
  const GAMES = Number((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.CUP_FUZZ_GAMES || 1000);
  it(`${GAMES} random cup games: no hidden card reaches anyone, watchers stay behind, nothing freezes`, () => {
    const f = fuzz(GAMES, 9_000);
    console.log(JSON.stringify({ games: f.games, moves: f.moves, refused: f.refused, timeouts: f.timeouts, forfeits: f.forfeits, hows: f.hows, worstGapOverBoundMs: f.worstGapOverBound }));
    expect(f.leaks).toEqual([]);
    expect(f.games).toBe(GAMES);
    expect(f.worstGapOverBound).toBeLessThanOrEqual(0);
    // The fuzz really did exercise the paths it is meant to.
    for (const how of ["checkup", "clock", "forfeit"]) expect(f.hows[how] ?? 0).toBeGreaterThan(0);
    expect(f.timeouts).toBeGreaterThan(0);
    expect(f.refused).toBeGreaterThan(1000);
  }, 300_000);
});

/* ---------- S-3 ---------- */

describe("S-3: the deck is independent of anything published", () => {
  it("a table is never told a seed, and identical tables deal different decks", () => {
    const s = spec();
    expect(JSON.stringify(s)).not.toMatch(/seed/i);
    const decks = new Set<string>();
    for (let i = 0; i < 200; i++) { const g = dealt().g!; decks.add(g.players.map(p => p.hand.map(c => c.id).join()).join("|") + g.discard[0].id); }
    expect(decks.size).toBe(200);
  });
  it("10,000 deals: no card position depends on the round's seed (chi-squared, p < 0.0001)", () => {
    const N = 10_000, tables = Array.from({ length: 4 }, () => [[0, 0], [0, 0]]);
    for (let k = 0; k < N; k++) {
      const seed = crypto.getRandomValues(new Uint8Array(32));         // what the cup page would publish for this slot
      const g = dealt().g!;
      const pairs = [[seed[0] & 1, g.players[0].hand[0].id & 1], [seed[1] & 1, g.discard[0].id & 1], [seed[2] >> 7, g.market[g.market.length - 1].id & 1], [seed[31] & 1, g.players[3].hand[4].id & 1]];
      pairs.forEach(([a, b], j) => tables[j][a][b]++);
    }
    for (const t of tables) {
      const rows = [t[0][0] + t[0][1], t[1][0] + t[1][1]], cols = [t[0][0] + t[1][0], t[0][1] + t[1][1]];
      let chi = 0;
      for (const a of [0, 1]) for (const b of [0, 1]) { const e = rows[a] * cols[b] / N; chi += (t[a][b] - e) ** 2 / e; }
      expect(chi).toBeLessThan(15.14);                                // 1 degree of freedom, p = 0.0001
    }
  }, 120_000);
});

/* ---------- the table's rules ---------- */

describe("cup table rules", () => {
  it("deals the moment everyone is here, or a minute after seating with whoever came", () => {
    const t = C.newTable(spec(4));
    C.setConn(t, 0, true, T0); C.setConn(t, 1, true, T0);
    expect(C.settle(t, T0 + 30_000)).toEqual([]);
    expect(t.phase).toBe("waiting");
    expect(C.wakeAt(t, T0 + 30_000)).toBe(T0 + C.JOIN_MS);
    const steps = C.settle(t, T0 + C.JOIN_MS);
    expect(t.phase).toBe("playing");
    expect(steps[0].kind).toBe("deal");
    expect(t.g!.players.map(p => p.type)).toEqual(["human", "human", "cpu", "cpu"]);   // the computer holds the absent seats
    expect(t.endAt).toBe(T0 + C.JOIN_MS + 600_000);
    // ...and those two forfeit a grace after the deal if they never come.
    C.settle(t, T0 + C.JOIN_MS + 60_000);
    expect(t.seats.map(s => !!s.forfeit)).toEqual([false, false, true, true]);
  });

  it("the table clock always ends before the director's backstop", () => {
    const t = C.newTable(spec(4));
    t.seats.forEach((_, i) => C.setConn(t, i, true, T0 + 500_000));
    C.settle(t, T0 + 500_000);                                            // everyone came late
    expect(t.endAt).toBe(t.spec.deadline - C.END_MARGIN_MS);
  });

  it("when the clock runs out: fewest points, then fewest cards, then seat order; forfeits last", () => {
    const t = dealt(4);
    const g = t.g!, card = (n: number) => ({ id: 0, shape: "circle", n });
    g.players[0].hand = [card(10)];
    g.players[1].hand = [card(3), card(4)];                 // 7 points
    g.players[2].hand = [card(7)];                          // 7 points, fewer cards: ahead of seat 1
    g.players[3].hand = [card(1)];                          // fewest points, but forfeited
    t.seats[3].forfeit = T0;
    expect(C.rank(t, null)).toEqual([2, 1, 0, 3]);
    g.players[1].hand = [card(7)];                          // a full tie: seat order
    expect(C.rank(t, null)).toEqual([1, 2, 0, 3]);
    expect(C.rank(t, 0)).toEqual([0, 1, 2, 3]);             // a check-up winner comes first
  });

  it("ends on the clock with everyone's hands shown and the places ranked", () => {
    const t = dealt(3);
    const steps = C.settle(t, t.endAt);
    expect(t.phase).toBe("done");
    expect(t.how).toBe("clock");
    expect(steps.at(-1)!.kind).toBe("end");
    expect(JSON.parse(`{${steps.at(-1)!.views[0]}}`).v.players.every((p: any) => Array.isArray(p.hand))).toBe(true);
    expect(t.places).toEqual(C.rank(t, null));
    const r = C.resultOf(t);
    expect(JSON.parse(r.stats)).toMatchObject({ how: "clock", moves: t.steps });
  });

  it("a player away past the grace forfeits; the last one standing wins the table", () => {
    const t = dealt(2);
    C.setConn(t, 1, false, T0 + 1000);
    C.settle(t, T0 + 1000 + 59_000);
    expect(t.phase).toBe("playing");
    C.settle(t, T0 + 1000 + 60_000);
    expect(t.phase).toBe("done");
    expect(t.how).toBe("forfeit");
    expect(t.places).toEqual([0, 1]);
    expect(JSON.parse(C.resultOf(t).stats).forfeits).toEqual(["p1"]);
  });

  it("a dropped player's turn waits a few seconds, then the computer plays for them", () => {
    const t = dealt(2);
    const cur = t.g!.current, turns = t.g!.turns;
    C.setConn(t, cur, false, T0 + 1000);
    expect(C.settle(t, T0 + 1000 + C.HOLD_MS - 1)).toEqual([]);
    expect(C.meta(t, 1 - cur, T0 + 5000, { watching: 0, voice: null })).toContain('"grace":{"seat":' + cur);
    const steps = C.settle(t, T0 + 1000 + C.HOLD_MS);
    expect(steps[0]).toMatchObject({ kind: "cpu", actor: cur });
    expect(t.g!.turns).toBeGreaterThan(turns);
  });

  it("T11: dropping and coming back never buys a fresh turn clock", () => {
    const t = dealt(2);
    const cur = t.g!.current, dl = t.dl;
    C.setConn(t, cur, false, dl - 5000); C.settle(t, dl - 5000);
    C.setConn(t, cur, true, dl - 1000); C.settle(t, dl - 1000);
    expect(t.dl).toBe(dl);
    const steps = C.settle(t, dl);
    expect(steps[0]).toMatchObject({ kind: "auto", actor: cur });
    expect(t.seats[cur].timeouts).toBe(1);
  });

  it("with nobody at the table, the computer does not play the game out", () => {
    const t = dealt(4);
    t.seats.forEach((_, i) => C.setConn(t, i, false, T0 + 1000));
    expect(C.settle(t, T0 + 30_000)).toEqual([]);
    expect(t.steps).toBe(0);
    C.settle(t, T0 + 1000 + 60_000);                                       // everyone forfeits together
    expect(t.phase).toBe("done");
    expect(t.how).toBe("forfeit");
  });

  it("refuses moves before the deal, after the end, from a forfeited seat and out of turn", () => {
    const w = C.newTable(spec(2));
    expect(C.move(w, 0, { t: "market", turn: 0 }, T0)).toEqual({ ok: false, reason: "not-started" });
    const t = dealt(2), cur = t.g!.current;
    expect(C.move(t, 1 - cur, { t: "market", turn: t.g!.turns }, T0)).toEqual({ ok: false, reason: "not-your-turn" });
    t.seats[cur].forfeit = T0;
    expect(C.move(t, cur, { t: "market", turn: t.g!.turns }, T0)).toEqual({ ok: false, reason: "forfeited" });
    t.seats[cur].forfeit = 0;
    C.settle(t, t.endAt);
    expect(C.move(t, cur, { t: "market", turn: t.g!.turns }, t.endAt)).toEqual({ ok: false, reason: "over" });
  });

  it("names are unique at the table", () => {
    const t = C.newTable(spec(3, {}, { names: ["Tunde", "Tunde", "<b>Tunde</b>"] }));
    expect(t.names).toEqual(["Tunde", "Tunde 2", "bTunde/b"]);
  });

  it("reports once, retries what can change, gives up on what can't, then closes after the reveal", () => {
    const t = dealt(2);
    C.settle(t, t.endAt);
    expect(t.report.state).toBe("pending");
    C.reported(t, null, t.endAt);                                           // the director didn't answer
    expect(t.report).toMatchObject({ state: "pending", tries: 1 });
    expect(C.closing(t, t.closeAt)).toBe(false);                            // never closes on an unsent result...
    C.reported(t, { ok: false, error: "bad-signature" }, t.endAt);
    expect(t.report.state).toBe("failed");                                  // ...unless it can never be sent
    expect(C.closing(t, t.closeAt - 1)).toBe(false);
    expect(C.closing(t, t.closeAt)).toBe(true);
  });

  it("watchers see nothing until spectatorDelayMoves moves have been made, then always that far behind", () => {
    const t = dealt(4, { spectatorDelayMoves: 3 });
    expect(C.watchView(t)).toBeNull();
    let now = T0;
    for (let i = 0; i < 12 && t.phase === "playing"; i++) {
      now += 1000;
      const r = C.move(t, t.g!.current, personMove(t), now);
      if (!r.ok) break;
      C.settle(t, now);
      const sent = C.spectatorUpdate(t).steps.map(m => Number(/"n":(\d+)/.exec(m)![1]));
      for (const n of sent) expect(n).toBeLessThanOrEqual(t.steps - 3);
      if (t.steps >= 3) expect(Number(/"n":(\d+)/.exec(C.watchView(t)!)![1])).toBe(t.steps - 3);
    }
  });
});
