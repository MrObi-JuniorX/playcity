/* Floodlight FC match engine. Pure logic: no DOM, no three.js, so the same code runs in the browser and in Node tests.
   createMatch(cfg, on) returns the match; the app feeds it inputs and calls step(dt); the view reads its state.
   Everything the outside world should see or hear is reported through on(event, ...args). */
import { V3, clamp, lerp, angDiff, mulberry32 } from './vec.js';
import { LINE, STYLES, NEUTRAL_STYLE, AI_STYLES, MOVES, canDo, moveNeeds, LINKUPS, LEVELS, PLAYSTYLES } from './data.js';

export const HX = 52.5, HZ = 34, GW = 7.32, GH = 2.44, BR = 0.11, GRAV = 9.81, ROLL = 3.0, BOX_D = 16.5, BOX_W = 20.16;
export const DIR = [1, -1];               // team 0 attacks +x, team 1 attacks -x
/* What each difficulty changes for the computer's side: how often it tackles, how well its keeper saves, how fast it reads loose balls,
   how wild its passing and shooting are (acc), how readily it shoots, and how good the person's own keeper is (own) and how early
   the person's teammates help to press (helpZone, as a fraction of the pitch length from the halfway line). */
const DIFF = [
  { tackle: 1.1, save: 0.42, react: 0.9, acc: 1.6, shoot: 0.6, own: 0.72, helpZone: -0.05 },
  { tackle: 1.7, save: 0.58, react: 1, acc: 1, shoot: 1, own: 0.6, helpZone: -0.33 },
  { tackle: 2.4, save: 0.7, react: 1.06, acc: 0.78, shoot: 1.15, own: 0.52, helpZone: -0.5 },
];
const PASS_KINDS = new Set(['pass', 'through', 'loft']);
const NO_OFFSIDE_FROM = new Set(['goalkick', 'corner', 'throw']);
const damp = (k, dt) => 1 - Math.exp(-k * dt);
const ZERO = new V3();

export function createMatch(cfg, on = () => {}) {
  const rnd = mulberry32(cfg.seed === undefined ? (Math.random() * 4294967296) >>> 0 : cfg.seed);
  const rand = (a, b) => a + rnd() * (b - a);
  const gauss = () => (rnd() + rnd() + rnd() - 1.5) / 1.5;
  const pick = a => a[(rnd() * a.length) | 0];
  const human = cfg.human === undefined ? 0 : cfg.human;      // which team the person plays; -1 = computer v computer
  const S = { diff: 1, len: 300, assist: 1, offside: 1, ...(cfg.settings || {}) };
  const diff = () => DIFF[S.diff];
  const tmpA = new V3(), tmpB = new V3(), tmpC = new V3(), tmpD = new V3(), formTmp = new V3();

  // ------------------------------------------------------------------ state
  const ball = { pos: new V3(0, BR, 0), vel: new V3(), curl: new V3(), owner: null, lastTeam: 0, lastKicker: null, kickType: '', intended: null,
    inGoal: false, power: 0, kt: -9, shotBy: null, shotCounted: false, offs: null, block: null, stun: false };
  const G = { phase: 'kickoff', clock: 0, score: [0, 0], timer: 0, restart: null, sp: null, kickoffTeam: 0, slowmo: 0, now: 0, ht: false, mode: 'attack',
    oneTwo: null, queued: null, lastSwitch: 0, hold: null,
    stats: { shots: [0, 0], onT: [0, 0], poss: [0, 0], passA: [0, 0], passC: [0, 0], tackles: [0, 0], skills: [0, 0], fouls: [0, 0], offsides: [0, 0], corners: [0, 0], inter: [0, 0], heavy: [0, 0] } };
  const inp = { dir: new V3(), btn: { pass: false, shoot: false, through: false, loft: false, sprint: false, skill: false }, shield: false,
    charging: false, charge: 0, chargeMode: 'power', tap: { shoot: -9, sprint: -9 } };
  const teams = cfg.teams.map((tc, t) => ({ t, cfg: tc, tac: 0, T: tc.tactics[0].T, linkUp: tc.tactics[0].linkUp, level: 0, trapT: 0, trapCd: 0, pressT: 0, pressCd: 0,
    rushT: 0, lostAt: -99, offLine: 0, link: null, linkCd: 4, mgrT: 3, fatK: 1 }));
  const players = [];
  let ctrl = null;
  let roles = { chaser: [null, null], press: [[], []], cover: [null, null] };
  let roleT = 0;

  cfg.teams.forEach((tc, t) => tc.xi.forEach((x, i) => {
    const pl = x.pl;
    players.push({ team: t, i, pl, xi: x, name: pl.name, num: pl.num, stars: pl.stars, foot: pl.foot, cond: x.cond, skills: new Set(pl.skills), ai: pl.ai ? AI_STYLES[pl.ai].b : {},
      isGK: x.tac[0].pos === 'GK', posCode: '', line: '', fx: 0, fz: 0, s: x.tac[0].s, style: NEUTRAL_STYLE, ins: { att: tc.instr.att[i] || null, def: tc.instr.def[i] || null, mark: null },
      pos: new V3(), vel: new V3(), facing: t === 0 ? 0 : Math.PI, phase: rnd() * 6, stamina: 1, fit: 1, jogSp: 5, sprintSp: 7.5, acc: 16,
      kickCd: 0, stagger: 0, evade: 0, tackleT: 0, tackleDone: false, slide: false, tackleCd: 0, skillCd: 0, skill: null, dive: null, burst: 0, kickAnim: 0, headAnim: 0,
      celebrate: 0, runTarget: null, runT: 0, aiT: 0, holdT: 0, jockey: false, protect: 0, shield: false, shieldT: 0, wind: null, wallT: 0, link: 0, plant: 0 });
  }));
  const teamOf = t => players.filter(p => p.team === t);
  const gkOf = t => players.find(p => p.team === t && p.isGK);
  const n = (p, k) => clamp((p.s[k] - 40) / 59, 0, 1);       // a stat as 0…1
  const has = (p, skill) => p.skills.has(skill);
  const possTeam = () => ball.owner ? ball.owner.team : -1;
  const fwd = p => new V3(Math.cos(p.facing), 0, Math.sin(p.facing));
  const live = () => G.phase === 'play' || G.phase === 'kickoff' || G.phase === 'setpiece';
  const tag = (p, text, ok) => { if (p && p.team === human) on('tag', text, ok); };
  /* Tired legs: 1 when fresh, rising as match fitness drains. Fighting Spirit halves it. */
  const tired = p => (1 - p.fit) * (has(p, 'Fighting Spirit') ? 0.5 : 1);
  const fatigueErr = p => 1 + tired(p) * 0.6;
  const dribSkill = p => n(p, 'drib') * 0.6 + n(p, 'tightPos') * 0.4;
  function refresh(p) {
    const f = 1 - tired(p);
    p.jogSp = 4.4 + 1.0 * n(p, 'speed');
    p.sprintSp = (6.3 + 2.2 * n(p, 'speed')) * (0.86 + 0.14 * f);
    p.acc = (11 + 9 * n(p, 'accel')) * (0.9 + 0.1 * f);
  }
  /* Switch a team to sub-tactic 0 or 1: new slots, new out-of-position stats, new playstyle numbers. */
  function applyTactic(t, idx) {
    const tm = teams[t], tc = tm.cfg.tactics[idx];
    tm.tac = idx; tm.T = tc.T; tm.linkUp = tc.linkUp; tm.link = null;
    for (const p of players) if (p.team === t) {
      const s = p.xi.tac[idx];
      p.posCode = s.pos; p.line = LINE[s.pos]; p.fx = s.fx; p.fz = s.fz; p.s = s.s; p.fitPos = s.fit;
      p.style = s.styleOn ? STYLES[p.pl.style].b : NEUTRAL_STYLE;
      refresh(p);
    }
    const cap = players.find(p => p.team === t && p.i === tm.cfg.captain);
    tm.fatK = cap && has(cap, 'Captaincy') ? 0.92 : 1;
  }
  applyTactic(0, 0); applyTactic(1, 0);
  for (const p of players) if (p.ins.def === 'man') {       // Man Marking shadows the other side's most dangerous attacker
    p.ins.mark = teamOf(1 - p.team).filter(o => !o.isGK).sort((a, b) => (b.s.finish + b.s.offAwa) - (a.s.finish + a.s.offAwa))[0];
  }

  // ------------------------------------------------------------------ movement
  function moveP(p, dir, speed, dt, accel) {
    tmpA.set(dir.x, 0, dir.z);
    const len = tmpA.length();
    if (len > 1) tmpA.divideScalar(len);
    tmpA.multiplyScalar(speed);
    if (p.burst > 0) tmpA.multiplyScalar(1.18);
    tmpB.subVectors(tmpA, p.vel); tmpB.y = 0;
    const lim = (tmpA.lengthSq() < p.vel.lengthSq() ? 22 : (accel || p.acc)) * dt;
    if (tmpB.length() > lim) tmpB.setLength(lim);
    p.vel.add(tmpB);
    const hs = Math.hypot(p.vel.x, p.vel.z);
    if (hs > 0.4 && !p.shield) {
      const want = Math.atan2(p.vel.z, p.vel.x);
      const rate = ball.owner === p ? (5.5 + 4.5 * n(p, 'tightPos')) * (hs > p.jogSp && has(p, 'Momentum Dribbling') ? 1.2 : 1) : 11;
      p.facing += clamp(angDiff(p.facing, want), -rate * dt, rate * dt);
    }
  }
  function goTo(p, target, speed, dt, stopR = 0.3) {
    tmpC.subVectors(target, p.pos); tmpC.y = 0;
    const d = tmpC.length();
    if (d < stopR) { moveP(p, ZERO, 0, dt); return d; }
    moveP(p, tmpC.divideScalar(d), Math.min(speed, d * 2.4 + 0.5), dt);
    return d;
  }
  function faceTo(p, pt, dt, rate = 9) { const want = Math.atan2(pt.z - p.pos.z, pt.x - p.pos.x); p.facing += clamp(angDiff(p.facing, want), -rate * dt, rate * dt); }
  function integrate(p, dt) {
    p.pos.addScaledVector(p.vel, dt);
    p.pos.x = clamp(p.pos.x, -HX - 3.5, HX + 3.5); p.pos.z = clamp(p.pos.z, -HZ - 3, HZ + 3);
    const sp = Math.hypot(p.vel.x, p.vel.z);
    p.phase += sp * dt * 1.7;
    const sprinting = sp > p.jogSp + 0.4;
    p.stamina = clamp(p.stamina + (sprinting ? -0.07 : 0.045 * (0.6 + 0.4 * p.fit)) * dt, 0, 0.4 + 0.6 * p.fit);
    if (G.phase === 'play' && sp > 2) {      // match fitness drains with the running done; low Stamina drains faster
      const k = (300 / S.len) * (1.35 - n(p, 'stamina')) * teams[p.team].fatK;
      p.fit = Math.max(0.3, p.fit - (sprinting ? 0.0042 : 0.0011) * k * dt);
    }
  }
  function separate() {
    for (let a = 0; a < players.length; a++) for (let b = a + 1; b < players.length; b++) {
      const A = players[a], B = players[b];
      const dx = B.pos.x - A.pos.x, dz = B.pos.z - A.pos.z, d2 = dx * dx + dz * dz;
      if (d2 < 0.64 && d2 > 1e-6) { const d = Math.sqrt(d2), push = (0.8 - d) * 0.5; A.pos.x -= dx / d * push; A.pos.z -= dz / d * push; B.pos.x += dx / d * push; B.pos.z += dz / d * push; }
    }
  }

  // ------------------------------------------------------------------ ball control and kicking
  function footPos(p, out, dist = 0.55) { return out.set(p.pos.x + Math.cos(p.facing) * dist, BR, p.pos.z + Math.sin(p.facing) * dist); }
  function setOwner(p) {
    const prev = ball.lastKicker;
    if (ball.offs && ball.offs.has(p) && prev && prev.team === p.team) { offside(p); return false; }
    if (PASS_KINDS.has(ball.kickType) && prev && prev !== p) G.stats[prev.team === p.team ? 'passC' : 'inter'][p.team]++;
    if (ball.lastTeam !== p.team) teams[1 - p.team].lostAt = G.now;
    ball.owner = p; ball.vel.set(0, 0, 0); ball.curl.set(0, 0, 0); ball.intended = null; ball.kickType = ''; ball.lastTeam = p.team; ball.offs = null; ball.block = null;
    p.holdT = 0; p.runTarget = null;
    if (p.team === human) setCtrl(p);
    return true;
  }
  /* Offside is judged when the pass is played: who is in the other half, ahead of the ball and of the second-last defender. */
  function markOffside(p) {
    const t = p.team, d = DIR[t];
    let a = -1e9, b = -1e9;
    for (const o of players) if (o.team !== t) { const x = o.pos.x * d; if (x > a) { b = a; a = x; } else if (x > b) b = x; }
    const line = Math.max(b, ball.pos.x * d, 0);
    let m = null;
    for (const q of players) if (q.team === t && q !== p && q.pos.x * d > line + 0.35) (m || (m = new Map())).set(q, { x: q.pos.x, z: q.pos.z });
    ball.offs = m;
  }
  function offside(p) {
    const at = ball.offs.get(p);
    G.stats.offsides[p.team]++; ball.offs = null; ball.owner = null; ball.vel.set(0, 0, 0); ball.intended = null;
    on('banner', 'OFFSIDE', p.name, true, 1100);
    outOfPlay('freekick', 1 - p.team, new V3(clamp(at.x, -HX + 2, HX - 2), BR, clamp(at.z, -HZ + 2, HZ - 2)), true);
  }
  function inOffsidePos(q) {
    if (!S.offside || (G.sp && NO_OFFSIDE_FROM.has(G.sp.kind))) return false;
    const d = DIR[q.team];
    return q.pos.x * d > Math.max(teams[q.team].offLine, ball.pos.x * d, 0) + 0.35;
  }
  function kick(p, vel, type, curl) {
    const sp = G.sp;
    footPos(p, ball.pos, 0.45);
    ball.owner = null; ball.vel.copy(vel); ball.curl.copy(curl || ZERO);
    ball.lastTeam = p.team; ball.lastKicker = p; ball.kickType = type; ball.power = vel.length(); ball.block = null; ball.stun = false; ball.offs = null;
    if (S.offside && PASS_KINDS.has(type) && !(sp && NO_OFFSIDE_FROM.has(sp.kind))) markOffside(p);
    if (G.phase === 'setpiece' || G.phase === 'kickoff') {       // the dead ball is in play as soon as it is kicked
      if (sp && sp.wall) for (const w of sp.wall) { w.wallT = 1; w.headAnim = 0.45; }
      if (sp && sp.spots && sp.spots.size) G.hold = { team: 1 - sp.team, t: 2.6, spots: sp.spots };      // markers stay with their men while the ball is in the air
      G.phase = 'play'; G.sp = null; inp.charging = false;
    }
    p.kickCd = 0.32; p.kickAnim = 0.3; p.holdT = 0; p.shield = false;
    ball.kt = G.now;
    on('kick', p, type, vel.length());
  }
  function dribble(p, dt) {
    let d = 0.55 + Math.min(1, Math.hypot(p.vel.x, p.vel.z) / 7) * 0.35 + Math.max(0, Math.sin(p.phase * 0.5)) * 0.12;
    if (p.isGK && inOwnBox(p) && G.phase !== 'setpiece') tmpB.set(p.pos.x + Math.cos(p.facing) * 0.35, 1.05, p.pos.z + Math.sin(p.facing) * 0.35);
    else if (p.skill) {
      const s = p.skill, f = s.f0, k = s.t / s.dur, L = s.lat;
      if (s.type === 'dragback') tmpB.set(p.pos.x + f.x * lerp(0.5, -0.45, k), BR, p.pos.z + f.z * lerp(0.5, -0.45, k));
      else if (s.type === 'elastico') tmpB.set(p.pos.x + f.x * 0.35 + L.x * 0.45 * (s.t < 0.12 ? -0.6 : 1), BR, p.pos.z + f.z * 0.35 + L.z * 0.45 * (s.t < 0.12 ? -0.6 : 1));
      else if (s.type === 'roulette') tmpB.set(p.pos.x + Math.cos(p.facing + 2.2 * s.side) * 0.35, BR, p.pos.z + Math.sin(p.facing + 2.2 * s.side) * 0.35);
      else if (s.type === 'ballroll' || s.type === 'doubletouch') tmpB.set(p.pos.x + f.x * 0.3 + L.x * 0.5 * k, BR, p.pos.z + f.z * 0.3 + L.z * 0.5 * k);
      else if (s.type === 'chop') tmpB.set(p.pos.x + L.x * 0.5 * k + f.x * 0.3 * (1 - k), BR, p.pos.z + L.z * 0.5 * k + f.z * 0.3 * (1 - k));
      else footPos(p, tmpB, 0.5);
    } else footPos(p, tmpB, p.shield || G.phase === 'setpiece' ? 0.45 : d);
    const prev = tmpC.copy(ball.pos);
    ball.pos.lerp(tmpB, damp(p.isGK ? 25 : 16, dt));
    ball.vel.subVectors(ball.pos, prev).divideScalar(Math.max(dt, 1e-4));
  }
  function inOwnBox(p, pt = p.pos) { const gx = -DIR[p.team] * HX; return Math.abs(pt.x - gx) < BOX_D && Math.abs(pt.z) < BOX_W; }
  function nearestOpp(p) { let best = null, bd = 1e9; for (const o of players) if (o.team !== p.team) { const d = o.pos.distanceTo(p.pos); if (d < bd) { bd = d; best = o; } } return { o: best, d: bd }; }
  function segDist(px, pz, ax, az, bx, bz) { const vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz; let t = l2 ? ((px - ax) * vx + (pz - az) * vz) / l2 : 0; t = clamp(t, 0, 1); return Math.hypot(px - (ax + vx * t), pz - (az + vz * t)); }
  /* Kicking toward your right is a left-foot kick, and the other way round. Off the weaker foot a kick loses accuracy:
     a player with high Weak Foot Usage takes it on (losing by his Weak Foot Accuracy), one with low Usage wraps the strong foot round it. */
  function weakFoot(p, a, type) {
    const turn = angDiff(p.facing, a);
    if (Math.abs(turn) < 0.3) return 1;
    if ((turn > 0 ? -1 : 1) === p.foot) return 1;
    if (type === 'pass' && has(p, 'Outside Curler')) return 1;
    const usesWeak = Math.abs(turn) > 1.5 - p.pl.wfUse * 0.4;
    let pen = usesWeak ? 1 + (4 - p.pl.wfAcc) * 0.25 : 1.3;
    if (type !== 'pass' && has(p, 'Rabona')) pen = 1 + (pen - 1) / 2;
    return pen;
  }

  function bestPassTarget(p, hint, kind, o = {}) {
    const d = DIR[p.team], T = teams[p.team].T;
    const maxD = o.maxD || (kind === 'loft' ? 38 + 22 * n(p, 'kickPow') + (p.isGK && has(p, 'GK High Punt') ? 10 : 0) : 42);
    let best = null, bs = -1e9;
    for (const t of players) {
      if (t.team !== p.team || t === p) continue;
      if (t.isGK && kind !== 'pass') continue;
      const vx = t.pos.x - p.pos.x, vz = t.pos.z - p.pos.z, dist = Math.hypot(vx, vz);
      if (dist < 3.5 || dist > maxD) continue;
      const nx = vx / dist, nz = vz / dist;
      const align = hint ? nx * hint.x + nz * hint.z : 0;
      if (hint && align < 0.42) continue;
      const forward = nx * d;
      if (o.forwardOnly && vx * d < 12) continue;
      let risk = 0, open = 1e9;
      for (const q of players) if (q.team !== p.team) {
        if (kind !== 'loft') { const sd = segDist(q.pos.x, q.pos.z, p.pos.x, p.pos.z, t.pos.x, t.pos.z); if (sd < 2.2) risk += (2.2 - sd); }
        open = Math.min(open, q.pos.distanceTo(t.pos));
      }
      let sc = (hint ? align * 2.4 : forward * 0.9) + Math.min(1, open / 6) * 0.9 - risk * 0.8 - dist * 0.012 * (hint ? 1 : 1 - T.passLen * 0.6)
        + (kind === 'through' ? forward * 0.8 : 0) - (t.isGK ? 1.2 : 0);
      if (inOffsidePos(t)) sc -= hint ? 0.7 : 3;
      if (t.link > 0) sc += 1.4;
      if (o.inBox) sc += ((t.pos.x * d > HX - 16 && Math.abs(t.pos.z) < 12) ? 1.5 : -1) + rnd() * 1.2;       // vary the delivery
      if (sc > bs) { bs = sc; best = t; }
    }
    return best ? { t: best, score: bs } : null;
  }
  function doPass(p, kind, hint, o = {}) {
    const d = DIR[p.team], spKind = G.sp ? G.sp.kind : null;
    let tgt = o.target || null;
    if (!tgt) { const b = bestPassTarget(p, hint, kind, { maxD: spKind === 'throw' ? (has(p, 'Long Throw') ? 34 : 22) : 0, inBox: spKind === 'corner' && kind === 'loft' }); tgt = b && b.t; }
    const lofted = kind === 'loft' || !!o.lofted;
    let aim;
    if (!tgt) aim = p.pos.clone().addScaledVector(hint || fwd(p), lofted ? 25 : 14);
    else {
      const dist = tgt.pos.distanceTo(p.pos);
      if (kind === 'through') {
        const lead = clamp(dist * 0.32, 5, 11) * (o.lofted ? 1.25 : 1);
        aim = tgt.pos.clone().add(tmpD.set(d * lead, 0, (hint ? hint.z : 0) * 3 - tgt.pos.z * 0.08));
      } else aim = tgt.pos.clone().addScaledVector(tgt.vel, dist / (lofted ? 22 : 15) * 0.8);
      tgt.runTarget = aim.clone(); tgt.runT = 2.6;
    }
    aim.x = clamp(aim.x, -HX + 1, HX - 1); aim.z = clamp(aim.z, -HZ + 1, HZ - 1);
    footPos(p, tmpB, 0.45);
    const dx = aim.x - tmpB.x, dz = aim.z - tmpB.z, D = Math.hypot(dx, dz), a0 = Math.atan2(dz, dx);
    let stat = n(p, lofted ? 'loftPass' : 'lowPass');
    if (spKind === 'corner' || spKind === 'freekick') stat = (stat + n(p, 'setPiece')) / 2;
    let acc = (p.team !== human ? diff().acc : 1) * fatigueErr(p);
    if (!G.sp) {
      if (nearestOpp(p).d < 2 && !has(p, 'Phenomenal Pass')) acc *= 1.6;
      if (Math.abs(angDiff(p.facing, a0)) > 1.75 && !has(p, 'No Look Pass')) acc *= 1.4;
      acc *= weakFoot(p, a0, lofted ? 'loft' : 'pass');
      if (o.first && !has(p, 'One-touch Pass')) acc *= 1.35;
    }
    if (kind === 'through' && has(p, 'Through Passing')) acc *= 0.7;
    if (kind === 'loft' && Math.abs(p.pos.z) > 16 && has(p, 'Pinpoint Crossing')) acc *= 0.6;
    if (lofted && D > 35 && has(p, 'Game-changing Pass')) acc *= 0.7;
    if (o.stun) acc *= o.rushed ? 1.5 : (kind === 'loft' && has(p, 'Edged Crossing') ? 0.45 : 0.65);
    const a = a0 + gauss() * (0.06 * (1.15 - stat)) * acc;
    let v;
    if (lofted) {
      let T = 0.85 + D * 0.034;
      if (has(p, 'Low Lofted Pass') || (p.isGK && has(p, 'GK Low Punt'))) T *= 0.9;
      if (o.stun) T *= 0.74;
      const hv = D / T * 1.04;
      // a cross to a player in the box arrives at head height, so it is there to be headed
      const high = kind === 'loft' && tgt && !tgt.isGK && aim.x * d > HX - 18 && Math.abs(aim.z) < 15 ? 1.8 : 0;
      v = new V3(Math.cos(a) * hv, GRAV * T / 2 + high / T, Math.sin(a) * hv);
    } else {
      const vEnd = (kind === 'through' ? 4.5 : 7) - (has(p, 'Weighted Pass') ? 1.5 : 0);
      let v0 = clamp(Math.sqrt(vEnd * vEnd + 2 * ROLL * 1.25 * D), 7, p.isGK && has(p, 'GK Long Throw') ? 31 : 27);
      if (o.stun) v0 = Math.min(32, v0 * 1.3);
      v = new V3(Math.cos(a) * v0, 0.6, Math.sin(a) * v0);
    }
    kick(p, v, kind);
    ball.intended = tgt;
    G.stats.passA[p.team]++;
    if (o.stun) tag(p, 'STUNNING ' + (kind === 'loft' ? 'CROSS' : kind === 'through' ? 'THROUGH BALL' : 'PASS'), o.rushed ? false : undefined);
    if (p.team === human && tgt) setCtrl(tgt);
    if (o.oneTwo && tgt) {
      p.runTarget = new V3(clamp(p.pos.x + d * 13, -HX + 3, HX - 3), 0, clamp(p.pos.z + (p.pos.z > 0 ? -3 : 3), -HZ + 3, HZ - 3)); p.runT = 3.2;
      G.oneTwo = { runner: p, t: 3.4 };
      tag(p, 'ONE-TWO');
    }
    return tgt;
  }
  /* Stunning kicks take a moment to wind up and need room: struck with space they are faster and truer, rushed they are worse. */
  function stun(p, fn) { if (!p.wind) { p.wind = { t: 0.26, fn }; p.kickAnim = 0.5; } }
  function doShot(p, power, mode, hint, o = {}) {
    const d = DIR[p.team], gx = d * HX;
    footPos(p, tmpB, 0.45);
    const gk = gkOf(1 - p.team);
    const distG = Math.hypot(gx - tmpB.x, tmpB.z);
    const aiTeam = p.team !== human, assist = aiTeam || S.assist, fk = mode === 'fk';
    let side;
    if (hint && Math.abs(hint.z) > 0.35) side = Math.sign(hint.z);
    else side = gk ? (gk.pos.z > tmpB.z * 0.15 ? -1 : 1) : (tmpB.z > 0 ? -1 : 1);
    let tz = side * (GW / 2 - 0.6), ty;
    const sweet = power >= 0.68 && power <= 0.86;
    const wf = fk ? 1 : weakFoot(p, Math.atan2(tz - tmpB.z, gx - tmpB.x), 'shot');
    let err = (1.75 - n(p, fk ? 'setPiece' : 'finish') * 1.0) * (sweet ? (fk ? 0.6 : 0.3) : 1) * (0.35 + distG / 28) * (power > 0.95 ? 2 : 1) * (assist ? 1 : 1.3)
      * (aiTeam ? diff().acc : 1) * wf * fatigueErr(p);
    if (!fk && nearestOpp(p).d < 1.8 && !has(p, 'Phenomenal Finishing')) err *= 1.5;
    if (distG > 20 && has(p, 'Long-range Shooting')) err *= 0.75;
    if (o.first) err *= has(p, 'First-time Shot') ? 0.8 : 1.15;
    if (o.volley) err *= has(p, 'Acrobatic Finishing') ? 0.7 : 1.25;
    if (o.stun) err *= o.rushed ? 1.5 : 0.8;
    if (wf > 1.2) tag(p, 'WEAK FOOT', false);
    const kp = n(p, 'kickPow') * (wf > 1 ? 0.85 : 1);
    if (mode === 'chip') {
      ty = 2.0; err *= has(p, 'Chip Shot Control') ? 0.5 : 0.8;
      tz += gauss() * err * 1.6;
      const H = Math.hypot(gx - tmpB.x, tz - tmpB.z), hv = 10 + power * 6, T = H / hv;
      const a = Math.atan2(tz - tmpB.z, gx - tmpB.x);
      kick(p, new V3(Math.cos(a) * hv, (ty - BR + 0.5 * GRAV * T * T) / T, Math.sin(a) * hv), 'shot');
      on('trail', 1, 0.9, 0.6); tag(p, 'CHIP SHOT');
    } else {
      let speed, lat = 0, dip = 0;
      if (mode === 'finesse') {
        speed = (17 + power * 9) * (has(p, 'Blitz Curler') ? 1.12 : 1); ty = 0.5 + power * 1.1; lat = 1.1 + 1.2 * n(p, 'curl');
        err *= 0.55 * (distG > BOX_D && has(p, 'Long-range Curler') ? 0.7 : 1);
      } else if (fk) {        // up over the wall and down again: slower is loopier, faster is flatter and finds the wall
        speed = 17 + power * 7; ty = 1.55 + power * 0.5; lat = 0.6 + 1.2 * n(p, 'curl'); dip = 3 + 4 * n(p, 'curl') + (has(p, 'Dipping Shot') ? 3 : 0); err *= 1.5;
      } else {
        speed = 16 + power * (14 + 7 * kp) + (has(p, 'Rising Shot') ? 0.8 : 0); ty = 0.25 + power * 1.75 + (power > 0.95 ? 1.4 : 0);
        if (o.stun) { speed *= 1.16; dip = has(p, 'Dipping Shot') ? 7 : 4; ty += 0.3; }
      }
      tz += gauss() * err * 2.6; ty = Math.max(0.15, ty + gauss() * err * (fk ? 1.3 : 0.8));
      const aimZ = tz + side * lat;       // finesse: aim outside the post, curl it back in
      const H = Math.hypot(gx - tmpB.x, aimZ - tmpB.z), T = H / speed;
      const vy = (ty - BR + 0.5 * (GRAV + dip) * T * T) / T;
      const a = Math.atan2(aimZ - tmpB.z, gx - tmpB.x);
      const curl = new V3(0, -dip, lat ? -side * 2 * lat / (T * T) : 0);
      if (o.stun && has(p, 'Knuckle Shot')) curl.z += gauss() * 5;
      if (mode === 'finesse') { on('trail', 0.5, 1.1, 1.6); tag(p, 'FINESSE SHOT'); }
      else if (o.stun) { on('trail', 1.8, 0.7, 1.6); tag(p, 'STUNNING SHOT', o.rushed ? false : undefined); }
      else on('trail', 1.6, 1.1, 0.5);
      kick(p, new V3(Math.cos(a) * speed, vy, Math.sin(a) * speed), 'shot', curl);
      if (sweet && p.team === human && !fk) on('perfect');
    }
    G.stats.shots[p.team]++;
    ball.shotBy = p; ball.shotCounted = false; ball.stun = !!o.stun;
    shotBlock(p);
    on('swell', 0.3, 0.2);
  }
  /* A defender standing in the path of a shot may block it (a wall nearly always does). Decided at the kick, played out when the ball arrives. */
  function shotBlock(p) {
    const v = ball.vel, hs = Math.hypot(v.x, v.z);
    if (hs < 1) return;
    const ux = v.x / hs, uz = v.z / hs;
    let best = null, bt = 1e9;
    for (const o of players) {
      if (o.team === p.team || o.isGK || o.stagger > 0) continue;
      const along = (o.pos.x - ball.pos.x) * ux + (o.pos.z - ball.pos.z) * uz;
      if (along < 0.8 || along > 12) continue;
      const t = along / hs, wall = o.wallT > 0;
      const px = ball.pos.x + v.x * t, pz = ball.pos.z + v.z * t + 0.5 * ball.curl.z * t * t, py = ball.pos.y + v.y * t - 0.5 * (GRAV - ball.curl.y) * t * t;
      if (Math.hypot(o.pos.x - px, o.pos.z - pz) > (wall ? 0.42 : 0.5) || py > (wall ? 2.3 : 1.75)) continue;
      const ch = wall ? 0.92 : (0.1 + (has(o, 'Blocker') ? 0.3 : 0) + 0.12 * n(o, 'defAwa')) * (along < 4 ? 1 : 0.5);
      if (rnd() < ch && t < bt) { bt = t; best = o; }
    }
    ball.block = best;
  }
  function doPenalty(p, power, hint) {
    const d = DIR[p.team], gx = d * HX, gk = gkOf(1 - p.team), aiTeam = p.team !== human;
    footPos(p, tmpB, 0.45);
    const side = hint && Math.abs(hint.z) > 0.3 ? Math.sign(hint.z) : aiTeam ? pick([-1, -1, 1, 1, 0]) : 0;
    const sweet = power >= 0.68 && power <= 0.86;
    const err = (1.2 - n(p, 'setPiece') * 0.8) * (has(p, 'Penalty Specialist') ? 0.5 : 1) * (power > 0.95 ? 2.4 : 1) * (sweet ? 0.5 : 1) * (aiTeam ? diff().acc : 1);
    const tz = side * (GW / 2 - 0.75) + gauss() * err * 0.9, ty = Math.max(0.15, 0.25 + power * 1.8 + (power > 0.95 ? 1.2 : 0) + gauss() * err * 0.4);
    const speed = 20 + power * 7, H = Math.hypot(gx - tmpB.x, tz - tmpB.z), T = H / speed, a = Math.atan2(tz - tmpB.z, gx - tmpB.x);
    kick(p, new V3(Math.cos(a) * speed, (ty - BR + 0.5 * GRAV * T * T) / T, Math.sin(a) * speed), 'shot');
    on('trail', 1.6, 1.1, 0.5);
    G.stats.shots[p.team]++; ball.shotBy = p; ball.shotCounted = false;
    const onTarget = Math.abs(tz) < GW / 2 - BR && ty < GH - BR;
    if (onTarget) { G.stats.onT[p.team]++; ball.shotCounted = true; }
    // the keeper commits as the ball is struck: the person picks a side with the stick, the computer guesses or reads it
    let guess;
    if (gk.team === human) guess = Math.abs(inp.dir.z) > 0.3 ? Math.sign(inp.dir.z) : 0;
    else guess = rnd() < 0.16 + 0.28 * n(gk, 'gkReflex') + (has(gk, 'GK Penalty Saver') ? 0.12 : 0) ? side : pick([-1, 0, 1]);
    const right = guess === side;
    const ch = right && onTarget ? clamp(0.6 + 0.2 * n(gk, 'gkReach') - Math.max(0, Math.abs(tz) - 2.2) * 0.35 - (ty > 1.7 ? 0.22 : 0) - (speed - 22) * 0.03, 0.05, 0.9) : 0;
    gk.dive = { t: 0, side: guess, save: rnd() < ch, pz: right ? tz : guess * 2.6, py: ty, z0: gk.pos.z, T: T * 0.95, done: false };
    on('swell', 0.5, 0.4);
  }

  // ------------------------------------------------------------------ tackling, fouls, contact
  function tryTackle(p, slide) {
    if (p.tackleT > 0 && !(slide && !p.slide)) return;
    if (p.stagger > 0 || p.tackleCd > 0.6) return;
    p.tackleT = slide ? 0.75 : 0.42; p.slide = slide; p.tackleDone = false; p.tackleCd = slide ? 1.4 : 0.8;
    p.vel.addScaledVector(fwd(p), slide ? 6.5 : 3);
    if (slide) { on('turf', p.pos, 26, 1.4); tag(p, 'SLIDE TACKLE'); }
  }
  function resolveTackle(p) {
    if (p.tackleDone) return;
    const c = ball.owner;
    const reach = p.slide ? 1.9 : 1.35;
    const tgtPos = c ? c.pos : ball.pos;
    tmpC.subVectors(tgtPos, p.pos); tmpC.y = 0;
    const dist = tmpC.length();
    if (dist > reach) return;
    const f = fwd(p); const dot = dist > 0.01 ? (tmpC.x * f.x + tmpC.z * f.z) / dist : 1;
    if (dot < 0.1) return;
    p.tackleDone = true;
    if (!c) { if (ball.pos.y < 0.6) kick(p, new V3(f.x * 6, 0.8, f.z * 6), 'poke'); return; }
    if (c.team === p.team) return;
    if (c.isGK && inOwnBox(c)) return;                              // the keeper has it in his hands
    const cf = fwd(c), behind = dist > 0.01 && (tmpC.x * cf.x + tmpC.z * cf.z) / dist > 0.5;
    let chance = (p.slide ? 0.72 : 0.6) * (0.65 + 0.45 * n(p, 'tackling')) - n(c, 'drib') * 0.2 + (c.vel.length() > c.jogSp ? 0.1 : 0);
    if (p.slide && has(p, 'Sliding Tackle')) chance += 0.1;
    if (c.shield) chance *= clamp(0.55 - 0.5 * (n(c, 'physical') - n(p, 'physical')), 0.15, 0.8);
    chance *= 1 - tired(p) * 0.3;
    if (c.evade > 0 || c.protect > 0) chance = 0;
    const won = rnd() < chance;
    // fouls: going through the back of a player, and mistimed slides
    let foulCh = won ? (p.slide && behind ? 0.5 : 0) : dist < reach * 0.8 ? (p.slide ? 0.4 : 0.06) + (behind ? 0.25 : 0) : 0;
    if (c.shield && behind) foulCh += 0.2;
    if (has(c, 'Gamesmanship')) foulCh *= 1.3;
    if (p.slide && has(p, 'Sliding Tackle')) foulCh *= 0.6;
    if (c.protect > 0) foulCh = 0;
    if (rnd() < foulCh) { foul(p, c); return; }
    if (won) {
      G.stats.tackles[p.team]++;
      on('turf', c.pos, 18, 1.2);
      c.stagger = 0.45 - 0.15 * n(c, 'balance'); c.wind = null; c.shield = false;
      if (!p.slide && rnd() < 0.55) { ball.owner = null; setOwner(p); }
      else { ball.owner = null; ball.vel.set(f.x * 5 + rand(-1.5, 1.5), 0.6, f.z * 5 + rand(-1.5, 1.5)); ball.lastTeam = p.team; ball.lastKicker = p; ball.kickType = 'poke'; ball.offs = null; teams[c.team].lostAt = G.now; p.kickCd = 0.2; c.kickCd = 0.5; }
      if (p.team === human) on('vibrate', 18);
      tag(p, 'TACKLE', true);
    } else tag(p, c.evade > 0 ? 'EVADED' : c.shield ? 'SHIELDED' : 'MISSED', false);
  }
  function foul(by, victim) {
    const d = DIR[victim.team];
    G.stats.fouls[by.team]++;
    victim.stagger = 1.1; victim.wind = null; victim.shield = false; victim.skill = null; by.tackleT = 0; by.stagger = 0.3;
    victim.fit = Math.max(0.3, victim.fit - 0.012 * (4 - victim.pl.injRes));      // a knock: costs more the lower the Injury Resistance
    const inBox = victim.pos.x * d > HX - BOX_D && Math.abs(victim.pos.z) < BOX_W;
    ball.owner = null; ball.vel.set(0, 0, 0); ball.intended = null; ball.offs = null; inp.charging = false;
    on('turf', victim.pos, 20, 1.2); on('whistle', 0.3, 1);
    if (inBox) { on('banner', 'PENALTY!', `${by.name} on ${victim.name}`, false, 1700); on('swell', 0.8, 1); outOfPlay('penalty', victim.team, new V3(d * (HX - 11), BR, 0), true); }
    else { on('banner', 'FOUL', `${by.name} on ${victim.name}`, true, 1100); outOfPlay('freekick', victim.team, new V3(clamp(victim.pos.x, -HX + 1, HX - 1), BR, clamp(victim.pos.z, -HZ + 1, HZ - 1)), true); }
  }
  /* Shoulder to shoulder: Physical Contact and Balance decide who stays on the ball. From behind it is a foul. */
  function shoulderCharge(p) {
    const c = ball.owner;
    if (!c || c.team === p.team || p.tackleCd > 0 || p.stagger > 0 || p.tackleT > 0 || (c.isGK && inOwnBox(c))) return;
    tmpC.subVectors(c.pos, p.pos); tmpC.y = 0;
    const dist = tmpC.length();
    if (dist > 1.7) { tag(p, 'TOO FAR TO CHARGE', false); return; }
    tmpC.divideScalar(Math.max(dist, 0.01));
    p.tackleCd = 0.9; p.vel.addScaledVector(tmpC, 2.5); p.kickAnim = 0.2;
    const cf = fwd(c), behind = tmpC.x * cf.x + tmpC.z * cf.z > 0.6;
    if (c.protect > 0 || c.evade > 0) { tag(p, 'MISSED', false); return; }
    if (behind && rnd() < 0.65) { foul(p, c); return; }
    const mine = n(p, 'physical') + 0.5 * n(p, 'balance') + rnd() * 0.6, his = n(c, 'physical') + 0.5 * n(c, 'balance') + rnd() * 0.6 + (c.shield ? 0.25 : 0);
    if (mine > his) {
      G.stats.tackles[p.team]++;
      c.stagger = 0.55 - 0.2 * n(c, 'balance'); c.wind = null; c.shield = false; c.kickCd = 0.5;
      ball.owner = null; ball.vel.set(tmpC.x * 3 + rand(-1.5, 1.5), 0.4, tmpC.z * 3 + rand(-1.5, 1.5)); ball.lastTeam = p.team; ball.lastKicker = p; ball.kickType = 'poke'; ball.offs = null; teams[c.team].lostAt = G.now;
      on('turf', c.pos, 14, 1); tag(p, 'SHOULDER CHARGE', true);
    } else { p.stagger = 0.35; tag(p, 'SHOULDER CHARGE', false); }
  }
  function quickStop(p) {
    if (ball.owner !== p || p.skill || p.stagger > 0 || p.isGK) return;
    p.vel.set(0, 0, 0); p.plant = 0.2; p.skillCd = Math.max(p.skillCd, 0.2);
    p.facing = Math.atan2(-p.pos.z, DIR[p.team] * HX - p.pos.x);
    for (const o of players) if (o.team !== p.team && !o.isGK && o.stagger <= 0 && o.pos.distanceTo(p.pos) < 2.6 && o.vel.length() > o.jogSp * 0.9 && rnd() < 0.3 * (1 - n(o, 'balance') * 0.5)) o.stagger = 0.35;
    tag(p, 'QUICK STOP');
  }

  // ------------------------------------------------------------------ skill moves
  function startSkill(p, type, worldDir) {
    if (ball.owner !== p || p.skill || p.skillCd > 0 || p.stagger > 0 || p.isGK || p.wind) return false;
    const M = MOVES[type];
    if (!canDo(p.pl, type)) { tag(p, `${M.name.toUpperCase()} NEEDS ${moveNeeds(type)}`, false); return false; }
    const f0 = fwd(p);
    const lat = new V3(-f0.z, 0, f0.x);
    let side = 1;
    if (worldDir && worldDir.lengthSq() > 0.01) side = Math.sign(lat.dot(worldDir)) || 1;
    else { const o = nearestOpp(p).o; if (o) side = -Math.sign(lat.dot(tmpC.subVectors(o.pos, p.pos))) || 1; }
    const quick = type === 'dragback' && has(p, 'Cut Behind & Turn') ? 0.8 : 1;
    p.skill = { type, t: 0, dur: M.dur * quick, f0, lat: lat.multiplyScalar(side), side, done: false, beat: false, f0ang: p.facing };
    p.skillCd = has(p, 'Sole Control') ? 0.4 : 0.55; p.stamina = Math.max(0, p.stamina - 0.04); p.shield = false;
    G.stats.skills[p.team]++;
    if (type === 'roulette' || type === 'dragback' || type === 'chop') p.evade = p.skill.dur + 0.15;
    if (type === 'doubletouch') p.evade = 0.25;
    if (type === 'fakeshot') p.kickAnim = 0.3;
    if (type === 'knockon') {
      const D = 7.5, v0 = Math.sqrt(16 + 2 * ROLL * D);
      kick(p, new V3(f0.x * v0, 0.4, f0.z * v0), 'knock'); p.kickCd = 0.12; p.burst = has(p, 'Acceleration Burst') ? 1.5 : 1.1;
    }
    if (type === 'rainbow') {
      const T = 0.85, hv = 5.2 / T;
      kick(p, new V3(f0.x * hv, GRAV * T / 2 + 0.3, f0.z * hv), 'flick'); p.kickCd = 0.35; p.burst = 0.9;
      bite(p, 0.7);
    }
    tag(p, M.name.toUpperCase());
    if (p.team === human) on('vibrate', 8);
    return true;
  }
  /* A feint "bites" when a nearby defender facing the carrier buys it and is left flat-footed. */
  function bite(p, base) {
    let any = false;
    for (const o of players) {
      if (o.team === p.team || o.stagger > 0) continue;
      if (o.isGK && !(p.skill && p.skill.type === 'fakeshot')) continue;
      tmpC.subVectors(p.pos, o.pos); const d = tmpC.length(); if (d > (o.isGK ? 9 : 3.8)) continue;
      const of = Math.cos(o.facing) * tmpC.x / d + Math.sin(o.facing) * tmpC.z / d;
      if (of < 0.1) continue;
      const ch = base * (0.55 + 0.6 * dribSkill(p)) * (o.jockey ? 0.35 : 1) * (1 - n(o, 'defAwa') * 0.35) * (o.team !== human ? (1.1 - S.diff * 0.12) : 0.9);
      if (rnd() < ch) {
        o.stagger = rand(0.55, 0.85) * (1.15 - 0.3 * n(o, 'balance')); o.tackleT = 0;
        const side = p.skill ? -p.skill.side : 1;
        o.vel.set(-Math.sin(o.facing) * 3 * side, 0, Math.cos(o.facing) * 3 * side);
        on('turf', o.pos, 10, 0.9); any = true;
      }
    }
    if (p.skill) p.skill.beat = p.skill.beat || any;
    if (any) { tag(p, MOVES[p.skill ? p.skill.type : 'rainbow'].name.toUpperCase(), true); if (p.team === human) on('swell', 0.26, 0.1); }
    return any;
  }
  function updateSkill(p, dt) {
    const s = p.skill; s.t += dt;
    const f = s.f0, L = s.lat;
    const once = (at, base) => { if (!s.done && s.t > at) { s.done = true; bite(p, base); } };
    switch (s.type) {
      case 'stepover': moveP(p, f, p.jogSp * 0.5, dt); once(0.28, 0.5); break;
      case 'bodyfeint': { const out = s.t < 0.12; p.vel.set(f.x * 3 + L.x * (out ? -2.5 : 5.5), 0, f.z * 3 + L.z * (out ? -2.5 : 5.5)); once(0.12, 0.4); break; }
      case 'ballroll': p.vel.set(f.x * 2.5 + L.x * 5.5, 0, f.z * 2.5 + L.z * 5.5); once(0.15, 0.35); break;
      case 'doubletouch': p.vel.set(f.x * 1.5 + L.x * 7.5, 0, f.z * 1.5 + L.z * 7.5); once(0.1, 0.6); break;
      case 'elastico': { const out = s.t < 0.12; p.vel.set(f.x * 2 + L.x * (out ? -1.6 : 7), 0, f.z * 2 + L.z * (out ? -1.6 : 7)); once(0.12, 0.65); break; }
      case 'chop': p.facing = s.f0ang + Math.PI / 2 * Math.min(1, s.t / s.dur) * s.side; if (s.t < 0.1) p.vel.multiplyScalar(Math.max(0, 1 - 12 * dt)); else p.vel.set(L.x * 6.5, 0, L.z * 6.5); once(0.1, 0.45); break;
      case 'dragback': p.vel.multiplyScalar(Math.max(0, 1 - 9 * dt)); p.facing = s.f0ang + Math.PI * Math.min(1, s.t / s.dur) * s.side; once(0.25, has(p, 'Cut Behind & Turn') ? 0.5 : 0.35); break;
      case 'roulette': p.facing = s.f0ang + Math.PI * 2 * Math.min(1, s.t / s.dur) * s.side; p.vel.set(f.x * 2.6 + L.x * 1.2, 0, f.z * 2.6 + L.z * 1.2); once(0.3, 0.5); break;
      case 'fakeshot': if (s.t < 0.16) p.vel.multiplyScalar(Math.max(0, 1 - 10 * dt)); else p.vel.set(f.x * 2.5 + L.x * 6, 0, f.z * 2.5 + L.z * 6); once(0.14, 0.5); break;
      default: moveP(p, f, p.sprintSp, dt);
    }
    if (s.t >= s.dur) {
      if (s.type === 'roulette') p.facing = s.f0ang;
      if (s.type === 'dragback') p.facing = s.f0ang + Math.PI * s.side;
      if (s.type === 'chop') p.facing = s.f0ang + Math.PI / 2 * s.side;
      p.skill = null;
    }
  }

  // ------------------------------------------------------------------ shape: where a player should stand
  function lateAndChasing(t) { return G.clock > S.len * 0.8 && G.score[t] <= G.score[1 - t]; }
  function formationTarget(p, out) {
    const t = p.team, d = DIR[t], tm = teams[t], T = tm.T, b = p.style, pt = possTeam();
    const attacking = pt === t || (pt === -1 && ball.lastTeam === t);
    const bxa = ball.pos.x * d, bz = ball.pos.z, lvl = tm.level, ins = p.ins;
    let center = clamp(bxa * 0.62 + (attacking ? 7 + lvl * 2.5 : -9 + lvl * 2 + (T.line - 0.5) * 14), -HX * 0.55, HX * 0.5);
    const depth = attacking ? 0.64 : lerp(0.58, 0.44, T.compact);
    let xa = center + (p.fx + 0.42) * HX * depth;
    let z = p.fz * d * HZ * (attacking ? 0.92 * T.width : lerp(0.78, 0.56, T.compact)) + bz * (attacking ? 0.22 : 0.38);
    if (attacking) {
      if (p.line === 'FW') xa += 5;
      xa += b.adv * (1 + lvl * 0.15);
      if (b.late && lateAndChasing(t)) xa += 18;
      if (b.wide > 0) z = lerp(z, Math.sign(p.fz * d || 1) * (HZ - 2.5), b.wide * 0.8);
      else if (b.wide < 0) z *= 1 + b.wide * 0.55;
      if (T.overload) z += (bz - z) * 0.28 * T.overload;
      const o = ball.owner;
      if (b.drop && o && o !== p && o.team === t && o.pos.distanceTo(p.pos) > 10) { xa = lerp(xa, o.pos.x * d + 6, b.drop * 0.5); z = lerp(z, o.pos.z, b.drop * 0.35); }
      if (b.box && bxa > HX - 32) { xa = HX - 8.5; z = clamp(z * 0.4 - bz * 0.12, -6, 6); }
      if (b.holdLine) xa = Math.max(xa, tm.offLine - 0.6);
      if (b.anchor) xa = Math.min(xa, bxa - 7, HX * 0.12);
      if (b.hold) xa = Math.min(xa, HX * 0.02);
      if (ins.att === 'defensive') xa = Math.min(xa, bxa - 10, 0);
      if (ins.att === 'attacking') xa += 7;
      if (ins.att === 'anchoring') z *= 0.35;
      if (p.line === 'DF' && b.adv < 8 && ins.att !== 'attacking' && !(b.late && lateAndChasing(t))) xa = Math.min(xa, HX * 0.22 + lvl * 3);
      if (S.offside) xa = Math.min(xa, Math.max(tm.offLine, bxa) - 0.5);          // stay onside
    } else {
      xa += b.advDef;
      if (p.line === 'FW' && has(p, 'Track Back')) xa -= 5;
      if (p.line === 'DF') { xa = Math.min(xa, HX * 0.05 + (T.line - 0.5) * 10); if (tm.trapT > 0) xa += 7; }
      if (tm.pressT > 0) xa += 4;
      if (ins.def === 'counter') xa = Math.max(xa, -3);
      if (ins.def === 'deep') xa = Math.min(xa, center - 0.3 * HX * depth);
    }
    xa = clamp(xa, -HX + 5, HX - 4);
    out.set(xa * d, 0, clamp(z, -HZ + 1.5, HZ - 1.5));
    if (!attacking && ball.owner && tm.trapT <= 0) {
      if (ins.def === 'man' && ins.mark) out.lerp(tmpC.copy(ins.mark.pos).add(tmpD.set(-d * 1.2, 0, 0)), 0.85);
      else if (p.line !== 'FW' || ins.def === 'tight') {
        // drift goal-side of the nearest attacker in the zone; Defensive Awareness and Man Marking make it tighter
        let mk = null, md = ins.def === 'tight' ? 12 : 9;
        for (const o of players) if (o.team !== t && !o.isGK && o !== ball.owner) { const dd = o.pos.distanceTo(out); if (dd < md) { md = dd; mk = o; } }
        if (mk) out.lerp(tmpC.copy(mk.pos).add(tmpD.set(-d * 1.6, 0, 0)), ins.def === 'tight' ? 0.78 : (has(p, 'Man Marking') ? 0.58 : 0.4) * (0.8 + 0.4 * n(p, 'defAwa')));
      }
    }
    return out;
  }
  function ballFuture(t, out) { return out.copy(ball.pos).addScaledVector(ball.vel, t).setY(0); }
  function assignRoles() {
    roles = { chaser: [null, null], press: [[], []], cover: [null, null] };
    const bf = ballFuture(0.35, new V3());
    for (let t = 0; t < 2; t++) {
      const tm = teams[t], d = DIR[t], isHuman = t === human;
      // the offside line this team attacks: the second-last opponent, never inside its own half
      let a = -1e9, b = -1e9;
      for (const o of players) if (o.team !== t) { const x = o.pos.x * d; if (x > a) { b = a; a = x; } else if (x > b) b = x; }
      tm.offLine = Math.max(b, 0);
      const mine = players.filter(p => p.team === t && !p.isGK && p.stagger <= 0);
      if (!ball.owner) {
        let best = null, bd = 1e9;
        for (const p of mine) {
          if (ball.offs && ball.offs.has(p) && ball.lastTeam === t) continue;         // he would be flagged
          const dd = p.pos.distanceTo(bf) / (p.sprintSp * (isHuman ? 1 : diff().react)); if (dd < bd) { bd = dd; best = p; }
        }
        roles.chaser[t] = (isHuman && best === ctrl) ? null : best;
      } else if (ball.owner.team !== t) {
        const c = ball.owner;
        const sorted = mine.filter(p => !(isHuman && p === ctrl)).sort((x, y) => x.pos.distanceTo(c.pos) - y.pos.distanceTo(c.pos));
        const counterPress = G.now - tm.lostAt < tm.T.cp;
        let nPress;
        // the person's teammates press on command, in the counter-press window, and (with Smart Assist) once the ball is in their own third
        if (isHuman) nPress = tm.pressT > 0 ? 2 : (inp.btn.loft && G.mode === 'defend') || counterPress || (S.assist && c.pos.x * d < HX * diff().helpZone) ? 1 : 0;
        else {
          const near = sorted[0];
          const trig = near ? tm.T.pressDist * (0.8 + 0.4 * n(near, 'defEng')) * near.style.press + tm.level * 2 : 0;
          nPress = near && (near.pos.distanceTo(c.pos) < trig || c.pos.x * d < -HX * 0.3) ? 1 : 0;
          if (counterPress) nPress++;
          if (tm.pressT > 0) nPress = Math.max(nPress, 2) + 1;
        }
        roles.press[t] = sorted.slice(0, nPress); roles.cover[t] = sorted[nPress] || null;
      }
    }
  }
  function pressCarrier(p, c, dt, tackleRate) {
    const d = DIR[p.team];
    tmpC.subVectors(tmpB.set(-d * HX, 0, 0), c.pos).setY(0).normalize();
    const dist = p.pos.distanceTo(c.pos);
    const tgt = new V3().copy(c.pos).addScaledVector(tmpC, dist > 4 ? 1.6 : 0.9);
    goTo(p, tgt, dist > 5 ? p.sprintSp * 0.95 : p.jogSp * 1.05, dt, 0.15);
    if (dist < 3) faceTo(p, c.pos, dt);
    if (!tackleRate || p.tackleCd > 0) return;
    if (dist < 1.75 && rnd() < tackleRate * (0.7 + 0.6 * n(p, 'aggr')) * dt) {
      const slide = dist > 1.3 && rnd() < 0.25 && !inOwnBox(p);         // the computer stays on its feet in its own box
      if (!slide && dist < 1.4 && n(p, 'physical') > 0.6 && rnd() < 0.2) shoulderCharge(p); else tryTackle(p, slide);
    }
  }

  // ------------------------------------------------------------------ computer players
  function startRun(p) {
    const d = DIR[p.team], tm = teams[p.team], b = p.style;
    const line = tm.offLine;
    let z = clamp(p.pos.z + rand(-6, 6), -HZ + 4, HZ - 4);
    if (b.decoy) z = clamp(ball.pos.z > 0 ? p.pos.z - rand(8, 14) : p.pos.z + rand(8, 14), -HZ + 4, HZ - 4);       // drag the marker away from the ball
    p.runTarget = new V3(clamp((line + (b.decoy ? 2 : 6)) * d, -HX + 6, HX - 6), 0, z); p.runT = 2.4; p.aiT = 2.5;
  }
  function aiPlayer(p, dt) {
    if (p.isGK) { keeperAI(p, dt); return; }
    if (G.phase !== 'play') { goTo(p, formationTarget(p, formTmp), p.jogSp, dt); return; }
    if (ball.owner === p) { carrierAI(p, dt); return; }
    const t = p.team, tm = teams[t], own = ball.owner;
    if (p.runTarget && p.runT > 0 && (!own || own.team === t)) {
      const tg = formTmp.copy(p.runTarget);
      if (S.offside && ball.intended !== p && own) {         // hold the run on the last defender's shoulder until the pass is played
        const d = DIR[t], lim = Math.max(tm.offLine, ball.pos.x * d) - 0.3;
        if (tg.x * d > lim) tg.x = lim * d;
      }
      const dd = goTo(p, tg, p.sprintSp, dt, 0.4);
      if (dd < 0.5 && ball.intended !== p && p.pos.distanceTo(p.runTarget) < 1) p.runTarget = null;
      return;
    }
    if (!own && G.hold && G.hold.team === t && G.hold.spots.has(p) && roles.chaser[t] !== p) {
      // defending a set piece: stay goal-side of the nearest attacker until the ball is won or cleared
      let mk = null, md = 4;
      for (const o of players) if (o.team !== t && !o.isGK) { const dd = o.pos.distanceTo(p.pos); if (dd < md) { md = dd; mk = o; } }
      goTo(p, mk ? tmpB.copy(mk.pos).add(tmpD.set(-DIR[t] * 0.75, 0, 0)) : G.hold.spots.get(p), p.sprintSp, dt, 0.2);
      return;
    }
    if (!own) {
      if (roles.chaser[t] === p) {
        // a pass to an opponent: cut it out only if he reads it (Defensive Awareness, Interception), otherwise close the receiver down
        const it = ball.intended;
        if (it && it.team !== t && PASS_KINDS.has(ball.kickType)) {
          const to = it.runTarget || it.pos, read = (0.5 + 1.5 * n(p, 'defAwa')) * (has(p, 'Interception') ? 1.35 : 1) * (t !== human ? diff().react : 1);
          if (segDist(p.pos.x, p.pos.z, ball.pos.x, ball.pos.z, to.x, to.z) > read) { goTo(p, tmpB.copy(to).add(tmpD.set(-DIR[t] * 1.4, 0, 0)), p.sprintSp, dt, 0.3); return; }
        }
        goTo(p, ballFuture(0.3, formTmp), p.sprintSp, dt, 0.05); return;
      }
    } else if (own.team !== t) {
      if (roles.press[t].includes(p)) { pressCarrier(p, own, dt, t !== human ? diff().tackle : 1.0); return; }
      if (roles.cover[t] === p) {
        goTo(p, tmpB.lerpVectors(own.pos, tmpD.set(-DIR[t] * HX, 0, 0), 0.25), p.jogSp * 1.1, dt); faceTo(p, own.pos, dt); return;
      }
    } else if (p.aiT <= 0 && (p.line === 'FW' || p.style.runs >= 1 || p.ins.att === 'attacking')) {
      // runs in behind: the team playstyle sets how many, the playing style and Attacking Awareness scale it
      const perMin = tm.T.runs * p.style.runs * (0.7 + 0.6 * n(p, 'offAwa')) * (1 + 0.25 * tm.level) * (p.ins.att === 'attacking' ? 1.5 : 1) * (has(p, 'Attack Trigger') ? 1.3 : 1);
      if (p.ins.att !== 'defensive' && rnd() < perMin / 60 * dt) startRun(p);
    }
    const tgt = formationTarget(p, formTmp);
    const far = p.pos.distanceTo(tgt) > 9;
    goTo(p, tgt, far ? p.sprintSp * 0.85 : p.jogSp * 0.9, dt, 0.6);
    if (p.vel.lengthSq() < 0.5) faceTo(p, ball.pos, dt, 5);
  }
  const AI_FEINTS = ['stepover', 'elastico', 'dragback', 'roulette', 'bodyfeint', 'ballroll', 'chop', 'doubletouch'];
  function carrierAI(p, dt) {
    const t = p.team, d = DIR[t], tm = teams[t], T = tm.T, A = p.ai, goal = new V3(d * HX, 0, 0);
    p.holdT += dt;
    const pr = nearestOpp(p), dg = p.pos.distanceTo(goal), xa = p.pos.x * d;
    const lvl = t !== human ? S.diff : 1;
    p.shield = false;
    if (p.shieldT > 0) { p.shieldT -= dt; p.shield = pr.d < 2.6; }
    if (p.aiT <= 0) {
      p.aiT = rand(0.22, 0.45);
      const L = tm.link;
      if (L && L.from === p && L.t > 0 && L.t < 2.4 && rnd() < 0.5) { tm.link = null; doPass(p, L.kind, null, { target: L.runner, lofted: L.lofted }); return; }
      const angOK = Math.abs(p.pos.z) < 18 + (dg < 14 ? 6 : 0);
      const range = 25 + (A.longShot ? 8 : 0);
      if (dg < range && angOK && rnd() < (dg < 15 ? 0.6 : dg < 25 ? 0.28 : 0.2) * (t !== human ? diff().shoot : 1)) {
        const gk = gkOf(1 - t);
        const mode = gk && Math.abs(Math.abs(gk.pos.x) - HX) > 4 && dg > 12 ? 'chip' : rnd() < 0.35 ? 'finesse' : 'power';
        const pw = rand(0.48, 0.98) + lvl * 0.02;
        if (mode === 'power' && pr.d > 3.2 && dg > 15 && rnd() < 0.3) stun(p, rushed => doShot(p, pw, 'power', null, { stun: true, rushed }));
        else doShot(p, pw, mode, null);
        return;
      }
      if (pr.d < 2.8 && p.skillCd <= 0 && rnd() < (0.3 * dribSkill(p) + 0.05 * lvl) * (A.trick ? 1.8 : 1)) {
        const can = AI_FEINTS.filter(m => canDo(p.pl, m));
        if (pr.d > 2 && rnd() < 0.2) { startSkill(p, 'knockon', null); return; }
        if (can.length) { startSkill(p, pick(can), null); return; }
      }
      if (A.knock && pr.d > 4.5 && p.skillCd <= 0 && xa < HX - 20 && rnd() < 0.2) { startSkill(p, 'knockon', null); return; }
      if (Math.abs(p.pos.z) > (A.earlyCross ? 15 : 20) && xa > HX - (A.earlyCross ? 34 : 24) && rnd() < 0.45 + (T.width > 1 ? 0.2 : 0)) {
        const b = bestPassTarget(p, null, 'loft');
        if (b && b.t.pos.x * d > HX - 20) { if (pr.d > 3 && rnd() < 0.3) stun(p, rushed => doPass(p, 'loft', null, { target: b.t, stun: true, rushed })); else doPass(p, 'loft', null, { target: b.t }); return; }
      }
      const longBall = Math.max(0, T.passLen) * 0.3 + (A.longBall ? 0.18 : 0);
      if (longBall > 0 && xa < HX * 0.25 && rnd() < longBall) {
        const b = bestPassTarget(p, null, 'loft', { forwardOnly: true });
        if (b && b.score > 0.2) { doPass(p, 'loft', null, { target: b.t }); return; }
      }
      if (pr.d < 2.2 || p.holdT > 2.6 + T.passLen * 0.5 || rnd() < 0.14 * (1 - T.passLen * 0.6) * (A.maze ? 0.5 : 1)) {
        const kind = rnd() < 0.2 + Math.max(0, T.passLen) * 0.15 ? 'through' : 'pass';
        const b = bestPassTarget(p, null, kind);
        if (b && (b.score > 0.35 || pr.d < 1.6)) { doPass(p, kind, null, { target: b.t }); return; }
        if (p.style.holdUp && pr.d < 2) p.shieldT = 0.9;          // nothing on: a Target Man holds it up
      }
    }
    if (p.shield) { moveP(p, ZERO, 0, dt); p.facing += clamp(angDiff(p.facing, Math.atan2(p.pos.z - pr.o.pos.z, p.pos.x - pr.o.pos.x)), -8 * dt, 8 * dt); return; }
    // dribble toward goal, steering around defenders
    const dir = new V3().subVectors(goal, p.pos).setY(0).normalize();
    let space = true;
    for (const o of players) if (o.team !== t) {
      tmpC.subVectors(o.pos, p.pos); const dd = tmpC.length();
      if (dd < 5 && tmpC.dot(dir) > 0) { space = false; const lat = tmpD.set(-dir.z, 0, dir.x); const s = Math.sign(lat.dot(tmpC)) || 1; dir.addScaledVector(lat, -s * (5 - dd) / 5 * 1.2); }
    }
    dir.z += (-p.pos.z) * (A.cutIn ? 0.03 : 0.01); dir.normalize();
    moveP(p, dir, (space ? p.sprintSp * 0.9 : p.jogSp * 0.95) * (0.9 + 0.1 * n(p, 'drib')), dt);
  }
  function keeperAI(p, dt) {
    const t = p.team, d = DIR[t], gx = -d * HX, tm = teams[t];
    if (ball.owner === p) {
      p.holdT += dt; moveP(p, ZERO, 0, dt);
      faceTo(p, ZERO, dt);
      if ((t !== human || ctrl !== p) && p.holdT > (inOwnBox(p) ? 1.1 : 0.15) && G.phase === 'play') {
        const b = bestPassTarget(p, null, 'pass');
        if (b && b.score > 0.7 + Math.min(0, tm.T.passLen) * 0.4 - (inOwnBox(p) ? 0 : 1)) doPass(p, 'pass', null, { target: b.t });
        else { const l = bestPassTarget(p, null, 'loft', { forwardOnly: true }) || bestPassTarget(p, null, 'loft'); doPass(p, 'loft', null, l ? { target: l.t } : {}); }
      }
      return;
    }
    if (p.dive) { updateDive(p, dt); return; }
    if (p.stagger > 0) { p.vel.multiplyScalar(Math.max(0, 1 - 4 * dt)); return; }
    if (G.phase !== 'play') { goTo(p, tmpB.set(gx + d * 1.2, 0, 0), p.jogSp, dt); faceTo(p, ball.pos, dt); return; }
    // shot incoming?
    if (!ball.owner && ball.vel.x * -d > 2.5 && ball.kickType !== '' && ball.lastTeam !== t) {
      const tt = (p.pos.x - ball.pos.x) / ball.vel.x;
      if (tt > 0 && tt < 1.1) {
        const pz = ball.pos.z + ball.vel.z * tt + 0.5 * ball.curl.z * tt * tt;
        const py = ball.pos.y + ball.vel.y * tt - 0.5 * (GRAV - ball.curl.y) * tt * tt;
        if (Math.abs(pz) < GW / 2 + 0.6 && py < GH + 0.5 && py > -0.5) { startDive(p, pz, Math.max(BR, py), tt); return; }
      }
    }
    // come off the line for a carrier clean through: on the person's command, or by himself if he is an Attacking Goalkeeper
    const c = ball.owner;
    if (c && c.team !== t) {
      const cd = Math.hypot(c.pos.x - gx, c.pos.z);
      let rush = tm.rushT > 0 && cd < 30;
      if (!rush && p.style.sweep && cd < 20 && Math.abs(c.pos.z) < 13) {
        let cover = 1e9; for (const q of players) if (q.team === t && !q.isGK) cover = Math.min(cover, q.pos.distanceTo(c.pos));
        rush = cover > 3.5;
      }
      if (rush) {
        const dist = goTo(p, c.pos, p.sprintSp, dt, 0.3); faceTo(p, c.pos, dt);
        if (dist < 1.35 && p.tackleCd <= 0) {
          p.tackleCd = 1.5;
          const ch = c.evade > 0 || c.protect > 0 ? 0 : 0.3 + 0.4 * n(p, 'gkReflex') - 0.25 * n(c, 'drib');
          if (inOwnBox(p) && rnd() < ch) { ball.owner = null; c.stagger = 0.4; c.wind = null; setOwner(p); on('banner', 'SMOTHERED', p.name + ' at his feet', true, 900); on('swell', 0.45, 0.3); }
          else { p.stagger = 0.7; tm.rushT = 0; }
        }
        return;
      }
    }
    // loose balls in the box (a sweeper keeper also comes for ones just outside it)
    const reach = p.style.sweep ? 9 : -2;
    const near = Math.abs(ball.pos.x - gx) < BOX_D + reach && Math.abs(ball.pos.z) < BOX_W - 4 + Math.max(0, reach);
    if (!ball.owner && near && ball.vel.length() < 14) {
      let nearest = 99; for (const q of players) if (!q.isGK) nearest = Math.min(nearest, q.pos.distanceTo(ball.pos));
      if (p.pos.distanceTo(ball.pos) < nearest + 1.5) { goTo(p, ball.pos, p.sprintSp, dt, 0.05); return; }
    }
    // angle-bisector positioning; GK Awareness sets how well he narrows the angle
    const bd = Math.hypot(ball.pos.x - gx, ball.pos.z);
    const out = clamp(bd < 30 ? 1.2 + (30 - bd) * (0.035 + 0.03 * n(p, 'gkAwa')) : 1, 0.8, 2.8);
    const tz = clamp(ball.pos.z * (out / Math.max(bd, 1)) * 2.0, -GW / 2 + 0.5, GW / 2 - 0.5);
    goTo(p, tmpB.set(gx + d * out, 0, tz), p.jogSp * 1.1, dt, 0.1);
    faceTo(p, ball.pos, dt, 6);
  }
  function startDive(p, pz, py, t) {
    const lat = pz - p.pos.z, side = Math.sign(lat) || 1;
    const reach = 1.0 + (5 + 3 * n(p, 'gkReach')) * Math.max(0, t - 0.08);
    const sp = ball.vel.length();
    let ch = (p.team !== human ? diff().save : human < 0 ? DIFF[1].save : diff().own) + 0.35;
    ch -= Math.max(0, Math.abs(lat) - 0.7) / 3.6 * 0.62 * clamp(1.25 - 0.75 * t, 0.5, 1);        // with time to see it, he covers more of the goal
    ch -= Math.max(0, sp - 20) / 30;
    ch -= (py > 1.8 && Math.abs(pz) > 2.4) ? 0.2 : 0;
    ch += (n(p, 'gkReflex') - 0.5) * (t < 0.45 ? 0.45 : 0.25) + (n(p, 'gkReach') - 0.5) * 0.15;
    ch += clamp((t - 0.45) * 0.4, 0, 0.22);
    if (ball.stun) ch -= 0.12;
    if (Math.abs(lat) > reach) ch = 0;
    if (ball.kickType === 'shot' && ball.shotBy && ball.shotBy.team !== p.team && !ball.shotCounted && Math.abs(pz) < GW / 2 && py < GH) { G.stats.onT[ball.shotBy.team]++; ball.shotCounted = true; }
    p.dive = { t: 0, side: Math.abs(lat) > 0.6 ? side : 0, save: rnd() < ch, pz, py, z0: p.pos.z, T: t, done: false };
  }
  function updateDive(p, dt) {
    const dv = p.dive; dv.t += dt;
    const k = clamp(dv.t / Math.max(0.12, dv.T), 0, 1);
    const tgtZ = dv.save ? dv.pz : lerp(dv.z0, dv.pz, 0.62);
    p.pos.z = lerp(dv.z0, tgtZ, Math.min(1, k * 1.15)); p.vel.set(0, 0, 0);
    if (!dv.done && dv.save && !ball.owner) {
      tmpA.set(p.pos.x, dv.side ? clamp(dv.py, 0.2, 2.4) : Math.min(dv.py, 1.6), p.pos.z);
      if (tmpA.distanceTo(ball.pos) < 1.15) {
        dv.done = true;
        const sp = ball.vel.length();
        ball.offs = null; ball.block = null;
        if (sp < 21 && rnd() < 0.25 + 0.5 * n(p, 'gkCatch') && Math.abs(dv.side) < 1) { if (setOwner(p)) on('banner', 'SAVED', p.name + ' holds it', true, 900); }
        else {       // GK Parrying: a good parry goes wide, a poor one drops back into the danger area
          const d = DIR[p.team], q = n(p, 'gkParry');
          if (dv.side && rnd() < 0.2 + 0.3 * q) ball.vel.set(-d * rand(1.5, 4), rand(1.5, 4), dv.side * rand(7, 10));        // tipped round the post
          else ball.vel.set(d * Math.abs(ball.vel.x) * (0.4 - 0.25 * q) + d * 2, rand(2, 5), (dv.side || (rnd() < 0.5 ? -1 : 1)) * rand(3, 5 + 5 * q));
          ball.lastTeam = p.team; ball.lastKicker = p; ball.kickType = 'parry'; ball.curl.set(0, 0, 0);
          on('burst', ball.pos, 'white'); on('kick', p, 'parry', 15);
          on('banner', 'SAVE!', p.name + (dv.side ? ' at full stretch' : ''), true, 900);
        }
        on('swell', 0.45, 0.3); on('excite', 0.6);
      }
    }
    if (dv.t > Math.max(0.9, dv.T + 0.5)) p.dive = null;
  }

  // ------------------------------------------------------------------ team levers, link-up plays, the computer's manager
  function teamLever(t, name, arg) {
    const tm = teams[t], say = (big, sub) => { if (t === human) on('banner', big, sub || '', true, 1000); on('lever', t, name); };
    if (name === 'level') { const v = clamp(tm.level + arg, -2, 2); if (v !== tm.level) { tm.level = v; say(LEVELS[v + 2].toUpperCase()); } }
    else if (name === 'tactic') { applyTactic(t, arg === undefined ? 1 - tm.tac : arg); const c = tm.cfg.tactics[tm.tac]; say('TACTIC ' + 'AB'[tm.tac], c.formation + ' · ' + PLAYSTYLES[c.playstyle].name); }
    else if (name === 'trap') { if (tm.trapCd <= 0 && S.offside) { tm.trapT = 2.2; tm.trapCd = 9; say('OFFSIDE TRAP', 'the back line steps up'); } }
    else if (name === 'pressure') {
      if (tm.pressCd <= 0) { tm.pressT = 6; tm.pressCd = 16; for (const p of players) if (p.team === t && !p.isGK) p.fit = Math.max(0.3, p.fit - 0.012); say('CALL FOR PRESSURE', 'everyone closes down'); }
    }
    else if (name === 'gkrush') { tm.rushT = 2.5; say('KEEPER RUSH'); }
  }
  function linkTick(tm, dt) {
    if (tm.link) { tm.link.t -= dt; if (tm.link.t <= 0 || (ball.owner && ball.owner !== tm.link.from)) tm.link = null; }
    tm.linkCd -= dt;
    const o = ball.owner;
    if (tm.link || tm.linkCd > 0 || !tm.linkUp || !o || o.team !== tm.t || G.phase !== 'play') return;
    const L = LINKUPS[tm.linkUp], d = DIR[tm.t], xa = o.pos.x * d;
    if (!L.from.includes(o.posCode)) return;
    const cands = players.filter(q => q.team === tm.t && q !== o && L.to.includes(q.posCode) && q.stagger <= 0);
    if (!cands.length) return;
    const far = cands.slice().sort((a, b) => b.pos.x * d - a.pos.x * d)[0];
    let runner, tx, tz, lofted = false, kind = L.kind;
    if (tm.linkUp === 'overTop') { if (xa > 8) return; runner = cands.find(q => q.style.holdLine) || far; tx = tm.offLine + 9; tz = runner.pos.z * 0.7; kind = 'through'; lofted = true; }
    else if (tm.linkUp === 'breakthrough') { if (xa < -20 || xa > HX - 22) return; runner = far === o ? cands[1] : far; if (!runner) return; tx = tm.offLine + 7; tz = runner.pos.z * 0.5; }
    else if (tm.linkUp === 'buildDeep') { if (xa > -HX * 0.4) return; runner = cands.slice().sort((a, b) => a.pos.distanceTo(o.pos) - b.pos.distanceTo(o.pos))[0]; tx = xa + 5; tz = o.pos.z + (o.pos.z > 0 ? -9 : 9); }
    else { if (xa < HX - 30 || Math.abs(o.pos.z) < 14) return; runner = far; tx = HX - 5.5; tz = Math.sign(o.pos.z) * 3; }
    runner.runTarget = new V3(clamp(tx, -HX + 3, HX - 4) * d, 0, clamp(tz, -HZ + 3, HZ - 3)); runner.runT = 3; runner.link = 3;
    tm.link = { from: o, runner, kind, lofted, t: 3 }; tm.linkCd = 10;
    if (tm.t === human) on('tag', 'LINK-UP · ' + L.name.toUpperCase());
  }
  function aiManager(tm, dt) {
    tm.mgrT -= dt; if (tm.mgrT > 0) return; tm.mgrT = 1.5;
    const t = tm.t, gd = G.score[t] - G.score[1 - t], frac = G.clock / S.len, o = ball.owner;
    const lvl = gd < 0 ? (frac > 0.75 ? 2 : frac > 0.4 ? 1 : 0) : gd > 0 ? (frac > 0.8 ? -2 : frac > 0.6 ? -1 : 0) : 0;
    if (lvl !== tm.level) teamLever(t, 'level', lvl - tm.level);
    const want = gd < 0 && frac > 0.6 ? 1 : 0;
    if (want !== tm.tac && G.phase === 'play') teamLever(t, 'tactic', want);
    if (S.offside && o && o.team !== t && tm.trapCd <= 0 && tm.T.line > 0.55 && rnd() < 0.12) { const oxa = o.pos.x * DIR[o.team]; if (oxa > -10 && oxa < 14) teamLever(t, 'trap'); }
    if (gd < 0 && frac > 0.85 && tm.pressCd <= 0 && o && o.team !== t) teamLever(t, 'pressure');
  }

  // ------------------------------------------------------------------ the person's player
  function setCtrl(p) {
    if (ctrl === p || p.team !== human) return;
    ctrl = p; G.lastSwitch = G.now;
    if (inp.charging && ball.owner !== p) inp.charging = false;
    on('ctrl', p);
  }
  function switchPlayer() {
    const bf = ballFuture(0.3, new V3());
    let best = null, bd = 1e9;
    for (const p of players) { if (p.team !== human || p === ctrl || p.isGK) continue; const d = p.pos.distanceTo(bf); if (d < bd) { bd = d; best = p; } }
    if (best) { setCtrl(best); on('burst', new V3(best.pos.x, 0.2, best.pos.z), 'team0'); }
  }
  function computeMode() {
    const o = ball.owner;
    if (o && o.team === human) return 'attack';
    if (!o && ball.lastTeam === human && ball.intended && ball.intended.team === human && PASS_KINDS.has(ball.kickType)) return 'attack';
    return 'defend';
  }
  const hintNow = () => inp.dir.lengthSq() > 0.04 ? inp.dir.clone().normalize() : null;
  function press(a) {
    inp.btn[a] = true;
    if (!live() || !ctrl) return;
    const holds = ball.owner === ctrl;
    if (G.mode === 'defend') {
      if (a === 'pass') switchPlayer();
      if (a === 'shoot') { const dbl = G.now - inp.tap.shoot < 0.32; inp.tap.shoot = G.now; if (G.phase === 'play' && !(ball.owner && ball.owner.team === human)) tryTackle(ctrl, dbl); }
      return;
    }
    if (a === 'pass' && inp.charging && holds && G.phase === 'play') {       // kick feint: Pass during the shot wind-up
      inp.charging = false; inp.btn.pass = false; inp.btn.shoot = false; startSkill(ctrl, 'fakeshot', hintNow()); return;
    }
    if (a === 'shoot' && holds) { inp.charging = true; inp.charge = 0; inp.chargeMode = 'power'; }
    if (a === 'sprint') { if (G.now - inp.tap.sprint < 0.3 && holds && G.phase === 'play') startSkill(ctrl, 'knockon', null); inp.tap.sprint = G.now; }
  }
  /* mod is the direction the thumb slid off the button before letting go: '', 'up', 'down', 'left' or 'right'. */
  function release(a, mod = '') {
    const was = inp.btn[a]; inp.btn[a] = false;
    if (!was || !live() || !ctrl) return;
    if (G.mode === 'defend') {
      if (mod === 'up' && a === 'through') teamLever(human, 'pressure');
      if (mod === 'up' && a === 'loft') teamLever(human, 'gkrush');
      return;
    }
    const p = ctrl, hint = hintNow();
    if (G.phase === 'setpiece') { if (G.sp.taker === p && ball.owner === p) userSetPiece(a, hint); return; }
    if (ball.owner !== p) {
      // first-time: queue the action until the ball arrives
      if (a !== 'sprint' && a !== 'skill' && !ball.owner && ball.intended === p) G.queued = { a, mod, t: 1.2, power: a === 'shoot' ? Math.max(0.7, inp.charge) : 0, hint };
      inp.charging = false;
      return;
    }
    doAction(a, mod, hint, null);
  }
  function doAction(a, mod, hint, first) {
    const p = ctrl, f = !!first;
    if (a === 'pass') {
      const oneTwo = mod === 'left' || mod === 'down';
      if (G.oneTwo && G.oneTwo.runner !== p && G.oneTwo.t > 0 && !oneTwo) { const r = G.oneTwo.runner; G.oneTwo = null; doPass(p, 'through', hint, { target: r, first: f }); }
      else if (mod === 'right') stun(p, rushed => doPass(p, 'pass', hint, { stun: true, rushed }));
      else doPass(p, 'pass', hint, { oneTwo, first: f });
    }
    if (a === 'through') { if (mod === 'right') stun(p, rushed => doPass(p, 'through', hint, { stun: true, rushed })); else doPass(p, 'through', hint, { lofted: mod === 'up', first: f }); }
    if (a === 'loft') { if (mod === 'right') stun(p, rushed => doPass(p, 'loft', hint, { stun: true, rushed })); else doPass(p, 'loft', hint, { first: f }); }
    if (a === 'shoot') {
      const pw = first ? first.power : clamp(inp.charge, 0.05, 1.08);
      const mode = mod === 'up' ? 'chip' : mod === 'down' ? 'finesse' : mod === 'right' ? 'stun' : inp.chargeMode;
      inp.charging = false;
      if (mod === 'left') { startSkill(p, 'fakeshot', hint); return; }
      if (mode === 'stun') stun(p, rushed => doShot(p, pw, 'power', hint, { stun: true, rushed }));
      else doShot(p, pw, mode, hint, { first: f, volley: f && first.volley });
    }
    if (f) tag(p, 'FIRST-TIME');
  }
  function skillInput(slot) {
    if (G.mode !== 'attack' || !ctrl || ball.owner !== ctrl || G.phase !== 'play') return;
    const id = slot === 'tap' ? 'bodyfeint' : MOVES[slot] ? slot : teams[human].cfg.moves[slot];
    if (id) startSkill(ctrl, id, hintNow());
  }
  /* Double-tap on the stick side: stop dead and face goal with the ball, or shoulder-charge without it. */
  function leftDouble() {
    if (!ctrl || G.phase !== 'play') return;
    if (G.mode === 'attack') quickStop(ctrl); else shoulderCharge(ctrl);
  }
  function userUpdate(dt) {
    const p = ctrl; if (!p) return;
    if (p.stagger > 0 || p.skill || p.dive || p.tackleT > 0) return;
    const dir = tmpD.copy(inp.dir);
    const mag = Math.min(1, dir.length());
    const holds = ball.owner === p;
    p.jockey = G.mode === 'defend' && inp.btn.skill;
    p.shield = holds && inp.shield && !p.isGK;
    if (p.plant > 0) { moveP(p, ZERO, 0, dt); return; }
    let sp = inp.btn.sprint && p.stamina > 0.02 ? p.sprintSp * (0.72 + 0.28 * Math.min(1, p.stamina / 0.3)) : p.jogSp;
    if (holds) sp *= 0.84 + 0.1 * n(p, 'drib');
    if (p.jockey) sp = p.jogSp * 0.55;
    if (holds && p.isGK) { moveP(p, dir, p.jogSp * 0.6 * mag, dt); return; }
    if (p.shield) {      // body between man and ball: slow, facing away from the nearest opponent
      const o = nearestOpp(p).o;
      moveP(p, dir, p.jogSp * 0.42 * mag, dt);
      if (o) p.facing += clamp(angDiff(p.facing, Math.atan2(p.pos.z - o.pos.z, p.pos.x - o.pos.x)), -8 * dt, 8 * dt);
      return;
    }
    const opp = ball.owner && ball.owner.team !== p.team ? ball.owner : null;
    if (G.mode === 'defend' && inp.btn.through && opp) {
      if (mag > 0.2) { tmpB.subVectors(opp.pos, p.pos).setY(0).normalize(); const dd = new V3().copy(dir).normalize().lerp(tmpB, 0.5); moveP(p, dd, sp, dt); }
      else pressCarrier(p, opp, dt, 0);
      faceTo(p, opp.pos, dt);
      return;
    }
    if (mag < 0.12) { moveP(p, ZERO, 0, dt); if (p.jockey) faceTo(p, ball.pos, dt); return; }
    moveP(p, dir, sp * Math.max(0.35, mag), dt);
    if (p.jockey) faceTo(p, ball.pos, dt);
  }
  function autoSwitch() {
    if (!S.assist || G.mode !== 'defend' || !ctrl || G.phase !== 'play') return;
    if (G.now - G.lastSwitch < 0.7 || ctrl.tackleT > 0) return;
    const bf = ballFuture(0.35, new V3());
    let best = null, bd = 1e9;
    for (const p of players) { if (p.team !== human || p.isGK) continue; const d = p.pos.distanceTo(bf); if (d < bd) { bd = d; best = p; } }
    if (best && best !== ctrl && bd + 3 < ctrl.pos.distanceTo(bf)) setCtrl(best);
  }

  // ------------------------------------------------------------------ ball physics, pickups, goals
  function checkPickups() {
    if (ball.owner || ball.inGoal) return;
    let best = null, bd = 1e9, header = null, hs = -1;
    const sp = ball.vel.length(), hsp = Math.hypot(ball.vel.x, ball.vel.z), fresh = G.now - ball.kt < 0.3 && ball.kickType !== 'poke';
    for (const p of players) {
      if (p.kickCd > 0 || p.stagger > 0 || p.dive || p.wallT > 0.5) continue;
      const dx = ball.pos.x - p.pos.x, dz = ball.pos.z - p.pos.z, h = Math.hypot(dx, dz);
      if (p.isGK && inOwnBox(p, ball.pos)) {
        if (h < 1.25 && ball.pos.y < 2.5 && sp < 17 && h < bd) { bd = h; best = p; }
        continue;
      }
      // just after a kick the ball can only be stopped by an opponent it is travelling toward, not by one standing beside the kicker
      if (fresh && p.team !== ball.lastTeam && dx * ball.vel.x + dz * ball.vel.z > -0.6 * h * hsp) continue;
      let r = (ball.intended === p ? 1.05 : 0.85) + (p.tackleT > 0 ? 0.4 : 0);
      if (ball.lastTeam !== p.team && PASS_KINDS.has(ball.kickType) && has(p, 'Interception')) r += 0.3;
      if (ball.pos.y < 0.95 && h < r && h < bd) {
        if (sp > 23 && ball.intended !== p && rnd() < 0.6) continue;
        bd = h; best = p;
      }
      if (ball.pos.y > 1.35 && ball.pos.y < 2.2 + 0.5 * n(p, 'jump') && h < 1.0 && ball.vel.y < 2 && ball.lastKicker !== p) {
        const sc = aerial(p);
        if (sc > hs) { hs = sc; header = p; }
      }
    }
    if (best) {
      if (ball.offs && ball.offs.has(best) && ball.lastTeam === best.team) { offside(best); return; }
      const lim = 11 + 14 * n(best, 'ballCtl');
      if (!best.isGK && sp > lim && rnd() < clamp((sp - lim) / 16, 0, 0.6)) {        // a heavy first touch: the ball gets away from him
        const a = best.facing + gauss() * 0.8;
        G.stats.heavy[best.team]++;
        if (PASS_KINDS.has(ball.kickType) && ball.lastKicker && ball.lastKicker !== best) G.stats[ball.lastTeam === best.team ? 'passC' : 'inter'][best.team]++;
        if (ball.lastTeam !== best.team) teams[1 - best.team].lostAt = G.now;
        ball.vel.set(Math.cos(a) * 4.5, 1.2, Math.sin(a) * 4.5); ball.curl.set(0, 0, 0); ball.kickType = 'touch'; ball.lastTeam = best.team; ball.lastKicker = best; ball.intended = null; ball.offs = null; ball.block = null;
        best.kickCd = 0.28; tag(best, 'HEAVY TOUCH', false);
        return;
      }
      const volley = ball.pos.y > 0.4;
      if (!setOwner(best)) return;
      if (best === ctrl && G.queued && G.queued.t > 0) { const q = G.queued; G.queued = null; q.volley = volley; doAction(q.a, q.mod, q.hint, q); }
      return;
    }
    if (header) {
      // an aerial duel: anyone marking him tightly jumps with him, and the better leap wins the header
      let rival = null, rd = 1.6;
      for (const o of players) if (o.team !== header.team && !o.isGK && o.stagger <= 0 && o.kickCd <= 0) { const dd = o.pos.distanceTo(header.pos); if (dd < rd) { rd = dd; rival = o; } }
      if (rival && aerial(rival) > hs) header = rival;
      doHeader(header);
    }
  }
  /* Who wins a header: Jumping, Heading, Physical Contact, the Aerial Superiority skill, a defender's edge in his own box, and some luck. */
  function aerial(p) { return n(p, 'jump') + n(p, 'heading') + n(p, 'physical') * 0.4 + (has(p, 'Aerial Superiority') ? 0.4 : 0) + (inOwnBox(p) ? 0.3 : 0) + rnd() * 0.9; }
  function doHeader(p) {
    if (ball.offs && ball.offs.has(p) && ball.lastTeam === p.team) { offside(p); return; }
    const d = DIR[p.team], gx = d * HX;
    const dg = Math.hypot(gx - p.pos.x, p.pos.z);
    p.headAnim = 0.45; p.kickCd = 0.4;
    if (ball.lastTeam !== p.team) teams[1 - p.team].lostAt = G.now;
    if (dg < 17 && Math.abs(p.pos.z) < 14) {
      const err = (1.25 - n(p, 'heading')) * (has(p, 'Heading') ? 0.7 : 1) * (nearestOpp(p).d < 1.5 ? 1.5 : 1);
      const tz = (rnd() < 0.5 ? -1 : 1) * rand(0.4, GW / 2 - 0.3) + gauss() * (2 + err * 7), ty = Math.max(0.2, rand(0.3, 2.0) + gauss() * (0.6 + err * 3));
      const sp = 10 + n(p, 'heading') * 5 + (has(p, 'Bullet Header') ? 3 : 0), H = Math.hypot(gx - ball.pos.x, tz - ball.pos.z), T = H / sp;
      const a = Math.atan2(tz - ball.pos.z, gx - ball.pos.x);
      ball.vel.set(Math.cos(a) * sp, (ty - ball.pos.y + 0.5 * GRAV * T * T) / T, Math.sin(a) * sp);
      ball.kickType = 'shot'; ball.shotBy = p; ball.shotCounted = false; ball.stun = false; G.stats.shots[p.team]++;
      tag(p, 'HEADER'); on('trail', 1.6, 1.1, 0.5);
    } else { ball.vel.set(d * 12 + rand(-2, 2), 5, rand(-4, 4)); ball.kickType = 'clear'; }
    ball.lastTeam = p.team; ball.lastKicker = p; ball.curl.set(0, 0, 0); ball.intended = null; ball.offs = null; ball.block = null;
    on('kick', p, 'header', 12);
  }
  function updateBall(dt) {
    const p = ball.pos, v = ball.vel;
    if (ball.owner) {
      dribble(ball.owner, dt);
      // a ball carried over the line is out, just like one that is kicked over it
      if (G.phase === 'play' && !ball.inGoal) {
        const o = ball.owner;
        if (Math.abs(p.z) > HZ + BR) { ball.owner = null; outOfPlay('throw', 1 - o.team, new V3(clamp(p.x, -HX + 1, HX - 1), BR, Math.sign(p.z) * (HZ - 0.3))); }
        else if (Math.abs(p.x) > HX + BR) {
          const s = Math.sign(p.x);
          if (Math.abs(p.z) >= GW / 2 - BR || p.y >= GH) { ball.owner = null; byline(s, o.team); }
          else if (!(o.isGK && inOwnBox(o))) { ball.owner = null; ball.lastKicker = o; ball.lastTeam = o.team; goalScored(s > 0 ? 0 : 1, s); }      // walked into the net
        }
      }
      return;
    }
    const air = p.y > BR + 0.02 || v.y > 0.3;
    if (air) { v.y -= GRAV * dt; v.addScaledVector(ball.curl, dt); }
    else {
      const hs = Math.hypot(v.x, v.z);
      if (hs > 0) { const ns = Math.max(0, hs - ROLL * dt - hs * 0.05 * dt); v.x *= ns / hs; v.z *= ns / hs; }
      ball.curl.multiplyScalar(Math.max(0, 1 - 4 * dt)); ball.curl.y = 0; v.addScaledVector(ball.curl, dt);
    }
    const sp = v.length(); if (sp > 12) v.multiplyScalar(1 - 0.002 * sp * dt);
    const prevX = p.x;
    p.addScaledVector(v, dt);
    if (p.y < BR) { p.y = BR; if (v.y < -1.6) { v.y = -v.y * 0.5; v.x *= 0.84; v.z *= 0.84; ball.curl.multiplyScalar(0.4); } else v.y = 0; }
    if (ball.block) {
      const o = ball.block;
      if (Math.hypot(o.pos.x - p.x, o.pos.z - p.z) < 0.65 && p.y < 2.4) {
        v.set(-v.x * 0.2 + rand(-3, 3), rand(1, 4.5), -v.z * 0.2 + rand(-4, 4)); ball.curl.set(0, 0, 0);
        ball.kickType = 'block'; ball.lastTeam = o.team; ball.lastKicker = o; ball.block = null; ball.offs = null; ball.intended = null; o.kickCd = 0.3; o.headAnim = Math.max(o.headAnim, 0.2);
        on('kick', o, 'block', 14); on('tag', 'BLOCKED', o.team === human ? true : false); on('burst', p, 'white');
      } else if ((o.pos.x - p.x) * v.x + (o.pos.z - p.z) * v.z < 0) ball.block = null;
    }
    frameCollide();
    if (G.phase !== 'play') { netConstrain(); return; }
    for (const s of [1, -1]) {
      const line = s * (HX + BR);
      if (!ball.inGoal && (prevX - line) * s <= 0 && (p.x - line) * s > 0) {
        if (Math.abs(p.z) < GW / 2 - BR && p.y < GH - BR) { goalScored(s > 0 ? 0 : 1, s); return; }
        byline(s, ball.lastTeam);
        return;
      }
    }
    if (Math.abs(p.z) > HZ + BR) outOfPlay('throw', 1 - ball.lastTeam, new V3(clamp(p.x, -HX + 1, HX - 1), BR, Math.sign(p.z) * (HZ - 0.3)));
  }
  function byline(s, lastTeam) {
    const defTeam = s > 0 ? 1 : 0;
    if (lastTeam === defTeam) { G.stats.corners[1 - defTeam]++; outOfPlay('corner', 1 - defTeam, new V3(s * (HX - 0.4), BR, Math.sign(ball.pos.z || 1) * (HZ - 0.4))); }
    else outOfPlay('goalkick', defTeam, new V3(s * (HX - 5.5), BR, 0));
  }
  function frameCollide() {
    const p = ball.pos, v = ball.vel, r = 0.06 + BR;
    for (const s of [1, -1]) {
      const gx = s * HX;
      if (Math.abs(p.x - gx) > 0.6) continue;
      for (const pz of [-GW / 2, GW / 2]) {
        if (p.y > GH + r) continue;
        const dx = p.x - gx, dz = p.z - pz, d = Math.hypot(dx, dz);
        if (d < r && d > 1e-5) {
          const nx = dx / d, nz = dz / d, vn = v.x * nx + v.z * nz;
          if (vn < 0) { v.x -= 1.7 * vn * nx; v.z -= 1.7 * vn * nz; p.x = gx + nx * r; p.z = pz + nz * r; hitWoodwork('POST'); }
        }
      }
      if (Math.abs(p.z) < GW / 2) {
        const dx = p.x - gx, dy = p.y - GH, d = Math.hypot(dx, dy);
        if (d < r && d > 1e-5) {
          const nx = dx / d, ny = dy / d, vn = v.x * nx + v.y * ny;
          if (vn < 0) { v.x -= 1.7 * vn * nx; v.y -= 1.7 * vn * ny; p.x = gx + nx * r; p.y = GH + ny * r; hitWoodwork('CROSSBAR'); }
        }
      }
    }
  }
  function hitWoodwork(what) {
    ball.curl.set(0, 0, 0); ball.block = null;
    on('woodwork', ball.pos, what, ball.kickType === 'shot');
  }
  function netConstrain() {
    if (!ball.inGoal) return;
    const p = ball.pos, v = ball.vel, s = Math.sign(p.x);
    const back = s * (HX + 1.9);
    if ((p.x - back) * s > 0) { p.x = back; if (Math.abs(v.x) > 2) on('net', s, p.z, p.y, Math.min(1.4, Math.abs(v.x) / 14)); v.x *= -0.12; v.z *= 0.5; v.y *= 0.5; }
    if (Math.abs(p.z) > GW / 2 - BR) { p.z = Math.sign(p.z) * (GW / 2 - BR); v.z *= -0.25; }
    if (p.y > GH - BR) { p.y = GH - BR; v.y = -Math.abs(v.y) * 0.3; }
  }
  function goalScored(team, s) {
    ball.inGoal = true; G.phase = 'goal'; G.timer = 4.2; G.slowmo = 1.3; ball.offs = null; ball.block = null; inp.charging = false;
    G.score[team]++;
    const sc = ball.lastKicker && ball.lastKicker.team === team ? ball.lastKicker : null;
    if (ball.shotBy && ball.shotBy.team === team && !ball.shotCounted) G.stats.onT[team]++;
    for (const p of players) if (p.team === team && (p === sc || p.pos.distanceTo(sc ? sc.pos : ball.pos) < 22)) p.celebrate = 4;
    on('goal', team, s, sc, Math.ceil(G.clock / S.len * 90));
  }
  function outOfPlay(kind, team, pos, quiet) {
    G.phase = 'restart'; G.timer = kind === 'penalty' || kind === 'corner' || kind === 'freekick' ? 2.0 : 1.2;
    G.restart = { kind, team, pos, spots: null, wall: null, direct: false, taker: null };
    ball.vel.multiplyScalar(0.3); ball.offs = null; ball.block = null; ball.intended = null; G.queued = null; G.oneTwo = null;
    planSetPiece(G.restart);
    if (!quiet) { on('banner', { corner: 'CORNER', goalkick: 'GOAL KICK', throw: 'THROW-IN' }[kind], teams[team].cfg.name, true, 1000); on('whistle', 0.18, 1); }
  }

  // ------------------------------------------------------------------ set pieces
  /* Decide who takes it and where everyone else should stand. Players start moving there straight away. */
  function planSetPiece(R) {
    const { kind, team, pos } = R, d = DIR[team], tc = teams[team].cfg, spots = new Map();
    const mine = players.filter(p => p.team === team && !p.isGK), theirs = players.filter(p => p.team !== team && !p.isGK);
    const byXi = i => players.find(p => p.team === team && p.i === i);
    const nearest = () => mine.slice().sort((a, b) => a.pos.distanceTo(pos) - b.pos.distanceTo(pos))[0];
    const at = (xa, z) => new V3(clamp(xa, -HX + 1, HX - 1) * d, 0, clamp(z, -HZ + 1, HZ - 1));
    const sgn = Math.sign(pos.z) || 1, gxa = HX, distG = Math.hypot(d * HX - pos.x, pos.z), pxa = pos.x * d;
    if (kind === 'goalkick') R.taker = gkOf(team);
    else if (kind === 'penalty') R.taker = byXi(tc.takers.pk);
    else if (kind === 'corner') R.taker = byXi(tc.takers.ck);
    else if (kind === 'freekick') R.taker = pxa > 5 ? byXi(tc.takers.fk) : nearest();
    else R.taker = nearest();
    if (!R.taker || (R.taker.isGK && kind !== 'goalkick' && kind !== 'penalty')) R.taker = nearest();
    const tk = R.taker;
    const aerial = p => p.s.heading + p.s.jump * 0.5 + p.s.physical * 0.3;
    const marking = p => p.s.defAwa + p.s.heading * 0.5;
    if (kind === 'corner') {
      // into the box: forwards and midfielders by aerial ability, plus as many centre-backs as the team sends up
      const cbs = mine.filter(p => p.posCode === 'CB' && p !== tk).sort((a, b) => aerial(b) - aerial(a)).slice(0, tc.cbUp);
      const pool = mine.filter(p => p !== tk && (p.line === 'FW' || p.line === 'MF')).concat(cbs).sort((a, b) => aerial(b) - aerial(a));
      const box = [[gxa - 4.5, sgn * 3.2], [gxa - 5, -sgn * 4], [gxa - 10.5, 0], [gxa - 6.5, -sgn * 0.8]].map(([x, z]) => at(x, z));
      const inBox = pool.splice(0, 4);
      inBox.forEach((p, i) => spots.set(p, box[i]));
      if (pool[0]) spots.set(pool.shift(), at(gxa - 19, sgn * 3));
      if (pool[0]) spots.set(pool.shift(), at(gxa - 8, sgn * (HZ - 9)));
      const back = mine.filter(p => p !== tk && !spots.has(p));
      back.forEach((p, i) => spots.set(p, at(i < 2 ? -4 : 8, (i % 2 ? 1 : -1) * (i < 2 ? 9 : 14))));
      const defs = theirs.slice().sort((a, b) => marking(b) - marking(a));
      spots.set(defs.shift(), at(gxa - 0.8, sgn * 3.3));
      inBox.forEach((p, i) => { const q = defs.shift(); if (q) spots.set(q, at(box[i].x * d + 0.9, box[i].z * 0.9)); });
      const zone = [[gxa - 9, -sgn * 6], [gxa - 12, sgn * 5], [gxa - 17, 0], [gxa - 9, sgn * (HZ - 12)]];
      zone.forEach(([x, z]) => { const q = defs.shift(); if (q) spots.set(q, at(x, z)); });
      defs.forEach((q, i) => spots.set(q, at(gxa - 34 - i * 8, (i ? -1 : 1) * 6)));
    } else if (kind === 'penalty') {
      let i = 0;
      for (const p of mine.concat(theirs)) if (p !== tk) {       // everyone else outside the box and the arc
        const z = (Math.floor(i / 2) - 4.5) * 3.4 + (i % 2) * 1.2;
        spots.set(p, at(gxa - BOX_D - 1.5 - (i % 2) * 1.6 - (Math.abs(z) < 7 ? 3 : 0), z)); i++;
      }
    } else if (kind === 'freekick') {
      R.direct = distG < 31 && pxa > HX - 34;
      if (R.direct) {
        // the wall: 9.15 m away, covering the near post side
        const nWall = Math.abs(pos.z) > 17 ? 2 : distG < 24 ? 4 : 3;
        const gz = clamp(pos.z, -1, 1) * (GW / 2) * 0.55, ang = Math.atan2(gz - pos.z, d * HX - pos.x);
        const cx = pos.x + Math.cos(ang) * 9.15, cz = pos.z + Math.sin(ang) * 9.15;
        R.wall = theirs.slice().sort((a, b) => b.s.jump - a.s.jump).slice(0, nWall);
        R.wall.forEach((p, i) => spots.set(p, new V3(cx - Math.sin(ang) * (i - (nWall - 1) / 2) * 0.62, 0, cz + Math.cos(ang) * (i - (nWall - 1) / 2) * 0.62)));
      }
      if (pxa > HX - 45) {
        const pool = mine.filter(p => p !== tk && p.line !== 'DF').sort((a, b) => aerial(b) - aerial(a)).slice(0, 4);
        const far = -Math.sign(pos.z || 1);
        const line = Math.min(gxa - 13, Math.max(pxa + 2, gxa - 18));
        pool.forEach((p, i) => spots.set(p, at(line - (i % 2) * 1.5, far * (2 + i * 3.2) - (i === 3 ? far * 14 : 0))));
        const defs = theirs.filter(p => !spots.has(p)).sort((a, b) => marking(b) - marking(a));
        pool.forEach(p => { const q = defs.shift(), s = spots.get(p); if (q) spots.set(q, at(s.x * d + 1.2, s.z * 0.92)); });
      }
    }
    R.spots = spots;
  }
  function setupRestart() {
    const R = G.restart, { kind, team, pos } = R, d = DIR[team], tk = R.taker;
    ball.pos.copy(pos); ball.vel.set(0, 0, 0); ball.curl.set(0, 0, 0); ball.inGoal = false; ball.owner = null; ball.lastTeam = team;
    for (const [p, s] of R.spots) if (p.pos.distanceTo(s) > 5) { p.pos.copy(s); p.vel.set(0, 0, 0); }      // stragglers are placed
    for (const p of players) { p.skill = null; p.wind = null; p.tackleT = 0; p.stagger = Math.min(p.stagger, 0.2); p.runTarget = null; p.shield = false; p.dive = null; }
    const inward = new V3(-pos.x, 0, -pos.z).normalize();
    if (kind === 'throw') inward.set(d * 0.4, 0, -Math.sign(pos.z)).normalize();
    if (kind === 'penalty' || R.direct) inward.set(d * HX - pos.x, 0, -pos.z).normalize();
    if (kind === 'goalkick' || (kind === 'freekick' && !R.direct)) inward.set(d, 0, 0);
    tk.pos.set(pos.x - inward.x * 0.6, 0, pos.z - inward.z * 0.6); tk.vel.set(0, 0, 0);
    tk.facing = Math.atan2(inward.z, inward.x);
    if (kind === 'penalty') { const gk = gkOf(1 - team); gk.pos.set(d * (HX - 0.3), 0, 0); gk.vel.set(0, 0, 0); gk.facing = Math.atan2(0, -d); gk.dive = null; gk.stagger = 0; }
    setOwner(tk); teams[1 - team].lostAt = -99; tk.protect = 1.2; tk.holdT = 0;
    G.sp = { ...R, t: 0, wait: rand(1.4, 2.4) + (kind === 'penalty' ? 0.8 : 0), keepOut: kind === 'throw' ? 3 : kind === 'goalkick' ? 12 : 9.15 };
    G.restart = null; G.phase = 'setpiece';
    if (human >= 0) {
      if (team === human) setCtrl(tk);
      else if (kind === 'penalty') setCtrl(gkOf(human));
      if (kind === 'penalty') on('tag', team === human ? 'AIM WITH THE STICK · HOLD SHOOT' : 'PICK A SIDE WITH THE STICK');
      else if (R.direct && team === human) on('tag', 'FREE KICK · SHOOT OR PASS');
    }
    on('setpiece', kind, team);
  }
  function setPieceMove(p, dt) {
    const sp = G.sp || G.restart;
    if (p.dive) { updateDive(p, dt); return; }
    if (G.sp && p === sp.taker) {
      moveP(p, ZERO, 0, dt); p.vel.set(0, 0, 0);
      if (p === ctrl && sp.kind !== 'penalty' && inp.dir.lengthSq() > 0.04) p.facing += clamp(angDiff(p.facing, Math.atan2(inp.dir.z, inp.dir.x)), -5 * dt, 5 * dt);
      return;
    }
    if (p.stagger > 0) { p.vel.multiplyScalar(Math.max(0, 1 - 4 * dt)); return; }
    const s = sp.spots && sp.spots.get(p);
    if (s) { if (goTo(p, s, p.sprintSp * 1.25, dt, 0.25) < 0.6) faceTo(p, sp.pos, dt, 6); }
    else if (p.isGK) {
      if (sp.kind === 'penalty' && p.team !== sp.team) { moveP(p, ZERO, 0, dt); faceTo(p, sp.pos, dt); return; }
      const d = DIR[p.team]; goTo(p, tmpB.set(-d * (HX - 1.4), 0, clamp(sp.pos.z * 0.08, -2, 2)), p.jogSp, dt); faceTo(p, sp.pos, dt);
    } else {
      const tgt = formationTarget(p, formTmp);
      if (G.sp && p.team !== sp.team) {       // give the taker room
        const dx = tgt.x - sp.pos.x, dz = tgt.z - sp.pos.z, dd = Math.hypot(dx, dz) || 1;
        if (dd < sp.keepOut + 0.5) { tgt.x = sp.pos.x + dx / dd * (sp.keepOut + 0.5); tgt.z = sp.pos.z + dz / dd * (sp.keepOut + 0.5); }
      }
      goTo(p, tgt, p.jogSp * 1.2, dt, 0.5);
      if (p.vel.lengthSq() < 0.5) faceTo(p, sp.pos, dt, 5);
    }
    if (G.sp && p.team !== sp.team && !s) {
      const dx = p.pos.x - sp.pos.x, dz = p.pos.z - sp.pos.z, dd = Math.hypot(dx, dz);
      if (dd < sp.keepOut && dd > 0.01) { p.pos.x += dx / dd * (sp.keepOut - dd) * Math.min(1, 6 * dt); p.pos.z += dz / dd * (sp.keepOut - dd) * Math.min(1, 6 * dt); }
    }
  }
  /* The computer takes a set piece (also used when the person lets the clock run out). */
  function aiSetPiece() {
    const sp = G.sp, p = sp.taker, d = DIR[p.team], T = teams[p.team].T, xa = sp.pos.x * d;
    if (sp.kind === 'penalty') return doPenalty(p, rand(0.6, 0.9), null);
    if (sp.kind === 'freekick' && sp.direct && rnd() < 0.65) return doShot(p, rand(0.6, 0.9), 'fk', null);
    if (sp.kind === 'corner') { if (rnd() < 0.82) return doPass(p, 'loft', null, {}); const b = bestPassTarget(p, null, 'pass'); return b ? doPass(p, 'pass', null, { target: b.t }) : doPass(p, 'loft', null, {}); }
    if (sp.kind === 'freekick' && xa > HX - 45) { const b = bestPassTarget(p, null, 'loft', { inBox: true }); if (b) return doPass(p, 'loft', null, { target: b.t }); }
    if (sp.kind === 'goalkick' && T.passLen >= 0.3) { const l = bestPassTarget(p, null, 'loft', { forwardOnly: true }); if (l) return doPass(p, 'loft', null, { target: l.t }); }
    const b = bestPassTarget(p, null, 'pass', { maxD: sp.kind === 'throw' ? 22 : 0 });
    if (b && b.score > 0.2) return doPass(p, 'pass', null, { target: b.t });
    const l = bestPassTarget(p, null, 'loft', { maxD: sp.kind === 'throw' ? 22 : 0 });
    return doPass(p, l ? 'loft' : 'pass', null, l ? { target: l.t } : b ? { target: b.t } : {});
  }
  function userSetPiece(a, hint) {
    const sp = G.sp, p = sp.taker;
    if (a === 'shoot') {
      const pw = clamp(inp.charge, 0.05, 1.08); inp.charging = false;
      if (sp.kind === 'penalty') doPenalty(p, pw, hint);
      else if (sp.direct) doShot(p, pw, 'fk', hint);
      else if (Math.hypot(DIR[p.team] * HX - p.pos.x, p.pos.z) < 40 && sp.kind === 'freekick') doShot(p, pw, 'power', hint);
      else doPass(p, 'loft', hint, {});
    } else if (sp.kind !== 'penalty' && PASS_KINDS.has(a)) doPass(p, a, hint, {});
  }
  function setupKickoff(team) {
    G.phase = 'kickoff'; G.timer = 1.6; G.kickoffTeam = team; G.sp = null; G.restart = null; G.queued = null; G.oneTwo = null;
    ball.inGoal = false; ball.owner = null; ball.vel.set(0, 0, 0); ball.curl.set(0, 0, 0); ball.pos.set(0, BR, 0); ball.intended = null; ball.offs = null; ball.block = null;
    for (const p of players) {
      const d = DIR[p.team];
      let xa = clamp(-14 + (p.fx + 0.42) * HX * 0.62, -HX + 1.5, -1.2);
      if (p.isGK) xa = -HX + 1.2;
      p.pos.set(xa * d, 0, p.fz * d * HZ * 0.7); p.vel.set(0, 0, 0); p.facing = d > 0 ? 0 : Math.PI;
      p.skill = null; p.dive = null; p.stagger = 0; p.tackleT = 0; p.celebrate = 0; p.runTarget = null; p.burst = 0; p.wind = null; p.shield = false; p.shieldT = 0; p.wallT = 0;
    }
    const adv = t => players.filter(p => p.team === t && !p.isGK).sort((a, b) => (b.fx - a.fx) || (Math.abs(a.fz) - Math.abs(b.fz)));
    const [striker, mate] = adv(team), d = DIR[team];
    striker.pos.set(-0.35 * d, 0, 0); mate.pos.set(-2.5 * d, 0, 3);
    for (const p of players) if (p.team !== team && Math.hypot(p.pos.x, p.pos.z) < 9.3) p.pos.x = -9.6 * DIR[p.team];
    setOwner(striker); striker.protect = 1.5; teams[0].lostAt = teams[1].lostAt = -99;
    if (human >= 0 && team !== human) setCtrl(adv(human)[0]);
    ball.lastTeam = team;
  }

  // ------------------------------------------------------------------ one step of the match
  function step(dt) {
    G.now += dt;
    for (const p of players) {
      p.kickCd -= dt; p.stagger = Math.max(0, p.stagger - dt); p.evade = Math.max(0, p.evade - dt); p.tackleCd -= dt; p.skillCd -= dt;
      p.burst = Math.max(0, p.burst - dt); p.kickAnim = Math.max(0, p.kickAnim - dt); p.headAnim = Math.max(0, p.headAnim - dt);
      p.celebrate = Math.max(0, p.celebrate - dt); p.runT -= dt; p.aiT -= dt; p.protect = Math.max(0, p.protect - dt);
      p.wallT = Math.max(0, p.wallT - dt); p.link = Math.max(0, p.link - dt); p.plant = Math.max(0, p.plant - dt);
      if (p.tackleT > 0) { p.tackleT -= dt; if (G.phase === 'play') resolveTackle(p); if (p.tackleT <= 0 && !p.tackleDone) p.stagger = Math.max(p.stagger, p.slide ? 0.7 : 0.25); }
      if (p !== ctrl && ball.owner !== p) p.shield = false;
    }
    for (const tm of teams) { tm.trapT -= dt; tm.trapCd -= dt; tm.pressT -= dt; tm.pressCd -= dt; tm.rushT -= dt; }
    if (G.oneTwo) { G.oneTwo.t -= dt; if (G.oneTwo.t <= 0) G.oneTwo = null; }
    if (G.queued) { G.queued.t -= dt; if (G.queued.t <= 0) G.queued = null; }
    if (G.hold) { G.hold.t -= dt; if (G.hold.t <= 0 || ball.owner || G.phase !== 'play') G.hold = null; }

    if (G.phase === 'play') {
      G.clock += dt;
      if (ball.owner) G.stats.poss[ball.owner.team] += dt;
      if (!G.ht && G.clock >= S.len / 2) {
        G.ht = true; G.phase = 'ht'; G.timer = 2.8; inp.charging = false;
        for (const p of players) p.fit = Math.min(1, p.fit + 0.1);
        on('halftime');
      } else if (G.clock >= S.len) { G.phase = 'ft'; inp.charging = false; on('fulltime'); return; }
    } else if (G.phase === 'kickoff') { G.timer -= dt; if (G.timer <= 0) { G.phase = 'play'; on('whistle', 0.3, 1); } }
    else if (G.phase === 'restart') { G.timer -= dt; if (G.timer <= 0) setupRestart(); }
    else if (G.phase === 'setpiece') {
      const sp = G.sp; sp.t += dt;
      if (ball.owner !== sp.taker) { G.phase = 'play'; G.sp = null; }
      else if (sp.t > (sp.taker.team === human ? 12 : sp.wait)) aiSetPiece();
    }
    else if (G.phase === 'goal') { G.timer -= dt; if (G.timer <= 0) setupKickoff(ball.pos.x > 0 ? 1 : 0); }
    else if (G.phase === 'ht') { G.timer -= dt; if (G.timer <= 0) setupKickoff(1); }

    const mode = computeMode();
    if (mode !== G.mode) { G.mode = mode; on('mode', mode); }
    roleT -= dt;
    if (roleT <= 0) {
      roleT = 0.12; assignRoles(); autoSwitch();
      for (const p of players) refresh(p);
      for (const tm of teams) { linkTick(tm, 0.12); if (tm.t !== human && G.phase === 'play') aiManager(tm, 0.12); }
    }

    for (const p of players) {
      if (G.phase === 'kickoff' || (G.phase === 'goal' && p.celebrate <= 0)) moveP(p, ZERO, 0, dt);
      else if (G.phase === 'goal') goTo(p, tmpB.set(DIR[p.team] * (HX - 8), 0, Math.sign(p.pos.z || 1) * 20), p.jogSp, dt);
      else if (G.phase === 'restart' || G.phase === 'setpiece') setPieceMove(p, dt);
      else if (p.skill) updateSkill(p, dt);
      else if (p.stagger > 0) p.vel.multiplyScalar(Math.max(0, 1 - 4 * dt));
      else if (p.tackleT > 0) p.vel.multiplyScalar(Math.max(0, 1 - (p.slide ? 1.6 : 6) * dt));
      else if (p.wind) {
        p.vel.multiplyScalar(Math.max(0, 1 - 7 * dt)); p.wind.t -= dt;
        if (ball.owner !== p) p.wind = null;
        else if (p.wind.t <= 0) { const fn = p.wind.fn; p.wind = null; fn(nearestOpp(p).d < 1.5); }
      }
      else if (p === ctrl && G.phase === 'play' && !(p.isGK && ball.owner !== p)) userUpdate(dt);
      else aiPlayer(p, dt);
      integrate(p, dt);
    }
    separate();
    if (inp.charging) {
      if (ball.owner !== ctrl || G.mode !== 'attack') inp.charging = false;
      else inp.charge = Math.min(1.08, inp.charge + dt / 0.95);
    }
    if (G.phase !== 'ht' && G.phase !== 'ft') {
      if (G.phase === 'play') checkPickups();
      updateBall(dt);
      if (ball.inGoal) netConstrain();
    }
  }

  setupKickoff(0);
  return {
    G, ball, players, teams, inp, S, human, step, press, release, skillInput, leftDouble,
    get ctrl() { return ctrl; },
    lever: (name, arg) => { if (human >= 0 && live()) teamLever(human, name, arg); },
    /* for tests and debugging */
    dbg: { setOwner, doShot, doPass, startSkill, foul, outOfPlay, formationTarget, teamLever, kick, n, has, shoulderCharge, quickStop, tryTackle },
  };
}
