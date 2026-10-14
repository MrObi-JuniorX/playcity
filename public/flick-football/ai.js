/* Flick Football computer opponent. It tries candidate flicks in a copy of the physics world and keeps the best. */
(function (root) {
'use strict';
const isNode = typeof module !== 'undefined' && module.exports;
const P = isNode ? require('./phys.js') : root.Phys;
const Rl = () => (isNode ? require('./rules.js') : root.Rules);
const C = P.C, hyp = Math.hypot, H = 1 / 240, DECEL = C.muP * P.G, VMIN = 28, VMAX = 214;   // same top speed as a person's full pull
const LV = {
  easy:   { ang: 0.09, pw: 0.2, pick: 6, react: 0.3, err: 5, dive: 0.45 },
  normal: { ang: 0.04, pw: 0.1, pick: 2, react: 0.16, err: 2.5, dive: 0.8 },
  hard:   { ang: 0.012, pw: 0.04, pick: 1, react: 0.08, err: 1, dive: 1 }
};

function clone(w) {
  return { t: w.t, ev: [], ball: Object.assign({}, w.ball),
    players: w.players.map(p => Object.assign({}, p, { ctl: { dir: 0, dive: 0 }, strike: null })) };
}

/* Run one candidate flick to rest and report what happened. */
function simulate(G, team, c) {
  const w = clone(G.w), f = w.players[c.id];
  if (c.place) { f.x = c.place[0]; f.z = c.place[1]; }
  P.flick(w, f, c.dx, c.dz, c.speed, c.loft, c.curl);
  let contact = null, out = false, goal = 0;
  for (let i = 0; i < 240 * 4; i++) {
    P.step(w, H);
    for (const e of w.ev) {
      if (contact !== null) break;
      if (e.k === 'pb' && e.id === c.id) contact = 'ball';
      else if (e.k === 'pp' && e.v > 4 && (e.a === c.id || e.b === c.id)) { const o = w.players[e.a === c.id ? e.b : e.a]; if (o.team !== team) contact = 'foul'; }
    }
    w.ev.length = 0;
    if (contact === 'foul') break;
    const b = w.ball;
    if (b.inNet) { goal = b.inNet; break; }
    if (Math.abs(b.z) > C.HW + C.br || Math.abs(b.x) > C.HL + C.br) { out = true; break; }
    if (i > 40 && i % 12 === 0 && P.atRest(w)) break;
  }
  return { w, contact, out, goal, fx: f.x, fz: f.z };
}

function score(G, team, r) {
  const d = G.dir[team], b = r.w.ball, ourGoalX = -d * C.HL;
  if (r.contact === 'foul') return (Math.abs(r.fx - ourGoalX) < C.boxD && Math.abs(r.fz) < C.boxHW) ? -900 : -260;
  if (r.goal) return r.goal === d ? 1000 : -1000;
  let s = 0;
  if (r.contact === null) s -= 150;
  if (r.out) {
    const lt = b.lastTouch ? b.lastTouch.team : team;
    if (Math.abs(b.z) > C.HW + C.br) s += (lt === team ? -45 : 15) - (d * b.x < -30 ? 40 : 0);
    else if (Math.sign(b.x) === d) s += lt === team ? -20 : 70;
    else s += lt === team ? -220 : 0;
    return s;
  }
  s += d * b.x * 1.6;                                                    // territory
  const opp = r.w.players.filter(p => p.team !== team && p.kind === 'p' && !p.off);
  const mine = r.w.players.filter(p => p.team === team && p.kind === 'p' && !p.off);
  const od = Math.min(...opp.map(p => hyp(p.x - b.x, p.z - b.z)));
  const md = Math.min(...mine.map(p => hyp(p.x - b.x, p.z - b.z)));
  const toOurs = hyp(b.x - ourGoalX, b.z), toTheirs = hyp(b.x + ourGoalX, b.z);
  s -= Math.max(0, 1 - od / 22) * Math.max(0.25, 1 - toOurs / 90) * 130;  // opponent gets a clean flick next
  s += Math.max(0, 1 - md / 18) * Math.max(0, 1 - toTheirs / 70) * 70;    // we keep a chance near their goal
  return s;
}

/* Speed the flicker needs so the ball travels about D cm after a hit at angle cosA. */
function flickSpeed(D, dist, cosA, mult) {
  const v0 = Math.sqrt(2 * C.muB * P.G * Math.max(4, D)) * mult;      // the button slides to a stop
  const vc = v0 / ((1 + C.ePlayer) * C.pm / (C.pm + C.bm) * Math.max(0.45, cosA));
  return Math.max(VMIN, Math.min(VMAX, Math.sqrt(vc * vc + 2 * DECEL * dist)));
}

function candidates(G, team) {
  const R = Rl(), w = G.w, b = w.ball, d = G.dir[team], out = [];
  let pool = G.forced !== null ? [w.players[G.forced]] : R.outfield(G, team).slice().sort((p, q) => hyp(p.x - b.x, p.z - b.z) - hyp(q.x - b.x, q.z - b.z));
  pool = pool.filter((p, i) => i === 0 || hyp(p.x - b.x, p.z - b.z) < 70).slice(0, 4);
  const goalX = d * C.HL, toGoal = hyp(goalX - b.x, b.z);
  for (const p of pool) {
    const T = [];
    for (const z of [-8, -4, 0, 4, 8]) for (const m of [1.5, 9]) for (const loft of [0]) {
      if (toGoal > 80 && (m < 2 || z !== 0)) continue;
      T.push({ x: goalX + d * 4, z, D: hyp(goalX - b.x, z - b.z) + 20, mult: m, loft, curl: loft ? -Math.sign(z) * 0.3 : 0 });
    }
    for (const q of R.outfield(G, team)) if (q.id !== p.id && d * (q.x - b.x) > -6) T.push({ x: q.x + d * 5, z: q.z, D: hyp(q.x + d * 5 - b.x, q.z - b.z), mult: 1, loft: 0, curl: 0 });
    for (const [ox, oz] of [[35, b.z * 0.5], [28, 26], [28, -26]]) for (const m of [1, 1.3]) T.push({ x: b.x + d * ox, z: oz, D: hyp(ox, oz - b.z), mult: m, loft: 0, curl: 0 });
    for (const t of T) {
      let ux = t.x - b.x, uz = t.z - b.z; const ul = hyp(ux, uz) || 1; ux /= ul; uz /= ul;
      const qx = b.x - ux * (C.pr + C.br - 0.25), qz = b.z - uz * (C.pr + C.br - 0.25);
      let vx = qx - p.x, vz = qz - p.z; const dist = hyp(vx, vz); if (dist < 0.3) continue; vx /= dist; vz /= dist;
      const cosA = vx * ux + vz * uz; if (cosA < 0.4) continue;
      out.push({ id: p.id, dx: vx, dz: vz, speed: flickSpeed(t.D, dist, cosA, t.mult), loft: t.loft, curl: t.curl, q: [qx, qz] });
      if (G.zone && G.forced === p.id) {                          // set piece: also try standing right behind the ball for this line
        const run = 3.5, pl = R.zoneClamp(G, qx - ux * run, qz - uz * run, p.id);
        if (pl) {
          let wx = qx - pl[0], wz = qz - pl[1]; const wl = hyp(wx, wz);
          if (wl > 0.3) { wx /= wl; wz /= wl; const ca = wx * ux + wz * uz;
            if (ca > 0.6) out.push({ id: p.id, place: pl, q: [qx, qz], dx: wx, dz: wz, speed: flickSpeed(t.D, wl, ca, t.mult), loft: t.loft, curl: t.curl }); }
        }
      }
    }
    const bx = b.x - p.x, bz = b.z - p.z, bl = hyp(bx, bz) || 1;      // plain hit straight through the ball
    for (const sp of [110, 214]) out.push({ id: p.id, dx: bx / bl, dz: bz / bl, speed: sp, loft: 0, curl: 0 });
  }
  return out;
}

/* Generator: yields after each simulation so the caller can spread the work over frames. */
function* think(G, team, level) {
  const lv = LV[level] || LV.normal, cs = candidates(G, team);
  for (const c of cs) { c.s = score(G, team, simulate(G, team, c)) + Math.random() * 6; yield; }
  cs.sort((a, b) => b.s - a.s);
  const top = cs.filter(c => c.s > cs[0].s - 120).slice(0, lv.pick);
  const pick = Object.assign({}, top[Math.floor(Math.random() * top.length)] || cs[0]);
  const a = Math.atan2(pick.dz, pick.dx) + (Math.random() - 0.5) * 2 * lv.ang;
  pick.dx = Math.cos(a); pick.dz = Math.sin(a);
  pick.speed = Math.max(VMIN, Math.min(VMAX, pick.speed * (1 + (Math.random() - 0.5) * 2 * lv.pw)));
  return pick;
}
function chooseNow(G, team, level) { const g = think(G, team, level); let r; do { r = g.next(); } while (!r.done); return r.value; }

/* Keeper: reads the ball's line and slides or dives, with a reaction delay and aim error by level. */
function keeper(G, team, level, dt, st) {
  const lv = LV[level] || LV.normal, k = Rl().keeperOf(G, team), b = G.w.ball;
  st.t = (st.t || 0) - dt;
  if (st.t > 0) return { dir: st.dir || 0, dive: 0 };
  st.t = lv.react * 0.5;
  let dir = 0, dive = 0;
  const s = Math.sign(k.homeX);
  if (G.phase === 'moving' && s * b.vx > 25) {
    const t = (k.homeX - b.x) / b.vx;
    if (t > 0 && t < 1.6) {
      const zp = b.z + b.vz * t + (Math.random() - 0.5) * 2 * lv.err, diff = zp - k.z;
      if (Math.abs(zp) < C.gw / 2 + 3) {
        dir = Math.abs(diff) > 0.8 ? Math.sign(diff) : 0;
        if (Math.abs(diff) > 3.2 && t < 0.32 && Math.random() < lv.dive) dive = Math.sign(diff);
      }
    }
  } else {
    const want = Math.max(-6, Math.min(6, b.z * 0.25)), diff = want - k.z;
    dir = Math.abs(diff) > 1 ? Math.sign(diff) : 0;
  }
  st.dir = dir;
  return { dir, dive };
}

/* Arrangement for the computer. Kick-off: a compact block in front of its box that screens the middle.
   Goal kick: press high, a line along the kicker's box edge with cover behind (distances from the kicker's goal line). */
function arrange(G, team) {
  const R = Rl(), d = G.dir[team], A = G.arrange || {};
  if (A.mode === 'goalkick') {
    const C = P.C, inward = -A.side, gx = A.side * C.HL;
    const spots = [[C.boxD + 4, -14], [C.boxD + 4, 14], [C.boxD + 7, 0], [C.boxD + 16, -26], [C.boxD + 16, 26], [C.boxD + 28, 0]];
    R.outfield(G, team).forEach((p, i) => { const s = spots[i % spots.length]; R.arrangeMove(G, p.id, gx + inward * s[0], s[1]); });
  } else {
    const spots = [[14, -16], [14, 16], [24, 0], [33, -25], [33, 25], [38, -8]];
    R.outfield(G, team).forEach((p, i) => { const s = spots[i % spots.length]; R.arrangeMove(G, p.id, -d * s[0], s[1]); });
  }
  R.arrangeDone(G);
}
const API = { think, chooseNow, keeper, arrange, LV };
if (isNode) module.exports = API; else root.AI = API;
})(typeof self !== 'undefined' ? self : this);

