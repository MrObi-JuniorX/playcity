/* Floodlight FC view: the WebGPU stadium, players, ball, particles and camera. It only reads the match; it never changes it. */
import * as THREE from 'three/webgpu';
import { pass, renderOutput, uniform, instancedArray, instanceIndex, Fn, If, float, vec2, vec3, vec4, hash, mix, mod,
  positionLocal, positionWorld, time, sin, exp, step, smoothstep, screenUV, texture, uv, floor, length, varying, max, abs } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { chromaticAberration } from 'three/addons/tsl/display/ChromaticAberrationNode.js';
import { HX, HZ, GW, GH, BR, BOX_W } from './sim.js';
import { loadRig, createRigBuilder } from './rig.js';

const V3 = THREE.Vector3;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const damp = (k, dt) => 1 - Math.exp(-k * dt);
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const C = (r, g, b) => new THREE.Color(r, g, b);
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

/* Camera presets. Dynamic Wide holds one distance; Duel pulls out in midfield and closes in on the final third. */
export const CAMERAS = {
  dynamic: { name: 'Dynamic Wide', note: 'Side-on at one distance. Easiest for reading runs.' },
  duel: { name: 'Duel', note: 'Wide in midfield, closes in near goal.' },
  wide: { name: 'Wide', note: 'Further out: more of the pitch, smaller players.' },
  broadcast: { name: 'Broadcast', note: 'Long-lens TV view from high in the stand.' },
  vertical: { name: 'Vertical', note: 'Behind your team, attacking up the screen.' },
};

export async function createView(stage, opts = {}) {
  const renderer = new THREE.WebGPURenderer({ antialias: false, powerPreference: 'high-performance' });
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  stage.appendChild(renderer.domElement);
  await renderer.init();
  const IS_GPU = !!renderer.backend.isWebGPUBackend;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05080f);
  scene.fog = new THREE.Fog(0x05080f, 120, 330);
  const camera = new THREE.PerspectiveCamera(34, innerWidth / innerHeight, 0.5, 900);
  camera.position.set(0, 24, 44);
  const tmpA = new V3(), tmpB = new V3(), tmpC = new V3(), ZERO = new V3();

  // ---------- lights
  scene.add(new THREE.HemisphereLight(0x8ea6ff, 0x16240f, 0.55));
  const sun = new THREE.DirectionalLight(0xfff1dc, 1.7);
  sun.position.set(20, 50, 18);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -34, right: 34, top: 34, bottom: -34, near: 5, far: 120 });
  sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);
  const towers = [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([sx, sz]) => new V3(sx * (HX + 16), 36, sz * (HZ + 18)));
  for (const t of towers) {
    const sp = new THREE.SpotLight(0xfff4e0, 5200, 0, 0.62, 0.7, 2);
    sp.position.copy(t); sp.target.position.set(t.x * 0.15, 0, t.z * 0.1);
    scene.add(sp, sp.target);
  }

  // ---------- sky dome (TSL gradient + twinkling stars)
  {
    const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, fog: false, depthWrite: false });
    const h = positionWorld.y.div(420).clamp(0, 1);
    const base = mix(vec3(0.05, 0.07, 0.13), vec3(0.008, 0.01, 0.025), h.pow(0.5));
    const cell = floor(positionWorld.mul(0.9));
    const star = step(0.9975, hash(cell.x.add(cell.y.mul(131.7)).add(cell.z.mul(71.3))))
      .mul(sin(time.mul(2).add(hash(cell.x.add(cell.z)).mul(40))).mul(0.4).add(0.6)).mul(step(0.12, h));
    m.colorNode = vec4(base.add(vec3(star.mul(1.4))), 1);
    scene.add(new THREE.Mesh(new THREE.SphereGeometry(450, 32, 16), m));
  }

  // ---------- pitch (canvas markings + TSL turf variation)
  function pitchTexture() {
    const W = 2048, H = 1400, SX = W / 120, SZ = H / 82;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    const X = x => (x + 60) * SX, Z = z => (z + 41) * SZ;
    for (let i = 0; i < 24; i++) { g.fillStyle = i % 2 ? '#2b7533' : '#33843b'; g.fillRect(X(-60 + i * 5.25 - 0.5), 0, 5.25 * SX + 1, H); }
    for (let i = 0; i < 9000; i++) { g.fillStyle = `rgba(${Math.random() < .5 ? '10,40,10' : '120,170,90'},${Math.random() * 0.12})`; g.fillRect(Math.random() * W, Math.random() * H, 2, 2); }
    g.strokeStyle = 'rgba(245,250,245,.92)'; g.lineWidth = 0.14 * SX; g.fillStyle = g.strokeStyle;
    const rect = (x0, z0, x1, z1) => g.strokeRect(X(x0), Z(z0), X(x1) - X(x0), Z(z1) - Z(z0));
    const arc = (x, z, r, a0, a1) => { g.beginPath(); g.ellipse(X(x), Z(z), r * SX, r * SZ, 0, a0, a1); g.stroke(); };
    const dot = (x, z) => { g.beginPath(); g.ellipse(X(x), Z(z), .22 * SX, .22 * SZ, 0, 0, 7); g.fill(); };
    rect(-HX, -HZ, HX, HZ);
    g.beginPath(); g.moveTo(X(0), Z(-HZ)); g.lineTo(X(0), Z(HZ)); g.stroke();
    arc(0, 0, 9.15, 0, Math.PI * 2); dot(0, 0);
    for (const s of [-1, 1]) {
      const gx = s * HX;
      rect(Math.min(gx, gx - s * 16.5), -BOX_W, Math.max(gx, gx - s * 16.5), BOX_W);
      rect(Math.min(gx, gx - s * 5.5), -9.16, Math.max(gx, gx - s * 5.5), 9.16);
      dot(gx - s * 11, 0);
      const a = Math.acos(5.5 / 9.15);
      if (s > 0) arc(gx - 11, 0, 9.15, Math.PI - a, Math.PI + a); else arc(gx + 11, 0, 9.15, -a, a);
      for (const sz of [-1, 1]) arc(gx, sz * HZ, 1, 0, Math.PI * 2);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    return t;
  }
  {
    const tex = pitchTexture();
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
    const blade = hash(floor(positionWorld.x.mul(28)).add(floor(positionWorld.z.mul(28)).mul(157.31)));
    m.colorNode = vec4(texture(tex, uv()).rgb.mul(blade.mul(0.16).add(0.9)), 1);
    const pitch = new THREE.Mesh(new THREE.PlaneGeometry(120, 82), m);
    pitch.rotation.x = -Math.PI / 2; pitch.receiveShadow = true;
    scene.add(pitch);
    const apron = new THREE.Mesh(new THREE.PlaneGeometry(260, 200), new THREE.MeshStandardNodeMaterial({ color: 0x15301a, roughness: 1 }));
    apron.rotation.x = -Math.PI / 2; apron.position.y = -0.02; scene.add(apron);
  }

  // ---------- stadium: stands, crowd (instanced + TSL animation), LED boards, towers
  const uExcite = uniform(0.15), uFlash = uniform(0);
  function buildStadium(names, cols) {
    const concrete = new THREE.MeshStandardNodeMaterial({ color: 0x1b2130, roughness: 0.9 });
    const roofM = new THREE.MeshStandardNodeMaterial({ color: 0x0c0f18, roughness: 0.8 });
    const ledM = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(1.6, 1.5, 1.3) });
    const slope = 0.55, rows = 14, depth = 0.95;
    const seats = [];
    const sides = [
      { len: 124, off: HZ + 8, axis: 'z', sgn: 1 }, { len: 124, off: HZ + 8, axis: 'z', sgn: -1 },
      { len: 84, off: HX + 9, axis: 'x', sgn: 1 }, { len: 84, off: HX + 9, axis: 'x', sgn: -1 },
    ];
    for (const s of sides) {
      const run = rows * depth, rise = run * slope;
      const m = new THREE.Mesh(new THREE.BoxGeometry(s.len, 0.4, Math.hypot(run, rise)), concrete);
      const mid = s.off + run / 2, ang = Math.atan(slope);
      if (s.axis === 'z') { m.position.set(0, rise / 2 + 0.6, s.sgn * mid); m.rotation.x = s.sgn * ang; }
      else { m.rotation.y = Math.PI / 2; m.position.set(s.sgn * mid, rise / 2 + 0.6, 0); m.rotateX(-s.sgn * ang); }
      m.receiveShadow = true; scene.add(m);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(s.len + 4, 0.5, run + 6), roofM);
      const led = new THREE.Mesh(new THREE.BoxGeometry(s.len + 4, 0.25, 0.25), ledM);
      if (s.axis === 'z') { roof.position.set(0, rise + 12, s.sgn * (mid + 1)); led.position.set(0, rise + 11.7, s.sgn * (s.off - 1.8)); }
      else { roof.rotation.y = led.rotation.y = Math.PI / 2; roof.position.set(s.sgn * (mid + 1), rise + 12, 0); led.position.set(s.sgn * (s.off - 1.8), rise + 11.7, 0); }
      scene.add(roof, led);
      for (let r = 0; r < rows; r++) {
        const d = s.off + (r + 0.5) * depth, y = 0.95 + (r + 0.5) * depth * slope;
        for (let u = -s.len / 2 + 0.6; u < s.len / 2 - 0.6; u += 0.82) {
          if (Math.random() < 0.1) continue;
          const along = u + rand(-0.12, 0.12);
          seats.push(s.axis === 'z' ? [along, y, s.sgn * d] : [s.sgn * d, y, along]);
        }
      }
    }
    const cm = new THREE.MeshStandardNodeMaterial({ roughness: 0.85 });
    const seed = float(instanceIndex);
    const ph = hash(seed).mul(6.283);
    const jump = max(sin(time.mul(uExcite.mul(7).add(2)).add(ph)), 0).mul(uExcite.mul(0.55).add(0.03));
    cm.positionNode = positionLocal.add(vec3(0, jump, 0));
    const flash = varying(step(float(0.9988).sub(uFlash.mul(0.006)), hash(seed.add(floor(time.mul(9)).mul(17.13)))));
    cm.emissiveNode = vec3(flash.mul(9));
    const crowd = new THREE.InstancedMesh(new THREE.BoxGeometry(0.46, 0.8, 0.36), cm, seats.length);
    const mtx = new THREE.Matrix4(), col = new THREE.Color();
    const palette = [0x1fbf6a, 0x1fbf6a, 0xf2f4f7, 0x0f7a3f, 0xe3444f, 0xb8252f, 0x23305e, 0xd8c7a3, 0x2a2a2a, 0x6c4a2e];
    seats.forEach((p, i) => {
      mtx.makeTranslation(p[0], p[1] + 0.4, p[2]);
      crowd.setMatrixAt(i, mtx);
      let c = palette[(Math.random() * palette.length) | 0];
      if (p[0] > HX + 6 && Math.random() < 0.7) c = Math.random() < .7 ? 0xe3444f : 0x1a2040;      // the away end
      crowd.setColorAt(i, col.setHex(c).multiplyScalar(rand(0.55, 1)));
    });
    scene.add(crowd);

    // scrolling LED ad boards (TSL uv scroll, HDR for bloom)
    const ac = document.createElement('canvas'); ac.width = 2048; ac.height = 64;
    const ag = ac.getContext('2d');
    ag.fillStyle = '#05070c'; ag.fillRect(0, 0, 2048, 64);
    ag.font = '900 44px "Arial Narrow", Impact, sans-serif'; ag.textBaseline = 'middle';
    const words = [['FLOODLIGHT FC', '#ffd24a'], [names[0].toUpperCase(), cols[0]], [names[1].toUpperCase(), cols[1]], ['PLAYCITY', '#e8eeff']];
    let x = 20, k = 0;
    while (x < 2048) { const [w, c] = words[k++ % words.length]; ag.fillStyle = c; ag.fillText(w, x, 34); x += ag.measureText(w).width + 70; }
    const adTex = new THREE.CanvasTexture(ac); adTex.wrapS = THREE.RepeatWrapping; adTex.colorSpace = THREE.SRGBColorSpace;
    const adM = new THREE.MeshBasicNodeMaterial();
    adM.colorNode = texture(adTex, uv().mul(vec2(3, 1)).add(vec2(time.mul(0.04), 0))).mul(2.4);
    for (const s of [-1, 1]) {
      const a = new THREE.Mesh(new THREE.PlaneGeometry(112, 0.95), adM);
      a.position.set(0, 0.48, s * (HZ + 4)); if (s > 0) a.rotation.y = Math.PI; scene.add(a);
      const b = new THREE.Mesh(new THREE.PlaneGeometry(70, 0.95), adM);
      b.position.set(s * (HX + 5), 0.48, 0); b.rotation.y = -s * Math.PI / 2; scene.add(b);
    }
    // floodlight towers with glowing lamp banks
    const lc = document.createElement('canvas'); lc.width = 128; lc.height = 64;
    const lg = lc.getContext('2d'); lg.fillStyle = '#111'; lg.fillRect(0, 0, 128, 64);
    for (let i = 0; i < 8; i++) for (let j = 0; j < 4; j++) { lg.fillStyle = '#fff'; lg.beginPath(); lg.arc(8 + i * 16, 8 + j * 16, 5.5, 0, 7); lg.fill(); }
    const lampM = new THREE.MeshBasicNodeMaterial({ fog: false }); lampM.colorNode = texture(new THREE.CanvasTexture(lc), uv()).mul(vec4(9, 8.4, 7, 1));
    const mastM = new THREE.MeshStandardNodeMaterial({ color: 0x2a3142, roughness: 0.6, metalness: 0.5 });
    for (const t of towers) {
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.9, t.y, 8), mastM);
      mast.position.set(t.x * 1.04, t.y / 2, t.z * 1.04); scene.add(mast);
      const lamp = new THREE.Mesh(new THREE.PlaneGeometry(9, 4.5), lampM);
      lamp.position.set(t.x, t.y + 1, t.z); lamp.lookAt(0, 0, 0); scene.add(lamp);
    }
  }

  // ---------- goals with TSL-rippling nets
  const goals = [];
  function buildGoal(s) {
    const grp = new THREE.Group();
    grp.position.set(s * HX, 0, 0);
    if (s < 0) grp.rotation.y = Math.PI;              // local +x always points out of the pitch
    const postM = new THREE.MeshStandardNodeMaterial({ color: 0xf6f8ff, roughness: 0.3, emissive: 0x222428 });
    const pg = new THREE.CylinderGeometry(0.06, 0.06, GH, 12);
    for (const z of [-GW / 2, GW / 2]) { const p = new THREE.Mesh(pg, postM); p.position.set(0, GH / 2, z); p.castShadow = true; grp.add(p); }
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, GW + 0.12, 12), postM);
    bar.rotation.x = Math.PI / 2; bar.position.set(0, GH, 0); bar.castShadow = true; grp.add(bar);
    const D = 2.0, pts = [], st = 0.22;
    const push = (a, b) => pts.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    for (let z = -GW / 2; z <= GW / 2 + 1e-3; z += st) { push([0, GH, z], [D * 0.6, GH, z]); push([D * 0.6, GH, z], [D, 0, z]); }
    for (let y = 0; y <= GH + 1e-3; y += st) { const xx = lerp(D, D * 0.6, y / GH); push([xx, y, -GW / 2], [xx, y, GW / 2]); }
    for (let x = 0; x <= D + 1e-3; x += st) {
      const yy = x < D * 0.6 ? GH : GH * (D - x) / (D * 0.4);
      push([x, GH, -GW / 2], [x, GH, GW / 2]);
      for (const z of [-GW / 2, GW / 2]) push([x, 0, z], [x, Math.max(yy, 0), z]);
    }
    for (let y = 0; y <= GH + 1e-3; y += st) for (const z of [-GW / 2, GW / 2]) push([0, y, z], [lerp(D, D * 0.6, y / GH), y, z]);
    const ng = new THREE.BufferGeometry(); ng.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const uImp = uniform(new V3(1, 1, 0)), uStr = uniform(0);
    const nm = new THREE.LineBasicNodeMaterial({ color: 0xdfe6f5, transparent: true, opacity: 0.55 });
    nm.positionNode = Fn(() => {
      const p = positionLocal;
      const d = length(p.yz.sub(uImp.yz));
      const depthF = p.x.div(D).clamp(0, 1);
      const wave = sin(time.mul(22).sub(d.mul(4))).mul(exp(d.mul(-0.8))).mul(uStr);
      const bulge = exp(d.mul(-1.1)).mul(uStr).mul(0.7);
      return p.add(vec3(wave.mul(0.35).add(bulge).mul(depthF), 0, 0));
    })();
    grp.add(new THREE.LineSegments(ng, nm));
    scene.add(grp);
    goals.push({ s, uImp, uStr });
  }
  buildGoal(1); buildGoal(-1);
  function rippleNet(s, worldZ, y, power) {
    const g = goals.find(g => g.s === s);
    g.uImp.value.set(1, y, s > 0 ? worldZ : -worldZ);
    g.uStr.value = Math.max(g.uStr.value, power);
  }

  // ---------- GPU compute particles (turf, sparks, confetti, pyro)
  const PN = 8192;
  const pPos = instancedArray(PN, 'vec4');   // xyz position, w size
  const pVel = instancedArray(PN, 'vec4');   // xyz velocity
  const pCol = instancedArray(PN, 'vec4');   // rgb colour
  const pPar = instancedArray(PN, 'vec4');   // x life left, y life max, z gravity, w drag
  // four buffers keeps the WebGL2 transform-feedback fallback within its varying limit
  const E = {
    start: uniform(0), count: uniform(0), pos: uniform(new V3()), vel: uniform(new V3()), spread: uniform(new V3(1, 1, 1)),
    colA: uniform(new THREE.Color()), colB: uniform(new THREE.Color()), life: uniform(1), grav: uniform(9.8), drag: uniform(0.5),
    size: uniform(0.08), seed: uniform(0), box: uniform(new V3(0.1, 0.1, 0.1)), dt: uniform(0.016)
  };
  const particleCompute = Fn(() => {
    const i = float(instanceIndex);
    const p = pPos.element(instanceIndex), v = pVel.element(instanceIndex), c = pCol.element(instanceIndex);
    const q = pPar.element(instanceIndex);
    const rel = mod(i.sub(E.start).add(PN), PN);
    If(rel.lessThan(E.count), () => {
      const h1 = hash(i.add(E.seed)), h2 = hash(i.mul(1.37).add(E.seed).add(11.1)), h3 = hash(i.mul(2.11).add(E.seed).add(23.7));
      const h4 = hash(i.mul(3.31).add(E.seed).add(5.5)), h5 = hash(i.mul(0.71).add(E.seed).add(41.9));
      const r = vec3(h1, h2, h3).sub(0.5).mul(2);
      p.assign(vec4(E.pos.add(r.mul(E.box)), E.size.mul(h4.mul(0.8).add(0.6))));
      v.assign(vec4(E.vel.add(vec3(h3, h1, h2).sub(0.5).mul(2).mul(E.spread)), 0));
      c.assign(vec4(mix(E.colA, E.colB, h4), 1));
      q.assign(vec4(E.life.mul(h5.mul(0.6).add(0.7)), E.life, E.grav, E.drag));
    }).Else(() => {
      If(q.x.greaterThan(0), () => {
        const nv = v.xyz.mul(float(1).sub(q.w.mul(E.dt)).max(0)).sub(vec3(0, q.z.mul(E.dt), 0)).toVar();
        const np = p.xyz.add(nv.mul(E.dt)).toVar();
        If(np.y.lessThan(0.03), () => {
          np.assign(vec3(np.x, 0.03, np.z));
          nv.assign(vec3(nv.x.mul(0.45), abs(nv.y).mul(0.25), nv.z.mul(0.45)));
        });
        v.assign(vec4(nv, 0));
        p.assign(vec4(np, p.w));
        q.assign(vec4(q.x.sub(E.dt), q.y, q.z, q.w));
      });
    });
  })().compute(PN);
  {
    const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
    const q = pPar.toAttribute(), pa = pPos.toAttribute();
    const lifeT = q.x.div(q.y.max(0.001)).clamp(0, 1);
    m.positionNode = pa.xyz;
    m.colorNode = vec4(pCol.toAttribute().xyz, 1);
    m.opacityNode = smoothstep(0, 0.25, lifeT);
    m.scaleNode = pa.w.mul(step(0.0001, q.x)).mul(lifeT.mul(0.5).add(0.5));
    const sp = new THREE.Sprite(m); sp.count = PN; sp.frustumCulled = false; sp.renderOrder = 5;
    scene.add(sp);
  }
  let pCursor = 0; const emitQ = [];
  const ONE = new V3(1, 1, 1), BOX0 = new V3(0.12, 0.05, 0.12);
  function emit(o) { if (emitQ.length < 24) emitQ.push(o); }
  function flushEmit(dt) {
    E.dt.value = dt;
    const o = emitQ.shift();
    if (o) {
      E.start.value = pCursor; E.count.value = o.n; pCursor = (pCursor + o.n) % PN;
      E.pos.value.copy(o.pos); E.vel.value.copy(o.vel || ZERO); E.spread.value.copy(o.spread || ONE);
      E.colA.value.copy(o.a); E.colB.value.copy(o.b || o.a); E.life.value = o.life ?? 0.8; E.grav.value = o.grav ?? 9.8;
      E.drag.value = o.drag ?? 0.6; E.size.value = o.size ?? 0.08; E.seed.value = Math.random() * 1000; E.box.value.copy(o.box || BOX0);
    } else E.count.value = 0;
    renderer.compute(particleCompute);
  }
  const at = p => new V3(p.x, p.y, p.z);
  const FX = {
    turf(pos, n = 10, power = 1) { emit({ n, pos: at(pos).setY(0.05), vel: new V3(0, 2.2 * power, 0), spread: new V3(1.6 * power, 1.2 * power, 1.6 * power), a: C(0.12, 0.35, 0.1), b: C(0.32, 0.22, 0.1), life: 0.7, grav: 9.8, drag: 1.2, size: 0.07 }); },
    sparks(pos) { emit({ n: 70, pos: at(pos), vel: new V3(0, 1.5, 0), spread: new V3(6, 5, 6), a: C(6, 4.5, 2), b: C(4, 2, 0.6), life: 0.55, grav: 12, drag: 1.5, size: 0.07 }); },
    confetti(pos, colA, colB) { emit({ n: 900, pos: at(pos), vel: new V3(0, 1, 0), spread: new V3(5, 3, 5), box: new V3(4, 2, 8), a: colA, b: colB, life: 4.5, grav: 2.2, drag: 1.4, size: 0.16 }); },
    pyro(pos, col) { emit({ n: 420, pos: at(pos), vel: new V3(0, 3, 0), spread: new V3(14, 12, 14), a: col, b: C(8, 7, 5), life: 1.8, grav: 6, drag: 1.1, size: 0.35 }); },
    burst(pos, col) { emit({ n: 36, pos: at(pos), vel: new V3(0, 0.6, 0), spread: new V3(2.6, 1.6, 2.6), a: col, b: C(3, 3, 3), life: 0.5, grav: 3, drag: 2.5, size: 0.08 }); },
  };

  // ---------- post-processing pipeline (bloom, chroma kick, vignette, FXAA)
  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  const sceneCol = scenePass.getTextureNode('output');
  const bloomN = bloom(sceneCol, 0.6, 0.35, 0.85);
  const uCA = uniform(0);
  const vig = float(1).sub(smoothstep(0.42, 0.95, length(screenUV.sub(0.5).mul(vec2(1.25, 1)))).mul(0.55));
  const graded = chromaticAberration(sceneCol.add(bloomN), uCA, vec2(0.5, 0.5), 1.08);
  pipeline.outputColorTransform = false;
  pipeline.outputNode = fxaa(renderOutput(vec4(graded.rgb.mul(vig), 1)));
  let usePipeline = true;
  function applyQuality(setting) {
    const q = setting === 'auto' ? ((IS_GPU || !isTouch) ? 'high' : 'low') : setting;
    usePipeline = q === 'high';
    renderer.setPixelRatio(Math.min(devicePixelRatio, q === 'high' ? (isTouch ? 1.6 : 2) : 1));
    renderer.setSize(innerWidth, innerHeight);
    const sh = q === 'high';
    if (renderer.shadowMap.enabled !== sh) { renderer.shadowMap.enabled = sh; scene.traverse(o => { if (o.material) o.material.needsUpdate = true; }); }
  }

  // ---------- ball and trail
  function ballTexture() {
    const c = document.createElement('canvas'); c.width = 256; c.height = 128;
    const g = c.getContext('2d'); g.fillStyle = '#f4f6fb'; g.fillRect(0, 0, 256, 128);
    g.fillStyle = '#141a2a';
    for (let i = 0; i < 14; i++) {
      const x = (i * 37) % 256, y = 20 + ((i * 53) % 90), r = 11;
      g.beginPath(); for (let k = 0; k < 5; k++) { const a = k / 5 * Math.PI * 2; g.lineTo(x + Math.cos(a) * r * 1.3, y + Math.sin(a) * r); } g.fill();
    }
    g.fillStyle = '#ffd24a'; g.fillRect(0, 60, 256, 6);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  }
  const ballMesh = new THREE.Mesh(new THREE.SphereGeometry(BR, 24, 16), new THREE.MeshStandardNodeMaterial({ map: ballTexture(), roughness: 0.35 }));
  ballMesh.castShadow = true; scene.add(ballMesh);
  const TRAIL = 26, trailPts = [];
  const trailGeo = new THREE.BufferGeometry();
  const tPos = new Float32Array(TRAIL * 2 * 3), tCol = new Float32Array(TRAIL * 2 * 3);
  trailGeo.setAttribute('position', new THREE.BufferAttribute(tPos, 3));
  trailGeo.setAttribute('color', new THREE.BufferAttribute(tCol, 3));
  { const idx = []; for (let i = 0; i < TRAIL - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } trailGeo.setIndex(idx); }
  const trailMesh = new THREE.Mesh(trailGeo, new THREE.MeshBasicNodeMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  trailMesh.frustumCulled = false; scene.add(trailMesh);
  const trailTint = new THREE.Color(1, 1, 1);
  function updateTrail(ball) {
    const sp = Math.hypot(ball.vel.x, ball.vel.y, ball.vel.z);
    if (!ball.owner && sp > 9) trailPts.unshift(at(ball.pos)); else if (trailPts.length) trailPts.pop();
    if (trailPts.length > TRAIL) trailPts.length = TRAIL;
    const heat = clamp((sp - 12) / 18, 0, 1) * (ball.owner ? 0 : 1);
    const camP = camera.position;
    for (let i = 0; i < TRAIL; i++) {
      const p = trailPts[Math.min(i, trailPts.length - 1)] || ball.pos;
      const q = trailPts[Math.min(i + 1, trailPts.length - 1)] || p;
      tmpA.set(p.x - q.x, p.y - q.y, p.z - q.z); if (tmpA.lengthSq() < 1e-6) tmpA.set(1, 0, 0);
      tmpB.set(camP.x - p.x, camP.y - p.y, camP.z - p.z); tmpC.crossVectors(tmpA, tmpB).normalize();
      const f = 1 - i / TRAIL, w = BR * 0.9 * f;
      const valid = i < trailPts.length - 1 ? 1 : 0;
      const k = valid * f * f * (0.25 + heat * 2.6);
      for (let s = 0; s < 2; s++) {
        const o = (i * 2 + s) * 3, sg = s ? 1 : -1;
        tPos[o] = p.x + tmpC.x * w * sg; tPos[o + 1] = p.y + tmpC.y * w * sg; tPos[o + 2] = p.z + tmpC.z * w * sg;
        tCol[o] = trailTint.r * k; tCol[o + 1] = trailTint.g * k; tCol[o + 2] = trailTint.b * k;
      }
    }
    trailGeo.attributes.position.needsUpdate = true; trailGeo.attributes.color.needsUpdate = true;
  }

  // ---------- players
  const SKIN = [0x5a3a26, 0x4a2f20, 0x6b4630, 0x3b2519, 0x8a5d3d, 0xc69472, 0xe0b496];
  const geo = {
    torso: new THREE.CapsuleGeometry(0.2, 0.42, 4, 10), shorts: new THREE.CylinderGeometry(0.21, 0.23, 0.26, 10),
    head: new THREE.SphereGeometry(0.13, 14, 10), leg: new THREE.CapsuleGeometry(0.075, 0.62, 4, 8),
    boot: new THREE.BoxGeometry(0.24, 0.08, 0.11), arm: new THREE.CapsuleGeometry(0.055, 0.46, 4, 8), band: new THREE.CylinderGeometry(0.066, 0.066, 0.09, 10),
  };
  geo.leg.translate(0, -0.42, 0); geo.arm.translate(0, -0.27, 0); geo.boot.translate(0.04, -0.82, 0); geo.band.translate(0, -0.18, 0);
  const matCache = {};
  const mat = (hex, rough = 0.7) => matCache[hex + ':' + rough] ||= new THREE.MeshStandardNodeMaterial({ color: hex, roughness: rough });
  const bandMat = new THREE.MeshBasicNodeMaterial({ color: C(2.6, 2.1, 0.5) });
  const ringGeo = new THREE.RingGeometry(0.62, 0.8, 40); ringGeo.rotateX(-Math.PI / 2);
  function makeBody(kit, isGK, skinHex, captain) {
    const root = new THREE.Group(), body = new THREE.Group(); root.add(body);
    const shirt = mat(isGK ? kit.gk : kit.shirt, 0.65), shorts = mat(isGK ? 0x1c1c22 : kit.shorts), skin = mat(skinHex, 0.6), boot = mat(0x111111, 0.4);
    const torso = new THREE.Mesh(geo.torso, shirt); torso.position.y = 1.3;
    const sh = new THREE.Mesh(geo.shorts, shorts); sh.position.y = 0.95;
    const head = new THREE.Mesh(geo.head, skin); head.position.y = 1.74;
    const legs = [], arms = [];
    for (const z of [-0.11, 0.11]) {
      const pv = new THREE.Group(); pv.position.set(0, 0.9, z);
      const l = new THREE.Mesh(geo.leg, skin), b = new THREE.Mesh(geo.boot, boot);
      l.castShadow = b.castShadow = true; pv.add(l, b); body.add(pv); legs.push(pv);
      const ap = new THREE.Group(); ap.position.set(0, 1.52, z * 2.5);
      const a = new THREE.Mesh(geo.arm, skin); a.castShadow = true; ap.add(a); body.add(ap); arms.push(ap);
      if (captain && z < 0) ap.add(new THREE.Mesh(geo.band, bandMat));
    }
    torso.castShadow = sh.castShadow = head.castShadow = true;
    body.add(torso, sh, head);
    scene.add(root);
    return { root, body, legs, arms };
  }
  const bodies = new Map();
  // rigged, motion-captured players (prototype); the simple shape-built players stay as the fallback
  let rigB = null, useRig = opts.players !== 'simple';
  try { rigB = createRigBuilder(await Promise.race([loadRig(new URL('assets/xbot.glb', import.meta.url).href), new Promise((_, no) => setTimeout(() => no(new Error('rig load timed out')), 20000))])); }
  catch (e) { console.warn('Rigged players unavailable, using simple players:', e); }
  let kits = [null, null], stadiumBuilt = false;
  const ringCol = hex => { const c = new THREE.Color(hex); const m = Math.max(c.r, c.g, c.b, 0.01); return c.multiplyScalar(3.4 / m); };
  /* Put a match on the pitch: one body per player, in his team's kit. */
  function setMatch(M) {
    for (const b of bodies.values()) scene.remove(b.root);
    bodies.clear();
    kits = M.teams.map(tm => ({ ...tm.cfg, ring: ringCol(tm.cfg.shirt), confA: ringCol(tm.cfg.shirt).multiplyScalar(0.9), confB: tm.t === 0 ? C(3, 3, 3) : C(0.4, 0.6, 2.4) }));
    for (const p of M.players) bodies.set(p, useRig && rigB ? rigB.make(kits[p.team], p.isGK, SKIN[p.pl.skin % SKIN.length], scene)
      : makeBody(kits[p.team], p.isGK, SKIN[p.pl.skin % SKIN.length], p.i === M.teams[p.team].cfg.captain));
    if (!stadiumBuilt) { stadiumBuilt = true; buildStadium(kits.map(k => k.name), kits.map(k => k.css)); }
    const you = kits[Math.max(0, M.human)].ring;
    ctrlRing.material.color.copy(you); aimArrow.material.color.copy(you);
    trailPts.length = 0;
  }
  const SKILL_POSE = { ballroll: 'elastico', doubletouch: 'elastico', bodyfeint: 'stepover', chop: 'dragback' };
  function animate(p, now, dt, holds) {
    const m = bodies.get(p); if (!m) return;
    if (m.rigged) { rigB.pose(p, m, dt, now, holds); return; }
    const sp = Math.hypot(p.vel.x, p.vel.z), amp = Math.min(1, sp / 7);
    const swing = Math.sin(p.phase) * amp * 0.95;
    m.root.position.set(p.pos.x, 0, p.pos.z);
    m.root.rotation.y = -p.facing;
    m.body.position.set(0, Math.abs(Math.sin(p.phase)) * 0.06 * amp, 0);
    m.body.rotation.set(0, 0, -amp * 0.16);
    let lL = swing, lR = -swing, aL = -swing * 0.8, aR = swing * 0.8, sideL = 0, sideR = 0, armX = 0;
    if (p.wind) { lR = -1.0; aL = 0.7; m.body.rotation.z = 0.12; }
    else if (p.kickAnim > 0) { const k = 1 - Math.min(p.kickAnim, 0.3) / 0.3; lR = Math.sin(k * Math.PI) * 1.5 - 0.3; aL = -0.6; }
    if (p.skill) {
      const s = p.skill, k = s.t / s.dur, pose = SKILL_POSE[s.type] || s.type;
      if (pose === 'stepover') { sideL = Math.sin(k * Math.PI * 2) * 0.7; sideR = -Math.sin(k * Math.PI * 2 + 1) * 0.7; }
      if (pose === 'elastico') sideR = Math.sin(k * Math.PI) * 0.9 * s.side;
      if (pose === 'roulette') { lL = 0.4; lR = -0.4; armX = 0.6; }
      if (pose === 'dragback') { lR = -0.5 * Math.sin(k * Math.PI); m.body.rotation.z = 0.15; }
      if (pose === 'rainbow') { lR = -1.2 * Math.sin(k * Math.PI); lL = 0.2; m.body.rotation.z = -0.25; }
      if (pose === 'fakeshot') { lR = k < 0.45 ? -0.9 : 0.5; m.body.rotation.z = 0.1; }
    }
    if (p.shield) { m.body.rotation.z = 0.22; armX = 0.9; lL *= 0.5; lR *= 0.5; }
    if (p.tackleT > 0 && p.slide) { m.body.rotation.z = 1.15; m.body.position.y = -0.55; lR = 1.4; lL = 1.1; }
    else if (p.tackleT > 0) { lR = 1.1; m.body.rotation.z = -0.3; }
    if (p.dive) {
      const k = clamp(p.dive.t / 0.35, 0, 1);
      m.body.rotation.x = -p.dive.side * 1.35 * k; m.body.position.y = 0.5 * Math.sin(k * Math.PI * 0.9);
      armX = p.dive.side * 2.6 * k;
    }
    if (p.stagger > 0.9) { m.body.rotation.z = 1.3; m.body.position.y = -0.6; }           // fouled: on the floor
    else if (p.stagger > 0) m.body.rotation.x = Math.sin(now * 20) * 0.12;
    if (p.headAnim > 0) { m.body.position.y += Math.sin((1 - p.headAnim / 0.45) * Math.PI) * 0.45; armX = 0.9; }
    if (p.celebrate > 0) { m.body.position.y += Math.abs(Math.sin(now * 7 + p.i)) * 0.35; armX = 2.7; }
    m.legs[0].rotation.set(sideL, 0, lL); m.legs[1].rotation.set(sideR, 0, lR);
    m.arms[0].rotation.set(-armX, 0, aL); m.arms[1].rotation.set(armX, 0, aR);
  }
  const ctrlRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicNodeMaterial({ color: C(0.35, 3.4, 1.3), transparent: true, opacity: 0.95, depthWrite: false }));
  ctrlRing.renderOrder = 2; scene.add(ctrlRing);
  const aimArrow = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.5, 3), new THREE.MeshBasicNodeMaterial({ color: C(0.35, 3.4, 1.3) }));
  aimArrow.rotation.z = -Math.PI / 2; const aimPivot = new THREE.Group(); aimArrow.position.x = 1.15; aimPivot.add(aimArrow); scene.add(aimPivot);
  const targetRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicNodeMaterial({ color: C(2.6, 2.2, 0.6), transparent: true, opacity: 0.8, depthWrite: false }));
  targetRing.scale.setScalar(0.7); scene.add(targetRing);
  const linkRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicNodeMaterial({ color: C(0.6, 2.2, 3.4), transparent: true, opacity: 0.85, depthWrite: false }));
  linkRing.scale.setScalar(0.85); scene.add(linkRing);

  // ---------- camera
  const camFocus = new V3(), camLook = new V3(), camWant = new V3();
  let shake = 0;
  function updateCamera(M, dt, cam) {
    const { ball, G } = M;
    const portrait = innerHeight > innerWidth * 1.05;
    const tgt = ball.owner ? tmpA.set((ball.owner.pos.x + ball.pos.x) / 2, 0, (ball.owner.pos.z + ball.pos.z) / 2) : tmpA.set(ball.pos.x, 0, ball.pos.z);
    const track = 0.5 + cam.track / 10 * 1.1;                     // slider 0…10 → half to 1.6 times the stock speed
    camFocus.lerp(tgt, damp((G.phase === 'goal' ? 2 : 4.5) * track, dt));
    const f = camFocus, hK = 0.7 + cam.height / 20 * 0.6, zK = 1.3 - cam.zoom / 20 * 0.6;
    const goalZoom = G.phase === 'goal' ? 0.72 : 1;
    const mode = portrait ? 'vertical' : cam.preset;
    const dir = M.human === 1 ? -1 : 1;
    let fov;
    if (mode === 'vertical') {
      const k = zK * goalZoom;
      camWant.set(f.x - dir * 24 * k, 23 * hK * k, f.z * 0.85);
      tmpB.set(f.x + dir * 9, 0, f.z * 0.9);
      fov = portrait ? 52 : 40;
    } else {
      // k scales the whole rig: 1 is the stock Dynamic Wide distance
      let k = 1, follow = 0.9;
      if (mode === 'duel') k = lerp(1.3, 0.8, sstep(12, 38, Math.abs(f.x)));
      else if (mode === 'wide') { k = 1.34; follow = 0.78; }
      k *= zK * goalZoom;
      fov = innerWidth / innerHeight > 1.9 ? 30 : 34;
      if (mode === 'broadcast') { camWant.set(clamp(f.x * 0.55, -HX + 22, HX - 22), 27 * hK, f.z * 0.2 + 66 * zK * goalZoom); fov = 19; tmpB.set(clamp(f.x * 0.98, -HX - 2, HX + 2), 0, f.z * 0.7 - 1); }
      else { camWant.set(clamp(f.x * follow, -HX + 10, HX - 10), 20 * k * hK, f.z * 0.32 + 37 * k); tmpB.set(clamp(f.x * 0.96, -HX - 2, HX + 2), 0, f.z * 0.62 - 1); }
    }
    camera.position.lerp(camWant, damp(3.2 * track, dt));
    camLook.lerp(tmpB, damp(5 * track, dt));
    if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = lerp(camera.fov, fov, damp(4, dt)); camera.updateProjectionMatrix(); }
    camera.lookAt(camLook);
    if (shake > 0) { const s = shake * shake * 0.6; camera.position.x += rand(-s, s); camera.position.y += rand(-s, s); shake = Math.max(0, shake - dt * 1.6); }
    sun.position.set(camFocus.x + 18, 50, camFocus.z + 16); sun.target.position.copy(camFocus);
  }
  function resetCamera() { camera.position.set(0, 20, 37); camFocus.set(0, 0, 0); camLook.set(0, 0, 0); }

  /* Draw one frame. `o`: { dt (real seconds), simDt (match seconds this frame), cam, orbit (menu fly-over), aim (stick direction in the world) }. */
  function frame(M, o) {
    const { ball, G } = M, ctrl = M.ctrl, dt = o.dt;
    flushEmit(o.simDt);
    for (const p of M.players) animate(p, G.now, o.simDt, ball.owner === p);
    ballMesh.position.set(ball.pos.x, ball.pos.y, ball.pos.z);
    const hs = Math.hypot(ball.vel.x, ball.vel.z);
    if (hs > 0.05 && o.simDt > 0) { tmpA.set(ball.vel.z, 0, -ball.vel.x).normalize(); ballMesh.rotateOnWorldAxis(tmpA, hs * o.simDt / BR); }
    const showCtrl = !!ctrl && !o.orbit;
    ctrlRing.visible = showCtrl; aimPivot.visible = false;
    if (showCtrl) {
      ctrlRing.position.set(ctrl.pos.x, 0.03, ctrl.pos.z); ctrlRing.scale.setScalar(1 + Math.sin(G.now * 6) * 0.05);
      const taking = G.phase === 'setpiece' && G.sp.taker === ctrl;
      const ax = taking && !o.aim ? Math.cos(ctrl.facing) : o.aim ? o.aim.x : 0, az = taking && !o.aim ? Math.sin(ctrl.facing) : o.aim ? o.aim.z : 0;
      aimPivot.visible = ax * ax + az * az > 0.04;
      aimPivot.position.set(ctrl.pos.x, 0.06, ctrl.pos.z); aimPivot.rotation.y = -Math.atan2(az, ax);
    }
    const it = ball.intended;
    targetRing.visible = !!(it && !ball.owner && it.team === M.human) && !o.orbit;
    if (targetRing.visible) { const r = it.runTarget || it.pos; targetRing.position.set(r.x, 0.035, r.z); }
    const lk = M.human >= 0 && M.teams[M.human].link;
    linkRing.visible = !!lk && !o.orbit;
    if (lk) { linkRing.position.set(lk.runner.pos.x, 0.04, lk.runner.pos.z); linkRing.scale.setScalar(0.85 + Math.sin(G.now * 9) * 0.08); }
    for (const g of goals) g.uStr.value = Math.max(0, g.uStr.value - dt * 0.55);
    uExcite.value = Math.max(0.15, uExcite.value - dt * 0.12);
    uFlash.value = Math.max(0, uFlash.value - dt * 0.3);
    uCA.value = Math.max(0, uCA.value - dt * 2.5);
    bloomN.strength.value = 0.55 + uExcite.value * 0.25;
    updateTrail(ball);
    if (fixedCam) { camera.position.copy(fixedCam.pos); camera.lookAt(fixedCam.look); }
    else if (o.orbit) { const t = performance.now() / 1000 * 0.08; camera.position.set(Math.sin(t) * 70, 26, Math.cos(t) * 52); camera.lookAt(0, 0, 0); }
    else updateCamera(M, dt, o.cam);
    if (usePipeline) pipeline.render(); else renderer.render(scene, camera);
  }
  function resize() { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); }
  const proj = new V3();
  let fixedCam = null;
  return {
    IS_GPU, camera, FX, C, setMatch, get rigReady() { return !!rigB; }, setPlayers(style, M) { useRig = style !== 'simple'; if (M) setMatch(M); }, frame, resize, applyQuality, rippleNet, resetCamera,
    kit: t => kits[t],
    /* for screenshots and testing: hold the camera at a point, looking at another (null to release) */
    fixCamera(pos, look) { fixedCam = pos ? { pos: new V3(pos.x, pos.y, pos.z), look: new V3(look.x, look.y, look.z) } : null; },
    excite(v) { uExcite.value = Math.max(uExcite.value, v); }, flash(v) { uFlash.value = v; }, chroma(v) { uCA.value = Math.max(uCA.value, v); }, shake(v) { shake = Math.max(shake, v); },
    trail(r, g, b) { trailTint.setRGB(r, g, b); },
    /* where a point in the world lands on the screen, in CSS pixels */
    project(x, y, z) { proj.set(x, y, z).project(camera); return { x: (proj.x * 0.5 + 0.5) * innerWidth, y: (-proj.y * 0.5 + 0.5) * innerHeight }; },
    /* the camera's ground-plane forward direction, for mapping the stick to the pitch */
    forward(out) { camera.getWorldDirection(tmpC); tmpC.y = 0; tmpC.normalize(); out.x = tmpC.x; out.z = tmpC.z; return out; },
  };
}
