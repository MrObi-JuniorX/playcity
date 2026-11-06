/* Flick Football online play: rollback netcode on top of Rules.simTick.

   Both machines run the same deterministic match. Each one applies its own player's input the instant it happens
   and guesses the other player's (the last thing they were doing). When the real input arrives, the match is
   rewound to that tick and replayed, which takes well under a millisecond for this table. So your own keeper,
   your flick and your drag all react with zero delay, and the other player's actions show up about half a
   round trip late, smoothed so they do not jump.

   Every input packet carries all inputs the other side has not confirmed yet, so packets can be lost or arrive
   out of order on an unreliable channel and nothing is missed. At the start of every turn both sides compare a
   hash of the match. If they ever differ, the host's state wins and the guest replays from it, between turns
   where it cannot be seen. */
(function (root) {
'use strict';
const isNode = typeof module !== 'undefined' && module.exports;
const R = isNode ? require('./rules.js') : root.Rules;
const TICK = (isNode ? require('./phys.js') : root.Phys).TICK;

const MAX_ROLLBACK = 40;     // ticks (2/3 s). Beyond this the leading side waits for the other one.
const KEEP = 240;            // ticks of snapshots and inputs kept for rewinds and resyncs
const SEND_WINDOW = 60;      // most inputs sent in one packet

const same = (a, b) => (a.kd | 0) === (b.kd | 0) && (a.dv | 0) === (b.dv | 0) && JSON.stringify(a.c || []) === JSON.stringify(b.c || []);
const predictFrom = last => ({ kd: last ? last.kd | 0 : 0, dv: 0, c: [] });

/* opts: { G, me: 0|1, host: bool, send(msg, reliable), onEvent(e), now() } */
function createSession(opts) {
  const G = opts.G, me = opts.me, them = 1 - me, now = opts.now || (() => Math.round(performance.now()));
  const S = {
    G, me, them, tick: 0,
    inputs: [new Map(), new Map()],      // tick -> input, for both teams
    used: new Map(),                     // tick -> the input we simulated for the other side (real or guessed)
    snaps: new Map(),                    // tick -> state before that tick ran
    hashes: new Map(),                   // tick -> our hash at a turn start
    emitted: new Map(),                  // tick -> { kind: count } of events already played, so replays stay quiet
    remoteTick: -1,                      // highest tick for which we hold every remote input
    ackedByThem: -1,                     // highest of our ticks they hold
    theirTick: 0, theirAdv: 0,           // their clock and how far they run ahead of our inputs
    rewindFrom: Infinity,
    acc: 0, rtt: 100, stalled: 0,
    stats: { rollbacks: 0, rolledTicks: 0, resyncs: 0, maxRewind: 0 },
    lastSent: 0, sendEvery: 15, sentHashTo: 0, theirHashes: new Map(),
    taken: 0                             // next confirmed tick to hand to spectators
  };

  /* ----- simulation ----- */
  function runTick(t, replay) {
    S.snaps.set(t, R.snapshot(G));
    let rin = S.inputs[them].get(t);
    if (!rin) rin = predictFrom(S.inputs[them].get(t - 1) || S.used.get(t - 1));
    S.used.set(t, rin);
    const ins = []; ins[me] = S.inputs[me].get(t) || predictFrom(null); ins[them] = rin;
    const prevPhase = G.phase;
    const seen = S.emitted.get(t) || {}, counts = {}, outer = G.sink;
    G.sink = e => {
      const n = (counts[e.k] = (counts[e.k] || 0) + 1);
      if (n > (seen[e.k] || 0)) { seen[e.k] = n; opts.onEvent && opts.onEvent(e); }
    };
    R.simTick(G, ins);
    G.sink = outer;
    S.emitted.set(t, seen);
    if (G.phase === 'ready' && prevPhase !== 'ready') S.hashes.set(t + 1, R.hash(G));
    if (replay) S.stats.rolledTicks++;
  }

  function rewind() {
    if (S.rewindFrom === Infinity) return null;
    const from = Math.max(S.rewindFrom, S.tick - KEEP + 1); S.rewindFrom = Infinity;
    if (from >= S.tick) return null;
    const snap = S.snaps.get(from); if (!snap) return null;
    const before = bodies();
    for (const k of S.hashes.keys()) if (k > from) S.hashes.delete(k);
    R.restore(G, snap);
    for (let t = from; t < S.tick; t++) runTick(t, true);
    S.stats.rollbacks++; S.stats.maxRewind = Math.max(S.stats.maxRewind, S.tick - from);
    const after = bodies();
    return before.map((p, i) => [p[0] - after[i][0], p[1] - after[i][1]]);   // visual offsets to smooth away
  }
  function bodies() { const out = G.w.players.map(p => [p.x, p.z]); out.push([G.w.ball.x, G.w.ball.z]); return out; }

  /* ----- network ----- */
  function packet() {
    const from = Math.max(S.ackedByThem + 1, S.tick - SEND_WINDOW);
    const list = [];
    for (let t = from; t < S.tick; t++) { const i = S.inputs[me].get(t); if (i) list.push(compact(i)); }
    return { t: 'in', f: from, n: list, a: S.remoteTick, k: S.tick, d: S.tick - 1 - S.remoteTick, s: now() & 0x7fffffff };
  }
  const compact = i => (i.dv || (i.c && i.c.length)) ? [i.kd | 0, i.dv | 0, i.c || []] : (i.kd | 0);
  const expand = v => typeof v === 'number' ? { kd: v, dv: 0, c: [] } : { kd: v[0], dv: v[1], c: v[2] };

  S.receive = function (m) {
    if (m.t === 'in') {
      S.ackedByThem = Math.max(S.ackedByThem, m.a);
      S.theirTick = m.k; S.theirAdv = m.d;
      for (let j = 0; j < m.n.length; j++) {
        const t = m.f + j; if (t <= S.remoteTick) continue;
        if (t !== S.remoteTick + 1) break;            // only accept contiguous inputs
        const inp = expand(m.n[j]);
        S.inputs[them].set(t, inp); S.remoteTick = t;
        const u = S.used.get(t);
        if (t < S.tick && u && !same(u, inp)) S.rewindFrom = Math.min(S.rewindFrom, t);
      }
      if (m.e != null) S.rtt = S.rtt * 0.8 + Math.max(1, (now() & 0x7fffffff) - m.e) * 0.2;
      if (m.s != null) S.echo = m.s;
    } else if (m.t === 'hash') {
      S.theirHashes.set(m.tick, m.h);
    } else if (m.t === 'resync?' && opts.host) {
      const t = Math.min(m.tick, S.remoteTick + 1, S.tick);
      const snap = S.snaps.get(t) || (t === S.tick ? R.snapshot(G) : null);
      if (snap) opts.send({ t: 'resync', tick: t, state: snap }, true);
    } else if (m.t === 'resync' && !opts.host) {
      if (m.tick > S.tick || m.tick < S.tick - KEEP) return;
      S.snaps.set(m.tick, m.state);
      if (m.tick === S.tick) R.restore(G, m.state); else S.rewindFrom = Math.min(S.rewindFrom, m.tick);
      S.stats.resyncs++;
    }
  };

  function flush(force) {
    const t = now();
    if (!force && t - S.lastSent < S.sendEvery) return;
    S.lastSent = t;
    const p = packet(); if (S.echo != null) p.e = S.echo;
    opts.send(p, false);
    const final = Math.min(S.remoteTick + 1, S.tick);           // a hash is final once both inputs for it are in
    if (final > S.sentHashTo) {
      for (const [tk, h] of S.hashes) if (tk > S.sentHashTo && tk <= final) opts.send({ t: 'hash', tick: tk, h }, true);
      S.sentHashTo = final;
    }
    for (const [tk, h] of S.theirHashes) {                     // compare only once our own hash is final too
      if (tk > final) continue;
      S.theirHashes.delete(tk);
      const mine = S.hashes.get(tk);
      if (mine != null && mine !== h) { S.stats.mismatches = (S.stats.mismatches || 0) + 1; if (!opts.host) opts.send({ t: 'resync?', tick: tk }, true); }
    }
  }

  /* ----- clock -----
     Each side runs as far ahead of the other's inputs as the network forces it to. If we run further ahead than
     they do, we ease off a little so both see the same amount of rewind. */
  S.update = function (dt, localInput) {
    S.acc += Math.min(dt, 0.1);
    let offsets = rewind(), ran = 0;
    const adv = S.tick - 1 - S.remoteTick, skew = adv - S.theirAdv;
    const rate = skew > 2 ? 0.92 : skew < -2 ? 1.04 : 1;
    while (S.acc >= TICK / rate && ran < 5) {
      if (S.tick - S.remoteTick > MAX_ROLLBACK) { S.stalled += S.acc; S.acc = 0; break; }   // seconds of wall time, whatever the frame rate
      S.stalled = 0;
      S.acc -= TICK / rate;
      const t = S.tick, inp = localInput(t);
      S.inputs[me].set(t, inp);
      runTick(t, false);
      S.tick++;
      ran++;
    }
    if (ran === 5) S.acc = 0;
    const o2 = rewind(); if (o2) offsets = offsets ? offsets.map((v, i) => [v[0] + o2[i][0], v[1] + o2[i][1]]) : o2;
    prune();
    flush(false);
    return offsets;
  };
  S.flush = flush;
  /* Spectators get only final ticks: both inputs known, never rewound again. */
  S.takeConfirmed = function () {
    const out = [], upto = Math.min(S.remoteTick, S.tick - 1);
    for (let t = S.taken; t <= upto; t++) out.push([S.inputs[0].get(t), S.inputs[1].get(t)]);
    if (upto >= S.taken) S.taken = upto + 1;
    return out;
  };
  /* The state just before the next tick takeConfirmed() will return, for a spectator keyframe. */
  S.confirmedState = () => S.taken >= S.tick ? R.snapshot(G) : (S.snaps.get(S.taken) || null);
  function prune() {
    const lo = Math.min(S.tick - KEEP, S.remoteTick - 4, S.taken);
    for (const m of [S.snaps, S.used, S.emitted, S.hashes, S.inputs[0], S.inputs[1]]) for (const k of m.keys()) { if (k < lo) m.delete(k); else break; }
  }
  S.lag = () => Math.round(S.rtt);
  S.waiting = () => S.stalled > 0.25;
  /* Delay for a flick: half a round trip, at most 4 ticks. The flicker sees the cap go a few ms later, and the
     other player sees it start on time instead of jumping forward. */
  S.flickDelay = () => Math.max(0, Math.min(4, Math.round(S.rtt / 2 / 1000 * 60)));
  return S;
}

const API = { createSession, MAX_ROLLBACK };
if (isNode) module.exports = API; else root.Rollback = API;
})(typeof self !== 'undefined' ? self : this);
