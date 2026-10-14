/* Floodlight FC app: menus, HUD, touch and keyboard input, sound, and the frame loop that joins the match engine to the view. */
import { createMatch, HX, HZ } from './sim.js';
import { createView } from './view.js';
import { initTeamScreen } from './team.js';
import { squadById, defaultSetup, cleanSetup, buildTeam, teamRating, rollCondition, managerById, PLAYSTYLES, LEVELS, COND, MOVES } from './data.js';
import { V3, clamp, mulberry32 } from './vec.js';

const $ = id => document.getElementById(id);
function vibrate(ms) { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) {} }
function load(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (e) { return fallback; } }
function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} }

// settings and the team are per-viewer conveniences: kept in this browser only
// graphics, player models and camera are not user options: the best defaults are always used
const S = { diff: 1, len: 300, assist: 1, offside: 1, ...load('ffc-settings', {}), quality: 'auto', players: 'rigged', cam: 'dynamic', camH: 10, camZ: 10, camT: 5 };
const YOU = 'eko', THEM = 'nbk';
let setup = cleanSetup(load('ffc-team', null), YOU);
/* How the other side can line up. One is drawn for each match. */
const OPPONENTS = [
  { manager: 'bankole', formation: '5-2-1-2', playstyle: 'longBallCounter', formationB: '4-3-1-2', playstyleB: 'quickCounter' },
  { manager: 'ridl', formation: '4-2-1-3', playstyle: 'quickCounter', formationB: '4-3-3', playstyleB: 'outWide' },
  { manager: 'okonjo', formation: '4-4-2', playstyle: 'outWide', formationB: '4-2-1-3', playstyleB: 'quickCounter' },
  { manager: 'verhoeven', formation: '4-3-3', playstyle: 'possession', formationB: '4-2-1-3', playstyleB: 'quickCounter' },
  { manager: 'grange', formation: '4-4-2', playstyle: 'longBall', formationB: '4-2-3-1', playstyleB: 'outWide' },
  { manager: 'delmar', formation: '4-2-3-1', playstyle: 'overload', formationB: '4-3-3', playstyleB: 'possession' },
];
let oppIdx = Math.floor(Math.random() * OPPONENTS.length), oppSetup = defaultSetup(THEM, OPPONENTS[oppIdx]);
/* Condition arrows are rolled before each match, so the line-up screen shows them while you pick the team. */
let conds = {};
function rollConds() { const r = mulberry32((Math.random() * 4294967296) >>> 0); conds = {}; for (const id of [YOU, THEM]) { conds[id] = {}; for (const pl of squadById(id).players) conds[id][pl.idx] = rollCondition(pl, r); } }
rollConds();

// ------------------------------------------------------------------ renderer
let view;
try { view = await createView($('stage'), { players: S.players }); }
catch (e) { $('err').hidden = false; $('err').textContent = 'This browser could not start WebGPU or WebGL 2. Try a recent Chrome, Edge or Safari.'; throw e; }

// ------------------------------------------------------------------ audio (synthesised, starts on Kick off)
const sfx = {
  ctx: null, crowd: null, master: null,
  init() {
    if (this.ctx) return;
    try {
      const ctx = this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = ctx.createGain(); this.master.gain.value = 0.7; this.master.connect(ctx.destination);
      const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
      let b = 0; for (let i = 0; i < len; i++) { b = 0.97 * b + 0.03 * (Math.random() * 2 - 1); d[i] = b * 3; }
      const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 700; f.Q.value = 0.5;
      this.crowd = ctx.createGain(); this.crowd.gain.value = 0.12;
      src.connect(f); f.connect(this.crowd); this.crowd.connect(this.master); src.start();
    } catch (e) { this.ctx = null; }
  },
  /* the crowd goes quiet with the game: paused, in a menu, or with the tab hidden */
  run(on) { if (!this.ctx) return; try { on ? this.ctx.resume() : this.ctx.suspend(); } catch (e) {} },
  env(node, t, a, peak, dec) { const g = this.ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + dec); node.connect(g); g.connect(this.master); return g; },
  kick(p = 0.5) {
    if (!this.ctx) return; const t = this.ctx.currentTime, o = this.ctx.createOscillator();
    o.frequency.setValueAtTime(140 + p * 60, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    this.env(o, t, 0.004, 0.35 + p * 0.5, 0.14); o.start(t); o.stop(t + 0.2);
  },
  whistle(len = 0.35, n = 1) {
    if (!this.ctx) return; let t = this.ctx.currentTime;
    for (let i = 0; i < n; i++) {
      const o = this.ctx.createOscillator(), l = this.ctx.createOscillator(), lg = this.ctx.createGain();
      o.frequency.value = 2900; l.frequency.value = 28; lg.gain.value = 140; l.connect(lg); lg.connect(o.frequency);
      this.env(o, t, 0.01, 0.18, len); o.start(t); l.start(t); o.stop(t + len + 0.05); l.stop(t + len + 0.05); t += len + 0.12;
    }
  },
  post() {
    if (!this.ctx) return; const t = this.ctx.currentTime;
    for (const [f, a] of [[880, .3], [1390, .2], [2230, .12]]) { const o = this.ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = f; this.env(o, t, 0.002, a, 0.9); o.start(t); o.stop(t + 1); }
  },
  swell(level, hold = 0.5) { if (!this.ctx) return; const g = this.crowd.gain, t = this.ctx.currentTime; g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(level, t + 0.25); g.linearRampToValueAtTime(level, t + 0.25 + hold); g.linearRampToValueAtTime(0.12, t + 3 + hold); },
};

// ------------------------------------------------------------------ UI helpers
let bannerT = null;
function banner(big, sub = '', cool = false, ms = 1400) {
  const b = $('banner'); $('bBig').textContent = big; $('bSub').textContent = sub;
  b.classList.toggle('cool', cool); b.classList.add('show');
  clearTimeout(bannerT); bannerT = setTimeout(() => b.classList.remove('show'), ms);
}
let tagT = null;
function skillTag(name, ok) {
  const el = $('skillTag'); el.textContent = name;
  if (ok === true || ok === false) { const m = document.createElement(ok ? 'b' : 's'); m.textContent = ok ? ' ✓' : ' ✗'; el.appendChild(m); }
  el.classList.add('show'); clearTimeout(tagT); tagT = setTimeout(() => el.classList.remove('show'), ok === undefined && name.length > 22 ? 2200 : 1000);
}

// ------------------------------------------------------------------ the match and what it reports
let M = null, state = 'menu', paused = false;        // state: menu (fly-over) | match | ft
const LABELS = { attack: { pass: 'PASS', shoot: 'SHOOT', through: 'THROUGH', loft: 'LOFT', skill: 'SKILL' }, defend: { pass: 'SWITCH', shoot: 'TACKLE', through: 'PRESS', loft: '2ND MAN', skill: 'JOCKEY' } };
function refreshLabels() {
  $('controls').classList.toggle('defend', M.G.mode === 'defend');
  for (const [k, v] of Object.entries(LABELS[M.G.mode])) document.querySelector(`[data-a="${k}"] span`).textContent = v;
}
function refreshCtrl() {
  const p = M.ctrl; if (!p) return;
  $('pname').textContent = ''; const em = document.createElement('em'); em.textContent = p.num; $('pname').append(em, p.name);
  const c = COND[p.cond + 2];
  $('pmeta').innerHTML = `${p.posCode} · <b>${'★'.repeat(p.stars)}${'☆'.repeat(5 - p.stars)}</b> · <span style="color:${c.css}">${c.sym}</span>`;
}
function refreshLevers() {
  const tm = M.teams[M.human];
  $('lvl').textContent = LEVELS[tm.level + 2]; $('lvl').dataset.v = tm.level;
  $('tacBtn').textContent = 'AB'[tm.tac];
  $('trapBtn').hidden = !M.S.offside;
}
const fxCol = key => key === 'white' ? view.C(3, 3, 3) : key === 'good' ? view.C(0.5, 3, 1.2) : view.kit(0).ring;
/* Everything the engine reports comes through here: turn it into sound, particles, banners and HUD changes. */
function onEvent(ev, a, b, c, d) {
  switch (ev) {
    case 'kick': {
      const shot = b === 'shot', mine = a.team === M.human;
      sfx.kick(clamp(c / 32, 0, 1));
      view.FX.turf(M.ball.pos, shot ? 22 : 8, shot ? 1.6 : 0.8);
      if (!shot) view.trail(1, 1, 1);
      if (shot && c > 25) { view.shake(0.25); view.chroma(0.9); }
      if (mine) vibrate(shot ? 22 : 10);
      break;
    }
    case 'turf': view.FX.turf(a, b, c); break;
    case 'burst': view.FX.burst(a, fxCol(b)); break;
    case 'trail': view.trail(a, b, c); break;
    case 'perfect': banner('PERFECT', 'strike', true, 700); view.FX.burst(M.ball.pos, fxCol('good')); break;
    case 'tag': skillTag(a, b); break;
    case 'banner': banner(a, b, c, d); break;
    case 'whistle': sfx.whistle(a, b); break;
    case 'swell': sfx.swell(a, b); break;
    case 'excite': view.excite(a); break;
    case 'vibrate': vibrate(a); break;
    case 'net': view.rippleNet(a, b, c, d); break;
    case 'woodwork':
      view.FX.sparks(a); sfx.post(); view.shake(0.4); view.chroma(1.2);
      if (c) { banner(b === 'POST' ? 'OFF THE POST' : 'CROSSBAR', '', true, 1000); sfx.swell(0.55, 0.4); view.excite(0.7); }
      break;
    case 'goal': {
      const k = view.kit(a);
      $('s0').textContent = M.G.score[0]; $('s1').textContent = M.G.score[1];
      banner('GOAL!', c ? `${c.name} ${d}'` : 'own goal', false, 2600);
      view.rippleNet(b, M.ball.pos.z, M.ball.pos.y, 1.3);
      view.FX.confetti({ x: b * (HX + 2), y: 7, z: 0 }, k.confA, k.confB);
      view.FX.pyro({ x: b * (HX + 14), y: 30, z: HZ + 18 }, k.confA); view.FX.pyro({ x: b * (HX + 14), y: 30, z: -HZ - 18 }, k.confA);
      view.FX.confetti({ x: 0, y: 12, z: -(HZ + 14) }, k.confA, k.confB);
      view.excite(1); view.flash(1); view.chroma(2); view.shake(0.7);
      sfx.swell(1.0, 2.2); sfx.whistle(0.25); vibrate([40, 60, 90]);
      break;
    }
    case 'ctrl': refreshCtrl(); break;
    case 'mode': refreshLabels(); break;
    case 'lever': if (a === M.human) { refreshLevers(); refreshCtrl(); } break;
    case 'halftime': banner('HALF TIME', `${M.teams[0].cfg.short} ${M.G.score[0]} – ${M.G.score[1]} ${M.teams[1].cfg.short}`, true, 2600); sfx.whistle(0.4, 2); break;
    case 'fulltime': endMatch(); break;
  }
}
function newMatch(humanTeam, events) {
  const teams = [buildTeam(setup, conds[YOU]), buildTeam(oppSetup, conds[THEM])];
  M = createMatch({ teams, human: humanTeam, settings: { diff: S.diff, len: S.len, assist: S.assist, offside: S.offside } }, events);
  view.setMatch(M);
  return M;
}
function startMatch() {
  sfx.init(); sfx.run(true);
  view.applyQuality(S.quality);
  newMatch(0, onEvent);
  state = 'match'; paused = false; resetInput();
  $('s0').textContent = '0'; $('s1').textContent = '0';
  $('n0').textContent = M.teams[0].cfg.short; $('n1').textContent = M.teams[1].cfg.short;
  $('menu').hidden = true; $('hud').hidden = false; $('controls').hidden = false; $('ftBox').hidden = true; $('gauge').hidden = true;
  view.resetCamera();
  refreshLabels(); refreshCtrl(); refreshLevers();
  const t = M.teams[0].cfg.tactics[0];
  banner('KICK OFF', `${t.formation} · ${PLAYSTYLES[t.playstyle].name}`, true, 1600);
  wake(true);
}
function endMatch() {
  state = 'ft'; sfx.whistle(0.35, 3); sfx.run(false); wake(false);
  const G = M.G, st = G.stats, pt = st.poss[0] + st.poss[1] || 1;
  const pc = t => st.passA[t] ? Math.round(st.passC[t] / st.passA[t] * 100) + '%' : '–';
  const res = G.score[0] > G.score[1] ? 'You win' : G.score[0] < G.score[1] ? M.teams[1].cfg.name + ' win' : 'Draw';
  const rows = [[G.score[0], 'Goals', G.score[1]], [Math.round(st.poss[0] / pt * 100) + '%', 'Possession', Math.round(st.poss[1] / pt * 100) + '%'],
    [st.shots[0], 'Shots', st.shots[1]], [st.onT[0], 'On target', st.onT[1]], [pc(0), 'Pass accuracy', pc(1)], [st.inter[0], 'Interceptions', st.inter[1]],
    [st.tackles[0], 'Tackles won', st.tackles[1]], [st.fouls[0], 'Fouls', st.fouls[1]], [st.offsides[0], 'Offsides', st.offsides[1]], [st.corners[0], 'Corners', st.corners[1]],
    [st.skills[0], 'Skill moves', st.skills[1]]];
  $('ftBox').hidden = false;
  $('ftBox').innerHTML = `<div class="result">Full time · ${res}</div><table class="stats"><tbody>${rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td></tr>`).join('')}</tbody></table>`;
  $('startBtn').textContent = 'Rematch'; $('resumeBtn').hidden = true; $('teamBtn').hidden = false;
  $('menu').hidden = false; $('hud').hidden = true; $('controls').hidden = true; $('gauge').hidden = true; $('swipe').hidden = true;
  // a new day: fresh condition arrows and a new opponent plan for the next match
  rollConds(); oppIdx = (oppIdx + 1) % OPPONENTS.length; oppSetup = defaultSetup(THEM, OPPONENTS[oppIdx]);
  drawFixture();
}
function pause(on) {
  if (state !== 'match') return;
  paused = on; resetInput(); sfx.run(!on); wake(!on);
  $('menu').hidden = !on; $('resumeBtn').hidden = !on; $('startBtn').textContent = on ? 'Restart' : 'Kick off';
  $('teamBtn').hidden = on;          // the team is fixed once the match has started
  $('gauge').hidden = true; $('swipe').hidden = true;
}
let wakeLock = null;
function wake(on) {
  try {
    if (on && navigator.wakeLock && !wakeLock) navigator.wakeLock.request('screen').then(l => { wakeLock = l; l.addEventListener('release', () => { wakeLock = null; }); }).catch(() => {});
    if (!on && wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  } catch (e) {}
}

// ------------------------------------------------------------------ menu
function sideHtml(s, css, extra) {
  const sq = squadById(s.team), t = s.tactics[0], m = managerById(s.manager);
  return `<div class="side"><i style="background:${css}"></i><b>${sq.name}</b><small>${t.formation} · ${PLAYSTYLES[t.playstyle].name} · ${m.name}</small>${extra}</div>`;
}
function drawFixture() {
  $('fixture').innerHTML = sideHtml(setup, squadById(YOU).css, `<em>${teamRating(setup)}</em>`)
    + sideHtml(oppSetup, squadById(THEM).css, `<span class="mini"><button class="ghost sm" id="oppBtn" aria-label="Change the opponent's plan">Change</button><em style="position:static">${teamRating(oppSetup)}</em></span>`);
}
$('fixture').addEventListener('click', e => {
  if (!e.target.closest('#oppBtn') || (state === 'match')) return;
  oppIdx = (oppIdx + 1) % OPPONENTS.length; oppSetup = defaultSetup(THEM, OPPONENTS[oppIdx]); drawFixture(); showDemo();
});
function showDemo() { if (state !== 'match') { newMatch(-1, () => {}); } }
const teamScreen = initTeamScreen($('team'), {
  get: () => setup, set: s => { setup = s; save('ffc-team', s); }, conds: () => conds[YOU],
  done() { teamScreen.close(); $('menu').hidden = false; drawFixture(); showDemo(); },
});
$('teamBtn').onclick = () => { $('menu').hidden = true; teamScreen.open(); };
$('startBtn').onclick = startMatch;
$('resumeBtn').onclick = () => { view.applyQuality(S.quality); pause(false); };
$('pauseBtn').onclick = () => pause(true);
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(true); });
document.querySelectorAll('#menu .seg').forEach(seg => {
  const k = seg.dataset.k;
  const sync = () => seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v) === String(S[k])));
  seg.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    S[k] = isNaN(+b.dataset.v) ? b.dataset.v : +b.dataset.v; save('ffc-settings', S); sync();
    if (M && state === 'match' && (k === 'assist' || k === 'diff')) M.S[k] = S[k];       // these two can change mid-match
  });
  sync();
});
// ------------------------------------------------------------------ input
const stick = { x: 0, y: 0, id: null, ox: 0, oy: 0, downAt: 0, moved: 0, lastTap: 0 };
const keys = {};
const fwdTmp = { x: 0, z: 0 }, aim = new V3();
/* Stick and keys are camera-relative: up on the stick is away from the camera. */
function inputWorld(out) {
  let x = stick.x, y = stick.y;
  const kx = (keys.ArrowRight || keys.KeyD ? 1 : 0) - (keys.ArrowLeft || keys.KeyA ? 1 : 0);
  const ky = (keys.ArrowDown || keys.KeyS ? 1 : 0) - (keys.ArrowUp || keys.KeyW ? 1 : 0);
  if (kx || ky) { const l = Math.hypot(kx, ky); x = kx / l; y = ky / l; }
  const f = view.forward(fwdTmp);
  return out.set(-f.z * x - f.x * y, 0, f.x * x - f.z * y);
}
function resetInput() {
  stick.x = stick.y = 0; stick.id = null;
  for (const k in keys) keys[k] = false;
  $('knob').style.transform = 'translate(0,0)'; $('stick').classList.remove('on'); $('stick').style.left = ''; $('stick').style.top = '';
  document.querySelectorAll('.b.down').forEach(el => el.classList.remove('down'));
  if (M) { for (const k in M.inp.btn) M.inp.btn[k] = false; M.inp.shield = false; M.inp.charging = false; }
}
const playing = () => state === 'match' && !paused;
const SWIPE = 34;
const swipeDir = (dx, dy) => Math.hypot(dx, dy) < SWIPE ? '' : Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy < 0 ? 'up' : 'down');
/* What sliding off each button does, shown around the thumb while the button is held. */
const SWIPES = {
  attack: { pass: { right: 'STUNNING', left: 'ONE-TWO' }, through: { up: 'LOFTED', right: 'STUNNING' }, loft: { right: 'STUNNING' }, shoot: { up: 'CHIP', down: 'FINESSE', right: 'STUNNING', left: 'FAKE' }, skill: {} },
  defend: { through: { up: 'TEAM PRESS' }, loft: { up: 'KEEPER OUT' } },
};
function swipeHints(a, el, dir) {
  const box = $('swipe');
  let map = (SWIPES[M.G.mode] || {})[a];
  if (a === 'skill' && M.G.mode === 'attack') { const mv = M.teams[M.human].cfg.moves; map = Object.fromEntries(Object.entries(mv).map(([d, id]) => [d, MOVES[id].name.toUpperCase()])); }
  if (!map || !Object.keys(map).length || !el) { box.hidden = true; return; }
  const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2, d = r.width / 2 + 26;
  const off = { up: [0, -d], down: [0, d], left: [-d - 14, 0], right: [d + 14, 0] };
  box.hidden = false;
  box.innerHTML = Object.entries(map).map(([k, label]) => `<span class="${k === dir ? 'on' : ''}" style="left:${clamp(cx + off[k][0], 40, innerWidth - 40)}px;top:${clamp(cy + off[k][1], 12, innerHeight - 12)}px">${label}</span>`).join('');
}

const lz = $('lzone'), stickEl = $('stick'), knob = $('knob');
document.addEventListener('pointerdown', e => { if (e.pointerType === 'touch') document.body.classList.remove('kb'); }, true);
lz.addEventListener('pointerdown', e => {
  if (stick.id !== null) return;
  stick.id = e.pointerId; lz.setPointerCapture(e.pointerId);
  stick.ox = e.clientX; stick.oy = e.clientY; stick.downAt = e.timeStamp; stick.moved = 0;
  stickEl.style.left = e.clientX + 'px'; stickEl.style.top = e.clientY + 'px'; stickEl.classList.add('on');
  knob.style.transform = 'translate(0,0)';
});
lz.addEventListener('pointermove', e => {
  if (e.pointerId !== stick.id) return;
  let dx = e.clientX - stick.ox, dy = e.clientY - stick.oy; const R = 52, l = Math.hypot(dx, dy);
  stick.moved = Math.max(stick.moved, l);
  if (l > R) { // drag the base along so the thumb never falls off
    stick.ox += dx * (1 - R / l); stick.oy += dy * (1 - R / l); dx *= R / l; dy *= R / l;
    stickEl.style.left = stick.ox + 'px'; stickEl.style.top = stick.oy + 'px';
  }
  const m = Math.hypot(dx, dy) / R;
  stick.x = m < 0.14 ? 0 : dx / R; stick.y = m < 0.14 ? 0 : dy / R;
  knob.style.transform = `translate(${dx}px,${dy}px)`;
});
const stickEnd = e => {
  if (e.pointerId !== stick.id) return;
  const now = e.timeStamp;      // when the finger moved, not when a busy frame got round to it
  // two quick taps without moving: stop dead (attacking) or shoulder charge (defending)
  if (now - stick.downAt < 220 && stick.moved < 14) { if (now - stick.lastTap < 340 && playing()) { M.leftDouble(); stick.lastTap = 0; } else stick.lastTap = now; }
  stick.id = null; stick.x = stick.y = 0;
  knob.style.transform = 'translate(0,0)'; stickEl.classList.remove('on');
  stickEl.style.left = ''; stickEl.style.top = '';
};
lz.addEventListener('pointerup', stickEnd); lz.addEventListener('pointercancel', stickEnd);

const btnInfo = {};
document.querySelectorAll('.b').forEach(el => {
  const a = el.dataset.a, inf = btnInfo[a] = { id: null, x: 0, y: 0, dx: 0, dy: 0, t: 0, hold: null, shielding: false };
  el.addEventListener('pointerdown', e => {
    e.preventDefault(); if (!playing()) return;
    el.setPointerCapture(e.pointerId);
    inf.id = e.pointerId; inf.x = e.clientX; inf.y = e.clientY; inf.t = e.timeStamp; inf.dx = 0; inf.dy = 0; inf.shielding = false;
    el.classList.add('down');
    M.press(a);
    if (a === 'skill') inf.hold = setTimeout(() => { if (inf.id !== null && Math.hypot(inf.dx, inf.dy) < 20 && M.G.mode === 'attack') { inf.shielding = true; M.inp.shield = true; skillTag('SHIELD'); $('swipe').hidden = true; } }, 300);
    if (a !== 'sprint') swipeHints(a, el, '');
  });
  el.addEventListener('pointermove', e => {
    if (inf.id !== e.pointerId) return;
    inf.dx = e.clientX - inf.x; inf.dy = e.clientY - inf.y;
    if (a !== 'sprint' && !inf.shielding && playing()) swipeHints(a, el, swipeDir(inf.dx, inf.dy));
  });
  const up = e => {
    if (inf.id !== e.pointerId) return;
    inf.id = null; el.classList.remove('down'); clearTimeout(inf.hold); $('swipe').hidden = true;
    if (!playing()) return;
    const dir = e.type === 'pointercancel' ? '' : swipeDir(inf.dx, inf.dy);
    if (a === 'skill') {
      const mode = M.G.mode;
      M.release('skill');
      const wasShield = inf.shielding;
      if (wasShield) { M.inp.shield = false; inf.shielding = false; }
      // a quick swipe is a move even if a slow frame let the hold timer fire first
      if (mode === 'attack' && (!wasShield || (dir && e.timeStamp - inf.t < 450))) M.skillInput(dir || 'tap');
      return;
    }
    M.release(a, dir);
  };
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
});
// swipe anywhere on the right side for a skill move
const rz = $('rzone'), sw = { id: null, x: 0, y: 0, t: 0 };
rz.addEventListener('pointerdown', e => { if (sw.id !== null) return; sw.id = e.pointerId; rz.setPointerCapture(e.pointerId); sw.x = e.clientX; sw.y = e.clientY; sw.t = e.timeStamp; });
const swEnd = e => {
  if (e.pointerId !== sw.id) return; sw.id = null;
  const dx = e.clientX - sw.x, dy = e.clientY - sw.y, held = e.timeStamp - sw.t;
  if (playing() && M.G.mode === 'attack' && Math.hypot(dx, dy) > 40 && held < 500 && e.type !== 'pointercancel') M.skillInput(swipeDir(dx, dy));
};
rz.addEventListener('pointerup', swEnd); rz.addEventListener('pointercancel', swEnd);
document.addEventListener('contextmenu', e => { if (state === 'match' && !paused) e.preventDefault(); });

document.querySelectorAll('#levers button').forEach(b => b.addEventListener('pointerdown', e => {
  e.preventDefault(); if (!playing()) return;
  const l = b.dataset.l;
  if (l === 'up') M.lever('level', 1); else if (l === 'down') M.lever('level', -1); else M.lever(l);
}));

// keyboard
const KMAP = { KeyJ: 'pass', KeyK: 'shoot', KeyL: 'through', KeyI: 'loft', ShiftLeft: 'sprint', ShiftRight: 'sprint', KeyU: 'shoot', KeyO: 'shoot', KeyP: 'shoot', KeyV: 'pass', KeyH: 'through' };
const KMOD = { KeyV: 'left', KeyH: 'up', KeyU: 'up', KeyO: 'down', KeyP: 'right' }, KSHOT = { KeyU: 'chip', KeyO: 'finesse', KeyP: 'stun' }, KSLOT = { Digit1: 'up', Digit2: 'down', Digit3: 'left', Digit4: 'right', KeyQ: 'up', KeyE: 'down', KeyR: 'left', KeyF: 'right' };
addEventListener('keydown', e => {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;      // leave browser shortcuts (Cmd+R, Ctrl+W, Alt+Tab) alone
  if (playing() && (KMAP[e.code] || KSLOT[e.code] || e.code.startsWith('Arrow') || e.code === 'Space' || /^Key[WASD]$/.test(e.code))) document.body.classList.add('kb');
  if (e.code === 'Escape') { if (state === 'match' && $('team').hidden) pause(!paused); return; }
  if (!playing()) return;
  keys[e.code] = true;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  if (e.code === 'Space') { M.press('skill'); if (M.G.mode === 'attack') M.skillInput('tap'); return; }
  if (KSLOT[e.code]) { M.skillInput(KSLOT[e.code]); return; }
  if (e.code === 'KeyB') { M.skillInput('fakeshot'); return; }
  if (e.code === 'KeyZ') { M.inp.shield = true; return; }
  if (e.code === 'KeyX') { M.leftDouble(); return; }
  if (e.code === 'BracketLeft') { M.lever('level', -1); return; }
  if (e.code === 'BracketRight') { M.lever('level', 1); return; }
  if (e.code === 'KeyT') { M.lever('tactic'); return; }
  if (e.code === 'KeyY') { M.lever('trap'); return; }
  if (e.code === 'KeyN') { M.lever('pressure'); return; }
  if (e.code === 'KeyG') { M.lever('gkrush'); return; }
  const a = KMAP[e.code];
  if (a) { M.press(a); if (a === 'shoot' && M.inp.charging && KSHOT[e.code]) M.inp.chargeMode = KSHOT[e.code]; }
});
addEventListener('keyup', e => {
  keys[e.code] = false;
  if (!playing()) return;
  if (e.code === 'Space') { M.release('skill'); return; }
  if (e.code === 'KeyZ') { M.inp.shield = false; return; }
  const a = KMAP[e.code];
  if (a) M.release(a, KMOD[e.code] || (keys.KeyC && a !== 'shoot' && a !== 'sprint' ? 'right' : ''));
});
addEventListener('blur', () => { if (M) resetInput(); if (state === 'match' && !paused) pause(true); });      // alt-tab away: the match waits
addEventListener('resize', () => view.resize());

// ------------------------------------------------------------------ radar
const radar = $('radar'), rg = radar.getContext('2d');
function drawRadar() {
  const W = radar.width, H = radar.height, sx = W / 110, sz = H / 72;
  rg.clearRect(0, 0, W, H);
  rg.strokeStyle = 'rgba(255,255,255,.35)'; rg.lineWidth = 2;
  rg.strokeRect((55 - HX) * sx, (36 - HZ) * sz, 2 * HX * sx, 2 * HZ * sz);
  rg.beginPath(); rg.moveTo(55 * sx, (36 - HZ) * sz); rg.lineTo(55 * sx, (36 + HZ) * sz); rg.stroke();
  const ctrl = M.ctrl, link = M.teams[M.human].link;
  for (const p of M.players) {
    rg.fillStyle = M.teams[p.team].cfg.css;
    rg.beginPath(); rg.arc((55 + p.pos.x) * sx, (36 + p.pos.z) * sz, p === ctrl ? 6 : 4, 0, 7); rg.fill();
    if (p === ctrl) { rg.strokeStyle = '#ffd24a'; rg.lineWidth = 2; rg.stroke(); }
    else if (link && link.runner === p) { rg.strokeStyle = '#7fd4f0'; rg.lineWidth = 2; rg.stroke(); }
  }
  rg.fillStyle = '#fff'; rg.beginPath(); rg.arc((55 + M.ball.pos.x) * sx, (36 + M.ball.pos.z) * sz, 3.5, 0, 7); rg.fill();
}

// ------------------------------------------------------------------ frame loop
let last = performance.now(), radarT = 0;
const camOpt = { preset: S.cam, height: 10, zoom: 10, track: 5 };
function hud(dt) {
  const G = M.G, ctrl = M.ctrl, tm = M.teams[M.human];
  $('clock').textContent = Math.min(90, Math.floor(G.clock / M.S.len * 90)) + "'";
  if (ctrl) {
    const s = (ctrl.stamina * 100).toFixed(0) + '%';
    $('stam').style.width = s; $('stam2').style.width = s; $('fit').style.width = ((1 - (0.4 + 0.6 * ctrl.fit)) * 100).toFixed(0) + '%';
  }
  $('trapBtn').classList.toggle('cool', tm.trapCd > 0);
  const g = $('gauge');
  if (M.inp.charging && ctrl) {
    const at = view.project(ctrl.pos.x, 2.4, ctrl.pos.z);
    g.hidden = false; g.style.transform = `translate(${at.x}px, ${at.y}px)`;
    $('gfill').style.width = Math.min(100, M.inp.charge * 100) + '%';
    const inf = btnInfo.shoot, dir = inf.id !== null ? swipeDir(inf.dx, inf.dy) : '';
    const sp = G.sp;
    $('gmode').textContent = sp && sp.kind === 'penalty' ? 'PENALTY' : sp && sp.direct ? 'FREE KICK' : { up: 'CHIP', down: 'FINESSE', right: 'STUNNING', left: 'FAKE' }[dir] || { chip: 'CHIP', finesse: 'FINESSE', stun: 'STUNNING' }[M.inp.chargeMode] || 'POWER';
  } else g.hidden = true;
  radarT -= dt; if (radarT <= 0) { radarT = 1 / 20; drawRadar(); }
}
function frame() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  let simDt = 0;
  const live = state === 'match' && !paused;
  if (live) {
    inputWorld(M.inp.dir);
    const scale = M.G.slowmo > 0 ? 0.32 : 1; M.G.slowmo = Math.max(0, M.G.slowmo - dt);
    simDt = dt * scale;
    // equal small steps, so the game plays the same on a 60 Hz and a 144 Hz screen
    const n = Math.max(1, Math.ceil(simDt / (1 / 100)));
    for (let i = 0; i < n && state === 'match'; i++) M.step(simDt / n);
  }
  camOpt.preset = S.cam; camOpt.height = S.camH; camOpt.zoom = S.camZ; camOpt.track = S.camT;
  const a = live && M.inp.dir.lengthSq() > 0.04 ? aim.copy(M.inp.dir) : null;
  view.frame(M, { dt, simDt: live ? simDt : dt, cam: camOpt, orbit: state !== 'match', aim: a });
  if (live) hud(dt);
}

// boot: the two teams posed on the pitch for the menu fly-over
view.applyQuality(S.quality);
drawFixture();
newMatch(-1, () => {});
requestAnimationFrame(function loop() { frame(); requestAnimationFrame(loop); });
window.__ffc = { get M() { return M; }, startMatch, get state() { return state; }, S, view };
