import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const R = require("../../public/flick-football/rules.js");
const RB = require("../../public/flick-football/rollback.js");
const AI = require("../../public/flick-football/ai.js");
const SP = require("../../public/flick-football/spectate.js");
const fs = require("node:fs");

const opts = { teams: [{ kit: "ngr", form: "3-2-1" }, { kit: "bra", form: "2-2-2" }], halfLen: 60 };

/* Seeded RNG so every run plays the same match. */
function rng(seed) { let s = seed >>> 0; return () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5 >>> 0) / 4294967296); }

/* A scripted player: slides its keeper at random, and flicks with the computer's choice when it is its turn. */
function bot(team, rand) {
  let kd = 0, thinkAt = -1;
  return (G, t) => {
    if (rand() < 0.05) kd = Math.floor(rand() * 3) - 1;
    const c = [], dv = rand() < 0.01 ? (rand() < 0.5 ? -1 : 1) : 0;
    if (G.arrange && G.arrange.team === team && G.phase === "ready") c.push(R.cmd.arrangeDone());
    else if (G.phase === "ready" && G.turn === team && !G.timeUp) {
      if (thinkAt < 0) thinkAt = t + 10 + Math.floor(rand() * 20);
      if (t >= thinkAt) {
        thinkAt = -1;
        const saved = Math.random; Math.random = rand;            // the computer's randomness, made repeatable
        const pk = AI.chooseNow(G, team, "normal"); Math.random = saved;
        if (pk.place) c.push(R.cmd.taker(pk.place[0], pk.place[1]));
        c.push(R.cmd.flick(pk.id, pk.dx, pk.dz, pk.speed, pk.curl || 0));
      }
    } else thinkAt = -1;
    if (G.phase === "halftime") c.push(R.cmd.secondHalf());
    return { kd, dv, c };
  };
}

/* Two sessions joined by a fake network with delay, jitter, loss and reordering. */
function link({ delay, jitter, loss, rand }) {
  let clock = 0; const q = [];
  const chan = deliver => (msg, reliable) => {
    if (!reliable && rand() < loss) return;
    const at = clock + delay + rand() * jitter;
    q.push({ at, deliver, msg: JSON.parse(JSON.stringify(msg)) });
  };
  return {
    now: () => Math.round(clock),
    chan,
    step(ms) { clock += ms; q.sort((a, b) => a.at - b.at); while (q.length && q[0].at <= clock) { const m = q.shift(); m.deliver(m.msg); } }
  };
}

function playOnline({ ticks, delay, jitter, loss, seed }) {
  const rand = rng(seed), net = link({ delay, jitter, loss, rand: rng(seed + 1) });
  const GA = R.createGame(opts), GB = R.restore({}, R.snapshot(GA));
  let A, B;
  A = RB.createSession({ G: GA, me: 0, host: true, now: net.now, send: net.chan(m => B.receive(m)) });
  B = RB.createSession({ G: GB, me: 1, host: false, now: net.now, send: net.chan(m => A.receive(m)) });
  const pa = bot(0, rng(seed + 2)), pb = bot(1, rng(seed + 3));
  for (let i = 0; i < ticks; i++) {
    // each side's frame arrives a little irregularly, like a real browser
    A.update(1 / 60 + (rand() - 0.5) * 0.004, t => pa(GA, t));
    B.update(1 / 60 + (rand() - 0.5) * 0.004, t => pb(GB, t));
    net.step(1000 / 60);
  }
  // let the network drain, then both sides must agree tick for tick
  for (let i = 0; i < 120; i++) { A.flush(true); B.flush(true); net.step(20); }
  // a real game updates every frame; here one zero-length update applies any rewind the last inputs asked for
  A.update(0, () => ({})); B.update(0, () => ({}));
  return { A, B, GA, GB };
}

describe("deterministic simulation", () => {
  it("the same inputs give the same match, bit for bit", () => {
    const run = () => {
      const G = R.createGame(opts), pa = bot(0, rng(7)), pb = bot(1, rng(8));
      for (let t = 0; t < 3000; t++) R.simTick(G, [pa(G, t), pb(G, t)]);
      return { h: R.hash(G), score: G.score.join("-"), x: G.w.ball.x };
    };
    const a = run(), b = run();
    expect(a).toEqual(b);
  });

  it("snapshot + restore replays identically (what rollback relies on)", () => {
    const G = R.createGame(opts), pa = bot(0, rng(3)), pb = bot(1, rng(4)), ins = [];
    for (let t = 0; t < 1500; t++) { const i = [pa(G, t), pb(G, t)]; ins.push(i); R.simTick(G, i); }
    const snap = R.snapshot(G);
    for (let t = 1500; t < 1800; t++) { const i = [pa(G, t), pb(G, t)]; ins.push(i); R.simTick(G, i); }
    const h1 = R.hash(G);
    R.restore(G, snap);
    for (let t = 1500; t < 1800; t++) R.simTick(G, ins[t]);
    expect(R.hash(G)).toBe(h1);
  });

  it("the simulation never uses engine-dependent maths", () => {
    for (const f of ["phys.js", "rules.js"]) {
      const src = fs.readFileSync(new URL(`../../public/flick-football/${f}`, import.meta.url), "utf8")
        .split("\n").filter(l => !/p\.face|taker\.face|^\s*\/\*|^\s*\/\/|tilt\.loft|function ballDisc|Math\.exp\(-3 \* dt\)/.test(l)).join("\n");
      expect(src, f).not.toMatch(/Math\.(hypot|sin|cos|tan|atan2|asin|acos|exp|log|pow|random)\(/);
    }
  });
});

describe("rollback online play", () => {
  for (const net of [
    { name: "same city (20 ms)", delay: 10, jitter: 4, loss: 0 },
    { name: "cross-country (80 ms, 2% loss)", delay: 40, jitter: 15, loss: 0.02 },
    { name: "bad wifi (200 ms, 10% loss)", delay: 100, jitter: 60, loss: 0.1 }
  ]) {
    it(`both players end on the same match: ${net.name}`, () => {
      const { A, B, GA, GB } = playOnline({ ticks: 3600, seed: 11, ...net });
      expect(Math.abs(A.tick - B.tick)).toBeLessThanOrEqual(2);
      // compare at the same tick: rewind the one that is ahead
      expect(A.remoteTick).toBeGreaterThan(3000);
      const t = Math.min(A.tick, B.tick, A.remoteTick + 1, B.remoteTick + 1) - 1;
      const sa = A.snaps.get(t), sb = B.snaps.get(t);
      expect(R.hash(R.restore({}, sa))).toBe(R.hash(R.restore({}, sb)));
      expect(GA.score).toEqual(GB.score);
      expect(A.stats.mismatches || 0).toBe(0);
      expect(B.stats.mismatches || 0).toBe(0);
      expect(A.stats.maxRewind).toBeLessThanOrEqual(RB.MAX_ROLLBACK);
    });
  }

  it("a midstream join seeds the guest with the exact match in progress", () => {
    const G = R.createGame(opts), pa = bot(0, rng(5)), pb = bot(1, rng(6));
    for (let t = 0; t < 2000; t++) R.simTick(G, [pa(G, t), pb(G, t)]);   // host was playing the computer
    const wire = JSON.parse(JSON.stringify(R.snapshot(G)));               // sent as JSON over the wire
    const guest = R.restore({}, wire);
    expect(R.hash(guest)).toBe(R.hash(G));
    for (let t = 2000; t < 2600; t++) { const i = [pa(G, t), pb(G, t)]; R.simTick(G, i); R.simTick(guest, i); }
    expect(R.hash(guest)).toBe(R.hash(G));
  });

  it("a worst-case 40-tick rewind fits inside one frame", () => {
    const G = R.createGame(opts), pa = bot(0, rng(9)), pb = bot(1, rng(10));
    for (let t = 0; t < 600; t++) R.simTick(G, [pa(G, t), pb(G, t)]);
    const batch = () => { const t0 = performance.now(); for (let t = 0; t < 200; t++) { R.snapshot(G); R.simTick(G, [{ kd: 1 }, { kd: -1 }]); } return (performance.now() - t0) / 200; };
    for (let i = 0; i < 3; i++) batch();                              // warm up the JIT
    const runs = Array.from({ length: 7 }, batch).sort((a, b) => a - b), perTick = runs[3];
    // Worst case is a full 40-tick rewind, which must fit in one 60 Hz frame (16.7 ms) with room to draw.
    // Typical rewinds are 1 to 6 ticks. Standalone this measures ~0.1 ms a tick on a laptop.
    expect(perTick * RB.MAX_ROLLBACK).toBeLessThan(14);
  });
});

describe("spectators", () => {
  it("watchers replay the players' match exactly, including one who joins halfway", () => {
    const rand = rng(21), net = link({ delay: 40, jitter: 15, loss: 0.02, rand: rng(22) });
    const GA = R.createGame(opts), GB = R.restore({}, R.snapshot(GA));
    let A, B;
    A = RB.createSession({ G: GA, me: 0, host: true, now: net.now, send: net.chan(m => B.receive(m)) });
    B = RB.createSession({ G: GB, me: 1, host: false, now: net.now, send: net.chan(m => A.receive(m)) });
    const pa = bot(0, rng(23)), pb = bot(1, rng(24));

    // The room fans the feed out over a reliable WebSocket: ordered, a little late.
    const watchers = [];
    const room = []; const fanout = m => room.push({ at: net.now() + 60, m: JSON.parse(JSON.stringify(m)) });
    const feed = SP.createFeed(fanout);
    const join = () => { const w = SP.createViewer({}); watchers.push(w); feed.active = true; feed.keyframe(A.confirmedState()); return w; };
    const early = join();
    let late = null;

    for (let i = 0; i < 3600; i++) {
      A.update(1 / 60 + (rand() - 0.5) * 0.004, t => pa(GA, t));
      B.update(1 / 60 + (rand() - 0.5) * 0.004, t => pb(GB, t));
      for (const ins of A.takeConfirmed()) feed.push(ins);
      if (i === 1800) late = join();
      feed.tick(net.now());
      net.step(1000 / 60);
      while (room.length && room[0].at <= net.now()) { const { m } = room.shift(); for (const w of watchers) if (w !== late || m.t !== "wk" || m.ft >= 0) w.receive(m); }
      for (const w of watchers) w.update(1 / 60);
    }
    for (let i = 0; i < 120; i++) { A.flush(true); B.flush(true); net.step(20); for (const ins of A.takeConfirmed()) feed.push(ins); }
    feed.flush();
    for (const { m } of room.splice(0)) for (const w of watchers) w.receive(m);
    for (const w of watchers) while (w.buffered() > 0) w.update(0.25);

    const truth = R.hash(R.restore({}, A.confirmedState()));
    expect(early.play).toBe(A.taken);
    expect(R.hash(early.G)).toBe(truth);
    expect(late.play).toBe(A.taken);
    expect(R.hash(late.G)).toBe(truth);
  });
});

describe("physics constants", () => {
  it("are all real numbers (a stray comment once commented out half a line and turned every collision into NaN)", () => {
    const P = require("../../public/flick-football/phys.js");
    for (const [k, v] of Object.entries(P.C)) expect(Number.isFinite(v), k).toBe(true);
    for (const k of ["ePP", "ePost", "eNet", "ePlayer", "eKeeper", "eWall", "muP", "muB", "muBP"]) expect(P.C[k], k).toBeGreaterThan(0);
  });
});

describe("rules", () => {
  it("the team that really touched the ball last loses the throw-in (a graze while moving apart is not a touch)", () => {
    const saved = Math.random; let s = 11;
    Math.random = () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5 >>> 0) / 4294967296);
    let outs = 0, wrongTouch = 0, wrongThrow = 0;
    try {
      for (let m = 0; m < 2; m++) {
        const G = R.createGame({ ...opts, halfLen: 0 }), ks = [{}, {}]; let real = null, flicks = 0;
        G.sink = e => { if ((e.k === "pb" || e.k === "kb") && e.jn > 0) real = G.w.players[e.id].team; if (e.k === "flick") real = null; };
        for (let t = 0; t < 60 * 60 * 4 && flicks < 70; t++) {
          const ins = [0, 1].map(team => { const k = AI.keeper(G, team, "normal", 1 / 60, ks[team]); return { kd: k.dir, dv: k.dive, c: [] }; });
          if (G.arrange && G.phase === "ready") AI.arrange(G, G.arrange.team);
          else if (G.phase === "ready" && !G.timeUp) { const pk = AI.chooseNow(G, G.turn, "easy"); if (pk.place) ins[G.turn].c.push(R.cmd.taker(pk.place[0], pk.place[1])); ins[G.turn].c.push(R.cmd.flick(pk.id, pk.dx, pk.dz, pk.speed, 0)); flicks++; }
          const before = G.phase;
          R.simTick(G, ins);
          if (before === "moving" && G.phase === "dead" && G.out) {
            outs++; const lt = G.out.lt, line = G.out.line;
            if (real !== null && real !== lt) wrongTouch++;
            for (let i = 0; i < 120 && G.phase === "dead"; i++) R.simTick(G, [{}, {}]);
            if (line === "touch" && G.turn !== 1 - lt) wrongThrow++;
          }
        }
      }
    } finally { Math.random = saved; }
    expect(outs).toBeGreaterThan(20);
    expect(wrongTouch).toBe(0);
    expect(wrongThrow).toBe(0);
  });
});

describe("goal kick arrangement", () => {
  /* Team 0 knocks the ball over the far goal line, wide of the goal: a goal kick to team 1. */
  function goalKick() {
    const G = R.createGame(opts); R.arrangeDone(G);
    const P = require("../../public/flick-football/phys.js"), C = P.C, s = G.dir[0];
    const b = G.w.ball; Object.assign(b, { x: s * (C.HL - 3), z: 26, vx: s * 150, vz: 0, lastTouch: { team: 0, id: 0, t: 0 } });
    Object.assign(G, { phase: "moving", flickTeam: 0, flicker: 0, moveT: 0, stillT: 0 });
    for (let i = 0; i < 600 && !(G.phase === "ready" && G.mode === "goalkick"); i++) R.simTick(G, [null, null]);
    return { G, C, s };
  }
  it("lets the other side set up from its formation and waits for Ready", () => {
    const { G, C, s } = goalKick();
    expect(G.mode).toBe("goalkick");
    expect(G.turn).toBe(1);
    expect(G.arrange).toMatchObject({ team: 0, mode: "goalkick", side: s });
    expect(R.canFlick(G, G.forced)).toBe(false);                       // the kick waits
    const clock = G.clock; for (let i = 0; i < 30; i++) R.simTick(G, [null, null]);
    expect(G.clock).toBe(clock);                                       // and so does the clock
    // formation: every outfield cap of team 0 is back on its own formation spot (or nudged clear of the box)
    const f = R.FORMS[G.forms[0]], d = G.dir[0];
    R.outfield(G, 0).forEach((p, i) => expect(Math.hypot(p.x - -d * (C.HL - f[i][0]), p.z - f[i][1])).toBeLessThan(3));
    // a cap can go deep into the kicker's half, but never inside the kicker's box
    const p = R.outfield(G, 0)[5];
    expect(R.arrangeMove(G, p.id, s * (C.HL - C.boxD - 6), 0)).toBe(true);
    expect(Math.abs(p.x)).toBeCloseTo(C.HL - C.boxD - 6, 5);
    R.arrangeMove(G, p.id, s * (C.HL - 6), 0);
    expect(Math.abs(p.x)).toBeLessThanOrEqual(C.HL - C.boxD - C.pr + 1e-9);
    R.applyInput(G, 1, { c: [R.cmd.arrangeDone()] });                  // only the arranging side can say Ready
    expect(G.arrange).not.toBe(null);
    R.applyInput(G, 0, { c: [R.cmd.arrangeDone()] });
    expect(G.arrange).toBe(null);
    expect(R.canFlick(G, G.forced)).toBe(true);
  });
  it("the computer presses up to the box edge and is ready at once", () => {
    const { G, C, s } = goalKick();
    AI.arrange(G, 0);
    expect(G.arrange).toBe(null);
    const near = R.outfield(G, 0).filter(p => Math.abs(p.x - s * C.HL) < C.boxD + 12).length;
    expect(near).toBeGreaterThanOrEqual(2);
    for (const p of R.outfield(G, 0)) expect(Math.abs(p.x - s * C.HL) >= C.boxD + C.pr - 1e-9 || Math.abs(p.z) >= C.boxHW + C.pr - 1e-9).toBe(true);
  });
});
