/* Flick Football physics core. Units: cm, g, s. x = pitch length, z = pitch width, y = up. */
(function (root) {
'use strict';
const G = 981;
const C = {
  L: 120, W: 80, HL: 60, HW: 40, margin: 8,
  br: 1.0, bt: 0.3, bm: 1.0, bk: 0.5,      // ball: a flat 20 mm shirt button, 3 mm thick; glides flat, never lifts
  pr: 1.6, ph: 0.8, pbv: 0.3, pm: 2.8,     // bottle cap: radius, height, bevel, mass (hammered crown cap)
  kr: 1.7, kt: 0.3, kh: 3.4, kbv: 0.3, kw: 1.5,  // kw: half-width of the keeper's bent foot, the part a flat button meets     // keeper: an unflattened cap standing on its bent edge, facing the pitch (radius, half-thickness)
  gw: 14, gh: 4.0, gd: 5, postR: 0.4,     // goal mouth width, height, depth, post radius
  boxD: 18, boxHW: 22,                    // penalty area depth and half width
  muP: 0.27,                              // metal cap sliding on the table (was 0.3: a cap travels ~11% further for the same hit)
  muB: 0.18, muSpin: 200, kS: 2.5e-3,     // button sliding friction, spin decay (rad/s^2), spin bend (curling-stone effect)
  eWall: 0.55,                            // solid wooden side rails
  eGround: 0.5, ePlayer: 0.64, eKeeper: 0.55, ePost: 0.68, eNet: 0.12, ePP: 0.7,   // ePlayer: cap meets button, a touch livelier (was 0.6)
  muBP: 0.38, muPost: 0.2,
  kd: 4e-4, kM: 1.2e-3,                 // quadratic drag, Magnus coefficient
  kMaxV: 95, kDragV: 120, kAcc: 900, kBrake: 1400, sixD: 8, sixHW: 14, diveV: 80, diveT: 0.3, diveCD: 0.9
};
/* Deterministic across browsers: only + - * / and sqrt (IEEE-754 correctly rounded) feed the simulation.
   Math.hypot, exp, sin, cos and atan2 can differ in the last bit between JS engines, and a flick game is chaotic
   enough that one bit grows into a different result, so they are kept out of anything both players simulate. */
const hyp = (a, b, c) => c === undefined ? Math.sqrt(a * a + b * b) : Math.sqrt(a * a + b * b + c * c), clamp = (v, a, b) => v < a ? a : v > b ? b : v;

function createWorld() {
  return {
    t: 0, ev: [], players: [],
    ball: { x: 0, y: C.bt / 2, z: 0, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, inNet: 0, lastTouch: null }
  };
}
function makePlayer(id, team, kind, x, z) {
  return { id, team, kind, x, z, y: 0, vx: 0, vz: 0, vy: 0, face: team === 0 ? 0 : Math.PI, strike: null,
           homeX: x, ctl: { dir: 0, dive: 0 }, diving: false, diveT: 0, diveCD: 0, num: 0 };
}

/* ---------- ball contact resolution (shared by every obstacle) ---------- */
function resolveBall(w, b, n, pen, vo, mo, e, mu, tag) {
  // n: unit normal from obstacle to ball; vo: obstacle velocity {x,y,z}; mo: mass (Infinity = static)
  const r = C.br, mb = C.bm, I = C.bk * mb * r * r;
  b.x += n.x * pen; b.y += n.y * pen; b.z += n.z * pen;
  const rvx = b.vx - vo.x, rvy = b.vy - vo.y, rvz = b.vz - vo.z;
  const vn = rvx * n.x + rvy * n.y + rvz * n.z;
  if (vn >= 0) return 0;
  const imo = mo === Infinity ? 0 : 1 / mo;
  const jn = -(1 + e) * vn / (1 / mb + imo);
  b.vx += jn * n.x / mb; b.vy += jn * n.y / mb; b.vz += jn * n.z / mb;
  if (imo) { vo.x -= jn * n.x * imo; vo.y -= jn * n.y * imo; vo.z -= jn * n.z * imo; }
  // contact-point slip -> Coulomb friction and spin
  const rcx = -n.x * r, rcy = -n.y * r, rcz = -n.z * r;
  const cx = b.vx + (b.wy * rcz - b.wz * rcy) - vo.x;
  const cy = b.vy + (b.wz * rcx - b.wx * rcz) - vo.y;
  const cz = b.vz + (b.wx * rcy - b.wy * rcx) - vo.z;
  const dn = cx * n.x + cy * n.y + cz * n.z;
  const tx = cx - dn * n.x, ty = cy - dn * n.y, tz = cz - dn * n.z;
  const s = hyp(tx, ty, tz);
  if (s > 1e-4) {
    const ux = tx / s, uy = ty / s, uz = tz / s;
    const jt = Math.min(mu * jn, s / ((1 + 1 / C.bk) / mb + imo));
    b.vx -= jt * ux / mb; b.vy -= jt * uy / mb; b.vz -= jt * uz / mb;
    if (imo) { vo.x += jt * ux * imo; vo.y += jt * uy * imo; vo.z += jt * uz * imo; }
    const fx = -jt * ux, fy = -jt * uy, fz = -jt * uz;
    b.wx += (rcy * fz - rcz * fy) / I; b.wy += (rcz * fx - rcx * fz) / I; b.wz += (rcx * fy - rcy * fx) / I;
  }
  if (tag) w.ev.push({ k: tag, jn });
  return jn;
}

/* ---------- ball vs bottle cap ----------
   The cap is a low disc: a vertical side wall, a 45° bevel, then the flat top. The contact normal comes from the
   closest point on that profile, so a ball whose centre sits above the side wall is struck by the bevel and lifts. */
function ballDisc(w, b, o, mass, e, mu, tilt, tag, who) {
  const dx = b.x - o.x, dz = b.z - o.z, rho = hyp(dx, dz), qy = b.y - o.y0, r = C.br;
  if (rho > o.R + r || qy > o.H + r) return false;
  const R = o.R, Hh = o.H, bv = Math.min(o.bv, Hh * 0.6);
  const S = [[R, 0, R, Hh - bv], [R, Hh - bv, R - bv, Hh], [R - bv, Hh, 0, Hh]];
  let best = 1e9, cr = 0, cy = 0;
  for (const s of S) {
    const ex = s[2] - s[0], ey = s[3] - s[1], t = clamp(((rho - s[0]) * ex + (qy - s[1]) * ey) / (ex * ex + ey * ey), 0, 1);
    const px = s[0] + ex * t, py = s[1] + ey * t, d = hyp(rho - px, qy - py);
    if (d < best) { best = d; cr = px; cy = py; }
  }
  const inside = rho < R && qy < Hh && qy > 0 && rho + qy < R + Hh - bv;
  let nr, ny, pen;
  if (inside) { nr = cr - rho; ny = cy - qy; const l = hyp(nr, ny) || 1; nr /= l; ny /= l; pen = r + best; }
  else {
    if (best >= r) return false;
    nr = rho - cr; ny = qy - cy; const l = hyp(nr, ny);
    if (l < 1e-6) { nr = 1; ny = 0; } else { nr /= l; ny /= l; }
    pen = r - best;
  }
  const ux = rho > 1e-6 ? dx / rho : 1, uz = rho > 1e-6 ? dz / rho : 0;
  const nx = ux * nr, nz = uz * nr;
  let n = { x: nx, y: ny, z: nz };
  if (tilt && tilt.loft > Math.asin(clamp(ny, -1, 1)) && ny > -0.3) {   // extra loft from the flick: dig the bevel under the ball
    const hh = hyp(nx, nz) || 1, ca = Math.cos(tilt.loft), sa = Math.sin(tilt.loft);
    n = { x: nx / hh * ca, y: sa, z: nz / hh * ca };
  }
  const vo = { x: o.vx, y: o.vy, z: o.vz };
  b.x += nx * pen; b.y += ny * pen; b.z += nz * pen;
  const jn = resolveBall(w, b, n, 0, vo, mass, e, mu, null);
  if (jn > 0) {
    o.vx = vo.x; o.vz = vo.z; w.ev.push({ k: tag, id: who, jn });
    if (tilt && tilt.curl) b.wy -= tilt.curl * 1.8 * hyp(b.vx, b.vz) / C.br;   // brushed sidespin (curl>0 bends right)
  }
  return true;
}
/* ---------- ball vs standing keeper ----------
   The keeper is a cap standing on edge: a solid disc whose axis points along the pitch (x). It is held in place,
   so it does not give way; it deflects the ball off its face or rim. */
function ballKeeper(w, b, k) {
  const qz = k.z + clamp(b.z - k.z, -C.kw, C.kw), dx = b.x - k.x, dz = b.z - qz, d = hyp(dx, dz), lim = C.br + C.kt;
  if (d >= lim) return false;
  const n = d > 1e-6 ? { x: dx / d, y: 0, z: dz / d } : { x: Math.sign(dx) || 1, y: 0, z: 0 };
  const jn = resolveBall(w, b, n, lim - d, { x: k.vx || 0, y: 0, z: k.vz || 0 }, Infinity, C.eKeeper, C.muBP, null);
  if (jn > 0) w.ev.push({ k: 'kb', id: k.id, jn });
  return jn > 0;                       // only a real knock counts as a touch, not a graze while moving apart
}
/* ---------- ball vs static capsule (posts, crossbar) ---------- */
function ballCap(w, b, ax, ay, az, bx, by, bz, rad) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const t = clamp(((b.x - ax) * abx + (b.y - ay) * aby + (b.z - az) * abz) / (abx * abx + aby * aby + abz * abz), 0, 1);
  const qx = ax + abx * t, qy = ay + aby * t, qz = az + abz * t;
  let nx = b.x - qx, ny = b.y - qy, nz = b.z - qz; const dist = hyp(nx, ny, nz), lim = C.br + rad;
  if (dist >= lim) return;
  if (dist < 1e-6) { nx = 0; ny = 1; nz = 0; } else { nx /= dist; ny /= dist; nz /= dist; }
  resolveBall(w, b, { x: nx, y: ny, z: nz }, lim - dist, { x: 0, y: 0, z: 0 }, Infinity, C.ePost, C.muPost, 'post');
  b.lastPost = w.t;
}

/* ---------- ball integration ---------- */
function ballStep(w, dt) {
  // The button stays flat on the table: 2D sliding with Coulomb friction, plus a little bend from spin.
  const b = w.ball, r = C.br;
  b.y = C.bt / 2; b.vy = 0; b.wx = 0; b.wz = 0;
  if (b.vx || b.vz) {
    b.vx += C.kS * b.wy * b.vz * dt; b.vz -= C.kS * b.wy * b.vx * dt;
    const s = hyp(b.vx, b.vz), ns = Math.max(0, s - C.muB * G * dt);
    if (ns < 0.5) { b.vx = b.vz = 0; } else { b.vx *= ns / s; b.vz *= ns / s; }
  }
  const dw = C.muSpin * dt; b.wy = Math.abs(b.wy) <= dw ? 0 : b.wy - Math.sign(b.wy) * dw;
  b.x += b.vx * dt; b.z += b.vz * dt;
  /* goal posts: round uprights the flat button can strike */
  for (const s of [-1, 1]) for (const sz of [-1, 1]) {
    const dx = b.x - s * C.HL, dz = b.z - sz * C.gw / 2, d = hyp(dx, dz), lim = r + C.postR;
    if (d < lim && d > 1e-6) { resolveBall(w, b, { x: dx / d, y: 0, z: dz / d }, lim - d, { x: 0, y: 0, z: 0 }, Infinity, C.ePost, C.muPost, 'post'); b.lastPost = w.t; }
  }
  /* net */
  if (!b.inNet && Math.abs(b.x) > C.HL + r && Math.abs(b.z) < C.gw / 2) { b.inNet = Math.sign(b.x); w.ev.push({ k: 'net' }); }
  if (b.inNet) {
    const s = b.inNet, hw = C.gw / 2 - r, back = C.HL + C.gd - r;
    const damp = dt === H ? NET_DAMP : Math.exp(-3 * dt); b.vx *= damp; b.vz *= damp;
    if (s * b.x > back) { b.x = s * back; b.vx *= -C.eNet; }
    if (b.z > hw) { b.z = hw; b.vz *= -C.eNet; }
    if (b.z < -hw) { b.z = -hw; b.vz *= -C.eNet; }
  }
  /* solid side rails */
  const mx = C.HL + C.margin - r, mz = C.HW + C.margin - r;
  if (Math.abs(b.x) > mx) { b.x = Math.sign(b.x) * mx; if (b.vx * Math.sign(b.x) > 0) { w.ev.push({ k: 'wall', v: Math.abs(b.vx), ball: true, x: b.x, z: b.z }); b.vx *= -C.eWall; } }
  if (Math.abs(b.z) > mz) { b.z = Math.sign(b.z) * mz; if (b.vz * Math.sign(b.z) > 0) { w.ev.push({ k: 'wall', v: Math.abs(b.vz), ball: true, x: b.x, z: b.z }); b.vz *= -C.eWall; } }
}
/* ---------- button vs cap: both flat on the table, so contact is edge to edge ---------- */
function ballFlat(w, b, a, strike) {
  const dx = b.x - a.x, dz = b.z - a.z, d = hyp(dx, dz), lim = C.br + C.pr;
  if (d >= lim || d < 1e-6) return false;
  const vo = { x: a.vx, y: 0, z: a.vz };
  const jn = resolveBall(w, b, { x: dx / d, y: 0, z: dz / d }, lim - d, vo, C.pm, C.ePlayer, C.muBP, null);
  if (jn > 0) {
    a.vx = vo.x; a.vz = vo.z; w.ev.push({ k: 'pb', id: a.id, jn });
    if (strike && strike.curl) b.wy -= strike.curl * 0.6 * hyp(b.vx, b.vz) / C.br;   // flick spin: curl > 0 bends right
  }
  return jn > 0;                       // only a real knock counts as a touch, not a graze while moving apart
}
function stepKeeper(w, k, dt) {
  // The keeper may stand anywhere in the six-yard box. Keys slide it across the goal; a drag target moves it in x and z.
  const c = k.ctl, s = Math.sign(k.homeX) || 1;
  if (!k.diving) {
    k.y = 0; if (k.diveCD > 0) k.diveCD -= dt;
    if (c.dive && k.diveCD <= 0) { k.vz = c.dive * C.diveV; k.vx = 0; k.diving = true; k.diveT = 0; c.dive = 0; }
    else {
      c.dive = 0;
      let tvx = 0, tvz = c.dir * C.kMaxV;
      if (c.tx != null && !c.dir) {
        const dx = c.tx - k.x, dz = c.tz - k.z, d = hyp(dx, dz);
        if (d > 0.25) { const sp = Math.min(C.kDragV, d * 9); tvx = dx / d * sp; tvz = dz / d * sp; }
      }
      const ax = (Math.abs(tvx) > 0.1 ? C.kAcc : C.kBrake) * dt, az = (Math.abs(tvz) > 0.1 ? C.kAcc : C.kBrake) * dt;
      k.vx = (k.vx || 0) + clamp(tvx - (k.vx || 0), -ax, ax); k.vz += clamp(tvz - k.vz, -az, az);
    }
  } else {                                       // body flies sideways along the ground; y is only for the view
    k.diveT += dt; k.y = 0;
    if (k.diveT >= C.diveT) { k.diving = false; k.y = 0; k.diveCD = C.diveCD; k.vz *= 0.15; }
  }
  k.x += (k.vx || 0) * dt; k.z += k.vz * dt;
  const xIn = s * (C.HL - 1.6), xOut = s * (C.HL - C.sixD + 0.8), lo = Math.min(xIn, xOut), hi = Math.max(xIn, xOut);
  const zl = C.sixHW - 0.8 + (k.diving ? 2 : 0);
  if (k.x < lo) { k.x = lo; k.vx = 0; } if (k.x > hi) { k.x = hi; k.vx = 0; }
  if (Math.abs(k.z) > zl) { k.z = Math.sign(k.z) * zl; k.vz = 0; }
}
function stepPlayer(w, p, dt) {
  if (p.off) return;
  if (p.kind === 'k') return stepKeeper(w, p, dt);
  p.x += p.vx * dt; p.z += p.vz * dt;
  const s = hyp(p.vx, p.vz);
  if (s > 0) {
    const ns = Math.max(0, s - C.muP * G * dt);
    p.vx *= ns / s; p.vz *= ns / s;
    if (ns < 0.8) { p.vx = p.vz = 0; }
    if (s > 15) p.face = Math.atan2(p.vz, p.vx);
  }
  const mx = C.HL + C.margin - C.pr, mz = C.HW + C.margin - C.pr;       // solid side rails
  if (Math.abs(p.x) > mx) { p.x = Math.sign(p.x) * mx; if (p.vx * Math.sign(p.x) > 0) { w.ev.push({ k: 'wall', v: Math.abs(p.vx), id: p.id, x: p.x, z: p.z }); p.vx *= -C.eWall; } }
  if (Math.abs(p.z) > mz) { p.z = Math.sign(p.z) * mz; if (p.vz * Math.sign(p.z) > 0) { w.ev.push({ k: 'wall', v: Math.abs(p.vz), id: p.id, x: p.x, z: p.z }); p.vz *= -C.eWall; } }
}
function collidePlayers(w) {
  const ps = w.players, b = w.ball;
  for (let i = 0; i < ps.length; i++) {
    const a = ps[i], ra = a.kind === 'k' ? C.kr : C.pr;
    if (a.off) continue;
    // posts as static discs
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      if (a.kind === 'k') break;
      const dx = a.x - sx * C.HL, dz = a.z - sz * C.gw / 2, d = hyp(dx, dz), lim = ra + C.postR;
      if (d < lim && d > 1e-6) {
        const nx = dx / d, nz = dz / d; a.x += nx * (lim - d); a.z += nz * (lim - d);
        const vn = a.vx * nx + a.vz * nz; if (vn < 0) { a.vx -= 1.4 * vn * nx; a.vz -= 1.4 * vn * nz; }
      }
    }
    for (let j = i + 1; j < ps.length; j++) {
      const c = ps[j], rc = c.kind === 'k' ? C.kr : C.pr;
      if (c.off) continue;
      if (a.kind === 'k' && c.kind === 'k') continue;
      if (a.kind === 'k' || c.kind === 'k') {
        const K = a.kind === 'k' ? a : c, Q = K === a ? c : a;
        const qz = K.z + clamp(Q.z - K.z, -C.kw, C.kw), ddx = Q.x - K.x, ddz = Q.z - qz, dd = hyp(ddx, ddz), lim = C.pr + C.kt;
        if (dd < lim && dd > 1e-6) {
          const nx = ddx / dd, nz = ddz / dd; Q.x += nx * (lim - dd); Q.z += nz * (lim - dd);
          const vn = (Q.vx - (K.vx || 0)) * nx + (Q.vz - (K.vz || 0)) * nz;
          if (vn < 0) { Q.vx -= (1 + C.ePP) * vn * nx; Q.vz -= (1 + C.ePP) * vn * nz; w.ev.push({ k: 'pp', a: a.id, b: c.id, v: -vn }); }
        }
        continue;
      }
      const dx = a.x - c.x, dz = a.z - c.z, d = hyp(dx, dz), lim = ra + rc;
      if (d >= lim || d < 1e-6) continue;
      const nx = dx / d, nz = dz / d, pen = lim - d;
      const ma = a.kind === 'k' ? Infinity : C.pm, mc = c.kind === 'k' ? Infinity : C.pm;
      const ia = ma === Infinity ? 0 : 1 / ma, ic = mc === Infinity ? 0 : 1 / mc, tot = ia + ic;
      a.x += nx * pen * ia / tot; a.z += nz * pen * ia / tot; c.x -= nx * pen * ic / tot; c.z -= nz * pen * ic / tot;
      const vn = (a.vx - c.vx) * nx + (a.vz - c.vz) * nz;
      if (vn < 0) {
        const j2 = -(1 + C.ePP) * vn / tot;
        a.vx += j2 * nx * ia; a.vz += j2 * nz * ia; c.vx -= j2 * nx * ic; c.vz -= j2 * nz * ic;
        w.ev.push({ k: 'pp', a: a.id, b: c.id, v: -vn });
      } else if (pen > 0.05) w.ev.push({ k: 'pp', a: a.id, b: c.id, v: 0 });
    }
    // ball
    const isK = a.kind === 'k';
    let hit;
    const o = { x: a.x, z: a.z, y0: 0, H: C.ph, bv: C.pbv, R: C.pr, vx: a.vx, vy: a.vy, vz: a.vz };
    if (isK) hit = ballKeeper(w, b, a);
    else hit = ballFlat(w, b, a, a.strike && !a.strike.touched ? a.strike : null);
    if (hit && !isK) { a.vx = o.vx; a.vz = o.vz; if (a.strike) a.strike.touched = true; }
    if (hit) b.lastTouch = { team: a.team, id: a.id, t: w.t };
  }
}

function step(w, dt) {
  for (const p of w.players) stepPlayer(w, p, dt);
  ballStep(w, dt);
  collidePlayers(w);
  w.t += dt;
}
/* One game tick is a fixed 1/60 s of 8 substeps, so every machine runs exactly the same arithmetic. */
const H = 1 / 480, SUB = 8, TICK = SUB * H, NET_DAMP = 0.9937694906233947;   // NET_DAMP = exp(-3 * H), written out
function advance(w) { for (let i = 0; i < SUB; i++) step(w, H); }
function flick(w, p, dx, dz, speed, loft, curl) {
  const m = hyp(dx, dz) || 1;
  p.vx = dx / m * speed; p.vz = dz / m * speed; p.face = Math.atan2(dz, dx);
  p.strike = { loft: loft || 0, curl: curl || 0, touched: false, t: w.t, firstHit: null };
}
function atRest(w) {
  // Keepers are steered by people or the computer and never count as "still moving".
  const b = w.ball;
  if (hyp(b.vx, b.vz) > 4) return false;
  for (const p of w.players) { if (p.off || p.kind === 'k') continue; if (hyp(p.vx, p.vz) > 2.5) return false; }
  return true;
}

const API = { C, G, TICK, hyp, createWorld, makePlayer, step, advance, flick, atRest };
if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.Phys = API;
})(typeof self !== 'undefined' ? self : this);

