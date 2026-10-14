/* Flick Football canvas view: used when WebGL 3D cannot start. A small software camera draws the table in
   perspective, so presets, tilt, turn and zoom behave the same as in the 3D view. Same interface as View. */
(function (root) {
'use strict';
const C = root.Phys.C, V = { preset: 'broadcast', is2D: true };
const hyp = Math.hypot, PI = Math.PI;
let cv, g, G = null, cont, W = 800, H = 500, dpr = 1, hover = -1, aim = null, shake = 0, boxSide = 0, zone = null, conf = [];
const cam = { az: 0, el: 1.1, dist: 168, tx: 0, tz: 0, ty: 0 }, goal = Object.assign({}, cam);
const PRESET = { top: { el: 1.55, dist: 150 }, broadcast: { el: 1.1, dist: 168 }, low: { el: 0.42, dist: 165 }, behind: { el: 0.72, dist: 118 }, ball: { el: 0.62, dist: 62 } };
const EL_MIN = 0.16, EL_MAX = 1.55, D_MIN = 40, D_MAX = 300, NEAR = 3;
let P = [0, 0, 0], Rv = [1, 0, 0], Uv = [0, 1, 0], Fv = [0, 0, -1], focal = 500, ccx = 400, ccy = 250;
const refS = { x: 0, z: -(C.HW + 4), face: PI / 2, anim: null, arm: 0, armL: 0 };
const REFKIT = { a: '#17191c', b: '#f5c400', shorts: '#17191c', socks: '#17191c', pattern: 'solid' };
const SKIN = ['#f1c9a5', '#d9a47a', '#a56b45', '#6b4328', '#e8b98f'], HAIR = ['#1a1412', '#3a2616', '#7a5232', '#0f0f10', '#b88a4a'];
// ball panel centres: the 12 vertices of an icosahedron, rotated with the ball's spin
const PHI = (1 + Math.sqrt(5)) / 2;
let spots = [[-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0], [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI], [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1]]
  .map(v => { const l = hyp(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; });

/* ---------- setup ---------- */
V.init = function (el) {
  cont = el; cv = document.createElement('canvas'); cv.style.display = 'block'; cv.style.touchAction = 'none';
  el.appendChild(cv); g = cv.getContext('2d'); window.addEventListener('resize', V.resize); V.resize();
};
V.attach = function (game) { G = game; V.setPreset(V.preset, true); };
V.dispose = function () { window.removeEventListener('resize', V.resize); if (cv) cv.remove(); cv = null; };
V.resize = function () {
  if (!cv) return; W = cont.clientWidth || 800; H = cont.clientHeight || 500; dpr = Math.min(V.scaleCap || 1.5, window.devicePixelRatio || 1);
  cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px';
  if (FIT[V.preset]) goal.dist = Math.min(D_MAX, Math.max(PRESET[V.preset].dist * 0.8, fitDist(goal.el, W / H, portrait() ? 52 : 36)));
  const pt = portrait();                                  // turned phone: table the right way round again
  if (lastPortrait !== null && pt !== lastPortrait && (V.preset === 'top' || V.preset === 'broadcast' || V.preset === 'low')) V.setPreset(V.preset);
  lastPortrait = pt;
};
let lastPortrait = null;
const portrait = () => W / H < 0.9;

/* ---------- camera (same behaviour as the 3D view) ---------- */

/* Distance at which the whole table fits the board area for the preset views. */
function fitDist(el, aspect, vfovDeg) {
  const port = aspect < 0.9, v = vfovDeg * Math.PI / 180, h = 2 * Math.atan(Math.tan(v / 2) * aspect);
  const extH = (port ? C.HW : C.HL) + C.margin + 8, extV = ((port ? C.HL : C.HW) + C.margin + 9) * Math.sin(el) + 4 * Math.cos(el);
  return Math.max(extH / Math.tan(h / 2), extV / Math.tan(v / 2)) / (port ? 1.5 : 1) * 1.12;
}
const FIT = { broadcast: 1, low: 1, top: 1 };
V.setPreset = function (name, snap) {
  V.preset = name;
  if (PRESET[name]) Object.assign(goal, PRESET[name]);
  if (name === 'play' && V.play) { const q = V.play; Object.assign(goal, { az: q.az, el: q.el, dist: q.dist, tx: q.tx, tz: q.tz, ty: 0 }); }
  if (name === 'top' || name === 'broadcast' || name === 'low') goal.az = (portrait() ? -PI / 2 : 0) + (V.flip || 0);
  if (FIT[name]) goal.dist = Math.min(D_MAX, Math.max(PRESET[name].dist * 0.8, fitDist(goal.el, W / H, portrait() ? 52 : 36)));
  if (snap) Object.assign(cam, goal);
};
/* The best view for a set piece, worked out by the game: { az, el, dist, tx, tz }. */
V.setPlay = function (v) { V.play = v; V.setPreset('play'); };
V.orbit = function (daz, del) { if (daz) { V.preset = 'free'; goal.az += daz; } goal.el = Math.max(EL_MIN, Math.min(EL_MAX, goal.el + del)); };
V.zoom = function (f) { goal.dist = Math.max(D_MIN, Math.min(D_MAX, goal.dist * f)); };
V.getCam = function () { return { tilt: (goal.el - EL_MIN) / (EL_MAX - EL_MIN), turn: Math.atan2(Math.sin(goal.az), Math.cos(goal.az)), zoom: (goal.dist - D_MIN) / (D_MAX - D_MIN) }; };
V.setCam = function (o) {
  if (o.tilt != null) goal.el = EL_MIN + o.tilt * (EL_MAX - EL_MIN);
  if (o.zoom != null) goal.dist = D_MIN + o.zoom * (D_MAX - D_MIN);
  if (o.turn != null) { V.preset = 'free'; let d = o.turn - goal.az; d = Math.atan2(Math.sin(d), Math.cos(d)); goal.az += d; }
};
V.getAz = function () { return cam.az; };
/* The camera has reached where it is going (the game draws less often while nothing moves). */
V.settled = function () { let da = goal.az - cam.az; da = Math.atan2(Math.sin(da), Math.cos(da)); return Math.abs(da) < 1e-3 && Math.abs(goal.el - cam.el) < 1e-3 && Math.abs(goal.dist - cam.dist) < 0.05 && Math.abs(goal.tx - cam.tx) < 0.05 && Math.abs(goal.tz - cam.tz) < 0.05 && shake < 0.01 && !conf.length; };
V.setHover = function (id) { hover = id; }; V.shake = function (a) { shake = Math.max(shake, a); };
V.canvas = function () { return cv; };
V.setBoxHint = function (s) { boxSide = s || 0; }; V.setZoneHint = function (Z) { zone = Z || null; };
V.setAim = function (x, z, dx, dz, power, color) { aim = { x, z, dx, dz, power, color }; };
V.hideAim = function () { aim = null; };
V.getScale = () => dpr; V.maxScale = Math.min(1.5, window.devicePixelRatio || 1);
V.setScale = r => { V.scaleCap = r; V.resize(); }; V.setShadows = () => {}; V.shadows = () => false;
V.refCall = function (e) { refS.anim = { t: 0, call: e.call, px: e.x, pz: e.z, card: e.card }; };
V.burst = function (a, b) {
  const bx = G ? G.w.ball.x * 0.9 : 0;
  for (let i = 0; i < 220; i++) conf.push({ x: bx + (Math.random() - 0.5) * 16, y: 6 + Math.random() * 6, z: (Math.random() - 0.5) * 20, vx: (Math.random() - 0.5) * 60, vy: 70 + Math.random() * 120, vz: (Math.random() - 0.5) * 60, c: Math.random() < 0.5 ? a : b, life: 3 });
  shake = 1.2;
};

function setupCamera() {
  const D = cam.dist * (portrait() ? 1.5 : 1);
  let px = cam.tx + D * Math.cos(cam.el) * Math.sin(cam.az) + (Math.random() - 0.5) * shake;
  let py = cam.ty + D * Math.sin(cam.el) + (Math.random() - 0.5) * shake;
  const pz = cam.tz + D * Math.cos(cam.el) * Math.cos(cam.az);
  if (py < 4) py = 4;
  P = [px, py, pz];
  let fx = cam.tx - px, fy = cam.ty - py, fz = cam.tz - pz; const fl = hyp(fx, fy, fz); fx /= fl; fy /= fl; fz /= fl;
  let rx = -fz, rz = fx; const rl = hyp(rx, rz) || 1; rx /= rl; rz /= rl;
  Fv = [fx, fy, fz]; Rv = [rx, 0, rz]; Uv = [-rz * fy, rz * fx - rx * fz, rx * fy];
  const fov = (portrait() ? 52 : 36) * PI / 180;
  focal = (H / 2) / Math.tan(fov / 2); ccx = W / 2; ccy = H / 2;
}
function toCam(x, y, z) { const dx = x - P[0], dy = y - P[1], dz = z - P[2]; return [dx * Rv[0] + dz * Rv[2], dx * Uv[0] + dy * Uv[1] + dz * Uv[2], dx * Fv[0] + dy * Fv[1] + dz * Fv[2]]; }
function proj(c) { return [ccx + c[0] / c[2] * focal, ccy - c[1] / c[2] * focal]; }
function depth(x, y, z) { return (x - P[0]) * Fv[0] + (y - P[1]) * Fv[1] + (z - P[2]) * Fv[2]; }
function scr(x, y, z) { const c = toCam(x, y, z); return c[2] > NEAR ? proj(c) : null; }
function pxPerCm(x, y, z) { const d = depth(x, y, z); return d > NEAR ? focal / d : 0; }
function clip(cs) {
  const out = [];
  for (let i = 0; i < cs.length; i++) {
    const a = cs[i], b = cs[(i + 1) % cs.length], ain = a[2] > NEAR, bin = b[2] > NEAR;
    if (ain) out.push(a);
    if (ain !== bin) { const t = (NEAR - a[2]) / (b[2] - a[2]); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR]); }
  }
  return out;
}
function addPoly(pts) {               // world points -> sub-path; returns false when fully behind the camera
  const cs = clip(pts.map(p => toCam(p[0], p[1], p[2]))); if (cs.length < 3) return false;
  cs.forEach((c, i) => { const s = proj(c); if (i) g.lineTo(s[0], s[1]); else g.moveTo(s[0], s[1]); }); g.closePath(); return true;
}
function poly(pts, fill, stroke, lw) { g.beginPath(); if (!addPoly(pts)) return; if (fill) { g.fillStyle = fill; g.fill(); } if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw || 1; g.stroke(); } }
function circlePts(x, z, r, y, n, a0, a1) { const out = []; a0 = a0 || 0; a1 = a1 === undefined ? PI * 2 : a1; for (let i = 0; i < n; i++) { const a = a0 + (a1 - a0) * i / (a1 - a0 >= PI * 2 - 1e-6 ? n : n - 1); out.push([x + Math.cos(a) * r, y, z + Math.sin(a) * r]); } return out; }
function addLine(x1, z1, x2, z2, w, y) { const dx = x2 - x1, dz = z2 - z1, l = hyp(dx, dz) || 1, nx = -dz / l * w / 2, nz = dx / l * w / 2; addPoly([[x1 + nx, y, z1 + nz], [x2 + nx, y, z2 + nz], [x2 - nx, y, z2 - nz], [x1 - nx, y, z1 - nz]]); }
function addArc(x, z, r, a0, a1, w, y, n) { const pts = circlePts(x, z, r, y, n + 1, a0, a1); for (let i = 0; i < n; i++) addLine(pts[i][0], pts[i][2], pts[i + 1][0], pts[i + 1][2], w, y); }
function seg(a, b, color, wCm, cap) {  // thick 3D segment, width in cm, clipped at the near plane
  let ca = toCam(a[0], a[1], a[2]), cb = toCam(b[0], b[1], b[2]);
  if (ca[2] <= NEAR && cb[2] <= NEAR) return;
  if (ca[2] <= NEAR) { const t = (NEAR - ca[2]) / (cb[2] - ca[2]); ca = [ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, NEAR]; }
  if (cb[2] <= NEAR) { const t = (NEAR - cb[2]) / (ca[2] - cb[2]); cb = [cb[0] + (ca[0] - cb[0]) * t, cb[1] + (ca[1] - cb[1]) * t, NEAR]; }
  const sa = proj(ca), sb = proj(cb);
  g.strokeStyle = color; g.lineWidth = Math.max(0.6, wCm * focal / ((ca[2] + cb[2]) / 2)); g.lineCap = cap || 'round';
  g.beginPath(); g.moveTo(sa[0], sa[1]); g.lineTo(sb[0], sb[1]); g.stroke();
}
function shade(hex, f) { const n = parseInt(hex.slice(1), 16); const c = [n >> 16, (n >> 8) & 255, n & 255].map(v => Math.max(0, Math.min(255, Math.round(v * f)))); return `rgb(${c[0]},${c[1]},${c[2]})`; }

/* ---------- table ---------- */
const MX = C.HL + C.margin, MZ = C.HW + C.margin, TH = 5;
function boxFaces(x0, x1, y0, y1, z0, z1, top, side) {
  const F = [
    { n: [0, 1, 0], c: [(x0 + x1) / 2, y1, (z0 + z1) / 2], p: [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], col: top },
    { n: [0, 0, 1], c: [(x0 + x1) / 2, (y0 + y1) / 2, z1], p: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], col: side },
    { n: [0, 0, -1], c: [(x0 + x1) / 2, (y0 + y1) / 2, z0], p: [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], col: shade(side, 0.8) },
    { n: [1, 0, 0], c: [x1, (y0 + y1) / 2, (z0 + z1) / 2], p: [[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]], col: shade(side, 0.9) },
    { n: [-1, 0, 0], c: [x0, (y0 + y1) / 2, (z0 + z1) / 2], p: [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], col: shade(side, 0.9) }
  ];
  for (const f of F) if ((P[0] - f.c[0]) * f.n[0] + (P[1] - f.c[1]) * f.n[1] + (P[2] - f.c[2]) * f.n[2] > 0) poly(f.p, f.col);
}
const RAILS = [[-MX - TH, MX + TH, -MZ - TH, -MZ], [-MX - TH, MX + TH, MZ, MZ + TH], [-MX - TH, -MX, -MZ, MZ], [MX, MX + TH, -MZ, MZ]];
function drawRails(front) {
  const d0 = depth(0, 0, 0);
  for (const r of RAILS) { const isFront = depth((r[0] + r[1]) / 2, 1.5, (r[2] + r[3]) / 2) < d0; if (isFront === front) boxFaces(r[0], r[1], -0.7, 3.5, r[2], r[3], '#7a5130', '#6a4527'); }
}
function drawGround() {
  boxFaces(-MX - TH, MX + TH, -7.2, -0.7, -MZ - TH, MZ + TH, '#4a2f1a', '#4a2f1a');
  poly([[-MX, 0, -MZ], [MX, 0, -MZ], [MX, 0, MZ], [-MX, 0, MZ]], '#25663a');
  for (let i = 0; i < C.L / 10; i++) { const x = -C.HL + i * 10; poly([[x, 0, -C.HW], [x + 10, 0, -C.HW], [x + 10, 0, C.HW], [x, 0, C.HW]], i % 2 ? '#32864b' : '#2b7641'); }
  // markings, all in one path
  const w = 0.55, y = 0.02; g.beginPath();
  addLine(-C.HL, -C.HW, C.HL, -C.HW, w, y); addLine(-C.HL, C.HW, C.HL, C.HW, w, y); addLine(-C.HL, -C.HW, -C.HL, C.HW, w, y); addLine(C.HL, -C.HW, C.HL, C.HW, w, y);
  addLine(0, -C.HW, 0, C.HW, w, y); addArc(0, 0, 10, 0, PI * 2, w, y, 48);
  for (const s of [-1, 1]) {
    const gx = s * C.HL, bx = gx - s * C.boxD, sx = gx - s * C.sixD, px = gx - s * 12;
    addLine(gx, -C.boxHW, bx, -C.boxHW, w, y); addLine(bx, -C.boxHW, bx, C.boxHW, w, y); addLine(bx, C.boxHW, gx, C.boxHW, w, y);
    addLine(gx, -C.sixHW, sx, -C.sixHW, w, y); addLine(sx, -C.sixHW, sx, C.sixHW, w, y); addLine(sx, C.sixHW, gx, C.sixHW, w, y);
    const a0 = Math.acos((C.boxD - 12) / 10); if (s > 0) addArc(px, 0, 10, PI - a0, PI + a0, w, y, 14); else addArc(px, 0, 10, -a0, a0, w, y, 14);
    for (const sz of [-1, 1]) { const st = s > 0 ? (sz > 0 ? PI : PI / 2) : (sz > 0 ? PI * 1.5 : 0); addArc(gx, sz * C.HW, 2.2, st, st + PI / 2, w, y, 6); }
    addPoly(circlePts(px, 0, 0.7, y, 12));
  }
  addPoly(circlePts(0, 0, 0.7, y, 12));
  g.fillStyle = 'rgba(244,247,240,0.93)'; g.fill();
  if (boxSide) poly([[boxSide * C.HL, 0.05, -C.sixHW], [boxSide * (C.HL - C.sixD), 0.05, -C.sixHW], [boxSide * (C.HL - C.sixD), 0.05, C.sixHW], [boxSide * C.HL, 0.05, C.sixHW]], 'rgba(245,196,0,0.25)');
  if (zone) {
    if (zone.type === 'rect') poly([[zone.x0, 0.05, zone.z0], [zone.x1, 0.05, zone.z0], [zone.x1, 0.05, zone.z1], [zone.x0, 0.05, zone.z1]], 'rgba(245,196,0,0.22)');
    else poly(circlePts(zone.x, zone.z, zone.r, 0.05, 40), 'rgba(245,196,0,0.22)');
  }
}
/* ---------- the back patio around the table ----------
   Dusk on a wooden deck. The game board sits on a patio table; the back wall of the house (a lit window, a door
   and a lamp) stands behind the far end, a wooden fence closes the other three sides, string lights hang along
   the fence tops, there are potted plants in the corners and trees beyond the fence. Everything is drawn through
   the same camera as the table, so it turns, tilts and zooms with it, and far things fade into the evening.
   About 200 flat shapes a frame: cheap next to the caps and figures. */
const FY = -76, DX = 430, DZ = 340, FH = 185, HH = 330;      // deck level, deck half-size, fence and house wall height (cm)
const FOG = [46, 38, 52];
const hexRgb = h => { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const rgbS = c => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
function fogged(hex, x, y, z) { const c = hexRgb(hex), k = Math.max(0, Math.min(0.62, (depth(x, y, z) - 260) / 950)); return rgbS(c.map((v, i) => v + (FOG[i] - v) * k)); }
function horizonY() {
  const n = hyp(Fv[0], Fv[2]); if (n < 1e-3) return -1e4;
  const hx = Fv[0] / n, hz = Fv[2] / n;
  return ccy - (Uv[0] * hx + Uv[2] * hz) / (Fv[0] * hx + Fv[2] * hz) * focal;
}
const quad = (ax, az, bx, bz, y0, y1) => [[ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az]];
// trees beyond the fence, placed once (a fixed pattern, not random, so every screen shows the same garden)
const TREES = Array.from({ length: 16 }, (_, i) => { const a = i / 16 * PI * 2 + 0.17 * Math.sin(i * 2.3), r = 760 + 140 * ((i * 37) % 5) / 4; return { x: Math.sin(a) * r * 1.15, z: Math.cos(a) * r, h: 330 + 70 * ((i * 53) % 4), cr: 120 + 30 * ((i * 29) % 3) }; });
const PLANTS = [[-DX + 48, -DZ + 48], [DX - 48, -DZ + 48], [-DX + 48, DZ - 48], [DX - 48, DZ - 48], [180, -DZ + 40], [-260, -DZ + 40]];
/* Where the furniture stands: the TV on the house wall with a couch facing it, the grill on the left, and a little
   table with the tea and coffee things at the near end. */
const TVX = 290, COUCH = { x0: 205, x1: 375, z0: -205, z1: -140 }, GRILL = { x: -335, z: -175 }, TEA = { x: -290, z: 235 };
function drawSky() {
  const hy = horizonY(), y0 = Math.min(0, hy - H * 0.9), y1 = Math.max(hy, y0 + 1);
  const gr = g.createLinearGradient(0, y0, 0, y1);
  gr.addColorStop(0, '#141a33'); gr.addColorStop(0.55, '#3b3358'); gr.addColorStop(0.85, '#a3606a'); gr.addColorStop(1, '#e39a6b');
  g.fillStyle = gr; g.fillRect(0, 0, W, H);
}
function drawTrees() {
  const ts = TREES.map(t => ({ t, d: depth(t.x, t.h, t.z) })).filter(o => o.d > NEAR).sort((a, b) => b.d - a.d);
  for (const { t } of ts) {
    const k = pxPerCm(t.x, t.h, t.z); if (!k) continue;
    const b = scr(t.x, FY, t.z), c = scr(t.x, t.h, t.z); if (!b || !c) continue;
    g.fillStyle = '#231d2b'; g.fillRect(c[0] - 9 * k, c[1], 18 * k, b[1] - c[1]);
    g.fillStyle = '#28212f';
    for (const [ox, oy, r] of [[0, 0, 1], [-0.6, 0.35, 0.75], [0.62, 0.3, 0.8], [0, -0.55, 0.7]]) { g.beginPath(); g.arc(c[0] + ox * t.cr * k, c[1] + oy * t.cr * k, r * t.cr * k, 0, PI * 2); g.fill(); }
  }
}
function drawDeck() {
  poly([[-DX, FY, -DZ], [DX, FY, -DZ], [DX, FY, DZ], [-DX, FY, DZ]], '#110904');            // the gaps between boards
  const tones = ['#3b2517', '#332014', '#422a1a', '#2d1c11', '#382316'];   // dark coffee, burnt wood: well apart from the table's lighter rails
  for (let i = 0, z = -DZ; z < DZ; i++, z += 14) poly([[-DX, FY, z + 0.5], [DX, FY, z + 0.5], [DX, FY, z + 13.4], [-DX, FY, z + 13.4]], fogged(tones[(i * 3) % 5], P[0], FY, z + 7));
  // the patio table's shadow, soft
  const sx = MX + TH + 22, sz = MZ + TH + 22;
  poly([[-sx, FY + 0.1, -sz], [sx, FY + 0.1, -sz], [sx, FY + 0.1, sz], [-sx, FY + 0.1, sz]], 'rgba(10,6,4,0.35)');
}
function drawFence(ax, az, bx, bz) {
  const mx = (ax + bx) / 2, mz = (az + bz) / 2, len = hyp(bx - ax, bz - az), ux = (bx - ax) / len, uz = (bz - az) / len;
  poly(quad(ax, az, bx, bz, FY, FY + FH), fogged('#6b4730', mx, FY + FH / 2, mz));
  g.beginPath();
  for (let d = 14; d < len; d += 14) { const x = ax + ux * d, z = az + uz * d; addPoly(quad(x - ux * 0.7, z - uz * 0.7, x + ux * 0.7, z + uz * 0.7, FY, FY + FH)); }
  g.fillStyle = fogged('#3a2517', mx, FY + FH / 2, mz); g.fill();
  for (const y of [FY + FH - 7, FY + 55]) poly(quad(ax, az, bx, bz, y, y + 7), fogged('#82593a', mx, y, mz));
}
function drawHouse(nowS) {
  const z = -DZ, mid = (FY + HH) / 2;
  poly(quad(-DX, z, DX, z, FY, FY + HH), fogged('#7d4434', 0, mid, z));
  g.beginPath(); for (let y = FY + 8; y < FY + HH; y += 8) addPoly(quad(-DX, z + 0.2, DX, z + 0.2, y, y + 0.9)); g.fillStyle = fogged('#5e3226', 0, mid, z); g.fill();   // mortar courses
  poly(quad(-DX, z + 0.3, DX, z + 0.3, FY + HH - 14, FY + HH), fogged('#2f2a2c', 0, FY + HH, z));                                      // eaves
  // window: warm light inside, a dark frame with a cross
  const wx0 = -190, wx1 = -60, wy0 = FY + 95, wy1 = FY + 215;
  poly(quad(wx0 - 6, z + 0.5, wx1 + 6, z + 0.5, wy0 - 6, wy1 + 6), '#2b211d');
  poly(quad(wx0, z + 0.7, wx1, z + 0.7, wy0, wy1), '#ffcf7e');
  g.beginPath(); addPoly(quad((wx0 + wx1) / 2 - 2, z + 0.9, (wx0 + wx1) / 2 + 2, z + 0.9, wy0, wy1)); addPoly(quad(wx0, z + 0.9, wx1, z + 0.9, (wy0 + wy1) / 2 - 2, (wy0 + wy1) / 2 + 2)); g.fillStyle = '#2b211d'; g.fill();
  glow((wx0 + wx1) / 2, (wy0 + wy1) / 2, z + 2, 140, 'rgba(255,190,110,', 0.22);
  // door and its lamp
  poly(quad(40, z + 0.5, 140, z + 0.5, FY, FY + 215), '#3b2a22');
  poly(quad(48, z + 0.7, 132, z + 0.7, FY + 8, FY + 207), '#4a352a');
  const lamp = scr(160, FY + 240, z + 4);
  if (lamp) { const k = pxPerCm(160, FY + 240, z + 4); g.fillStyle = '#fff1c9'; g.beginPath(); g.arc(lamp[0], lamp[1], Math.max(1.5, 6 * k), 0, PI * 2); g.fill(); }
  glow(160, FY + 240, z + 4, 110, 'rgba(255,214,150,', 0.32 + 0.02 * Math.sin(nowS * 3));
}
/* A soft round light, added on top of what is there. One glow is drawn once per colour into a small canvas and
   then stamped at each light's size, which is far cheaper than a fresh gradient for every bulb on every frame. */
const glowSprites = {};
function glowSprite(rgba) {
  if (glowSprites[rgba]) return glowSprites[rgba];
  const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d');
  const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, rgba + '1)'); gr.addColorStop(1, rgba + '0)');
  x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
  return (glowSprites[rgba] = c);
}
function glow(x, y, z, r, rgba, a) {
  const c = scr(x, y, z); if (!c) return; const k = pxPerCm(x, y, z), R = r * k; if (R < 2) return;
  const op = g.globalCompositeOperation, al = g.globalAlpha;
  g.globalCompositeOperation = 'lighter'; g.globalAlpha = Math.min(1, a);
  g.drawImage(glowSprite(rgba), c[0] - R, c[1] - R, 2 * R, 2 * R);
  g.globalCompositeOperation = op; g.globalAlpha = al;
}
const GREENS = ['#2f5a33', '#3c6d3b', '#264b2c', '#4a7c45'];
function drawPlant(p) {
  const greens = GREENS;
  boxFaces(p.x - 20, p.x + 20, FY, FY + 42, p.z - 20, p.z + 20, '#a35a37', '#8d4a2c');   // shade() needs plain hex colours
    const n = 7;
    for (let i = 0; i < n; i++) {
      const a = i / n * PI * 2 + p.x * 0.01, lx = p.x + Math.cos(a) * 16, lz = p.z + Math.sin(a) * 16, ly = FY + 62 + ((i * 17) % 5) * 9;
      const c = scr(lx, ly, lz), k = pxPerCm(lx, ly, lz); if (!c) continue;
      g.fillStyle = fogged(greens[i % 4], lx, ly, lz); g.beginPath(); g.arc(c[0], c[1], 19 * k, 0, PI * 2); g.fill();
    }
    const c = scr(p.x, FY + 98, p.z), k = pxPerCm(p.x, FY + 98, p.z); if (c) { g.fillStyle = fogged('#3f7340', p.x, FY + 98, p.z); g.beginPath(); g.arc(c[0], c[1], 22 * k, 0, PI * 2); g.fill(); }
}
/* String lights along the fence tops: sagging wire, a bulb every 36 cm, each with a little warm glow. */
const LIGHT_SPANS = (() => {
  const top = FY + FH + 30, c = [[-DX, -DZ], [DX, -DZ], [DX, DZ], [-DX, DZ]], spans = [];
  for (let i = 0; i < 4; i++) {
    const [ax, az] = c[i], [bx, bz] = c[(i + 1) % 4], len = hyp(bx - ax, bz - az), n = Math.round(len / 120);
    for (let j = 0; j < n; j++) spans.push([ax + (bx - ax) * j / n, az + (bz - az) * j / n, ax + (bx - ax) * (j + 1) / n, az + (bz - az) * (j + 1) / n, top]);
  }
  return spans;
})();
function drawLights(nowS) {
  const bulbs = [];
  g.beginPath(); let started = false;
  for (const [ax, az, bx, bz, top] of LIGHT_SPANS) {
    for (let i = 0; i <= 10; i++) {
      const t = i / 10, x = ax + (bx - ax) * t, z = az + (bz - az) * t, y = top - 22 * 4 * t * (1 - t), sp = scr(x, y, z);
      if (!sp) { started = false; continue; }
      if (!started) { g.moveTo(sp[0], sp[1]); started = true; } else g.lineTo(sp[0], sp[1]);
      if (i % 3 === 1) bulbs.push([x, y - 3, z]);
    }
  }
  g.strokeStyle = 'rgba(20,16,14,0.8)'; g.lineWidth = 1; g.stroke();
  bulbs.forEach(([x, y, z], i) => {
    const c = scr(x, y, z); if (!c) return; const k = pxPerCm(x, y, z), f = 0.85 + 0.15 * Math.sin(nowS * 2.1 + i * 1.7);
    glow(x, y, z, 26, 'rgba(255,196,120,', 0.42 * f);
    g.fillStyle = '#fff3cf'; g.beginPath(); g.arc(c[0], c[1], Math.max(1.2, 3.2 * k), 0, PI * 2); g.fill();
  });
}
function drawPatioTable() {                  // an outdoor table: slim slate top on black metal legs, so the board stands out
  const TX = MX + TH + 7, TZ = MZ + TH + 7, t0 = -9.4, t1 = -7.2, L = 4;
  const legs = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => ({ x: a * (TX - 9), z: b * (TZ - 9) })).sort((p, q) => depth(q.x, -40, q.z) - depth(p.x, -40, p.z));
  for (const l of legs) boxFaces(l.x - L / 2, l.x + L / 2, FY, t0, l.z - L / 2, l.z + L / 2, '#1c1f21', '#25292b');
  boxFaces(-TX, TX, t0, t1, -TZ, TZ, '#4b5457', '#363d40');
}
const frac = v => v - Math.floor(v);                                              // 0..1 for negative numbers too
/* Boxes drawn far to near, so the parts of one piece of furniture cover each other properly. */
function boxes(list) {
  list.map(b => ({ b, d: depth((b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2) })).sort((p, q) => q.d - p.d)
    .forEach(({ b }) => boxFaces(b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]));
}
/* A flat shape on the house wall (x, y in the wall's plane, just in front of it). */
const wallPts = (pts, dz) => pts.map(([x, y]) => [x, y, -DZ + (dz || 3)]);
function drawTV(nowS) {
  const x0 = TVX - 62, x1 = TVX + 62, y0 = FY + 112, y1 = FY + 182;
  boxes([[TVX - 60, TVX + 60, FY, FY + 46, -DZ, -DZ + 42, '#3a2a20', '#2c1f17']]);                      // low console
  poly(wallPts([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], 3), '#0b0d10');                                 // the set
  const i0 = x0 + 3, i1 = x1 - 3, j0 = y0 + 3, j1 = y1 - 3;
  poly(wallPts([[i0, j0], [i1, j0], [i1, j1], [i0, j1]], 3.3), '#2f7d46');                               // a match on: the pitch
  for (let k = 0; k < 6; k += 2) { const a = i0 + (i1 - i0) * k / 6, b = i0 + (i1 - i0) * (k + 1) / 6; poly(wallPts([[a, j0], [b, j0], [b, j1], [a, j1]], 3.4), '#37904f'); }
  const cx = (i0 + i1) / 2, cy = (j0 + j1) / 2;
  poly(wallPts([[cx - 0.6, j0], [cx + 0.6, j0], [cx + 0.6, j1], [cx - 0.6, j1]], 3.5), 'rgba(255,255,255,0.8)');
  g.beginPath(); addPoly(wallPts(Array.from({ length: 24 }, (_, k) => [cx + Math.cos(k / 24 * PI * 2) * 9, cy + Math.sin(k / 24 * PI * 2) * 9]), 3.5));
  g.strokeStyle = 'rgba(255,255,255,0.75)'; g.lineWidth = Math.max(0.6, pxPerCm(cx, cy, -DZ) * 1.1); g.stroke();
  const t = nowS * 0.7, bx = cx + Math.sin(t) * 35, by = cy + Math.sin(t * 1.7) * 18;                     // the ball, wandering
  poly(wallPts(Array.from({ length: 10 }, (_, k) => [bx + Math.cos(k / 10 * PI * 2) * 1.6, by + Math.sin(k / 10 * PI * 2) * 1.6]), 3.6), '#fff');
  glow(TVX, cy, -DZ + 12, 150, 'rgba(120,200,255,', 0.16 + 0.03 * Math.sin(nowS * 5));
}
function drawCouch() {
  const { x0, x1, z0, z1 } = COUCH, F = '#56646d', D = '#45525a', L = '#66757e';
  const legs = [[x0 + 6, z0 + 6], [x1 - 6, z0 + 6], [x0 + 6, z1 - 6], [x1 - 6, z1 - 6]].map(([x, z]) => [x - 2, x + 2, FY, FY + 12, z - 2, z + 2, '#1c1f21', '#1c1f21']);
  const mid = (x0 + x1) / 2;
  boxes(legs.concat([
    [x0, x1, FY + 12, FY + 40, z0, z1, D, D],                                       // base
    [x0 + 12, mid - 1, FY + 40, FY + 50, z0 + 2, z1 - 14, L, F],                     // seat cushions
    [mid + 1, x1 - 12, FY + 40, FY + 50, z0 + 2, z1 - 14, L, F],
    [x0 + 10, x1 - 10, FY + 40, FY + 88, z1 - 14, z1, F, D],                         // back
    [x0, x0 + 12, FY + 40, FY + 62, z0, z1, F, D],                                   // arms
    [x1 - 12, x1, FY + 40, FY + 62, z0, z1, F, D],
    [x0 + 16, x0 + 40, FY + 50, FY + 74, z1 - 22, z1 - 14, '#d6a43a', '#b98a2c']     // a mustard cushion
  ]));
}
function drawGrill(nowS) {
  const { x, z } = GRILL, M = '#26292c', T = '#33383c';
  const legs = [[x - 26, z - 20], [x + 26, z - 20], [x - 26, z + 20], [x + 26, z + 20]].map(([a, b]) => [a - 1.5, a + 1.5, FY, FY + 72, b - 1.5, b + 1.5, '#16181a', '#16181a']);
  boxes(legs.concat([
    [x - 32, x + 32, FY + 22, FY + 25, z - 24, z + 24, '#3a3f43', '#2a2e31'],       // bottom shelf
    [x - 32, x + 32, FY + 72, FY + 100, z - 24, z + 24, M, M],                      // firebox
    [x - 30, x + 30, FY + 100, FY + 116, z - 22, z + 22, T, '#2b3034'],             // lid
    [x + 32, x + 58, FY + 94, FY + 97, z - 18, z + 18, '#6b4a30', '#563b26']        // side shelf, wood
  ]));
  seg([x - 18, FY + 110, z + 25], [x + 18, FY + 110, z + 25], '#b9bec2', 1.6);       // handle
  glow(x, FY + 99, z + 25, 30, 'rgba(255,120,50,', 0.35 + 0.1 * Math.sin(nowS * 6));   // embers under the lid
  for (let i = 0; i < 5; i++) {                                                      // a thread of smoke
    const t = frac(nowS * 0.35 + i / 5), y = FY + 120 + t * 110, sx = x + Math.sin(nowS + i * 1.3) * 6 + t * 18;
    const c = scr(sx, y, z), k = pxPerCm(sx, y, z); if (!c) continue;
    g.fillStyle = `rgba(200,200,210,${0.16 * (1 - t)})`; g.beginPath(); g.arc(c[0], c[1], (6 + t * 14) * k, 0, PI * 2); g.fill();
  }
}
function drawTea(nowS) {
  const { x, z } = TEA, top = FY + 62;
  const legs = [[x - 30, z - 22], [x + 30, z - 22], [x - 30, z + 22], [x + 30, z + 22]].map(([a, b]) => [a - 2, a + 2, FY, top - 3, b - 2, b + 2, '#3a2a20', '#3a2a20']);
  boxes(legs.concat([[x - 36, x + 36, top - 3, top, z - 28, z + 28, '#7a5232', '#5e3e26']]));
  // tray, teapot, coffee press, cups on saucers, sugar bowl: small enough to read as shapes
  poly([[x - 26, top + 0.2, z - 18], [x + 26, top + 0.2, z - 18], [x + 26, top + 0.2, z + 18], [x - 26, top + 0.2, z + 18]], '#b9a27e');
  const items = [];
  items.push({ x: x - 12, z: z - 4, f: () => {                                     // teapot: round body, lid, spout, handle
    const c = scr(x - 12, top + 7, z - 4), k = pxPerCm(x - 12, top + 7, z - 4); if (!c) return;
    seg([x - 4, top + 7, z - 4], [x + 2, top + 12, z - 4], '#e9e2d6', 2.2); seg([x - 20, top + 9, z - 4], [x - 22, top + 5, z - 4], '#d9d1c4', 1.6);
    g.fillStyle = '#efe8dc'; g.beginPath(); g.ellipse(c[0], c[1], 8 * k, 6.5 * k, 0, 0, PI * 2); g.fill();
    g.fillStyle = '#d9d1c4'; g.beginPath(); g.arc(c[0], c[1] - 6 * k, 2.4 * k, 0, PI * 2); g.fill(); } });
  items.push({ x: x + 14, z: z - 8, f: () => boxes([[x + 10, x + 18, top, top + 18, z - 12, z - 4, '#3b2a20', '#2a1e17'], [x + 9.5, x + 18.5, top + 18, top + 20, z - 12.5, z - 3.5, '#c9ccd0', '#a7abb0']]) });   // coffee press
  for (const [cx, cz] of [[x + 2, z + 9], [x + 16, z + 9], [x - 14, z + 10]]) items.push({ x: cx, z: cz, f: () => {
    poly(circlePts(cx, cz, 4.2, top + 0.4, 14), '#e8e2d6');                                                        // saucer
    boxes([[cx - 2.4, cx + 2.4, top + 0.4, top + 5.5, cz - 2.4, cz + 2.4, '#4a2c1a', '#f2ede4']]);                  // cup, tea inside
    const t = frac(nowS * 0.5 + cx * 0.1), c = scr(cx, top + 8 + t * 14, cz), k = pxPerCm(cx, top + 8, cz);         // steam
    if (c) { g.fillStyle = `rgba(235,235,240,${0.22 * (1 - t)})`; g.beginPath(); g.arc(c[0], c[1], (1.5 + t * 3) * k, 0, PI * 2); g.fill(); } } });
  items.push({ x: x + 22, z: z + 4, f: () => boxes([[x + 19, x + 25, top, top + 4, z + 1, z + 7, '#eae4d8', '#d7d0c3']]) });   // sugar
  items.map(o => ({ o, d: depth(o.x, top + 5, o.z) })).sort((p, q) => q.d - p.d).forEach(({ o }) => o.f());
}
function drawPatio(nowS) {
  drawSky(); drawTrees(); drawDeck();
  const walls = [
    { d: depth(0, 0, -DZ), f: () => drawHouse(nowS) },
    { d: depth(0, 0, DZ), f: () => drawFence(-DX, DZ, DX, DZ) },
    { d: depth(-DX, 0, 0), f: () => drawFence(-DX, -DZ, -DX, DZ) },
    { d: depth(DX, 0, 0), f: () => drawFence(DX, -DZ, DX, DZ) }
  ].sort((a, b) => b.d - a.d);
  walls.forEach(w => w.f());
  // furniture and plants, far to near
  const props = PLANTS.map(([x, z]) => ({ d: depth(x, FY + 60, z), f: () => drawPlant({ x, z }) }));
  props.push({ d: depth(TVX, FY + 140, -DZ + 10), f: () => drawTV(nowS) }, { d: depth((COUCH.x0 + COUCH.x1) / 2, FY + 40, (COUCH.z0 + COUCH.z1) / 2), f: drawCouch },
    { d: depth(GRILL.x, FY + 90, GRILL.z), f: () => drawGrill(nowS) }, { d: depth(TEA.x, FY + 60, TEA.z), f: () => drawTea(nowS) });
  props.filter(p => p.d > NEAR).sort((a, b) => b.d - a.d).forEach(p => p.f());
  drawLights(nowS); drawPatioTable();
}
function vignette() {
  const gr = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
  gr.addColorStop(0, 'rgba(12,8,20,0)'); gr.addColorStop(1, 'rgba(12,8,20,0.45)');
  g.fillStyle = gr; g.fillRect(0, 0, W, H);
}
function drawGoal(s) {
  const gx = s * C.HL, bx = s * (C.HL + C.gd), hw = C.gw / 2, h = C.gh, net = 'rgba(240,244,240,0.10)', mesh = 'rgba(240,244,240,0.45)';
  poly([[bx, 0, -hw], [bx, 0, hw], [bx, h, hw], [bx, h, -hw]], net);
  for (const z of [-hw, hw]) poly([[gx, 0, z], [bx, 0, z], [bx, h, z], [gx, h, z]], net);
  poly([[gx, h, -hw], [bx, h, -hw], [bx, h, hw], [gx, h, hw]], net);
  for (let z = -hw; z <= hw + 0.01; z += 2) { seg([bx, 0, z], [bx, h, z], mesh, 0.08, 'butt'); seg([gx, h, z], [bx, h, z], mesh, 0.08, 'butt'); }
  for (let yy = 2; yy < h; yy += 2) { seg([bx, yy, -hw], [bx, yy, hw], mesh, 0.08, 'butt'); for (const z of [-hw, hw]) seg([gx, yy, z], [bx, yy, z], mesh, 0.08, 'butt'); }
  for (const z of [-hw, hw]) { seg([bx, 0, z], [bx, h, z], '#e8ebe6', 0.3); seg([gx, h, z], [bx, h, z], '#e8ebe6', 0.3); }
  seg([bx, h, -hw], [bx, h, hw], '#e8ebe6', 0.3);
  for (const z of [-hw, hw]) seg([gx, 0, z], [gx, h, z], '#f6f7f4', C.postR * 2);
  seg([gx, h, -hw], [gx, h, hw], '#f6f7f4', C.postR * 2);
}

/* ---------- figures ---------- */
function torsoPattern(kit, main, sec, len, wb, wt) {
  // local frame: x across the body, y up the body (canvas y negative); clip is the torso trapezoid
  g.fillStyle = main; g.fillRect(-wt - wb, -len - wt, 2 * (wt + wb), len + 2 * wt);
  if (!kit || kit.pattern === 'solid') return;
  g.fillStyle = sec; const span = Math.max(wb, wt);
  if (kit.pattern === 'stripes') for (let i = -3; i < 3; i += 2) g.fillRect(i * span / 3, -len - wt, span / 3, len + 2 * wt);
  else if (kit.pattern === 'hoops') for (let i = 1; i < 6; i += 2) g.fillRect(-span, -len * (i + 1) / 6, 2 * span, len / 6);
  else if (kit.pattern === 'halves') g.fillRect(0, -len - wt, span, len + 2 * wt);
  else if (kit.pattern === 'checker') for (let y = 0; y < 4; y++) for (let x = -2; x < 2; x++) { if ((x + y) & 1) g.fillRect(x * span / 2, -len * (y + 1) / 4, span / 2, len / 4); }
  else if (kit.pattern === 'sash') { g.beginPath(); g.moveTo(-span, -len); g.lineTo(-span * 0.3, -len); g.lineTo(span, 0); g.lineTo(span * 0.3, 0); g.closePath(); g.fill(); }
}
function drawFigure(o) {
  // o: { x, z, y0, face, lean, scale, kit, main, sec, shorts, socks, skin, hair, num, isK, armR, armL, card }
  const sc = o.scale, f = [Math.cos(o.face), 0, Math.sin(o.face)], side = [-Math.sin(o.face), 0, Math.cos(o.face)];
  const cl = Math.cos(o.lean), sl = Math.sin(o.lean);
  const at = (h, s) => [o.x + side[0] * (s || 0), o.y0 + h * sc * cl, o.z + h * sc * sl + side[2] * (s || 0)];
  // base disc and boots
  const base = circlePts(o.x, o.z, (o.isK ? C.kr : C.pr) * (o.isRef ? 1 : 1), 0.36, 20);
  poly(base, shade(o.main, 0.85), 'rgba(0,0,0,0.35)', 1);
  for (const s of [-0.7, 0.7]) poly(circlePts(o.x + f[0] * 0.45 + side[0] * s * sc, o.z + f[2] * 0.45 + side[2] * s * sc, 0.5 * sc, 0.5, 8), '#15161a');
  // legs and shorts
  for (const s of [-0.7, 0.7]) seg(at(0.4, s * sc), at(1.7, s * sc), o.socks, 1.0 * sc);
  seg(at(1.7), at(2.4), o.shorts, 3.0 * sc);
  // arms behind the body first
  const shoulder = s => at(4.25, s * 1.6 * sc);
  const armEnd = (s, ang) => { const sh = shoulder(s), L = 1.55 * sc, fs = Math.sin(ang) * L, up = Math.cos(ang) * L; return [sh[0] + f[0] * fs + side[0] * s * 0.25, sh[1] - up, sh[2] + f[2] * fs + side[2] * s * 0.25]; };
  const arms = [[-1, o.armL || 0], [1, o.armR || 0]].map(([s, a]) => ({ s, a, d: depth(...shoulder(s)) })).sort((p, q) => q.d - p.d);
  const drawArm = A => { const e = armEnd(A.s, A.a); seg(shoulder(A.s), e, o.sleeve || o.main, 0.75 * sc); const k = pxPerCm(...e), sp = scr(...e); if (sp) { g.fillStyle = o.isK ? '#f6f6f2' : o.skin; g.beginPath(); g.arc(sp[0], sp[1], Math.max(1, 0.42 * sc * k * (o.isK ? 1.25 : 1)), 0, PI * 2); g.fill(); }
    if (o.card && A.s === 1) { const cs = scr(e[0], e[1] + 0.6 * sc, e[2]); if (cs) { const kk = pxPerCm(...e); g.fillStyle = o.card === 'red' ? '#d8262c' : '#f5c400'; g.fillRect(cs[0] - 0.5 * kk, cs[1] - 1.4 * kk, 1.0 * kk, 1.4 * kk); } } };
  drawArm(arms[0]);
  // torso: a trapezoid along the body axis, with the kit pattern clipped inside, plus a shoulder cap
  const pb = scr(...at(2.1)), pt = scr(...at(4.15));
  if (pb && pt) {
    const kb = pxPerCm(...at(2.1)), kt = pxPerCm(...at(4.15)), wb = 1.5 * sc * kb, wt = 1.4 * sc * kt;
    const ax = pt[0] - pb[0], ay = pt[1] - pb[1], len = hyp(ax, ay);
    g.save(); g.translate(pb[0], pb[1]); g.rotate(Math.atan2(ax, -ay));
    g.beginPath(); g.moveTo(-wb, 0); g.lineTo(wb, 0); g.lineTo(wt, -len); g.lineTo(-wt, -len); g.closePath();
    g.save(); g.clip(); torsoPattern(o.kit, o.main, o.sec, len, wb, wt);
    const gr = g.createLinearGradient(-wb, 0, wb, 0); gr.addColorStop(0, 'rgba(0,0,0,0.22)'); gr.addColorStop(0.5, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.18)');
    g.fillStyle = gr; g.fillRect(-wb - wt, -len - wt, 2 * (wb + wt), len + 2 * wt); g.restore();
    const squash = Math.max(0.16, Math.abs(Fv[1]) * cl + Math.abs(sl) * 0.5);
    g.beginPath(); g.ellipse(0, -len, wt, wt * squash, 0, 0, PI * 2); g.fillStyle = o.collar || o.main; g.fill();
    g.beginPath(); g.ellipse(0, -len, wt * 0.82, wt * 0.82 * squash, 0, 0, PI * 2); g.fillStyle = o.main; g.fill();
    if (o.num !== '' && kt > 3.2 && len > wt) { g.fillStyle = o.ink; g.font = `700 ${Math.round(1.25 * sc * kt)}px "Big Shoulders Display", Impact, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(o.num), 0, -len * 0.55); }
    g.restore();
  }
  drawArm(arms[1]);
  // head and hair
  const hc = at(5.0), hp = scr(...hc), kh = pxPerCm(...hc);
  if (hp) {
    const r = 0.86 * sc * kh, up = scr(...at(6.0)); let ux = 0, uy = -1; if (up) { ux = up[0] - hp[0]; uy = up[1] - hp[1]; const l = hyp(ux, uy) || 1; ux /= l; uy /= l; }
    g.fillStyle = o.skin; g.beginPath(); g.arc(hp[0], hp[1], r, 0, PI * 2); g.fill();
    g.save(); g.beginPath(); g.arc(hp[0], hp[1], r, 0, PI * 2); g.clip();
    g.fillStyle = o.hair; g.beginPath(); g.arc(hp[0] + ux * r * 0.55, hp[1] + uy * r * 0.55, r * 0.95, 0, PI * 2); g.fill(); g.restore();
    if (o.whistle) { const ws = scr(hc[0] + f[0] * 0.95 * sc, hc[1] - 0.3 * sc, hc[2] + f[2] * 0.95 * sc); if (ws) { g.fillStyle = '#d8dde2'; g.beginPath(); g.arc(ws[0], ws[1], Math.max(1, 0.22 * sc * kh * (1 + o.whistle)), 0, PI * 2); g.fill(); } }
  }
}
/* ---------- bottle caps ---------- */
const LIGHT = (() => { const l = [-0.4, 0.85, 0.35], n = hyp(...l); return l.map(v => v / n); })();
function capPattern(p, kit, main, sec, R, y, along) {
  // drawn inside a clip of the cap top; rectangles laid out in the cap's own frame
  const f = [Math.cos(p.face), Math.sin(p.face)], s = [-f[1], f[0]];
  const rect = (a0, a1, b0, b1, col) => poly([[p.x + f[0] * a0 + s[0] * b0, y, p.z + f[1] * a0 + s[1] * b0], [p.x + f[0] * a1 + s[0] * b0, y, p.z + f[1] * a1 + s[1] * b0], [p.x + f[0] * a1 + s[0] * b1, y, p.z + f[1] * a1 + s[1] * b1], [p.x + f[0] * a0 + s[0] * b1, y, p.z + f[1] * a0 + s[1] * b1]], col);
  const pat = kit.pattern, w = R / 2;
  if (pat === 'stripes') for (const b of [-1.5, 0.5]) rect(-R, R, b * w, (b + 1) * w, sec);
  else if (pat === 'hoops') for (const a of [-1.5, 0.5]) rect(a * w, (a + 1) * w, -R, R, sec);
  else if (pat === 'halves') rect(-R, R, 0, R, sec);
  else if (pat === 'checker') { for (let i = -2; i < 2; i++) for (let j = -2; j < 2; j++) if ((i + j) & 1) rect(i * w, (i + 1) * w, j * w, (j + 1) * w, sec); }
  else if (pat === 'sash') poly([[p.x - f[0] * R - s[0] * R * 0.5, y, p.z - f[1] * R - s[1] * R * 0.5], [p.x - f[0] * R * 0.5 - s[0] * R, y, p.z - f[1] * R * 0.5 - s[1] * R], [p.x + f[0] * R + s[0] * R * 0.5, y, p.z + f[1] * R + s[1] * R * 0.5], [p.x + f[0] * R * 0.5 + s[0] * R, y, p.z + f[1] * R * 0.5 + s[1] * R]], sec);
}
function capNumber(cx, cy, cz, num, k, squash) {
  const sp = scr(cx, cy, cz); if (!sp || k < 2.2) return;
  g.save(); g.translate(sp[0], sp[1]); g.scale(1, Math.max(0.25, squash));
  g.fillStyle = 'rgba(250,250,246,0.94)'; g.beginPath(); g.arc(0, 0, 0.5 * k, 0, PI * 2); g.fill();
  g.fillStyle = '#14181a'; g.font = `800 ${Math.max(7, Math.round(0.72 * k))}px "Big Shoulders Display", Impact, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(num), 0, 0.04 * k);
  g.restore();
}
function drawCap(p) {
  const kit = G.kits[p.team], main = kit.a, sec = kit.b, R = C.pr, h = C.ph, bv = C.pbv, N = 42, FL = 21, amp = 0.035;
  const at = (t, rad, y, a) => { const m = 1 + a * Math.cos(FL * t); return [p.x + Math.cos(t) * rad * m, y, p.z + Math.sin(t) * rad * m]; };
  for (let i = 0; i < N; i++) {
    const t0 = i / N * PI * 2, t1 = (i + 1) / N * PI * 2, tm = (t0 + t1) / 2, nx = Math.cos(tm), nz = Math.sin(tm);
    const mid = [p.x + nx * R, h / 2, p.z + nz * R];
    if ((P[0] - mid[0]) * nx + (P[2] - mid[2]) * nz <= 0) continue;
    const lit = Math.max(0.35, nx * LIGHT[0] + nz * LIGHT[2] + 0.55), crimp = 0.85 + 0.15 * Math.cos(FL * tm);
    poly([at(t0, R, 0, amp), at(t1, R, 0, amp), at(t1, R, h - bv, amp), at(t0, R, h - bv, amp)], shade(main, 0.55 * lit * crimp + 0.15));
    poly([at(t0, R, h - bv, amp), at(t1, R, h - bv, amp), at(t1, R - bv, h, amp * 0.3), at(t0, R - bv, h, amp * 0.3)], shade(main, 0.75 * lit + 0.25));
  }
  const top = []; for (let i = 0; i < 36; i++) top.push(at(i / 36 * PI * 2, R - bv, h, amp * 0.3));
  g.save(); g.beginPath(); if (addPoly(top)) { g.fillStyle = main; g.fill(); g.clip(); capPattern(p, kit, main, sec, R, h, true);
    poly(circlePts(p.x, p.z, R - bv - 0.08, h, 36), null, sec, Math.max(1, 0.14 * pxPerCm(p.x, h, p.z))); }
  g.restore();
  capNumber(p.x, h, p.z, p.num, pxPerCm(p.x, h, p.z), Math.abs(Fv[1]));
}
function drawKeeper(p) {
  // a cap standing on its bent edge: a disc in the plane x = const, printed face towards the pitch
  const kit = G.kits[p.team], main = kit.keeper, R = C.kr, t = C.kt, fn = -Math.sign(p.homeX) || 1, N = 40, FL = 21, amp = 0.06;
  const tgt = p.diving ? Math.sign(p.vz || 1) * 0.5 * Math.min(1, p.diveT / 0.08) : Math.max(-0.12, Math.min(0.12, p.vz / 600));
  p._lean = (p._lean || 0) + (tgt - (p._lean || 0)) * 0.4; const cl = Math.cos(p._lean), sl = Math.sin(p._lean);
  const pt = (off, ang, a) => { const m = 1 + a * Math.cos(FL * ang), yy = R + Math.sin(ang) * R * m, zz = Math.cos(ang) * R * m; return [p.x + off, yy * cl, p.z + zz + yy * sl]; };
  poly([[p.x - fn * 1.2, 0.05, p.z - 0.8], [p.x, 0.05, p.z - 0.8], [p.x, 0.05, p.z + 0.8], [p.x - fn * 1.2, 0.05, p.z + 0.8]], shade(main, 0.6));
  const camFront = (P[0] - p.x) * fn > 0, near = camFront ? fn * t : -fn * t, far = -near;
  const ring = off => { const out = []; for (let i = 0; i < N; i++) out.push(pt(off, i / N * PI * 2, amp)); return out; };
  poly(ring(far), shade(main, 0.45));
  for (let i = 0; i < N; i++) {
    const a0 = i / N * PI * 2, a1 = (i + 1) / N * PI * 2, am = (a0 + a1) / 2, ny = Math.sin(am), nz = Math.cos(am);
    const mid = [p.x, (R + ny * R) * cl, p.z + nz * R];
    if ((P[1] - mid[1]) * ny + (P[2] - mid[2]) * nz <= 0) continue;
    poly([pt(far, a0, amp), pt(far, a1, amp), pt(near, a1, amp), pt(near, a0, amp)], shade(main, 0.6 + 0.3 * Math.max(0, ny)));
  }
  const face = ring(near);
  if (camFront) {
    g.save(); g.beginPath(); if (addPoly(face)) { g.fillStyle = main; g.fill(); g.clip();
      for (const yb of [0.35, 1.05]) { const y0 = R * yb * 2 / 1.4 - 0.2; poly([[p.x + near, y0, p.z - R], [p.x + near, y0, p.z + R], [p.x + near, y0 + 0.5, p.z + R], [p.x + near, y0 + 0.5, p.z - R]], '#101214'); } }
    g.restore();
    const c = pt(near, 0, 0); const k = pxPerCm(p.x + near, R, p.z);
    const sp = scr(p.x + near, R * cl, p.z + R * sl);
    if (sp && k > 2.2) { g.save(); g.translate(sp[0], sp[1]); g.scale(Math.max(0.25, Math.abs(Fv[0])), 1);
      g.fillStyle = 'rgba(250,250,246,0.94)'; g.beginPath(); g.arc(0, 0, 0.55 * k, 0, PI * 2); g.fill();
      g.fillStyle = '#14181a'; g.font = `800 ${Math.max(7, Math.round(0.75 * k))}px "Big Shoulders Display", Impact, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('1', 0, 0.04 * k); g.restore(); }
  } else poly(face, '#c9ccc4', shade(main, 0.5), 1);
}
function inkFor(main, sec, pattern) {
  const lum = c => { const n = parseInt(c.slice(1), 16); return (n >> 16) * 0.3 + ((n >> 8) & 255) * 0.59 + (n & 255) * 0.11; };
  if (pattern === 'solid' || pattern === 'halves') return lum(main) > 150 ? '#14181a' : '#f4f6f2';
  return lum(main) > 150 && lum(sec) > 150 ? '#14181a' : lum(main) < 110 && lum(sec) < 110 ? '#f4f6f2' : '#14181a';
}
function playerSpec(p, now) {
  const kit = G.kits[p.team], isK = p.kind === 'k';
  let lean = 0;
  if (isK) {
    const tgt = p.diving ? -Math.sign(p.vz || 1) * 1.25 * Math.min(1, p.diveT / 0.08) : -Math.max(-0.15, Math.min(0.15, p.vz / 600));
    p._lean = (p._lean || 0) + (tgt - (p._lean || 0)) * 0.5; lean = -p._lean;
  }
  const main = isK ? kit.keeper : kit.a, sec = isK ? '#101214' : kit.b;
  return { x: p.x, z: p.z, y0: p.y || 0, face: p.face, lean, scale: isK ? 1.12 : 1, kit: isK ? { pattern: 'hoops' } : kit, main, sec, sleeve: main, collar: sec,
    shorts: isK ? '#16181b' : kit.shorts, socks: isK ? '#16181b' : kit.socks, skin: SKIN[p.id % SKIN.length], hair: HAIR[(p.id * 3 + 1) % HAIR.length],
    num: p.num, ink: inkFor(main, sec, isK ? 'hoops' : kit.pattern), isK, armR: isK ? 2.4 : 0.12, armL: isK ? 2.4 : 0.12 };
}

/* ---------- ball ---------- */
let btnAng = 0;
function drawBall(b, dt) {
  // A target marker so the 2 cm button stays findable on small screens: four short white arcs on a dark edge.
  // (A solid yellow ring read as a yellow-kit cap.)
  const near = scr(b.x, 0, b.z), edge = scr(b.x + C.br, 0, b.z);
  const rpx = near && edge ? Math.hypot(edge[0] - near[0], edge[1] - near[1]) : 10;
  if (rpx < 14 && !b.inNet) {
    const k = Math.max(1, 8 / rpx), R = C.br * 1.75 * k;
    const arc = (col, lw, a0, len) => {
      const pts = circlePts(b.x, b.z, R, 0.05, 8, a0, a0 + len).map(q => scr(q[0], q[1], q[2]));
      if (pts.some(q => !q)) return;
      g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
      g.strokeStyle = col; g.lineWidth = lw; g.lineCap = 'round'; g.stroke();
    };
    for (let q = 0; q < 4; q++) { const a0 = q * PI / 2 + PI / 4 - 0.42; arc('rgba(5,8,10,0.8)', 4.5, a0 - 0.06, 0.96); arc('#ffffff', 2.5, a0, 0.84); }
    g.lineCap = 'butt';
  }
  // flat four-hole button: side band, then the top face with holes turning with the spin
  btnAng += (b.wy || 0) * dt;
  const r = C.br, t = C.bt, N = 24;
  for (let i = 0; i < N; i++) {
    const a0 = i / N * PI * 2, a1 = (i + 1) / N * PI * 2, am = (a0 + a1) / 2, nx = Math.cos(am), nz = Math.sin(am);
    if ((P[0] - b.x - nx * r) * nx + (P[2] - b.z - nz * r) * nz <= 0) continue;
    poly([[b.x + Math.cos(a0) * r, 0, b.z + Math.sin(a0) * r], [b.x + Math.cos(a1) * r, 0, b.z + Math.sin(a1) * r], [b.x + Math.cos(a1) * r, t, b.z + Math.sin(a1) * r], [b.x + Math.cos(a0) * r, t, b.z + Math.sin(a0) * r]], '#cfc8b6');
  }
  poly(circlePts(b.x, b.z, r, t, 28), '#f3eee2', '#cfc7b4', Math.max(1, 0.12 * pxPerCm(b.x, t, b.z)));
  poly(circlePts(b.x, b.z, r * 0.72, t + 0.001, 24), '#e4decf');
  for (let i = 0; i < 4; i++) { const a = btnAng + PI / 4 + i * PI / 2; poly(circlePts(b.x + Math.cos(a) * r * 0.24, b.z + Math.sin(a) * r * 0.24, r * 0.11, t + 0.002, 10), '#3a342a'); }
}
let railFx = [];
V.railHit = function (x, z, sp) { railFx.push({ x, z, life: 0.45, size: 1 + Math.min(4, sp / 40) }); if (sp > 90) shake = Math.max(shake, Math.min(0.8, sp / 300)); };

/* ---------- picking ---------- */
V.pickPlane = function (cx, cy) {
  const rc = cv.getBoundingClientRect(), sx = (cx - rc.left - ccx) / focal, sy = -(cy - rc.top - ccy) / focal;
  const d = [Fv[0] + Rv[0] * sx + Uv[0] * sy, Fv[1] + Rv[1] * sx + Uv[1] * sy, Fv[2] + Rv[2] * sx + Uv[2] * sy];
  if (d[1] >= -1e-4) return null;
  const t = -P[1] / d[1]; return { x: P[0] + d[0] * t, z: P[2] + d[2] * t };
};
V.toScreen = function (x, y, z) { const rc = cv.getBoundingClientRect(), s = scr(x, y, z) || [ccx, ccy]; return { x: rc.left + s[0], y: rc.top + s[1] }; };

/* ---------- frame ---------- */
function followCamera(dt) {
  const b = G.w.ball, port = portrait(), attDir = G.dir[G.turn];
  if (V.preset === 'broadcast') { goal.tx = port ? -16 * (V.flip ? -1 : 1) : b.x * 0.3; goal.tz = port ? b.z * 0.2 : 1 + b.z * 0.42; goal.ty = 0; goal.az = (port ? -PI / 2 : 0) + (V.flip || 0); }
  else if (V.preset === 'low') { goal.tx = port ? 0 : b.x * 0.45; goal.tz = port ? b.z * 0.3 : 4 + b.z * 0.42; goal.ty = 0; goal.az = (port ? -PI / 2 : 0) + (V.flip || 0); }
  else if (V.preset === 'top') { goal.tx = port ? 0 : b.x * 0.2; goal.tz = 0; goal.ty = 0; goal.az = (port ? -PI / 2 : 0) + (V.flip || 0); }
  else if (V.preset === 'behind') { goal.tx = b.x * 0.7; goal.tz = b.z * 0.5; goal.ty = 0; goal.az = -attDir * PI / 2; }
  else if (V.preset === 'ball') { goal.tx = b.x; goal.tz = b.z; goal.ty = 1; goal.az = -attDir * PI / 2; }
  else if (V.preset === 'play' && V.play) { goal.tx = V.play.tx; goal.tz = V.play.tz; goal.ty = 0; }
  else { goal.tx = b.x * 0.35; goal.tz = b.z * 0.4; goal.ty = 0; }
  const k = 1 - Math.exp(-dt * (V.preset === 'ball' ? 6 : 4));
  let da = goal.az - cam.az; da = Math.atan2(Math.sin(da), Math.cos(da));
  cam.az += da * k; for (const n of ['el', 'dist', 'tx', 'tz', 'ty']) cam[n] += (goal[n] - cam[n]) * k;
  shake *= Math.exp(-dt * 6);
}
V.frame = function (dt, nowS) {
  if (!G) return;
  followCamera(dt); setupCamera();
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawPatio(nowS);
  g.lineJoin = 'round';
  drawRails(false); drawGround();
  const w = G.w, b = w.ball;
  // ground layer: shadows, highlight rings, aim
  for (const p of w.players) {
    if (p.off) continue;
    const r = p.kind === 'k' ? C.kr : C.pr;
    if (p.kind === 'k') poly([[p.x + 0.4, 0.03, p.z - r + 0.5], [p.x + 1.4, 0.03, p.z - r + 0.9], [p.x + 1.4, 0.03, p.z + r + 0.9], [p.x + 0.4, 0.03, p.z + r + 0.5]], 'rgba(0,0,0,0.25)');
    else poly(circlePts(p.x + 0.35, p.z + 0.3, r * 1.08, 0.03, 20), 'rgba(0,0,0,0.3)');
    if (p.kind === 'k') { if (p.id === hover) poly(circlePts(p.x, p.z, r + 1.2, 0.06, 32), null, 'rgba(245,196,0,0.95)', 2.5); continue; }
    const ok = V.watch ? false : G.arrange ? (G.phase === 'ready' && V.cpu !== p.team && p.team === G.arrange.team) : (G.phase === 'ready' && p.team === G.turn && V.cpu !== p.team && (G.forced === null || G.forced === p.id));
    if (ok) poly(circlePts(p.x, p.z, r + 0.9, 0.06, 32), null, `rgba(255,255,255,${p.id === hover ? 0.95 : G.forced === p.id ? 0.85 : 0.4 + 0.2 * Math.sin(nowS * 4 + p.id)})`, 2.5);
  }
  const h = Math.max(0, b.y - C.br);
  poly(circlePts(b.x + 0.3 + h * 0.25, b.z + 0.25 + h * 0.2, C.br * (1 + h * 0.03), 0.03, 14), `rgba(0,0,0,${Math.max(0.12, 0.35 - h * 0.01)})`);
  if (aim) {
    const len = 3 + aim.power * 26, ex = aim.x + aim.dx * len, ez = aim.z + aim.dz * len, nx = -aim.dz, nz = aim.dx, y = 0.25;
    g.beginPath(); addLine(aim.x, aim.z, aim.x - aim.dx * len * 0.9, aim.z - aim.dz * len * 0.9, 0.18, y); g.fillStyle = 'rgba(255,255,255,0.4)'; g.fill();
    g.beginPath(); addLine(aim.x, aim.z, ex, ez, 0.7, y); addPoly([[ex + aim.dx * 2.6, y, ez + aim.dz * 2.6], [ex + nx * 1.2, y, ez + nz * 1.2], [ex - nx * 1.2, y, ez - nz * 1.2]]);
    g.fillStyle = aim.color; g.fill();
  }
  // objects, far to near
  const objs = [];
  for (const p of w.players) if (!p.off) objs.push({ d: depth(p.x, p.kind === 'k' ? C.kr : 0.4, p.z), f: () => (p.kind === 'k' ? drawKeeper(p) : drawCap(p)) });
  objs.push({ d: depth(b.x, b.y, b.z), f: () => drawBall(b, dt) });
  for (const s of [-1, 1]) objs.push({ d: depth(s * (C.HL + C.gd * 0.5), C.gh / 2, 0), f: () => drawGoal(s) });
  // referee
  const rs = refS, a = rs.anim;
  const tx = Math.max(-56, Math.min(56, b.x * 0.85)), dxr = tx - rs.x, still = a && a.t < 0.7;
  const stp = still ? 0 : Math.sign(dxr) * Math.min(Math.abs(dxr), 55 * dt); rs.x += stp;
  const lx = a ? a.px : b.x, lz = a ? a.pz : b.z, fa = Math.atan2(lz - rs.z, lx - rs.x), df = Math.atan2(Math.sin(fa - rs.face), Math.cos(fa - rs.face));
  rs.face += df * Math.min(1, dt * 8);
  let tR = Math.abs(stp) > 0.02 ? Math.sin(nowS * 11) * 0.35 : 0, tL = -tR, card = null, blow = 0;
  if (a) {
    a.t += dt; const k = Math.min(1, a.t / 0.3), out = a.t > 2.3 ? Math.max(0, 1 - (a.t - 2.3) / 0.4) : 1;
    if (a.call === 'half' || a.call === 'full') tR = tL = 2.9 * k * out;
    else if (a.card) { tR = 2.95 * k * out; tL = 1.45 * k * out; if (a.t < 2.5) card = a.card; }
    else if (a.call !== 'kickoff') tR = 1.5 * k * out;
    blow = a.t < 0.6 ? Math.abs(Math.sin(a.t * 30)) : 0;
    if (a.t > 2.8) rs.anim = null;
  }
  rs.arm += (tR - rs.arm) * Math.min(1, dt * 12); rs.armL += (tL - rs.armL) * Math.min(1, dt * 12);
  objs.push({ d: depth(rs.x, 2, rs.z), f: () => drawFigure({ x: rs.x, z: rs.z, y0: 0, face: rs.face, lean: 0, scale: 0.6, kit: REFKIT, main: REFKIT.a, sec: REFKIT.b, sleeve: REFKIT.a, collar: REFKIT.b,
    shorts: REFKIT.shorts, socks: REFKIT.socks, skin: SKIN[3], hair: HAIR[0], num: '', ink: '#fff', armR: rs.arm, armL: rs.armL, card, whistle: blow, isRef: true }) });
  objs.sort((p, q) => q.d - p.d).forEach(o => o.f());
  drawRails(true);
  for (const f of railFx) { f.life -= dt; const k = 1 - f.life / 0.45; poly(circlePts(f.x, f.z, 0.8 + k * f.size * 2, 0.3, 24), null, `rgba(255,243,214,${Math.max(0, 0.85 * (1 - k))})`, 2); }
  railFx = railFx.filter(f => f.life > 0);
  // confetti
  for (const c of conf) {
    c.vy -= 220 * dt; c.x += c.vx * dt; c.y = Math.max(0.2, c.y + c.vy * dt); c.z += c.vz * dt; c.life -= dt;
    if (c.y <= 0.2) { c.vx *= 0.8; c.vz *= 0.8; c.vy = 0; }
    const s = scr(c.x, c.y, c.z); if (s) { const k = pxPerCm(c.x, c.y, c.z); g.fillStyle = c.c; g.fillRect(s[0], s[1], Math.max(1.5, k * 0.9), Math.max(1.5, k * 0.9)); }
  }
  conf = conf.filter(c => c.life > 0);
  vignette();
};

root.View2D = V;
})(typeof self !== 'undefined' ? self : this);

