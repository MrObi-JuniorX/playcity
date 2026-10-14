/* Flick Football spectating.

   The host publishes a feed: a keyframe (the whole match, ~4 KB) when someone starts watching or when the match
   changes outside the inputs, then batches of confirmed per-tick inputs four times a second. The feed goes to the
   room once, and the room fans it out to every watcher.

   A watcher runs the same deterministic simulation from the keyframe, about 0.4 s behind live so it always has
   the next inputs in hand. That makes playback smooth: no prediction, no rewinds, no jumps. Aim arrows are
   stamped with the feed tick and shown when playback reaches it, so they line up with the flick that follows. */
(function (root) {
'use strict';
const isNode = typeof module !== 'undefined' && module.exports;
const R = isNode ? require('./rules.js') : root.Rules;
const TICK = (isNode ? require('./phys.js') : root.Phys).TICK;

const compact = i => !i ? 0 : (i.dv || (i.c && i.c.length)) ? [i.kd | 0, i.dv | 0, i.c || []] : (i.kd | 0);
const expand = v => typeof v === 'number' ? { kd: v, dv: 0, c: [] } : { kd: v[0], dv: v[1], c: v[2] };

/* Host side. send(msg) goes to the room. Ticks are counted even when nobody watches, so the numbering
   never restarts; they are only buffered and sent while active. */
function createFeed(send) {
  const F = { ft: 0, active: false, buf: [], from: 0, last: 0 };
  F.push = ins => {
    if (F.active) { if (!F.buf.length) F.from = F.ft; F.buf.push([compact(ins[0]), compact(ins[1])]); }
    F.ft++;
  };
  F.flush = () => { if (F.buf.length) { send({ t: 'wi', f: F.from, n: F.buf }); F.buf = []; } };
  F.keyframe = (state, extra) => {
    if (!F.active || !state) return;
    F.flush();
    send(Object.assign({ t: 'wk', ft: F.ft, state }, extra || {}));
  };
  F.tick = now => { if (F.active && now - F.last >= 250) { F.last = now; F.flush(); } };
  F.aim = (team, m) => { if (F.active) send({ t: 'wa', ft: F.ft, team, id: m.id, dx: m.dx, dz: m.dz, p: m.p }); };
  return F;
}

/* Watcher side. G is the match object the views draw. */
function createViewer(G, opts) {
  opts = opts || {};
  const DELAY = opts.delay || 24;                 // ticks of buffer to keep (0.4 s)
  const W = { G, play: -1, latest: -1, inputs: new Map(), acc: 0, started: false, aims: [], waitedFor: 0 };
  W.receive = m => {
    if (m.t === 'wk') {
      R.restore(G, m.state);
      W.play = m.ft; W.acc = 0; W.started = false; W.waitedFor = 0;
      for (const k of W.inputs.keys()) if (k < m.ft) W.inputs.delete(k);
      W.aims = W.aims.filter(a => a.ft >= m.ft);
      opts.onKeyframe && opts.onKeyframe(m);
    } else if (m.t === 'wi') {
      for (let j = 0; j < m.n.length; j++) W.inputs.set(m.f + j, m.n[j]);
      W.latest = Math.max(W.latest, m.f + m.n.length - 1);
    } else if (m.t === 'wa') W.aims.push(m);
  };
  W.buffered = () => W.play < 0 ? 0 : Math.max(0, W.latest - W.play + 1);
  W.update = dt => {
    if (W.play < 0) return 0;
    const buf = W.buffered();
    if (!W.started) {                             // fill the buffer first (or give up waiting after a second)
      W.waitedFor += dt;
      if (buf < DELAY && W.waitedFor < 1) return 0;
      W.started = true;
    }
    // Ease the playback speed to hold the buffer near DELAY. Far behind (a hidden tab): catch up fast.
    const rate = buf > DELAY + 120 ? 8 : buf > DELAY + 30 ? 1.5 : buf > DELAY + 8 ? 1.08 : buf < DELAY - 10 ? 0.92 : 1;
    W.acc += Math.min(dt, 0.25) * rate;
    let n = 0;
    const sink = G.sink; if (rate > 2) G.sink = null;   // catching up: skip the whistles and clacks
    while (W.acc >= TICK) {
      const v = W.inputs.get(W.play);
      if (v === undefined) { W.acc = 0; break; }  // ran dry: wait for the next batch
      W.inputs.delete(W.play);
      R.simTick(G, [expand(v[0]), expand(v[1])]);
      W.play++; W.acc -= TICK; n++;
    }
    G.sink = sink;
    return n;
  };
  /* Aim samples whose moment has come, oldest first. */
  W.dueAims = () => { const out = []; while (W.aims.length && W.aims[0].ft <= W.play) out.push(W.aims.shift()); return out; };
  return W;
}

const API = { createFeed, createViewer, compact, expand };
if (isNode) module.exports = API; else root.Spectate = API;
})(typeof self !== 'undefined' ? self : this);
