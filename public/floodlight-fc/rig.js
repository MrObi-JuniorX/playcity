/* Rigged players (prototype): one skinned, motion-captured character (Mixamo's X Bot from the three.js examples), cloned
   for each player, dressed in the team kit by a shader, and animated by blending its mocap idle, walk and run clips.
   Football actions (kicks, tackles, slides, headers, dives) are layered on top by turning bones about world axes,
   so they work on any Mixamo-rigged model: swap assets/xbot.glb for a footballer model with the same skeleton. */
import * as THREE from 'three/webgpu';
import { attribute, uniform, mix, step, vec3, float } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const BONES = ['Hips', 'Spine', 'Spine2', 'Head', 'LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm', 'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg'];

/* Which part of the kit each vertex wears, from the bone that moves it most: 0 skin, 1 shirt, 2 shorts, 3 socks, 4 boots.
   Bone names, not positions, so it works for any Mixamo-rigged model in any rest pose. */
function boneRegion(name, below) {
  if (/Head|Neck|Eye/.test(name)) return 0;
  if (/ForeArm|Hand/.test(name)) return 0;
  if (/Shoulder|Arm|Spine/.test(name)) return 1;
  if (/Hips/.test(name)) return below ? 2 : 1;
  if (/UpLeg/.test(name)) return 2;
  if (/Leg/.test(name)) return 3;
  if (/Foot|Toe/.test(name)) return 4;
  return 1;
}
function addRegions(mesh) {
  const geo = mesh.geometry, bones = mesh.skeleton.bones, si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight, pos = geo.attributes.position;
  const n = pos.count, reg = new Float32Array(n);
  mesh.skeleton.bones.forEach(b => b.updateMatrixWorld(true));
  const hipsY = (bones.find(b => /Hips$/.test(b.name)) || bones[0]).getWorldPosition(new THREE.Vector3()).y;
  for (let i = 0; i < n; i++) {
    let best = 0, bw = -1;
    for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = si.getComponent(i, k); } }
    reg[i] = boneRegion(bones[best].name, pos.getY(i) < hipsY);
  }
  geo.setAttribute('region', new THREE.BufferAttribute(reg, 1));
}

export async function loadRig(url) {
  const gltf = await new GLTFLoader().loadAsync(url);
  const template = gltf.scene;
  template.updateMatrixWorld(true);
  template.traverse(o => { if (o.isSkinnedMesh) { addRegions(o); o.frustumCulled = false; } });
  const clips = {};
  for (const c of gltf.animations) {
    // keep the hips' up-and-down bounce but not any drift: the match engine moves the player
    for (const t of c.tracks) if (/Hips\.position$/.test(t.name)) for (let i = 0; i < t.values.length; i += 3) { t.values[i] = t.values[0]; t.values[i + 2] = t.values[2]; }
    clips[c.name] = c;
  }
  if (!clips.idle || !clips.walk || !clips.run) throw new Error('rig needs idle, walk and run clips');
  const animated = new Set(clips.run.tracks.map(t => t.name.split('.')[0]));
  return { template, clips, animated };
}

const qP = new THREE.Quaternion(), qR = new THREE.Quaternion(), qPi = new THREE.Quaternion(), AX = new THREE.Vector3();
/* Turn a bone by `angle` about an axis given in world space, whatever the bone's own axes are. */
function turn(bone, axis, angle) {
  if (!bone || !angle) return;
  bone.parent.getWorldQuaternion(qP);
  qPi.copy(qP).invert();
  qR.setFromAxisAngle(axis, angle);
  bone.quaternion.premultiply(qPi.multiply(qR).multiply(qP));
}

export function createRigBuilder(rig) {
  /* One player: base (position) → tilt (world-aligned falls and dives) → heading (facing) → the cloned character. */
  function make(kit, isGK, skinHex, scene) {
    const model = SkeletonUtils.clone(rig.template);
    const col = (hex, k = 1) => uniform(new THREE.Color(hex).multiplyScalar(k));
    const shirt = isGK ? kit.gk : kit.shirt, shorts = isGK ? 0x1c1c22 : kit.shorts, socks = isGK ? kit.gk : kit.shirt;
    model.traverse(o => {
      if (!o.isSkinnedMesh) return;
      const joints = /Joints/i.test(o.material.name), k = joints ? 0.55 : 1;
      const m = new THREE.MeshStandardNodeMaterial({ roughness: joints ? 0.5 : 0.75 });
      const r = attribute('region', 'float');
      const c = mix(mix(mix(mix(col(skinHex, k), col(shirt, k), step(0.5, r)), col(shorts, k), step(1.5, r)), col(socks, k * 0.85), step(2.5, r)), col(0x111111), step(3.5, r));
      m.colorNode = c;
      o.material = m; o.castShadow = !joints;
    });
    const heading = new THREE.Group(), tilt = new THREE.Group(), base = new THREE.Group();
    heading.add(model); tilt.add(heading); base.add(tilt); scene.add(base);
    const mixer = new THREE.AnimationMixer(model);
    const act = {};
    for (const k of ['idle', 'walk', 'run']) { act[k] = mixer.clipAction(rig.clips[k]); act[k].play(); act[k].setEffectiveWeight(k === 'idle' ? 1 : 0); }
    const bones = {}, rest = {};
    model.traverse(o => { if (!o.isBone) return; const short = o.name.replace(/^mixamorig:?/, ''); if (BONES.includes(short)) { bones[short] = o; rest[short] = o.quaternion.clone(); } });
    return { root: base, tilt, heading, model, mixer, act, bones, rest, rigged: true };
  }

  const F = new THREE.Vector3(), R = new THREE.Vector3(), X = new THREE.Vector3(1, 0, 0), UP = new THREE.Vector3(0, 1, 0);
  /* Pose one player from the match state: mocap locomotion by speed, then the football actions on top. */
  function pose(p, m, dt, now, holds) {
    const sp = Math.hypot(p.vel.x, p.vel.z);
    // idle → walk → run, crossfaded by speed, each clip sped up to match the feet to the ground
    const wWalk = clamp((sp - 0.3) / 1.6, 0, 1) * (1 - clamp((sp - 2.6) / 1.8, 0, 1)), wRun = clamp((sp - 2.6) / 1.8, 0, 1);
    m.act.idle.setEffectiveWeight(Math.max(0, 1 - wWalk - wRun)); m.act.walk.setEffectiveWeight(wWalk); m.act.run.setEffectiveWeight(wRun);
    m.act.walk.timeScale = clamp(sp / 1.5, 0.6, 1.6); m.act.run.timeScale = clamp(sp / 4.8, 0.75, 1.75);
    m.mixer.update(dt);
    for (const k in m.bones) if (!rig.animated.has(m.bones[k].name)) m.bones[k].quaternion.copy(m.rest[k]);

    const f = p.facing;
    m.root.position.set(p.pos.x, 0, p.pos.z);
    m.heading.rotation.y = Math.PI / 2 - f;              // the model faces +z; the engine's facing is an angle from +x
    m.tilt.quaternion.identity(); m.tilt.position.set(0, 0, 0);
    m.model.updateMatrixWorld(true);
    F.set(Math.cos(f), 0, Math.sin(f)); R.set(-Math.sin(f), 0, Math.cos(f));
    const B = m.bones, kickL = p.foot < 0;               // left-footers kick with the left
    const thigh = kickL ? B.LeftUpLeg : B.RightUpLeg, shin = kickL ? B.LeftLeg : B.RightLeg;
    // positive about R swings a leg forward or leans the body back; positive about F lifts the left arm or leg outward
    if (p.wind) { turn(thigh, R, -0.9); turn(shin, R, -1.1); turn(B.Spine, R, 0.12); }
    else if (p.kickAnim > 0) {
      const k = 1 - Math.min(p.kickAnim, 0.3) / 0.3;
      turn(thigh, R, Math.sin(k * Math.PI) * 1.5 - 0.35); turn(shin, R, -(1 - k) * 0.9); turn(B.Spine, R, 0.15);
      turn(kickL ? B.RightArm : B.LeftArm, F, (kickL ? -1 : 1) * 0.7);
    }
    if (p.skill) {
      const s = p.skill, k = s.t / s.dur;
      if (s.type === 'stepover' || s.type === 'bodyfeint') { turn(B.RightUpLeg, F, -Math.max(0, Math.sin(k * Math.PI * 2)) * 0.6); turn(B.LeftUpLeg, F, Math.max(0, -Math.sin(k * Math.PI * 2)) * 0.6); }
      else if (s.type === 'elastico' || s.type === 'ballroll' || s.type === 'doubletouch') turn(thigh, F, -Math.sin(k * Math.PI) * 0.7 * s.side);
      else if (s.type === 'dragback' || s.type === 'chop') { turn(thigh, R, -0.6 * Math.sin(k * Math.PI)); turn(B.Spine, R, 0.15); }
      else if (s.type === 'rainbow') { turn(thigh, R, -1.2 * Math.sin(k * Math.PI)); turn(B.Spine, R, -0.25); }
      else if (s.type === 'roulette') { turn(B.LeftArm, F, 0.6); turn(B.RightArm, F, -0.6); }
      else if (s.type === 'fakeshot') { turn(thigh, R, k < 0.45 ? -0.9 : 0.4); }
    }
    if (p.shield) { turn(B.Spine, R, 0.22); turn(B.LeftArm, F, 0.8); turn(B.RightArm, F, -0.8); }
    if (p.isGK && holds && !p.dive) { turn(B.LeftArm, R, 1.2); turn(B.RightArm, R, 1.2); }
    let lift = 0;
    if (p.tackleT > 0 && p.slide) { m.tilt.quaternion.setFromAxisAngle(R, 1.15); lift = -0.15; turn(B.LeftUpLeg, R, 0.9); turn(B.RightUpLeg, R, 1.2); }
    else if (p.tackleT > 0) { turn(thigh, R, 1.1); turn(B.Spine, R, -0.3); }
    if (p.dive) {
      const k = clamp(p.dive.t / 0.35, 0, 1);
      m.tilt.quaternion.setFromAxisAngle(X, p.dive.side * 1.35 * k);       // roll toward the side he dives to (world z)
      lift = 0.5 * Math.sin(k * Math.PI * 0.9);
      turn(B.LeftArm, F, 2.6 * k); turn(B.RightArm, F, -2.6 * k);
    }
    if (p.stagger > 0.9) { m.tilt.quaternion.setFromAxisAngle(R, 1.45); lift = 0.08; }       // fouled: on the floor
    else if (p.stagger > 0) turn(B.Spine, R, Math.sin(now * 20) * 0.15);
    if (p.headAnim > 0) { lift += Math.sin((1 - p.headAnim / 0.45) * Math.PI) * 0.45; turn(B.LeftArm, F, 0.9); turn(B.RightArm, F, -0.9); turn(B.Head, R, -0.3); }
    if (p.celebrate > 0) { lift += Math.abs(Math.sin(now * 7 + p.i)) * 0.35; turn(B.LeftArm, F, 2.6); turn(B.RightArm, F, -2.6); }
    m.tilt.position.y = lift;
  }
  return { make, pose };
}
