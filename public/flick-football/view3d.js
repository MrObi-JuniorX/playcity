/* Flick Football view: scene, camera presets, mesh sync, aim arrow, effects. Needs THREE, Phys, Models. */
self.defineView3D = function (root) {
'use strict';
const T = root.THREE, C = root.Phys.C, M = root.Models;
const V = { preset: 'broadcast' };
let ballHalo = null;
let renderer, scene, camera, dirLight, ballMesh, figs = [], rings = [], aim, aimLine, confetti, G = null, container, t0 = 0;
const cam = { az: 0, el: 0.95, dist: 150, tx: 0, tz: 0, ty: 0 };      // current (smoothed)
const goal = { az: 0, el: 0.95, dist: 150, tx: 0, tz: 0, ty: 0 };     // wanted
/* Touch camera, the way map and 3D viewers do it: once someone pans or zooms toward a point, the view stays where
   they put it (pinned) instead of drifting after the ball; a fling keeps turning briefly; double tap resets. */
let pinned = false, flingAz = 0, flingEl = 0, outlines = [], maxAniso = 4, orientTimer = null;
const ray = new T.Raycaster(), plane = new T.Plane(new T.Vector3(0, 1, 0), 0), ndc = new T.Vector2(), hit = new T.Vector3();
const spinQ = new T.Quaternion(), axis = new T.Vector3();
let hoverId = -1, shake = 0, ref = null;
const boxHints = {};
const refS = { x: 0, z: -(C.HW + 4), face: Math.PI / 2, anim: null };

V.init = function (el) {
  container = el;
  // Try full quality first, then lighter settings that more phones accept.
  let lastErr = null, lite = false;
  // Phones: a high-density screen hides jaggies, so skip antialiasing there and spend the GPU on frame rate.
  const phone = V.phone = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
  const tries = [{ antialias: !(phone && (window.devicePixelRatio || 1) >= 2), powerPreference: 'high-performance' }, { antialias: false }, { antialias: false, powerPreference: 'low-power', precision: 'mediump', failIfMajorPerformanceCaveat: false }];
  for (let i = 0; i < tries.length && !renderer; i++) {
    try { const r = new T.WebGLRenderer(tries[i]); if (r.getContext()) { renderer = r; lite = i > 0; } } catch (e) { lastErr = e; }
  }
  if (!renderer) throw lastErr || new Error('WebGL is not available');
  // Small or low-density screens: draw above the screen's own resolution (supersampling), so cap edges, numbers
  // and lines stay crisp where there are few pixels to spend. The frame-rate governor steps this down if needed.
  const dpr = window.devicePixelRatio || 1, area = (el.clientWidth || 800) * (el.clientHeight || 500);
  V.maxScale = lite ? Math.min(dpr, 1.25) : Math.min(2, dpr < 2 && area < 900000 ? Math.max(1.5, dpr * 1.5) : dpr);
  renderer.setPixelRatio(V.maxScale);
  renderer.shadowMap.enabled = !lite; renderer.shadowMap.type = phone ? T.PCFShadowMap : T.PCFSoftShadowMap;
  renderer.outputEncoding = T.sRGBEncoding; renderer.toneMapping = T.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  el.appendChild(renderer.domElement);
  // Dusk on the back patio: a cool sky light, a warm low key light over the board, the patio's own lamps (models.js).
  scene = new T.Scene(); scene.background = new T.Color(0x1a1622); scene.fog = new T.Fog(0x2e2634, 520, 1700);
  camera = new T.PerspectiveCamera(36, 1, 5, 4000);
  scene.add(new T.HemisphereLight(0xb9b2d6, 0x3a2a20, 0.55));
  dirLight = new T.DirectionalLight(0xffe2c0, 0.95); dirLight.position.set(-40, 140, 60); dirLight.castShadow = true;
  dirLight.shadow.mapSize.set(phone ? 1024 : 2048, phone ? 1024 : 2048); const sc = dirLight.shadow.camera; sc.left = -92; sc.right = 92; sc.top = 72; sc.bottom = -72; sc.near = 20; sc.far = 320; dirLight.shadow.bias = -0.0004;
  scene.add(dirLight);
  const rim = new T.PointLight(0x9fb8ff, 0.3, 400); rim.position.set(60, 60, -90); scene.add(rim);
  maxAniso = renderer.capabilities.getMaxAnisotropy();
  M.buildTable(scene, maxAniso); M.buildGoals(scene); V.patioLights = M.buildPatio(scene, maxAniso, lite || phone);
  ballMesh = M.buildBall(); scene.add(ballMesh);
  /* The button is 2 cm across: on a phone it can shrink to a few pixels. A ring keeps it findable, and the
     button itself is drawn a little larger when tiny. Both are only for the eye; the physics never changes. */
  ballHalo = new T.Group();
  // A target marker, not a ring: four short white arcs on a dark backing. A solid coloured ring read as a cap
  // (a yellow ring looked like a yellow-kit player); no kit looks like broken white brackets.
  const arc = (a, b, col, op, t0, len) => { const m = new T.Mesh(new T.RingGeometry(a, b, 24, 1, t0, len), new T.MeshBasicMaterial({ color: col, transparent: true, opacity: op, depthWrite: false, side: T.DoubleSide })); m.rotation.x = -Math.PI / 2; ballHalo.add(m); return m; };
  for (let q = 0; q < 4; q++) {
    const t0 = q * Math.PI / 2 + Math.PI / 4 - 0.42;
    arc(C.br * 1.42, C.br * 2.08, 0x05080a, 0.8, t0 - 0.06, 0.96);   // dark edge so it shows on light kits and lines
    arc(C.br * 1.55, C.br * 1.95, 0xffffff, 0.98, t0, 0.84);
  }
  ballHalo.position.y = 0.05; scene.add(ballHalo);
  ref = M.buildRef(); scene.add(ref.root);
  for (const s of [-1, 1]) {
    const m = new T.Mesh(new T.PlaneGeometry(C.sixD, 2 * C.sixHW), new T.MeshBasicMaterial({ color: 0xf5c400, transparent: true, opacity: 0.22, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; m.position.set(s * (C.HL - C.sixD / 2), 0.08, 0); m.visible = false; scene.add(m); boxHints[s] = m;
  }
  // aim arrow (shaft + head), pull line
  aim = new T.Group();
  const sg = new T.BoxGeometry(1, 0.12, 0.7); sg.translate(0.5, 0, 0);
  aim.shaft = new T.Mesh(sg, new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 }));
  aim.head = new T.Mesh(new T.ConeGeometry(1.2, 2.6, 16), aim.shaft.material); aim.head.rotation.z = -Math.PI / 2;
  aim.add(aim.shaft, aim.head); aim.visible = false; aim.position.y = 0.25; scene.add(aim);
  aimLine = new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(), new T.Vector3(1, 0, 0)]), new T.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4 }));
  aimLine.visible = false; scene.add(aimLine);
  // confetti
  const N = 260, pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
  const cg = new T.BufferGeometry(); cg.setAttribute('position', new T.BufferAttribute(pos, 3)); cg.setAttribute('color', new T.BufferAttribute(col, 3));
  confetti = new T.Points(cg, new T.PointsMaterial({ size: 1.6, vertexColors: true, transparent: true, depthWrite: false }));
  confetti.vel = new Float32Array(N * 3); confetti.life = 0; confetti.visible = false; confetti.frustumCulled = false; scene.add(confetti);
  window.addEventListener('resize', V.resize); V.resize();
  renderer.setAnimationLoop(null);
};

V.attach = function (game) {
  G = game;
  for (const f of figs) { scene.remove(f.root); f.tex.dispose(); } figs = [];
  for (const r of rings) scene.remove(r); rings = [];
  for (const o of outlines) if (o) scene.remove(o); outlines = [];
  for (const p of G.w.players) {
    const f = M.buildCap(G.kits[p.team], p.num, p.id, p.kind === 'k'); scene.add(f.root); figs[p.id] = f;
    f.tex.anisotropy = maxAniso; f.tex.needsUpdate = true;          // printed tops stay sharp at a low angle
    if (p.kind !== 'k') {
      // A dark outline under each cap: on a small or dim screen the green pitch and a dark kit blur together without it.
      const o = new T.Mesh(new T.RingGeometry(C.pr * 0.96, C.pr + 0.38, 48), new T.MeshBasicMaterial({ color: 0x040706, transparent: true, opacity: 0.6, depthWrite: false, side: T.DoubleSide }));
      o.rotation.x = -Math.PI / 2; o.position.y = 0.035; scene.add(o); outlines[p.id] = o;
    }
    {
      const isK = p.kind === 'k';
      const r = new T.Mesh(isK ? new T.RingGeometry(C.kr + 0.6, C.kr + 1.2, 40) : new T.RingGeometry(C.pr + 0.45, C.pr + 1.0, 40), new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, side: T.DoubleSide }));
      r.rotation.x = -Math.PI / 2; r.position.y = 0.06; scene.add(r); rings[p.id] = r;
    }
  }
  V.setPreset(V.preset, true);
};

/* Quality steps for the frame-rate governor: render scale first, then shadows. */
V.dispose = function () {
  window.removeEventListener('resize', V.resize); clearTimeout(orientTimer);
  scene.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) [].concat(o.material).forEach(m => { if (m.map) m.map.dispose(); m.dispose(); }); });
  renderer.dispose(); if (renderer.forceContextLoss) renderer.forceContextLoss(); renderer.domElement.remove();
};
V.getScale = () => renderer.getPixelRatio();
V.setScale = r => { renderer.setPixelRatio(r); V.resize(); };
V.setShadows = on => { if (renderer.shadowMap.enabled === on) return; renderer.shadowMap.enabled = on; scene.traverse(o => { if (o.material) o.material.needsUpdate = true; }); };
V.shadows = () => renderer.shadowMap.enabled;

let lastPortrait = null;
V.resize = function () {
  if (!container) return; const w = container.clientWidth || 800, h = container.clientHeight || 500;
  renderer.setSize(w, h, false); renderer.domElement.style.width = '100%'; renderer.domElement.style.height = '100%';
  camera.aspect = w / h; camera.fov = w / h < 1 ? 52 : 36; camera.updateProjectionMatrix();
  // A phone turned mid-match. Phones report several sizes while rotating, so wait for it to settle, then put the
  // table the right way round: presets re-apply, and a view the player set keeps its tilt and turn (rotated a
  // quarter so the pitch stays along the long side), with the whole table fitted to the new shape.
  if (FIT[V.preset]) goal.dist = Math.min(300, Math.max(PRESET[V.preset].dist * 0.8, fitDist(goal.el, camera.aspect, camera.fov)));
  clearTimeout(orientTimer);
  orientTimer = setTimeout(() => {
    const ww = container.clientWidth || 800, hh = container.clientHeight || 500, portrait = ww / hh < 0.9;
    if (lastPortrait !== null && portrait !== lastPortrait) {
      if (FIT[V.preset]) V.setPreset(V.preset);
      else { goal.az += portrait ? -Math.PI / 2 : Math.PI / 2; pinned = false; goal.dist = Math.min(D_MAX, Math.max(D_MIN, fitDist(goal.el, camera.aspect, camera.fov))); flingAz = flingEl = 0; }
    }
    lastPortrait = portrait;
  }, lastPortrait === null ? 0 : 180);
};

const PRESET = {
  top: { el: 1.55, dist: 150 }, broadcast: { el: 1.1, dist: 168 }, low: { el: 0.42, dist: 165 },
  behind: { el: 0.72, dist: 118 }, ball: { el: 0.62, dist: 62 }
};

/* Distance at which the whole table fits the board area for the preset views. */
function fitDist(el, aspect, vfovDeg) {
  const port = aspect < 0.9, v = vfovDeg * Math.PI / 180, h = 2 * Math.atan(Math.tan(v / 2) * aspect);
  const extH = (port ? C.HW : C.HL) + C.margin + 8, extV = ((port ? C.HL : C.HW) + C.margin + 9) * Math.sin(el) + 4 * Math.cos(el);
  return Math.max(extH / Math.tan(h / 2), extV / Math.tan(v / 2)) / (port ? 1.5 : 1) * 1.12;
}
const FIT = { broadcast: 1, low: 1, top: 1 };
V.setPreset = function (name, snap) {
  V.preset = name; pinned = false; flingAz = flingEl = 0;
  if (PRESET[name]) Object.assign(goal, PRESET[name]);
  if (name === 'play' && V.play) { const q = V.play; Object.assign(goal, { az: q.az, el: q.el, dist: q.dist, tx: q.tx, tz: q.tz, ty: 0 }); }
  if (name === 'top' || name === 'broadcast' || name === 'low') goal.az = (camera && camera.aspect < 0.9 ? -Math.PI / 2 : 0) + (V.flip || 0);
  if (FIT[name] && camera) goal.dist = Math.min(D_MAX, Math.max(PRESET[name].dist * 0.8, fitDist(goal.el, camera.aspect, camera.fov)));
  if (snap) Object.assign(cam, goal);
};
const EL_MIN = 0.16, EL_MAX = 1.55, D_MIN = 40, D_MAX = 300;
/* The best view for a set piece, worked out by the game: { az, el, dist, tx, tz }. */
V.setPlay = function (v) { V.play = v; V.setPreset('play'); };
V.orbit = function (daz, del) {
  if (daz) { V.preset = 'free'; goal.az += daz; }
  goal.el = Math.max(EL_MIN, Math.min(EL_MAX, goal.el + del));
};
V.zoom = function (f) { goal.dist = Math.max(D_MIN, Math.min(D_MAX, goal.dist * f)); };
/* Pinch zoom toward the point between the fingers, so what is under them stays under them. */
V.zoomAt = function (f, sx, sy) {
  const before = goal.dist; V.zoom(f);
  const p = V.pickPlane(sx, sy); if (!p) return;
  const k = 1 - goal.dist / before; if (!k) return;
  pinTarget(); goal.tx += (p.x - goal.tx) * k; goal.tz += (p.z - goal.tz) * k; clampTarget();
};
/* Two-finger pan: move the table with the fingers, in screen pixels. */
V.pan = function (dx, dy) {
  pinTarget();
  const h = renderer.domElement.clientHeight || 500, D = cam.dist * (camera.aspect < 0.9 ? 1.5 : 1);
  const s = 2 * D * Math.tan(camera.fov * Math.PI / 360) / h;            // world units per pixel at the target
  const az = cam.az, rx = Math.cos(az), rz = -Math.sin(az), fx = -Math.sin(az), fz = -Math.cos(az);
  const up = s / Math.max(0.35, Math.sin(cam.el));                       // a tilted table moves further per pixel up the screen
  goal.tx += -dx * s * rx + dy * up * fx; goal.tz += -dx * s * rz + dy * up * fz; clampTarget();
};
/* Let go mid-turn: keep turning for a moment and ease off, as orbit viewers do. */
V.fling = function (vaz, vel) { flingAz = Math.max(-4, Math.min(4, vaz)); flingEl = Math.max(-2, Math.min(2, vel)); if (flingAz) V.preset = 'free'; };
V.stopFling = function () { flingAz = flingEl = 0; };
/* Double tap: back to the standard view of the whole table. */
V.reset = function () { V.setPreset('broadcast'); };
V.pinned = () => pinned;
function pinTarget() { if (!pinned) { pinned = true; V.preset = 'free'; goal.tx = cam.tx; goal.tz = cam.tz; goal.ty = 0; } }
function clampTarget() { goal.tx = Math.max(-C.HL - 6, Math.min(C.HL + 6, goal.tx)); goal.tz = Math.max(-C.HW - 6, Math.min(C.HW + 6, goal.tz)); }
/* Camera as plain numbers for the view panel: tilt 0 = table level, 1 = overhead; turn in radians; zoom 0 = close, 1 = far. */
V.getCam = function () { return { tilt: (goal.el - EL_MIN) / (EL_MAX - EL_MIN), turn: Math.atan2(Math.sin(goal.az), Math.cos(goal.az)), zoom: (goal.dist - D_MIN) / (D_MAX - D_MIN) }; };
V.setCam = function (o) {
  if (o.tilt != null) goal.el = EL_MIN + o.tilt * (EL_MAX - EL_MIN);
  if (o.zoom != null) goal.dist = D_MIN + o.zoom * (D_MAX - D_MIN);
  if (o.turn != null) { V.preset = 'free'; let d = o.turn - goal.az; d = Math.atan2(Math.sin(d), Math.cos(d)); goal.az += d; }
};
let zDisc = null, zRect = null;
V.setZoneHint = function (Z) {
  if (!zDisc) {
    const m = new T.MeshBasicMaterial({ color: 0xf5c400, transparent: true, opacity: 0.2, depthWrite: false });
    zDisc = new T.Mesh(new T.CircleGeometry(1, 48), m); zRect = new T.Mesh(new T.PlaneGeometry(1, 1), m);
    for (const o of [zDisc, zRect]) { o.rotation.x = -Math.PI / 2; o.position.y = 0.09; o.visible = false; scene.add(o); }
  }
  zDisc.visible = !!Z && Z.type === 'disc'; zRect.visible = !!Z && Z.type === 'rect';
  if (Z && Z.type === 'disc') { zDisc.position.set(Z.x, 0.09, Z.z); zDisc.scale.set(Z.r, Z.r, 1); }
  if (Z && Z.type === 'rect') { zRect.position.set((Z.x0 + Z.x1) / 2, 0.09, (Z.z0 + Z.z1) / 2); zRect.scale.set(Z.x1 - Z.x0, Z.z1 - Z.z0, 1); }
};
V.setBoxHint = function (side) { for (const s of [-1, 1]) if (boxHints[s]) boxHints[s].visible = side === s; };
V.setHover = function (id) { hoverId = id; };
V.shake = function (a) { shake = Math.max(shake, a); };
V.canvas = function () { return renderer.domElement; };
V.toScreen = function (x, y, z) { const r = renderer.domElement.getBoundingClientRect(), p = new T.Vector3(x, y, z).project(camera); return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height }; };
V.getAz = function () { return cam.az; };
/* The camera has reached where it is going (the game draws less often while nothing moves). */
V.settled = function () { let da = goal.az - cam.az; da = Math.atan2(Math.sin(da), Math.cos(da)); return !flingAz && !flingEl && Math.abs(da) < 1e-3 && Math.abs(goal.el - cam.el) < 1e-3 && Math.abs(goal.dist - cam.dist) < 0.05 && Math.abs(goal.tx - cam.tx) < 0.05 && Math.abs(goal.tz - cam.tz) < 0.05 && shake < 0.01 && !confetti.visible; };

V.pickPlane = function (cx, cy) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  return ray.ray.intersectPlane(plane, hit) ? { x: hit.x, z: hit.z } : null;
};
V.setAim = function (x, z, dx, dz, power, color) {
  const len = 3 + power * 26, a = Math.atan2(dz, dx);
  aim.position.set(x, 0.25, z); aim.rotation.y = -a; aim.shaft.scale.set(len, 1, 1); aim.head.position.set(len + 1.1, 0, 0);
  aim.shaft.material.color.set(color); aim.visible = true;
  const pts = aimLine.geometry.attributes.position; pts.setXYZ(0, x, 0.2, z); pts.setXYZ(1, x - dx * (3 + power * 26) * 0.9, 0.2, z - dz * (3 + power * 26) * 0.9); pts.needsUpdate = true; aimLine.visible = true;
};
const railFx = [];
V.railHit = function (x, z, sp) {
  const m = new T.Mesh(new T.RingGeometry(0.6, 1.0, 28), new T.MeshBasicMaterial({ color: 0xfff3d6, transparent: true, opacity: 0.8, depthWrite: false, side: T.DoubleSide }));
  m.rotation.x = -Math.PI / 2; m.position.set(x, 0.25, z); m.life = 0.45; m.size = 1 + Math.min(4, sp / 40); scene.add(m); railFx.push(m);
  if (sp > 90) shake = Math.max(shake, Math.min(0.8, sp / 300));
};
V.refCall = function (e) { refS.anim = { t: 0, call: e.call, px: e.x, pz: e.z, card: e.card }; };
V.hideAim = function () { aim.visible = false; aimLine.visible = false; };

V.burst = function (hexA, hexB) {
  const a = new T.Color(hexA), b = new T.Color(hexB), P = confetti.geometry.attributes.position, K = confetti.geometry.attributes.color, N = P.count;
  const gx = G ? G.w.ball.x : 0;
  for (let i = 0; i < N; i++) {
    P.setXYZ(i, gx * 0.9 + (Math.random() - 0.5) * 16, 6 + Math.random() * 6, (Math.random() - 0.5) * 20);
    const c = Math.random() < 0.5 ? a : b; K.setXYZ(i, c.r, c.g, c.b);
    confetti.vel[i * 3] = (Math.random() - 0.5) * 60; confetti.vel[i * 3 + 1] = 70 + Math.random() * 120; confetti.vel[i * 3 + 2] = (Math.random() - 0.5) * 60;
  }
  confetti.life = 3.2; confetti.visible = true; P.needsUpdate = true; K.needsUpdate = true; shake = 1.2;
};

V.frame = function (dt, nowS) {
  if (!G) return;
  const w = G.w, b = w.ball;
  /* ball */
  ballMesh.position.set(b.x, b.y, b.z);
  {                                                  // ball size on screen, in CSS pixels
    const h = renderer.domElement.clientHeight || 500, d = camera.position.distanceTo(ballMesh.position) || 1;
    const rpx = C.br * (h / 2) / Math.tan(camera.fov * Math.PI / 360) / d;
    const grow = Math.min(1.7, Math.max(1, 5 / rpx)); ballMesh.scale.set(grow, 1, grow);
    const k = Math.max(1, 8 / rpx), show = rpx < 14;
    ballHalo.visible = show && !b.inNet; ballHalo.position.x = b.x; ballHalo.position.z = b.z; ballHalo.scale.set(k, 1, k);
  }
  const wm = Math.hypot(b.wx, b.wy, b.wz);
  if (wm > 1e-3) { axis.set(b.wx / wm, b.wy / wm, b.wz / wm); spinQ.setFromAxisAngle(axis, wm * dt); ballMesh.quaternion.premultiply(spinQ); }
  /* figures */
  const eligible = G.phase === 'ready';
  const hpx = renderer.domElement.clientHeight || 500, focal = (hpx / 2) / Math.tan(camera.fov * Math.PI / 360);
  for (const p of w.players) {
    const f = figs[p.id]; if (!f) continue;
    f.root.visible = !p.off; f.root.position.set(p.x, 0, p.z); f.root.rotation.y = -p.face;
    const o = outlines[p.id];
    if (o) {
      o.visible = !p.off; o.position.x = p.x; o.position.z = p.z;
      // Caps a few pixels across get drawn up to a quarter larger (for the eye only, like the ball; physics unchanged).
      const rpx = C.pr * focal / (camera.position.distanceTo(f.root.position) || 1), g = Math.min(1.25, Math.max(1, 7 / rpx));
      f.body.scale.set(g, 1, g); o.scale.set(g, g, 1);
    }
    if (p.kind === 'k') {
      const sgn = Math.cos(p.face) >= 0 ? 1 : -1, tgt = p.diving ? sgn * Math.sign(p.vz || 1) * 0.5 * Math.min(1, p.diveT / 0.08) : sgn * Math.max(-0.15, Math.min(0.15, p.vz / 600));
      f.body.rotation.x += (tgt - f.body.rotation.x) * Math.min(1, dt * 22); f.body.position.y = p.y;
    }
    const r = rings[p.id]; if (r) {
      r.position.set(p.x, 0.06, p.z);
      if (p.kind === 'k') { r.material.color.set(0xf5c400); r.material.opacity = p.id === hoverId ? 0.9 : 0; continue; }
      const ok = V.watch ? false : G.arrange ? (eligible && !p.off && V.cpu !== p.team && p.team === G.arrange.team) : (eligible && !p.off && !(V.cpu === p.team) && p.team === G.turn && (G.forced === null || G.forced === p.id));
      r.material.color.set(0xffffff);
      r.material.opacity = ok ? (p.id === hoverId ? 0.95 : G.forced === p.id ? 0.85 : 0.38 + 0.2 * Math.sin(nowS * 4 + p.id)) : 0;
    }
  }
  for (let i = railFx.length - 1; i >= 0; i--) { const m = railFx[i]; m.life -= dt; const k = 1 - m.life / 0.45; m.scale.setScalar(1 + k * m.size * 2); m.material.opacity = Math.max(0, 0.8 * (1 - k)); if (m.life <= 0) { scene.remove(m); m.geometry.dispose(); m.material.dispose(); railFx.splice(i, 1); } }
  /* referee */
  if (ref) {
    const rs = refS, a = rs.anim;
    const tx = Math.max(-56, Math.min(56, b.x * 0.85)), dxr = tx - rs.x, still = a && a.t < 0.7;
    const stp = still ? 0 : Math.sign(dxr) * Math.min(Math.abs(dxr), 55 * dt); rs.x += stp;
    const lx = a ? a.px : b.x, lz = a ? a.pz : b.z;
    const fa = Math.atan2(lz - rs.z, lx - rs.x), df = Math.atan2(Math.sin(fa - rs.face), Math.cos(fa - rs.face)); rs.face += df * Math.min(1, dt * 8);
    ref.root.position.set(rs.x, 0, rs.z); ref.root.rotation.y = -rs.face;
    const walking = Math.abs(stp) > 0.02;
    ref.body.position.y = walking ? Math.abs(Math.sin(nowS * 11)) * 0.3 : 0;
    let tR = walking ? Math.sin(nowS * 11) * 0.35 : 0, tL = -tR;
    ref.whistle.scale.set(1, 1, 1); ref.body.scale.y = 1;
    if (a) {
      a.t += dt; const k = Math.min(1, a.t / 0.3), out = a.t > 2.3 ? Math.max(0, 1 - (a.t - 2.3) / 0.4) : 1;
      if (a.call === 'half' || a.call === 'full') { tR = tL = 2.9 * k * out; }
      else if (a.card) { tR = 2.95 * k * out; tL = 1.45 * k * out; ref.card.visible = a.t < 2.5; ref.card.material.color.set(a.card === 'red' ? 0xd8262c : 0xf5c400); }
      else if (a.call !== 'kickoff') tR = 1.5 * k * out;
      const blow = a.t < 0.6 ? Math.abs(Math.sin(a.t * 30)) : 0;
      ref.whistle.scale.set(1, 1 + blow * 0.7, 1); ref.body.scale.y = 1 + blow * 0.03;
      if (a.t > 2.8) { rs.anim = null; ref.card.visible = false; }
    }
    ref.arms[1].rotation.z += (tR - ref.arms[1].rotation.z) * Math.min(1, dt * 12);
    ref.arms[0].rotation.z += (tL - ref.arms[0].rotation.z) * Math.min(1, dt * 12);
  }
  /* camera targets */
  const attDir = G.dir[G.turn];
  const port = camera.aspect < 0.9;
  if (V.preset === 'broadcast') { goal.tx = port ? -16 * (V.flip ? -1 : 1) : b.x * 0.3; goal.tz = port ? b.z * 0.2 : 1 + b.z * 0.42; goal.ty = 0; goal.az = (port ? -Math.PI / 2 : 0) + (V.flip || 0); }
  else if (V.preset === 'low') { goal.tx = port ? 0 : b.x * 0.45; goal.tz = port ? b.z * 0.3 : 4 + b.z * 0.42; goal.ty = 0; goal.az = (port ? -Math.PI / 2 : 0) + (V.flip || 0); }
  else if (V.preset === 'top') { goal.tx = port ? 0 : b.x * 0.2; goal.tz = 0; goal.ty = 0; goal.az = (port ? -Math.PI / 2 : 0) + (V.flip || 0); }
  else if (V.preset === 'behind') { goal.tx = b.x * 0.7; goal.tz = b.z * 0.5; goal.ty = 0; goal.az = -attDir * Math.PI / 2; }
  else if (V.preset === 'ball') { goal.tx = b.x; goal.tz = b.z; goal.ty = 1; goal.az = -attDir * Math.PI / 2; }
  else if (V.preset === 'play' && V.play) { goal.tx = V.play.tx; goal.tz = V.play.tz; goal.ty = 0; }
  else if (!pinned) { goal.tx = b.x * 0.35; goal.tz = b.z * 0.4; goal.ty = 0; }
  if (flingAz || flingEl) {
    goal.az += flingAz * dt; goal.el = Math.max(EL_MIN, Math.min(EL_MAX, goal.el + flingEl * dt));
    const decay = Math.exp(-dt * 3.2); flingAz *= decay; flingEl *= decay;
    if (Math.abs(flingAz) < 0.02 && Math.abs(flingEl) < 0.02) flingAz = flingEl = 0;
  }
  const k = 1 - Math.exp(-dt * (V.preset === 'ball' ? 6 : pinned ? 9 : 4));   // a view the fingers hold follows them tightly
  let da = goal.az - cam.az; da = Math.atan2(Math.sin(da), Math.cos(da));
  cam.az += da * k; for (const n of ['el', 'dist', 'tx', 'tz', 'ty']) cam[n] += (goal[n] - cam[n]) * k;
  shake *= Math.exp(-dt * 6);
  const sx = (Math.random() - 0.5) * shake, sy = (Math.random() - 0.5) * shake;
  const D = cam.dist * (camera.aspect < 0.9 ? 1.5 : 1);
  camera.position.set(cam.tx + D * Math.cos(cam.el) * Math.sin(cam.az) + sx, cam.ty + D * Math.sin(cam.el) + sy, cam.tz + D * Math.cos(cam.el) * Math.cos(cam.az));
  camera.lookAt(cam.tx, cam.ty, cam.tz);
  if (camera.position.y < 4) camera.position.y = 4;
  /* confetti */
  if (confetti.visible) {
    confetti.life -= dt; const P = confetti.geometry.attributes.position, vel = confetti.vel;
    for (let i = 0; i < P.count; i++) {
      vel[i * 3 + 1] -= 220 * dt; let y = P.getY(i) + vel[i * 3 + 1] * dt; if (y < 0.2) { y = 0.2; vel[i * 3] *= 0.8; vel[i * 3 + 2] *= 0.8; vel[i * 3 + 1] = 0; }
      P.setXYZ(i, P.getX(i) + vel[i * 3] * dt, y, P.getZ(i) + vel[i * 3 + 2] * dt);
    }
    P.needsUpdate = true; if (confetti.life <= 0) confetti.visible = false;
  }
  renderer.render(scene, camera);
};

root.View = V;
};

