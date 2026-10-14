/* Flick Football models: textures, pitch, goals, figures, ball. Needs THREE, Phys. */
self.defineModels = function (root) {
'use strict';
const C = root.Phys.C, T = root.THREE;
const PI2 = Math.PI * 2;

function tex_(c) { const t = new T.CanvasTexture(c); t.anisotropy = 4; t.encoding = T.sRGBEncoding; return t; }
function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function tex(c, aniso) { const t = new T.CanvasTexture(c); t.anisotropy = aniso || 4; t.encoding = T.sRGBEncoding; return t; }

/* Jersey: u wraps around the torso. Front of the figure is u = 0.25, back is u = 0.75. */
function jerseyCanvas(kit, num, keeperCol) {
  const W = 256, H = 128, c = canvas(W, H), g = c.getContext('2d');
  const A = keeperCol || kit.a, B = keeperCol ? '#101214' : kit.b, pat = keeperCol ? 'hoops' : kit.pattern;
  g.fillStyle = A; g.fillRect(0, 0, W, H);
  g.fillStyle = B;
  if (pat === 'stripes') { for (let i = 0; i < 12; i += 2) g.fillRect(i * W / 12, 0, W / 12, H); }
  else if (pat === 'hoops') { for (let i = 1; i < 6; i += 2) g.fillRect(0, i * H / 6, W, H / 6); }
  else if (pat === 'halves') { g.fillRect(W * 0.25, 0, W * 0.5, H); }
  else if (pat === 'checker') { for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) if ((x + y) & 1) g.fillRect(x * W / 16, y * H / 8, W / 16, H / 8); }
  else if (pat === 'sash') {
    for (const cx of [W * 0.25, W * 0.75]) { g.save(); g.beginPath(); g.moveTo(cx - 34, 0); g.lineTo(cx - 6, 0); g.lineTo(cx + 34, H); g.lineTo(cx + 6, H); g.closePath(); g.fill(); g.restore(); }
  }
  g.fillStyle = B; g.fillRect(0, 0, W, 9);                         // collar band
  g.save(); g.font = '700 58px "Big Shoulders Display", Impact, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  const lum = c0 => { const n = parseInt(c0.slice(1), 16); return ((n >> 16) * 0.3 + ((n >> 8) & 255) * 0.59 + (n & 255) * 0.11); };
  const ink = pat === 'solid' || pat === 'halves' ? (lum(A) > 150 ? '#14181a' : '#f4f6f2') : (lum(A) > 150 && lum(B) > 150 ? '#14181a' : lum(A) < 110 && lum(B) < 110 ? '#f4f6f2' : '#14181a');
  g.fillStyle = ink; g.globalAlpha = 0.92;
  g.fillText(String(num), W * 0.75, H * 0.52);                     // back number
  g.font = '700 22px "Big Shoulders Display", Impact, sans-serif'; g.fillText(String(num), W * 0.25 + 26, H * 0.34); // small front number
  g.restore();
  return c;
}

function ballTexture() {
  const c = canvas(256, 128), g = c.getContext('2d');
  g.fillStyle = '#f6f5ef'; g.fillRect(0, 0, 256, 128);
  g.fillStyle = '#1b1d20';
  const pts = [[32, 32], [96, 32], [160, 32], [224, 32], [64, 64], [128, 64], [192, 64], [0, 64], [32, 96], [96, 96], [160, 96], [224, 96]];
  for (const [x, y] of pts) { g.beginPath(); for (let i = 0; i < 5; i++) { const a = i / 5 * PI2 - Math.PI / 2; g.lineTo(x + Math.cos(a) * 15, y + Math.sin(a) * 15 * 1.0); } g.closePath(); g.fill(); }
  g.fillStyle = '#d9d7cc'; g.fillRect(0, 0, 256, 6); g.fillRect(0, 122, 256, 6);
  return c;
}

function pitchCanvas() {
  const S = 10, w = (C.L + 2 * C.margin) * S, h = (C.W + 2 * C.margin) * S, c = canvas(w, h), g = c.getContext('2d');
  const X = x => (x + C.HL + C.margin) * S, Z = z => (z + C.HW + C.margin) * S;
  for (let i = 0; i < Math.ceil(C.L + 2 * C.margin) / 10; i++) { g.fillStyle = i % 2 ? '#2f7d46' : '#2a733f'; g.fillRect(i * 10 * S, 0, 10 * S, h); }
  g.fillStyle = 'rgba(8,24,14,0.28)'; g.fillRect(0, 0, w, h); g.clearRect(X(-C.HL), Z(-C.HW), C.L * S, C.W * S);
  for (let i = 0; i < Math.ceil(C.L + 2 * C.margin) / 10; i++) { g.fillStyle = i % 2 ? '#32864b' : '#2b7641'; g.fillRect(i * 10 * S, Z(-C.HW), 10 * S, C.W * S); }
  g.globalCompositeOperation = 'destination-over'; g.fillStyle = '#25663a'; g.fillRect(0, 0, w, h); g.globalCompositeOperation = 'source-over';
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 26000; i++) { g.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.05)'; g.fillRect(rnd() * w, rnd() * h, 2, 2); }
  g.strokeStyle = 'rgba(244,247,240,0.93)'; g.lineWidth = 0.55 * S; g.lineCap = 'butt';
  const line = (x1, z1, x2, z2) => { g.beginPath(); g.moveTo(X(x1), Z(z1)); g.lineTo(X(x2), Z(z2)); g.stroke(); };
  g.strokeRect(X(-C.HL), Z(-C.HW), C.L * S, C.W * S);
  line(0, -C.HW, 0, C.HW);
  g.beginPath(); g.arc(X(0), Z(0), 10 * S, 0, PI2); g.stroke();
  g.fillStyle = 'rgba(244,247,240,0.93)'; g.beginPath(); g.arc(X(0), Z(0), 0.7 * S, 0, PI2); g.fill();
  for (const s of [-1, 1]) {
    const gx = s * C.HL;
    g.strokeRect(Math.min(X(gx), X(gx - s * C.boxD)), Z(-C.boxHW), C.boxD * S, 2 * C.boxHW * S);
    g.strokeRect(Math.min(X(gx), X(gx - s * 8)), Z(-14), 8 * S, 28 * S);
    const px = gx - s * 12; g.beginPath(); g.arc(X(px), Z(0), 0.7 * S, 0, PI2); g.fill();
    const a0 = Math.acos((C.boxD - 12) / 10); g.beginPath();
    if (s > 0) g.arc(X(px), Z(0), 10 * S, Math.PI - a0, Math.PI + a0); else g.arc(X(px), Z(0), 10 * S, -a0, a0);
    g.stroke();
    for (const sz of [-1, 1]) { g.beginPath(); const sa = s > 0 ? (sz > 0 ? Math.PI : Math.PI / 2) : (sz > 0 ? Math.PI * 1.5 : 0); g.arc(X(gx), Z(sz * C.HW), 2.2 * S, sa, sa + Math.PI / 2); g.stroke(); }
  }
  return c;
}

function netTexture() {
  const c = canvas(128, 128), g = c.getContext('2d'); g.clearRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(240,244,240,0.85)'; g.lineWidth = 3;
  for (let i = 0; i <= 128; i += 16) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 128); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(128, i); g.stroke(); }
  const t = new T.CanvasTexture(c); t.wrapS = t.wrapT = T.RepeatWrapping; return t;
}

function buildTable(scene, aniso) {
  const pt = tex(pitchCanvas(), aniso);
  const top = new T.Mesh(new T.PlaneGeometry(C.L + 2 * C.margin, C.W + 2 * C.margin), new T.MeshStandardMaterial({ map: pt, roughness: 0.96, metalness: 0 }));
  top.rotation.x = -Math.PI / 2; top.receiveShadow = true; scene.add(top);
  const wood = new T.MeshStandardMaterial({ color: 0x6a4527, roughness: 0.55, metalness: 0.05 });
  const mx = C.HL + C.margin, mz = C.HW + C.margin, th = 5;
  const rails = [[0, -mz - th / 2, 2 * (mx + th), th], [0, mz + th / 2, 2 * (mx + th), th], [-mx - th / 2, 0, th, 2 * mz], [mx + th / 2, 0, th, 2 * mz]];
  for (const [x, z, w, d] of rails) { const m = new T.Mesh(new T.BoxGeometry(w, 4.2, d), wood); m.position.set(x, 1.4, z); m.castShadow = m.receiveShadow = true; scene.add(m); }
  const slab = new T.Mesh(new T.BoxGeometry(2 * (mx + th), 7, 2 * (mz + th)), new T.MeshStandardMaterial({ color: 0x4a2f1a, roughness: 0.7 }));
  slab.position.y = -3.6; slab.receiveShadow = true; scene.add(slab);
}

/* A football match on the TV: a pitch with its lines (drawn once). */
function tvCanvas() {
  const W = 256, H = 144, c = canvas(W, H), g = c.getContext('2d');
  for (let i = 0; i < 8; i++) { g.fillStyle = i % 2 ? '#37904f' : '#2f7d46'; g.fillRect(i * W / 8, 0, W / 8, H); }
  g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 2; g.strokeRect(10, 10, W - 20, H - 20);
  g.beginPath(); g.moveTo(W / 2, 10); g.lineTo(W / 2, H - 10); g.stroke(); g.beginPath(); g.arc(W / 2, H / 2, 18, 0, PI2); g.stroke();
  g.strokeRect(10, H / 2 - 30, 26, 60); g.strokeRect(W - 36, H / 2 - 30, 26, 60);
  g.fillStyle = '#fff'; g.beginPath(); g.arc(W * 0.62, H * 0.4, 3, 0, PI2); g.fill();
  g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(8, 8, 64, 14); g.fillStyle = '#fff'; g.font = '700 10px sans-serif'; g.fillText('NGR 1 - 0 BRA', 11, 18);
  return c;
}
/* The furniture, where the canvas view puts it: a TV on the house wall over a low console with a couch facing it,
   a grill on the left, and a small table with the tea and coffee things at the near end. */
function buildFurniture(scene, box, dark) {
  const { FY, DZ } = PD, TVX = 290;
  const std2 = (c, r, m) => new T.MeshStandardMaterial({ color: c, roughness: r === undefined ? 0.7 : r, metalness: m || 0 });
  const cast = m => { m.castShadow = m.receiveShadow = true; return m; };
  // TV and console
  cast(box(120, 46, 42, TVX, FY + 23, -DZ + 21, std2(0x3a2a20, 0.6)));
  box(124, 70, 4, TVX, FY + 147, -DZ + 2, std2(0x0b0d10, 0.3, 0.4));
  const screen = new T.Mesh(new T.PlaneGeometry(118, 64), new T.MeshBasicMaterial({ map: tex(tvCanvas()) })); screen.position.set(TVX, FY + 147, -DZ + 4.1); scene.add(screen);
  const tvGlow = new T.PointLight(0x78c8ff, 0.35, 260, 2); tvGlow.position.set(TVX, FY + 140, -DZ + 50); scene.add(tvGlow);
  // couch facing the TV
  const x0 = 205, x1 = 375, z0 = -205, z1 = -140, mid = (x0 + x1) / 2, F = std2(0x56646d, 0.95), D = std2(0x45525a, 0.95), L = std2(0x66757e, 0.95);
  const part = (a0, a1, y0, y1, b0, b1, m) => cast(box(a1 - a0, y1 - y0, b1 - b0, (a0 + a1) / 2, (y0 + y1) / 2, (b0 + b1) / 2, m));
  for (const [x, z] of [[x0 + 6, z0 + 6], [x1 - 6, z0 + 6], [x0 + 6, z1 - 6], [x1 - 6, z1 - 6]]) part(x - 2, x + 2, FY, FY + 12, z - 2, z + 2, std2(0x1c1f21, 0.5, 0.6));
  part(x0, x1, FY + 12, FY + 40, z0, z1, D); part(x0 + 12, mid - 1, FY + 40, FY + 50, z0 + 2, z1 - 14, L); part(mid + 1, x1 - 12, FY + 40, FY + 50, z0 + 2, z1 - 14, L);
  part(x0 + 10, x1 - 10, FY + 40, FY + 88, z1 - 14, z1, F); part(x0, x0 + 12, FY + 40, FY + 62, z0, z1, F); part(x1 - 12, x1, FY + 40, FY + 62, z0, z1, F);
  const pillow = part(x0 + 16, x0 + 40, FY + 50, FY + 74, z1 - 22, z1 - 14, std2(0xd6a43a, 0.9)); pillow.rotation.z = 0.15;
  // grill: legs, firebox, domed-ish lid, wooden side shelf, embers and smoke
  const gx = -335, gz = -175, steel = std2(0x26292c, 0.45, 0.6);
  for (const [a, b] of [[gx - 26, gz - 20], [gx + 26, gz - 20], [gx - 26, gz + 20], [gx + 26, gz + 20]]) part(a - 1.5, a + 1.5, FY, FY + 72, b - 1.5, b + 1.5, std2(0x16181a, 0.5, 0.6));
  part(gx - 32, gx + 32, FY + 22, FY + 25, gz - 24, gz + 24, std2(0x3a3f43, 0.6, 0.4));
  part(gx - 32, gx + 32, FY + 72, FY + 100, gz - 24, gz + 24, steel);
  const lid = new T.Mesh(new T.CylinderGeometry(22, 22, 60, 20, 1, false, 0, Math.PI), std2(0x33383c, 0.4, 0.6)); lid.rotation.z = Math.PI / 2; lid.position.set(gx, FY + 100, gz); lid.scale.set(1, 1, 0.75); cast(lid); scene.add(lid);
  part(gx + 32, gx + 58, FY + 94, FY + 97, gz - 18, gz + 18, std2(0x6b4a30, 0.7));
  const handle = new T.Mesh(new T.CylinderGeometry(0.9, 0.9, 36, 8), std2(0xb9bec2, 0.3, 0.8)); handle.rotation.z = Math.PI / 2; handle.position.set(gx, FY + 112, gz + 18); scene.add(handle);
  const ember = new T.PointLight(0xff7a3a, 0.5, 120, 2); ember.position.set(gx, FY + 104, gz + 30); scene.add(ember);
  const smokeMat = new T.MeshBasicMaterial({ color: 0xc8c8d2, transparent: true, opacity: 0.12, depthWrite: false });
  for (let i = 0; i < 4; i++) { const p = new T.Mesh(new T.SphereGeometry(8 + i * 4, 10, 8), smokeMat); p.position.set(gx + i * 6, FY + 130 + i * 26, gz); scene.add(p); }
  // tea and coffee table
  const tx = -290, tz = 235, top = FY + 62, wood = std2(0x7a5232, 0.6), china = std2(0xefe8dc, 0.35);
  for (const [a, b] of [[tx - 30, tz - 22], [tx + 30, tz - 22], [tx - 30, tz + 22], [tx + 30, tz + 22]]) part(a - 2, a + 2, FY, top - 3, b - 2, b + 2, std2(0x3a2a20, 0.6));
  part(tx - 36, tx + 36, top - 3, top, tz - 28, tz + 28, wood);
  part(tx - 26, tx + 26, top, top + 0.6, tz - 18, tz + 18, std2(0xb9a27e, 0.6));
  const pot = new T.Mesh(new T.SphereGeometry(7.5, 18, 12), china); pot.scale.y = 0.8; pot.position.set(tx - 12, top + 6.5, tz - 4); cast(pot); scene.add(pot);
  const spout = new T.Mesh(new T.CylinderGeometry(0.8, 1.4, 9, 8), china); spout.position.set(tx - 3, top + 9, tz - 4); spout.rotation.z = -0.9; scene.add(spout);
  const knob = new T.Mesh(new T.SphereGeometry(1.6, 8, 6), china); knob.position.set(tx - 12, top + 12.5, tz - 4); scene.add(knob);
  const press = new T.Mesh(new T.CylinderGeometry(4, 4, 18, 16), new T.MeshStandardMaterial({ color: 0x3b2a20, roughness: 0.2, metalness: 0.1, transparent: true, opacity: 0.85 })); press.position.set(tx + 14, top + 9, tz - 8); scene.add(press);
  const lidP = new T.Mesh(new T.CylinderGeometry(4.3, 4.3, 2, 16), std2(0xc9ccd0, 0.3, 0.8)); lidP.position.set(tx + 14, top + 19, tz - 8); scene.add(lidP);
  for (const [cx, cz] of [[tx + 2, tz + 9], [tx + 16, tz + 9], [tx - 14, tz + 10]]) {
    const saucer = new T.Mesh(new T.CylinderGeometry(4.4, 3.8, 0.6, 16), china); saucer.position.set(cx, top + 0.9, cz); scene.add(saucer);
    const cup = new T.Mesh(new T.CylinderGeometry(2.8, 2.2, 5, 14), china); cup.position.set(cx, top + 3.7, cz); cast(cup); scene.add(cup);
    const tea = new T.Mesh(new T.CircleGeometry(2.6, 14), std2(0x4a2c1a, 0.2)); tea.rotation.x = -Math.PI / 2; tea.position.set(cx, top + 5.8, cz); scene.add(tea);
  }
}

/* ---------- the back patio (realistic graphics) ----------
   The same garden as the canvas view, in the same places: a deck at -76 cm, the house wall behind the far end
   (brick, a lit window, a door and a lamp), a fence on the other three sides with string lights along the top,
   potted plants, trees beyond, and a dusk sky. Textures are drawn here on canvases, so nothing is downloaded.
   Returns the lights it adds, so the view can dim them on slow phones. */
const PD = { FY: -76, DX: 430, DZ: 340, FH: 185, HH: 330 };
function noise(g, w, h, n, a) { for (let i = 0; i < n; i++) { g.fillStyle = `rgba(0,0,0,${Math.random() * a})`; g.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 40, 1); } }
function deckCanvas() {                       // 8 boards, each 64 px tall, with grain, knots and dark gaps
  const W = 1024, H = 512, c = canvas(W, H), g = c.getContext('2d'), tones = ['#3b2517', '#332014', '#422a1a', '#2d1c11', '#382316', '#3f2819', '#30200f', '#3a2416'];   // dark coffee, burnt wood
  for (let i = 0; i < 8; i++) {
    g.fillStyle = tones[i]; g.fillRect(0, i * 64, W, 64);
    for (let k = 0; k < 90; k++) { g.strokeStyle = `rgba(14,7,3,${0.08 + Math.random() * 0.14})`; g.lineWidth = 1 + Math.random() * 1.5; const y = i * 64 + 4 + Math.random() * 56; g.beginPath(); g.moveTo(0, y); g.bezierCurveTo(W * 0.3, y + (Math.random() - 0.5) * 8, W * 0.6, y + (Math.random() - 0.5) * 8, W, y + (Math.random() - 0.5) * 6); g.stroke(); }
    const jx = (i * 397) % W; g.fillStyle = 'rgba(30,16,8,0.7)'; g.fillRect(jx, i * 64, 3, 64);                       // board ends
    for (let k = 0; k < 2; k++) { g.fillStyle = 'rgba(50,28,14,0.45)'; g.beginPath(); g.ellipse(Math.random() * W, i * 64 + 32, 9, 5, 0, 0, PI2); g.fill(); }
    g.fillStyle = '#110904'; g.fillRect(0, i * 64 + 61, W, 3);
  }
  return c;
}
function fenceCanvas() {                      // vertical boards
  const W = 512, H = 512, c = canvas(W, H), g = c.getContext('2d');
  for (let i = 0; i < 8; i++) {
    g.fillStyle = ['#6e4a31', '#664429', '#74503a', '#6a4630'][i % 4]; g.fillRect(i * 64, 0, 64, H);
    for (let k = 0; k < 40; k++) { g.strokeStyle = `rgba(30,18,10,${0.06 + Math.random() * 0.1})`; g.beginPath(); const x = i * 64 + 3 + Math.random() * 58; g.moveTo(x, 0); g.lineTo(x + (Math.random() - 0.5) * 6, H); g.stroke(); }
    g.fillStyle = '#2b1a0e'; g.fillRect(i * 64 + 61, 0, 3, H);
  }
  return c;
}
function brickCanvas() {
  const W = 512, H = 512, c = canvas(W, H), g = c.getContext('2d'), bw = 64, bh = 24;
  g.fillStyle = '#5a3127'; g.fillRect(0, 0, W, H);
  for (let r = 0; r < H / bh; r++) for (let x = -(r % 2) * bw / 2; x < W; x += bw) {
    const v = Math.random(); g.fillStyle = `rgb(${120 + v * 30 | 0},${58 + v * 16 | 0},${44 + v * 10 | 0})`; g.fillRect(x + 2, r * bh + 2, bw - 4, bh - 4);
  }
  noise(g, W, H, 900, 0.18);
  return c;
}
function skyCanvas() {
  const c = canvas(16, 512), g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 0, 512);
  gr.addColorStop(0, '#0f1430'); gr.addColorStop(0.32, '#2c2b52'); gr.addColorStop(0.46, '#8a5468'); gr.addColorStop(0.5, '#e39a6b'); gr.addColorStop(0.56, '#3a2a2e'); gr.addColorStop(1, '#1a1418');
  g.fillStyle = gr; g.fillRect(0, 0, 16, 512); return c;
}
function buildPatio(scene, aniso, lite) {
  const { FY, DX, DZ, FH, HH } = PD, lights = [];
  const rep = (c, rx, ry) => { const t = tex(c, aniso); t.wrapS = t.wrapT = T.RepeatWrapping; t.repeat.set(rx, ry); return t; };
  // sky dome and trees
  const sky = new T.Mesh(new T.SphereGeometry(1800, 32, 16), new T.MeshBasicMaterial({ map: tex(skyCanvas()), side: T.BackSide, fog: false, depthWrite: false }));
  scene.add(sky);
  const bark = new T.MeshLambertMaterial({ color: 0x1d1820 }), crown = new T.MeshLambertMaterial({ color: 0x241d2a });
  for (let i = 0; i < 16; i++) {
    const a = i / 16 * PI2 + 0.17 * Math.sin(i * 2.3), r = 760 + 140 * ((i * 37) % 5) / 4, x = Math.sin(a) * r * 1.15, z = Math.cos(a) * r, h = 330 + 70 * ((i * 53) % 4), cr = 120 + 30 * ((i * 29) % 3);
    const tr = new T.Mesh(new T.CylinderGeometry(9, 13, h - FY, 8), bark); tr.position.set(x, (h + FY) / 2, z); scene.add(tr);
    const cm = new T.Mesh(new T.IcosahedronGeometry(cr, 1), crown); cm.position.set(x, h, z); cm.scale.y = 0.85; scene.add(cm);
  }
  // deck
  const deck = new T.Mesh(new T.PlaneGeometry(2 * DX, 2 * DZ), new T.MeshStandardMaterial({ map: rep(deckCanvas(), 2 * DX / 220, 2 * DZ / 112), roughness: 0.82, metalness: 0 }));
  deck.rotation.x = -Math.PI / 2; deck.position.y = FY; deck.receiveShadow = true; scene.add(deck);
  // patio table under the board: slate top on black metal legs
  const mx = C.HL + C.margin + 5 + 7, mz = C.HW + C.margin + 5 + 7;
  const top = new T.Mesh(new T.BoxGeometry(2 * mx, 2.2, 2 * mz), new T.MeshStandardMaterial({ color: 0x4b5457, roughness: 0.6, metalness: 0.1 }));
  top.position.y = -8.3; top.receiveShadow = top.castShadow = true; scene.add(top);
  const metal = new T.MeshStandardMaterial({ color: 0x1c1f21, roughness: 0.45, metalness: 0.7 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) { const l = new T.Mesh(new T.BoxGeometry(4, -9.4 - FY, 4), metal); l.position.set(sx * (mx - 9), (FY - 9.4) / 2, sz * (mz - 9)); l.castShadow = true; scene.add(l); }
  // fence on three sides
  const fenceMat = new T.MeshStandardMaterial({ map: rep(fenceCanvas(), 2 * DX / 112, 1.6), roughness: 0.85 });
  const railMat = new T.MeshStandardMaterial({ color: 0x82593a, roughness: 0.75 });
  const fence = (len, x, z, ry) => {
    const m = fenceMat.clone(); m.map = fenceMat.map.clone(); m.map.needsUpdate = true; m.map.repeat.set(len / 112, 1.6);
    const f = new T.Mesh(new T.PlaneGeometry(len, FH), m); f.position.set(x, FY + FH / 2, z); f.rotation.y = ry; f.receiveShadow = true; scene.add(f);
    for (const y of [FY + FH - 3.5, FY + 58]) { const r = new T.Mesh(new T.BoxGeometry(len, 7, 4), railMat); r.position.set(x, y, z); r.rotation.y = ry; r.translateZ(2); scene.add(r); }
  };
  fence(2 * DX, 0, DZ, Math.PI); fence(2 * DZ, -DX, 0, Math.PI / 2); fence(2 * DZ, DX, 0, -Math.PI / 2);
  // house wall: brick, eaves, a lit window, a door and a lamp
  const wall = new T.Mesh(new T.PlaneGeometry(2 * DX, HH), new T.MeshStandardMaterial({ map: rep(brickCanvas(), 2 * DX / 100, HH / 100), roughness: 0.9 }));
  wall.position.set(0, FY + HH / 2, -DZ); wall.receiveShadow = true; scene.add(wall);
  const eave = new T.Mesh(new T.BoxGeometry(2 * DX, 14, 40), new T.MeshStandardMaterial({ color: 0x2f2a2c, roughness: 0.8 })); eave.position.set(0, FY + HH - 7, -DZ + 20); scene.add(eave);
  const dark = new T.MeshStandardMaterial({ color: 0x2b211d, roughness: 0.7 });
  const box = (w, h, d, x, y, z, m) => { const b = new T.Mesh(new T.BoxGeometry(w, h, d), m); b.position.set(x, y, z); scene.add(b); return b; };
  const wx = -125, wy = FY + 155;
  const glass = new T.Mesh(new T.PlaneGeometry(130, 120), new T.MeshBasicMaterial({ color: 0xffcf7e })); glass.position.set(wx, wy, -DZ + 0.5); scene.add(glass);
  box(142, 6, 5, wx, wy + 63, -DZ + 2, dark); box(142, 6, 5, wx, wy - 63, -DZ + 2, dark); box(6, 132, 5, wx - 68, wy, -DZ + 2, dark); box(6, 132, 5, wx + 68, wy, -DZ + 2, dark);
  box(4, 120, 3, wx, wy, -DZ + 2, dark); box(130, 4, 3, wx, wy, -DZ + 2, dark);
  box(100, 215, 4, 90, FY + 107.5, -DZ + 2, new T.MeshStandardMaterial({ color: 0x4a352a, roughness: 0.6 }));
  const lampBulb = new T.Mesh(new T.SphereGeometry(5, 12, 8), new T.MeshBasicMaterial({ color: 0xfff1c9 })); lampBulb.position.set(160, FY + 240, -DZ + 6); scene.add(lampBulb);
  const winLight = new T.PointLight(0xffb76b, 0.9, 520, 2); winLight.position.set(wx, wy, -DZ + 40); scene.add(winLight); lights.push(winLight);
  // potted plants
  const pot = new T.MeshStandardMaterial({ color: 0xa35a37, roughness: 0.8 }), leafA = new T.MeshStandardMaterial({ color: 0x2f5a33, roughness: 0.75, flatShading: true }), leafB = new T.MeshStandardMaterial({ color: 0x447a40, roughness: 0.75, flatShading: true });
  for (const [x, z] of [[-DX + 48, -DZ + 48], [DX - 48, -DZ + 48], [-DX + 48, DZ - 48], [DX - 48, DZ - 48], [180, -DZ + 40], [-260, -DZ + 40]]) {
    const p = new T.Mesh(new T.CylinderGeometry(22, 16, 42, 16), pot); p.position.set(x, FY + 21, z); p.castShadow = p.receiveShadow = true; scene.add(p);
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * PI2 + x * 0.01, l = new T.Mesh(new T.IcosahedronGeometry(17 + (i % 3) * 3, 0), i % 2 ? leafA : leafB);
      l.position.set(x + Math.cos(a) * 15, FY + 62 + ((i * 17) % 5) * 9, z + Math.sin(a) * 15); l.rotation.set(i, i * 2, 0); l.castShadow = true; scene.add(l);
    }
    const c = new T.Mesh(new T.IcosahedronGeometry(21, 0), leafB); c.position.set(x, FY + 98, z); scene.add(c);
  }
  // string lights along the fence and wall tops: sagging wire, bulbs every 36 cm, a few real lights for the glow
  const bulbMat = new T.MeshBasicMaterial({ color: 0xfff0c4 }), bulbGeo = new T.SphereGeometry(2.4, 8, 6), wireMat = new T.LineBasicMaterial({ color: 0x14100e });
  const corners = [[-DX, -DZ], [DX, -DZ], [DX, DZ], [-DX, DZ]], topY = FY + FH + 30, bulbs = [];
  for (let i = 0; i < 4; i++) {
    const [ax, az] = corners[i], [bx, bz] = corners[(i + 1) % 4], n = Math.round(Math.hypot(bx - ax, bz - az) / 120);
    for (let j = 0; j < n; j++) {
      const pts = [];
      for (let k = 0; k <= 10; k++) {
        const t = (j + k / 10) / n, u = k / 10, x = ax + (bx - ax) * t, z = az + (bz - az) * t, y = topY - 88 * u * (1 - u);
        pts.push(new T.Vector3(x, y, z));
        if (k % 3 === 1) bulbs.push([x, y - 3, z]);
      }
      scene.add(new T.Line(new T.BufferGeometry().setFromPoints(pts), wireMat));
    }
  }
  const inst = new T.InstancedMesh(bulbGeo, bulbMat, bulbs.length), mtx = new T.Matrix4();      // every bulb in one draw call
  bulbs.forEach((b, i) => inst.setMatrixAt(i, mtx.makeTranslation(b[0], b[1], b[2]))); scene.add(inst);
  buildFurniture(scene, box, dark);
  const nL = lite ? 2 : 4;
  for (let i = 0; i < nL; i++) { const a = (i + 0.5) / nL * PI2, L = new T.PointLight(0xffc27a, 0.55, 420, 2); L.position.set(Math.sin(a) * DX * 0.85, topY - 10, Math.cos(a) * DZ * 0.85); scene.add(L); lights.push(L); }
  return lights;
}

function buildGoals(scene) {
  const white = new T.MeshStandardMaterial({ color: 0xf4f6f2, roughness: 0.35, metalness: 0.15 });
  const nt = netTexture(), group = [];
  for (const s of [-1, 1]) {
    const gx = s * C.HL, hw = C.gw / 2, d = C.gd, h = C.gh, pr = C.postR;
    const cyl = (r, len, rotZ) => { const m = new T.Mesh(new T.CylinderGeometry(r, r, len, 14), white); m.castShadow = true; if (rotZ) m.rotation.x = Math.PI / 2; return m; };
    for (const z of [-hw, hw]) { const p = cyl(pr, h); p.position.set(gx, h / 2, z); scene.add(p); const b = cyl(0.22, d); b.rotation.z = Math.PI / 2; b.position.set(gx + s * d / 2, h, z); scene.add(b); const bp = cyl(0.22, h); bp.position.set(gx + s * d, h / 2, z); scene.add(bp); }
    const bar = cyl(pr, C.gw, true); bar.position.set(gx, h, 0); scene.add(bar);
    const rear = cyl(0.22, C.gw, true); rear.position.set(gx + s * d, h, 0); scene.add(rear);
    const mat = (rx, ry) => { const t = nt.clone(); t.needsUpdate = true; t.repeat.set(rx, ry); return new T.MeshBasicMaterial({ map: t, transparent: true, side: T.DoubleSide, depthWrite: false, opacity: 0.9 }); };
    const back = new T.Mesh(new T.PlaneGeometry(C.gw, h), mat(C.gw / 1.4, h / 1.4)); back.rotation.y = Math.PI / 2; back.position.set(gx + s * d, h / 2, 0); scene.add(back);
    for (const z of [-hw, hw]) { const sd = new T.Mesh(new T.PlaneGeometry(d, h), mat(d / 1.4, h / 1.4)); sd.position.set(gx + s * d / 2, h / 2, z); scene.add(sd); }
    const roof = new T.Mesh(new T.PlaneGeometry(d, C.gw), mat(d / 1.4, C.gw / 1.4)); roof.rotation.x = -Math.PI / 2; roof.position.set(gx + s * d / 2, h, 0); scene.add(roof);
    group.push(back);
  }
  return group;
}

const SKIN = ['#f1c9a5', '#d9a47a', '#a56b45', '#6b4328', '#e8b98f'], HAIR = ['#1a1412', '#3a2616', '#7a5232', '#0f0f10', '#b88a4a'];
const G = {
  base: new T.CylinderGeometry(1.9, 1.9, 0.36, 28), leg: new T.CylinderGeometry(0.52, 0.5, 1.25, 12), boot: new T.BoxGeometry(1.15, 0.5, 0.72),
  shorts: new T.CylinderGeometry(1.5, 1.6, 0.85, 20), torso: new T.CylinderGeometry(1.38, 1.5, 1.95, 28), arm: new T.CylinderGeometry(0.36, 0.34, 1.5, 10),
  head: new T.SphereGeometry(0.86, 18, 14), hair: new T.SphereGeometry(0.9, 18, 10, 0, PI2, 0, 1.25), hand: new T.SphereGeometry(0.4, 10, 8)
};
function std(c, r) { return new T.MeshStandardMaterial({ color: c, roughness: r === undefined ? 0.7 : r }); }

function buildFigure(kit, num, id, isKeeper) {
  const root = new T.Group(), body = new T.Group(); root.add(body);
  const kcol = isKeeper ? kit.keeper : null;
  const shirtTex = tex(jerseyCanvas(kit, num, kcol), 4);
  const torsoMat = new T.MeshStandardMaterial({ map: shirtTex, roughness: 0.75 });
  const sleeve = std(kcol || kit.a), baseCol = kcol || kit.a;
  const mk = (geo, mat, x, y, z) => { const m = new T.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; body.add(m); return m; };
  const baseM = mk(G.base, std(baseCol, 0.5), 0, 0.18, 0);
  const sockM = std(isKeeper ? '#16181b' : kit.socks), bootM = std('#15161a', 0.5);
  for (const z of [-0.72, 0.72]) { mk(G.leg, sockM, 0, 0.36 + 0.62, z); mk(G.boot, bootM, 0.28, 0.62, z); }
  mk(G.shorts, std(isKeeper ? '#16181b' : kit.shorts), 0, 1.62 + 0.4, 0);
  mk(G.torso, torsoMat, 0, 2.05 + 1.0, 0).rotation.y = 0;
  const sk = SKIN[id % SKIN.length], hair = HAIR[(id * 3 + 1) % HAIR.length];
  const head = mk(G.head, std(sk, 0.6), 0, 4.55 + 0.45, 0);
  const hr = mk(G.hair, std(hair, 0.9), 0, 5.05, 0); hr.rotation.z = 0.0;
  const arms = [];
  for (const z of [-1, 1]) {
    if (isKeeper) { const arm = mk(G.arm, sleeve, 0.2, 4.1, z * 2.2); arm.rotation.x = -z * 0.75; mk(G.hand, std('#f6f6f2', 0.5), 0.2, 4.85, z * 2.85).scale.setScalar(1.25); continue; }
    const piv = new T.Group(); piv.position.set(0, 4.3, z * 1.72); piv.rotation.x = -z * 0.12; body.add(piv);
    const arm = new T.Mesh(G.arm, sleeve); arm.position.y = -0.75; arm.castShadow = true; piv.add(arm);
    const hand = new T.Mesh(G.hand, std(sk, 0.6)); hand.position.y = -1.5; hand.castShadow = true; piv.add(hand);
    arms.push(piv);
  }
  if (isKeeper) root.scale.setScalar(1.12);
  return { root, body, base: baseM, tex: shirtTex, arms };
}
function buildRef() {
  const f = buildFigure({ a: '#17191c', b: '#f5c400', shorts: '#17191c', socks: '#17191c', pattern: 'solid' }, '', 3, false);
  f.base.material.color.set('#2a2d31');
  const wh = new T.Mesh(new T.CylinderGeometry(0.17, 0.17, 0.75, 10), new T.MeshStandardMaterial({ color: 0xd8dde2, metalness: 0.8, roughness: 0.25 }));
  wh.rotation.z = Math.PI / 2; wh.position.set(1.05, 4.72, 0); f.body.add(wh);
  const card = new T.Mesh(new T.BoxGeometry(0.14, 1.4, 1.0), new T.MeshStandardMaterial({ color: 0xf5c400, roughness: 0.5, emissive: 0x222200 }));
  card.position.set(0, -2.1, 0); card.visible = false; f.arms[1].add(card);
  f.card = card; f.whistle = wh; f.root.scale.setScalar(0.6);
  return f;
}

/* ---------- bottle caps ---------- */
function capTopCanvas(kit, num, keeperCol) {
  const S = 256, c = canvas(S, S), g = c.getContext('2d'), A = keeperCol || kit.a, B = keeperCol ? '#101214' : kit.b, pat = keeperCol ? 'hoops' : kit.pattern;
  g.fillStyle = A; g.fillRect(0, 0, S, S); g.fillStyle = B;
  if (pat === 'stripes') for (let i = 0; i < 8; i += 2) g.fillRect(i * S / 8 + S / 16, 0, S / 8, S);
  else if (pat === 'hoops') for (let i = 0; i < 8; i += 2) g.fillRect(0, i * S / 8 + S / 16, S, S / 8);
  else if (pat === 'halves') g.fillRect(S / 2, 0, S / 2, S);
  else if (pat === 'checker') for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) { if ((x + y) & 1) g.fillRect(x * S / 6, y * S / 6, S / 6, S / 6); }
  else if (pat === 'sash') { g.beginPath(); g.moveTo(0, S * 0.25); g.lineTo(S * 0.25, 0); g.lineTo(S, S * 0.75); g.lineTo(S * 0.75, S); g.closePath(); g.fill(); }
  // printed rim ring and a number roundel, like a soft-drink cap
  g.lineWidth = 14; g.strokeStyle = B; g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 10, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 4; g.strokeStyle = 'rgba(255,255,255,0.55)'; g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 22, 0, Math.PI * 2); g.stroke();
  g.fillStyle = 'rgba(250,250,246,0.94)'; g.beginPath(); g.arc(S / 2, S / 2, S * 0.24, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#14181a'; g.font = '800 92px "Big Shoulders Display", Impact, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(String(num), S / 2, S / 2 + 4);
  return c;
}
/* A hammered crown cap: crimped skirt (21 flutes), short side wall, 45° bevel, flat printed top. Axis is +y. */
function capGeometry(R, h, bv, amp) {
  const N = 84, F = 21, pos = [], idx = [];
  const ring = (rad, y, a) => { const s = pos.length / 3; for (let i = 0; i < N; i++) { const t = i / N * PI2, m = 1 + a * Math.cos(F * t); pos.push(Math.cos(t) * rad * m, y, Math.sin(t) * rad * m); } return s; };
  const cb = pos.length / 3; pos.push(0, 0, 0);
  const r1 = ring(R, 0, amp), r2 = ring(R, h - bv, amp), r3 = ring(R - bv, h, amp * 0.3);
  const ct = pos.length / 3; pos.push(0, h, 0);
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    idx.push(cb, r1 + j, r1 + i);
    idx.push(r1 + i, r1 + j, r2 + j, r1 + i, r2 + j, r2 + i);
    idx.push(r2 + i, r2 + j, r3 + j, r2 + i, r3 + j, r3 + i);
    idx.push(ct, r3 + i, r3 + j);
  }
  const geo = new T.BufferGeometry(); geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); geo.setIndex(idx); geo.computeVertexNormals();
  return geo;
}
function buildCap(kit, num, id, isKeeper) {
  const root = new T.Group(), body = new T.Group(); root.add(body);
  const col = isKeeper ? kit.keeper : kit.a;
  const tex = tex_(capTopCanvas(kit, num, isKeeper ? kit.keeper : null));
  const metal = new T.MeshStandardMaterial({ color: col, metalness: 0.55, roughness: 0.32 });
  const R = isKeeper ? C.kr : C.pr, h = isKeeper ? C.kt * 2 : C.ph, bv = isKeeper ? 0.12 : C.pbv;
  const cap = new T.Group();
  const shell = new T.Mesh(capGeometry(R, h, bv, isKeeper ? 0.06 : 0.035), metal); shell.castShadow = true; shell.receiveShadow = true; cap.add(shell);
  const top = new T.Mesh(new T.CircleGeometry((R - bv) * 0.98, 48), new T.MeshStandardMaterial({ map: tex, metalness: 0.25, roughness: 0.45 }));
  top.rotation.x = -Math.PI / 2; top.position.y = h + 0.004; cap.add(top);
  if (isKeeper) {
    // stand the cap on its edge with the printed face towards the pitch (+x in the figure's frame), on a bent-over foot
    cap.rotation.z = -Math.PI / 2; cap.position.set(-C.kt, R, 0);
    const foot = new T.Mesh(new T.BoxGeometry(1.1, 0.12, 1.6), metal); foot.position.set(-C.kt - 0.55, 0.06, 0); foot.castShadow = true;
    body.add(foot);
  }
  body.add(cap);
  return { root, body, tex, base: shell };
}

/* The ball is a flat four-hole shirt button that slides on the table. */
function buttonCanvas() {
  const S = 256, c = canvas(S, S), g = c.getContext('2d');
  g.fillStyle = '#f1ece0'; g.fillRect(0, 0, S, S);
  const rg = g.createRadialGradient(S / 2, S / 2, S * 0.1, S / 2, S / 2, S * 0.36); rg.addColorStop(0, '#e2dccd'); rg.addColorStop(1, '#f6f2e8');
  g.fillStyle = rg; g.beginPath(); g.arc(S / 2, S / 2, S * 0.36, 0, PI2); g.fill();
  g.strokeStyle = '#cfc7b4'; g.lineWidth = 10; g.beginPath(); g.arc(S / 2, S / 2, S * 0.4, 0, PI2); g.stroke();
  g.fillStyle = '#3a342a';
  for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { g.beginPath(); g.arc(S / 2 + x * S * 0.085, S / 2 + y * S * 0.085, S * 0.042, 0, PI2); g.fill(); }
  return c;
}
function buildBall() {
  const grp = new T.Group();
  const body = new T.Mesh(new T.CylinderGeometry(C.br, C.br * 0.96, C.bt, 40), new T.MeshStandardMaterial({ color: 0xe6e0d0, roughness: 0.38 }));
  body.castShadow = true; grp.add(body);
  const top = new T.Mesh(new T.CircleGeometry(C.br * 0.99, 40), new T.MeshStandardMaterial({ map: tex(buttonCanvas(), 4), roughness: 0.32 }));
  top.rotation.x = -Math.PI / 2; top.position.y = C.bt / 2 + 0.003; grp.add(top);
  return grp;
}

root.Models = { buildTable, buildGoals, buildFigure, buildBall, buildRef, buildCap, buildPatio };
};

