/* Flick Football app: setup screen, HUD, input, computer opponent driver, online play, main loop.

   Who plays each team is ctl[team]: 'local' (this screen), 'ai' (the computer) or 'remote' (someone online).
   Every action, from a flick to a keeper slide, becomes an input for its team and is applied by Rules.simTick on
   a fixed 60 Hz tick. Offline the inputs come from this screen and the computer. Online the other team's inputs
   come over the network through a rollback session, so switching from the computer to a person mid-match is
   only a change of who supplies that team's inputs. */
(function () {
'use strict';
const $ = s => document.querySelector(s), $$ = s => Array.from(document.querySelectorAll(s));
const hudCache = {}, H$ = s => hudCache[s] || (hudCache[s] = document.querySelector(s));   // for static HUD nodes read every frame
const R = window.Rules, S = window.Sound, AI = window.AI, TICK = window.Phys.TICK, ATM = window.Atmosphere;

/* ---------- show errors on screen so they can be reported ---------- */
function showErr(msg) { const e = $('#err'); e.hidden = false; e.textContent = 'Something went wrong: ' + msg + '. Reload the page to try again.'; }
window.addEventListener('error', ev => { if (ev.message) showErr(ev.message); });
window.addEventListener('unhandledrejection', ev => console.warn('unhandled', ev.reason));

const sel = [{ kit: 'ngr', form: '3-2-1' }, { kit: 'bra', form: '3-2-1' }];
let V = null, is2D = false, viewReady = null;
let halfLen = 120, moveMode = false, takerDrag = null, vsCPU = true, level = 'normal', G = null, last = performance.now(), mode = 'setup';
const MAX_PULL = 22, MIN_PULL = 1.8, V_MIN = 28, V_MAX = 200;
/* Pull (0..1) to flick speed. Soft touches are unchanged; from mid to hard a smooth boost adds momentum,
   up to +8% at full pull (top speed 214). Impulse on whatever the cap hits grows with it; masses stay real. */
const BOOST = 0.08;
const smooth01 = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const flickSpeedOf = p => V_MIN + Math.pow(p, 1.15) * (V_MAX - V_MIN) * (1 + BOOST * smooth01(0.35, 1, p));
const V_TOP = flickSpeedOf(1);
function pullOf(speed) {                                    // the inverse, for drawing the computer's pull back
  let lo = 0, hi = 1;
  for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (flickSpeedOf(m) < speed) lo = m; else hi = m; }
  return (lo + hi) / 2;
}
let aiJob = null, aiKeep = {}, shownBreak = null;
let ctl = ['local', 'ai'];
let localTick = 0, acc = 0;
const pend = [[], []], diveReq = [0, 0];

/* ---------- who controls what ---------- */
const human = t => ctl[t] === 'local';
const cpuTeam = () => ctl.indexOf('ai');
const soloTeam = () => (ctl[0] === 'local') !== (ctl[1] === 'local') ? (ctl[0] === 'local' ? 0 : 1) : -1;   // the one local team, if only one
const myTeam = () => { const s = soloTeam(); return s >= 0 ? s : 0; };
function who(t) {
  if (net.watch && net.watch.names) return net.watch.names[t];
  if (ctl[t] === 'ai') return 'Computer';
  if (ctl[t] === 'remote') return net.peer || 'Opponent';
  return soloTeam() === t ? 'You' : G.names[t];
}
function setControllers(c) {
  ctl = c.slice();
  if (V) { V.cpu = soloTeam() >= 0 ? 1 - soloTeam() : -1; V.flip = net.session && myTeam() === 1 ? Math.PI : 0; }
  const s = soloTeam();
  $('#pad0').hidden = s === 1; $('#pad1').hidden = s === 0;
  const keysTxt = '<kbd>WASD</kbd> or <kbd>Arrows</kbd> slide · <kbd>Space</kbd> dive';
  $('#pad0 .keys').innerHTML = s === 0 ? keysTxt : '<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> slide · <kbd>Space</kbd> dive';
  $('#pad1 .keys').innerHTML = s === 1 ? keysTxt : '<kbd>Arrows</kbd> slide · <kbd>Enter</kbd> dive';
  aiJob = null; aiKeep = {};
  paintHud(true);
}

/* ---------- helpers ---------- */
function kitCss(k) {
  const a = k.a, b = k.b;
  switch (k.pattern) {
    case 'stripes': return `repeating-linear-gradient(90deg, ${a} 0 7px, ${b} 7px 14px)`;
    case 'hoops': return `repeating-linear-gradient(0deg, ${a} 0 7px, ${b} 7px 14px)`;
    case 'halves': return `linear-gradient(90deg, ${a} 50%, ${b} 50%)`;
    case 'checker': return `repeating-conic-gradient(${a} 0 25%, ${b} 0 50%) 0 0 / 12px 12px`;
    case 'sash': return `linear-gradient(135deg, ${a} 0 33%, ${b} 33% 66%, ${a} 66% 100%)`;
    default: return `linear-gradient(180deg, ${b} 0 12%, ${a} 12% 100%)`;
  }
}
const fmt = s => { s = Math.max(0, Math.ceil(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const MODE = { kickoff: 'Kick-off', free: 'Free kick', penalty: 'Penalty', throw: 'Throw-in', corner: 'Corner', goalkick: 'Goal kick', open: 'Open play' };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- 3D with fallbacks ---------- */
function loadScript(src, ms) {
  return new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src; s.async = true;
    const to = setTimeout(() => rej(new Error('timeout')), ms);
    s.onload = () => { clearTimeout(to); res(); }; s.onerror = () => { clearTimeout(to); rej(new Error('blocked')); };
    document.head.appendChild(s);
  });
}
/* The 3D library (about 150 KB compressed) and the 3D view are only downloaded when Realistic graphics are on. */
async function ensureThree() {
  if (!window.THREE) {
    for (const u of ['https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js', 'https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js']) {
      try { await loadScript(u, 8000); if (window.THREE) break; } catch (e) { /* try the next copy */ }
    }
    if (!window.THREE) return false;
  }
  if (!window.defineModels) await loadScript('models.js', 8000);
  if (!window.defineView3D) await loadScript('view3d.js', 8000);
  return true;
}
/* Graphics: the canvas view (no WebGL, light on batteries) is the default. "Realistic" switches on the WebGL 3D
   view, with real lighting and shadows; it falls back to the canvas view if WebGL cannot start. */
let gfx3d = false;
try { gfx3d = localStorage.getItem('ff-gfx') === '3d'; } catch (e) { /* private mode */ }
async function initView() {
  const stage = $('#stage'); let why = '';
  $('#note2d').hidden = true; is2D = false;
  if (gfx3d) {
    try {
      if (await ensureThree()) { if (!window.Models) window.defineModels(window); window.defineView3D(window); window.View.init(stage); V = window.View; return; }
      why = 'the 3D library could not be downloaded';
    } catch (e) { why = (e && e.message) || 'unknown error'; console.warn('3D unavailable', e); }
    $('#note2d').textContent = `Realistic graphics could not start on this device (${why}), so the game uses its standard drawing. The physics are the same.`;
    $('#note2d').hidden = false;
  }
  stage.innerHTML = ''; V = window.View2D; V.init(stage); is2D = true;
}
/* Switch graphics from the setup screen: the view is rebuilt around the same match. */
async function setGraphics(want3d) {
  if (want3d === gfx3d && V) return;
  gfx3d = want3d; try { localStorage.setItem('ff-gfx', want3d ? '3d' : 'canvas'); } catch (e) { /* ignore */ }
  paintGfx();
  const old = V; V = null;
  if (old && old.dispose) old.dispose();
  $('#stage').innerHTML = '';
  viewReady = initView().then(() => { if (G) { V.attach(G); setControllers(ctl); } V.setPreset('free', true); paintGfx(); });
  await viewReady;
}
function paintGfx() { $$('#gfxSeg button').forEach(b => b.setAttribute('aria-pressed', String((b.dataset.g === '3d') === gfx3d))); }

/* ---------- setup screen ---------- */
function seg(id, attr, fn) {
  $$(id + ' button').forEach(b => b.onclick = () => { $$(id + ' button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); fn(b.dataset[attr]); });
}
function buildSetup() {
  [['A', 0], ['B', 1]].forEach(([id, t]) => {
    const wrap = $('#pick' + id + ' .kits'), form = $('#form' + id);
    R.KITS.forEach(k => {
      const b = document.createElement('button'); b.className = 'kit'; b.dataset.kit = k.id; b.setAttribute('aria-pressed', String(sel[t].kit === k.id));
      b.innerHTML = `<span class="shirt" style="background:${kitCss(k)}"></span><span>${k.name}</span>`;
      b.onclick = () => { sel[t].kit = k.id; $$('#pick' + id + ' .kit').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.kit === k.id))); rebuild(); };
      wrap.appendChild(b);
    });
    Object.keys(R.FORMS).forEach(f => { const o = document.createElement('option'); o.value = o.textContent = f; if (sel[t].form === f) o.selected = true; form.appendChild(o); });
    form.onchange = () => { sel[t].form = form.value; rebuild(); };
  });
  seg('#halfSeg', 'h', v => { halfLen = +v; });
  $$('#gfxSeg button').forEach(b => b.onclick = () => setGraphics(b.dataset.g === '3d')); paintGfx();
  seg('#oppSeg', 'o', v => { vsCPU = v === 'cpu'; syncSetup(); });
  seg('#lvlSeg', 'l', v => { level = v; });
  $('#startBtn').onclick = () => startMatch();
  $('#setupHelp').onclick = () => { $('#help').hidden = false; };
  $('#btnQuick0').onclick = () => { enterFullscreen(); quickMatch(); };
  $('#btnInvite0').onclick = () => openOnline();
  $('#btnWatch0').onclick = () => { openOnline(); $('#olLive').scrollIntoView({ block: 'center' }); };
  syncSetup();
}
function syncSetup() {
  $('#lvlField').hidden = !vsCPU;
  $('#homeLbl').textContent = vsCPU ? 'You' : 'Home';
  $('#awayLbl').textContent = vsCPU ? 'Computer' : 'Away';
}
function makeGame() {
  G = R.createGame({ teams: [{ kit: sel[0].kit, form: sel[0].form }, { kit: sel[1].kit, form: sel[1].form }], halfLen });
  moveMode = false; takerDrag = null; if (V) V.setZoneHint(null);
  G.sink = onEvent; aiJob = null; aiKeep = {}; shownBreak = null; clearInputs();
  if (V) V.attach(G);
  setControllers(vsCPU ? ['local', 'ai'] : ['local', 'local']);
}
function rebuild() { if (V && mode === 'setup') makeGame(); }

async function startMatch(fresh) {
  enterFullscreen();
  const btn = $('#startBtn');
  S.init(); S.playIntro(7, 2); btn.disabled = true; btn.textContent = 'Loading…';
  try {
    await viewReady;
    try { await Promise.race([document.fonts.load('700 58px "Big Shoulders Display"'), new Promise(r => setTimeout(r, 1200))]); } catch (e) { /* font is optional */ }
    if (fresh !== false) makeGame();
    enterPlay();
    applyVis();                                  // Public by default: the match is listed as soon as it starts
    R.kickoffCall(G, 'Kick-off', `${G.names[0]} v ${G.names[1]}. ${who(0)} to start.`);
    flashGestures();
  } finally { btn.disabled = false; btn.textContent = 'Kick off'; }
}
function enterPlay() {
  mode = 'play'; localTick = 0; acc = 0; keepAwake(true); gov.warm = 0;
  $('#setup').hidden = true; showHud(true); $('#breakOv').hidden = true;
  V.setPreset('broadcast'); setCamButtons('broadcast'); V.resize();
}

/* ---------- HUD ---------- */
let prev = {};
function setText(el, v) { if (prev[el.id] !== v) { prev[el.id] = v; el.textContent = v; } }
function paintHud(force) {
  if (!G) return;
  const [kA, kB] = G.kits;
  if (force) {
    prev = {};
    $('#shA').style.background = kitCss(kA); $('#shB').style.background = kitCss(kB);
    $('#pad0 .cap i').style.background = kA.a; $('#pad1 .cap i').style.background = kB.a;
    $('#pad0 .who').style.background = kA.a; $('#pad1 .who').style.background = kB.a;
    $('#pad0 .cap span').textContent = (soloTeam() === 0 ? 'Your' : G.names[0]) + ' keeper'; $('#pad1 .cap span').textContent = (soloTeam() === 1 ? 'Your' : G.names[1]) + ' keeper';
  }
  const sm = window.innerWidth <= 520;
  setText(H$('#nmA'), sm ? G.kits[0].id.toUpperCase() : G.names[0]); setText(H$('#nmB'), sm ? G.kits[1].id.toUpperCase() : G.names[1]);
  setText(H$('#scA'), String(G.score[0])); setText(H$('#scB'), String(G.score[1]));
  H$('#tA').classList.toggle('turn', G.phase === 'ready' && G.turn === 0); H$('#tB').classList.toggle('turn', G.phase === 'ready' && G.turn === 1);
  setText(H$('#clk'), G.untimed ? 'Free' : fmt(G.clock)); setText(H$('#hf'), G.untimed ? 'play' : G.half === 1 ? '1st half' : '2nd half');
  let st;
  const yours = human(G.turn), solo = soloTeam() >= 0;
  if (G.phase === 'ready') {
    const k = G.kits[G.turn];
    if (G.arrange) {
      const at = G.arrange.team;
      const where = G.arrange.mode === 'goalkick' ? 'anywhere outside the kicker’s box' : 'in your half, outside the box and centre circle';
      st = human(at) ? `<b>${solo ? 'Arrange your caps' : esc(G.names[at]) + ': arrange your caps'}</b> ${where} · then press Ready`
                     : `<b>${esc(who(at))}</b> is setting up`;
    }
    else if (!yours) st = `<b>${esc(who(G.turn))}</b> is lining up a flick · ${MODE[G.mode] || ''}`;
    else if (placing()) st = `<b>${solo ? 'Your' : esc(G.names[G.turn]) + ':'}</b> ${(MODE[G.mode] || '').toLowerCase()} · place the taker, then Ready`;
    else st = `<b>${solo ? 'Your' : esc(G.names[G.turn])}</b> flick · ${MODE[G.mode] || ''}${G.forced !== null ? ' · only the lit taker can play it' : ''}`;
    H$('#ctrl').style.borderTopColor = k.a === '#f4f4f2' ? k.b : k.a;
  } else if (G.phase === 'moving') st = human(1 - G.turn) ? `Ball in play · <b>${solo ? 'your' : esc(G.names[1 - G.turn])}</b> keeper is live` : 'Ball in play';
  else if (G.phase === 'goal') st = `<b>Goal</b> for ${esc(G.names[G.scorer])}`;
  else st = 'Referee stops play';
  if (prev.st !== st) { prev.st = st; H$('#status').innerHTML = st; }
  const can = G.phase === 'ready' && yours;
  const arrHuman = !!G.arrange && G.phase === 'ready' && human(G.arrange.team);
  if (H$('#btnReady').hidden === arrHuman) { H$('#btnReady').hidden = !arrHuman; V.setZoneHint(arrHuman ? arrangeArea(G.arrange.team) : null); }
  paintPlacing();
  const movable = can && !G.arrange && G.forced !== null && !!G.zone && !placing();
  if (H$('#btnMove').hidden === movable) H$('#btnMove').hidden = !movable;
  if (!movable && moveMode) setMoveMode(false);
  autoFrame();
  if (prev.can !== can) { prev.can = can; for (const el of $$('#shot .ctl, #btnMove')) el.style.opacity = can ? 1 : 0.5; }
  const other = who(G.turn);
  const hint = G.arrange && human(G.arrange.team) ? `Drag a lit cap to move it. The ${G.arrange.mode === 'goalkick' ? 'goal kick' : 'kick-off'} waits for Ready.` : placing() ? 'Drag the lit taker where you want it, then tap Ready.' : can ? 'Pull back from a lit cap and let go.' : (G.phase === 'ready' ? (ctl[G.turn] === 'ai' ? 'Computer is thinking…' : `${other} is aiming…`) : 'Waiting for the ball to settle…');
  if (!dragging && !keeperDrag && !moveMode && prev.hint !== hint) { prev.hint = hint; H$('#hint').textContent = hint; }
  setText(H$('#btnFlat'), isFlat() ? '3D' : '2D');
  const az = V ? V.getAz() : 0;
  if (prev.az === undefined || Math.abs(az - prev.az) > 0.01) {                      // only when the camera turns
    prev.az = az; $$('.pad button[data-d]').forEach(b => { b.style.transform = `rotate(${(b.dataset.d === '-1' ? az : az + Math.PI) * 57.3}deg)`; });
  }
  paintNet();
}
/* Goals and the breaks get the big centre banner. Restarts, fouls and cards get a slim strip along the top edge,
   so the pitch stays in view while you line up the next flick. */
const BIG = new Set(['GOAL!', 'Own goal!', 'Half-time', 'Full time']);
function showBanner(text, kind, detail) {
  const b = $('#banner'); b.className = ''; void b.offsetWidth;
  const big = BIG.has(text);
  b.querySelector('.tt').textContent = text; b.querySelector('.dt').textContent = detail || '';
  b.querySelector('.ebt').textContent = kind === 'goal' ? 'Goal' : 'Referee';
  b.className = (big ? 'show ' : 'show strip ') + (kind || '');
}
function onEvent(e) {
  S.event(e); ATM.event(e);
  if (e.k === 'banner') showBanner(e.text, e.kind, e.detail);
  if (e.k === 'ref' && V) V.refCall(e);
  if (e.k === 'goal' && V) { const k = G.kits[e.team]; V.burst(k.a, k.b === '#f4f4f2' ? '#ffffff' : k.b); }
  if (e.k === 'pb' && e.jn > 250 && V) V.shake(0.5);
  if (e.k === 'post' && V) V.shake(Math.min(1, e.jn / 500));
  if (e.k === 'wall' && V && V.railHit) V.railHit(e.x, e.z, e.v);
  if (e.k === 'flick') { remoteAim.target = null; watchAim.target = [null, null]; }
}
function setCamButtons(name) { $$('[data-cam]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.cam === name))); }

/* ---------- inputs ----------
   UI actions queue commands for their team. Each tick takes the commands that are due, plus the keeper keys. */
function clearInputs() { pend[0].length = pend[1].length = 0; diveReq[0] = diveReq[1] = 0; }
const curTick = () => net.session ? net.session.tick : localTick;
function queue(t, c, delay) { pend[t].push({ at: curTick() + (delay || 0), c }); }
function inputFor(t, tick) {
  const c = [], due = pend[t].filter(x => x.at <= tick);
  pend[t] = pend[t].filter(x => x.at > tick);
  // a drag produces a move every pointer event: keep only the latest per piece
  for (let i = 0; i < due.length; i++) {
    const a = due[i].c, later = due.slice(i + 1).some(x => x.c[0] === a[0] && (a[0] === 't' || a[0] === 'kt' || (a[0] === 'a' && x.c[1] === a[1])));
    if (!later) c.push(a);
  }
  const dv = diveReq[t]; diveReq[t] = 0;
  return { kd: keeperDir(t), dv, c };
}
const flickQueued = () => pend.some(q => q.some(x => x.c[0] === 'f'));

/* ---------- shot controls ---------- */
const loftEl = $('#loft'), curlEl = $('#curl');
function shotParams() { return { loft: +loftEl.value * Math.PI / 180, curl: +curlEl.value / 100 }; }
function paintShot() {
  const l = +loftEl.value, c = +curlEl.value;
  $('#loftv').textContent = l === 0 ? 'flat' : l + '°';
  $('#curlv').textContent = c === 0 ? 'none' : (c > 0 ? 'right ' : 'left ') + Math.abs(c) + '%';
}
loftEl.oninput = curlEl.oninput = paintShot;
function resetShot() { loftEl.value = 0; curlEl.value = 0; paintShot(); }

/* ---------- pointer input ----------
   One finger or mouse: pull back from a lit cap to flick, drag your keeper to move it. Dragging empty table moves
   the view: on a touch screen it slides the table (as a map does); with a mouse it turns and tilts (let go
   mid-swipe and it keeps turning). Double tap empty table: the best view for the play in hand.
   Two fingers, as in maps: pinch to zoom toward your fingers, twist to turn the table the same way the fingers
   turn, slide both up or down to tilt, slide them sideways to move the table. Each part only starts once it is
   clearly meant (dead zones), and then stays on for that gesture, so a pinch never tilts or spins. */
let dragging = null, orbit = null, keeperDrag = null, gesture = null, arrDrag = null;
const touches = new Map();
const stage = $('#stage');
function eligible(p) { return G && G.phase === 'ready' && !G.arrange && !placing() && human(G.turn) && !flickQueued() && p.kind === 'p' && !p.off && p.team === G.turn && (G.forced === null || G.forced === p.id); }
function nearest(x, z, rad) {
  let best = null, bd = rad;
  for (const p of G.w.players) if (eligible(p)) { const d = Math.hypot(p.x - x, p.z - z); if (d < bd) { bd = d; best = p; } }
  return best;
}
function nearestKeeper(x, z, rad) {
  if (!G || G.phase === 'halftime' || G.phase === 'fulltime') return null;
  let best = null, bd = rad;
  for (let t = 0; t < 2; t++) if (human(t)) { const k = R.keeperOf(G, t), d = Math.hypot(k.x - x, k.z - z); if (d < bd) { bd = d; best = k; } }
  return best;
}
function powerColor(p) { return p < 0.5 ? '#62d98b' : p < 0.8 ? '#f5c400' : '#ff5a3c'; }
function endKeeperDrag() { if (keeperDrag) { keeperDrag = null; V.setBoxHint(0); V.setHover(-1); } }
stage.addEventListener('contextmenu', e => e.preventDefault());
stage.addEventListener('pointerdown', e => {
  if (mode !== 'play' || !V || !G) return;
  S.init(); try { stage.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  V.stopFling && V.stopFling();
  if (touches.size === 2) {                                   // second finger: switch to a camera gesture
    cancelDrag(); endKeeperDrag(); orbit = null;
    const [p1, p2] = [...touches.values()], d = Math.hypot(p1.x - p2.x, p1.y - p2.y), mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2, a = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    gesture = { d, mx, my, a, d0: d, mx0: mx, my0: my, a0: a, zoom: false, pan: false, twist: false, tilt: false };
    return;
  }
  if (touches.size > 2) return;
  const pt = V.pickPlane(e.clientX, e.clientY), touch = e.pointerType === 'touch';
  if (moveMode && pt && e.button === 0) { takerDrag = { pid: e.pointerId }; queue(G.turn, R.cmd.taker(pt.x, pt.z)); return; }
  if (placing() && pt && e.button === 0) {          // set piece, before Ready: pick up the taker, or tap where it should stand
    const tk = G.w.players[G.forced], d = Math.hypot(tk.x - pt.x, tk.z - pt.z), r = R.zoneClamp(G, pt.x, pt.z, tk.id);
    if (d < (touch ? 6.5 : 4.4)) { takerDrag = { pid: e.pointerId, ox: tk.x - pt.x, oz: tk.z - pt.z }; V.setHover(tk.id); stage.style.cursor = 'grabbing'; return; }
    if (r && Math.hypot(r[0] - pt.x, r[1] - pt.z) < 1.5) { takerDrag = { pid: e.pointerId, ox: 0, oz: 0 }; queue(G.turn, R.cmd.taker(pt.x, pt.z)); return; }
  }
  if (G.arrange && human(G.arrange.team) && pt && e.button === 0) {          // kick-off arrangement: pick up one of your caps
    let best = null, bd = touch ? 6 : 4.4;
    for (const q of R.outfield(G, G.arrange.team)) { const dd = Math.hypot(q.x - pt.x, q.z - pt.z); if (dd < bd) { bd = dd; best = q; } }
    if (best) { arrDrag = { id: best.id, team: best.team, pid: e.pointerId, ox: best.x - pt.x, oz: best.z - pt.z }; V.setHover(best.id); stage.style.cursor = 'grabbing'; return; }
  }
  if (e.button !== 0 || !pt) { orbit = { x: e.clientX, y: e.clientY, pid: e.pointerId, t: performance.now() }; return; }
  const p = nearest(pt.x, pt.z, touch ? 6.5 : 4.4), k = nearestKeeper(pt.x, pt.z, touch ? 7 : 5);
  const pd = p ? Math.hypot(p.x - pt.x, p.z - pt.z) : 1e9, kd = k ? Math.hypot(k.x - pt.x, k.z - pt.z) : 1e9;
  if (p && pd <= kd) { dragging = { id: p.id, pid: e.pointerId, power: 0, ok: false }; V.setHover(p.id); sendAim(p.id, 0, 0, 0, true); }
  else if (k) {
    keeperDrag = { t: k.team, pid: e.pointerId, ox: k.x - pt.x, oz: k.z - pt.z };
    V.setHover(k.id); V.setBoxHint(Math.sign(k.homeX)); stage.style.cursor = 'grabbing';
    $('#hint').textContent = 'Move your keeper anywhere in the six-yard box.';
  }
  else orbit = { x: e.clientX, y: e.clientY, pid: e.pointerId, t: performance.now(), pan: touch && !!V.pan };
});
stage.addEventListener('pointermove', e => {
  if (mode !== 'play' || !V || !G) return;
  if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (gesture && touches.size === 2) {
    const g = gesture, [p1, p2] = [...touches.values()], d = Math.hypot(p1.x - p2.x, p1.y - p2.y), mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
    const a = Math.atan2(p2.y - p1.y, p2.x - p1.x), wrap = x => Math.atan2(Math.sin(x), Math.cos(x));
    // switch each part on once it is clearly intended, and keep it on for the rest of this gesture
    if (!g.zoom && g.d0 > 0 && Math.abs(Math.log(d / g.d0)) > 0.08) g.zoom = true;
    if (!g.pan && !g.tilt && Math.hypot(mx - g.mx0, my - g.my0) > 14) {
      // both fingers sliding up or down together (and not pinching or twisting): tilt, as in maps; otherwise move
      if (!g.zoom && !g.twist && Math.abs(my - g.my0) > 1.6 * Math.abs(mx - g.mx0)) g.tilt = true; else g.pan = true;
    }
    if (!g.twist && Math.abs(wrap(a - g.a0)) > 0.22) g.twist = true;
    if (g.zoom && g.d > 0 && d > 0) { if (V.zoomAt) V.zoomAt(g.d / d, mx, my); else V.zoom(g.d / d); }   // the flat 2D board has plain zoom
    if (g.pan && V.pan) V.pan(mx - g.mx, my - g.my);
    if (g.tilt) V.orbit(0, (my - g.my) * 0.005);
    if (g.twist) V.orbit(wrap(a - g.a), 0);            // fingers turn clockwise, the table turns clockwise
    Object.assign(g, { d, mx, my, a }); setCamButtons(V.preset); return;
  }
  if (arrDrag && e.pointerId === arrDrag.pid) { const pt = V.pickPlane(e.clientX, e.clientY); if (pt) queue(arrDrag.team, R.cmd.arrange(arrDrag.id, pt.x + arrDrag.ox, pt.z + arrDrag.oz)); return; }
  if (takerDrag && e.pointerId === takerDrag.pid) { const pt = V.pickPlane(e.clientX, e.clientY); if (pt) queue(G.turn, R.cmd.taker(pt.x + (takerDrag.ox || 0), pt.z + (takerDrag.oz || 0))); return; }
  if (keeperDrag && e.pointerId === keeperDrag.pid) {
    const pt = V.pickPlane(e.clientX, e.clientY);
    if (pt) queue(keeperDrag.t, R.cmd.keeperTo(pt.x + keeperDrag.ox, pt.z + keeperDrag.oz));
    return;
  }
  if (dragging && e.pointerId === dragging.pid) {
    if (!eligible(G.w.players[dragging.id])) { cancelDrag(); return; }
    const p = G.w.players[dragging.id], pt = V.pickPlane(e.clientX, e.clientY); if (!pt) return;
    const dx = p.x - pt.x, dz = p.z - pt.z, len = Math.hypot(dx, dz);
    const pw = Math.min(1, len / MAX_PULL); dragging.power = pw; dragging.dx = dx; dragging.dz = dz; dragging.ok = len >= MIN_PULL;
    if (dragging.ok) V.setAim(p.x, p.z, dx / len, dz / len, pw, powerColor(pw)); else V.hideAim();
    sendAim(p.id, dragging.ok ? dx / len : 0, dragging.ok ? dz / len : 0, dragging.ok ? pw : 0);
    $('#pw').style.width = (pw * 100) + '%'; $('#pw').style.background = powerColor(pw); $('#pwv').textContent = dragging.ok ? Math.round(pw * 100) + '%' : 'cancel';
    $('#hint').textContent = dragging.ok ? 'Release to flick. Pull back to cancel.' : 'Too short, no flick.';
  } else if (orbit && e.pointerId === orbit.pid) {
    const dx = e.clientX - orbit.x, dy = e.clientY - orbit.y, now = performance.now(), dtm = Math.max(8, now - (orbit.t || now - 16));
    if (Math.abs(dx) + Math.abs(dy) > 3) orbit.moved = true;
    if (orbit.pan) { if (orbit.moved) V.pan(dx, dy); orbit.x = e.clientX; orbit.y = e.clientY; orbit.t = now; setCamButtons(V.preset); return; }
    V.orbit(-dx * 0.006, dy * 0.005);
    orbit.vaz = 0.7 * (orbit.vaz || 0) + 0.3 * (-dx * 0.006 / (dtm / 1000)); orbit.vel = 0.7 * (orbit.vel || 0) + 0.3 * (dy * 0.005 / (dtm / 1000));
    orbit.x = e.clientX; orbit.y = e.clientY; orbit.t = now; setCamButtons(V.preset);
  } else if (!e.buttons && e.pointerType !== 'touch' && placing()) {
    const pt = V.pickPlane(e.clientX, e.clientY), tk = G.w.players[G.forced];
    stage.style.cursor = pt && Math.hypot(tk.x - pt.x, tk.z - pt.z) < 4.4 ? 'grab' : 'default';
  } else if (!e.buttons && e.pointerType !== 'touch') {
    const pt = V.pickPlane(e.clientX, e.clientY), p = pt ? nearest(pt.x, pt.z, 4.4) : null, k = !p && pt ? nearestKeeper(pt.x, pt.z, 5) : null;
    const hv = p ? p.id : k ? k.id : -1;
    V.setHover(hv); stage.style.cursor = p || k ? 'grab' : 'default';
    if (p || prev.hov !== hv) { prev.hov = hv; sendHover(p ? p.id : -1); }
  }
});
function cancelDrag() { const had = dragging; dragging = null; if (V) { V.hideAim(); V.setHover(-1); } $('#pw').style.width = '0%'; $('#pwv').textContent = '0%'; if (had) sendAim(-1); }
function pointerEnd(e) {
  touches.delete(e.pointerId);
  if (gesture && touches.size < 2) { gesture = null; return; }
  if (arrDrag && e.pointerId === arrDrag.pid) { arrDrag = null; V.setHover(-1); stage.style.cursor = 'default'; return; }
  if (takerDrag && e.pointerId === takerDrag.pid) { if (moveMode) setMoveMode(false); else { takerDrag = null; stage.style.cursor = 'default'; } return; }
  if (keeperDrag && e.pointerId === keeperDrag.pid) { endKeeperDrag(); stage.style.cursor = 'default'; prev.hint = null; return; }
  if (dragging && e.pointerId === dragging.pid) {
    const d = dragging, p = G.w.players[d.id];
    if (e.type === 'pointerup' && d.ok && eligible(p)) {
      const sp = shotParams(), speed = flickSpeedOf(d.power);
      const delay = net.session ? net.session.flickDelay() : 0;
      queue(p.team, R.cmd.flick(d.id, d.dx, d.dz, speed, sp.curl), delay); resetShot();
      sendAim(d.id, d.dx / Math.hypot(d.dx, d.dz), d.dz / Math.hypot(d.dx, d.dz), d.power, false, true);
      dragging = null; V.setHover(-1); $('#pw').style.width = '0%'; $('#pwv').textContent = '0%';
      if (delay) setTimeout(() => V.hideAim(), delay * TICK * 1000); else V.hideAim();
    } else cancelDrag();
  }
  if (orbit && e.pointerId === orbit.pid) {
    const o = orbit; orbit = null;
    const now = performance.now();
    if (o.moved && !o.pan && e.type === 'pointerup' && now - (o.t || 0) < 80 && V.fling) V.fling(o.vaz || 0, (o.vel || 0) * 0.6);   // let go while moving: keep turning
    else if (!o.moved && e.type === 'pointerup') {                                                                         // a tap on empty table
      if (lastTap && now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) { lastTap = null; showBestView(); toastCam(); }
      else lastTap = { t: now, x: e.clientX, y: e.clientY };
    }
  }
}
let lastTap = null, camToastT = null;
function toastCam() { const h = $('#hint'); if (!h) return; const was = h.textContent, msg = V.preset === 'play' ? 'Best view for this play.' : 'View reset.'; h.textContent = msg; clearTimeout(camToastT); camToastT = setTimeout(() => { if (h.textContent === msg) h.textContent = was; }, 1400); }
// Safari has its own page pinch and rotate: keep them off the board so two fingers always move the table.
['gesturestart', 'gesturechange', 'gestureend'].forEach(ev => stage.addEventListener(ev, e => e.preventDefault(), { passive: false }));
stage.addEventListener('pointerup', pointerEnd);
stage.addEventListener('pointercancel', pointerEnd);
stage.addEventListener('wheel', e => { e.preventDefault(); if (V) V.zoom(e.deltaY > 0 ? 1.08 : 0.92); }, { passive: false });

/* ---------- the best view for the play in hand ----------
   A set piece is seen from behind the ball, looking where the kick goes (the goal for a corner, free kick or
   penalty; up the pitch for a goal kick or throw-in), close enough to place the taker and wide enough to see the
   target. Anything else, kick-offs included, gets the standard view of the whole table. It is chosen at the start
   of every set piece (unless switched off in View), on a double tap, and from the view button. */
function bestView() {
  if (!G || G.phase !== 'ready' || G.forced === null || !G.zone || G.mode === 'kickoff' || G.arrange) return null;
  const C = window.Phys.C, b = G.w.ball, dir = G.dir[G.turn];
  let fx = dir * C.HL, fz = 0;
  if (G.mode === 'goalkick') { fx = b.x + dir * 45; fz = b.z * 0.5; }
  else if (G.mode === 'throw') { fx = b.x + dir * 25; fz = b.z * 0.25; }
  let dx = fx - b.x, dz = fz - b.z; const len = Math.hypot(dx, dz) || 1; dx /= len; dz /= len;
  const span = Math.min(len, 70);
  return { az: Math.atan2(-dx, -dz), el: G.mode === 'penalty' ? 0.62 : 0.8, dist: Math.max(70, Math.min(190, 60 + span * 1.2)),
           tx: b.x + dx * span * 0.42, tz: b.z + dz * span * 0.42 };
}
function showBestView() {
  if (!V) return;
  const v = bestView();
  if (v && V.setPlay) V.setPlay(v); else if (V.reset) V.reset(); else V.setPreset('broadcast');
  setCamButtons(V.preset); syncCam(true);
}
let autoCam = true;
try { autoCam = localStorage.getItem('ff-autocam') !== 'off'; } catch (e) { /* private mode */ }
/* Called every frame: a new set piece gets its best view. */
function autoFrame() {
  if (!V || !G) return;
  const pk = bestView() ? `${G.mode}:${G.turn}:${G.forced}:${Math.round(G.w.ball.x)},${Math.round(G.w.ball.z)}` : '';
  if (pk !== prev.play) { prev.play = pk; if (pk && autoCam && !dragging && !gesture && !orbit) showBestView(); }
  // the set piece has been played and open play goes on: back to the usual view of the whole table
  if (!pk && autoCam && V.preset === 'play' && G.phase === 'ready' && !dragging && !gesture && !orbit) { V.setPreset('broadcast'); setCamButtons('broadcast'); }
}
$('#btnBest').onclick = () => { showBestView(); toastCam(); };
$('#camAuto').checked = autoCam;
$('#camAuto').onchange = e => { autoCam = e.target.checked; try { localStorage.setItem('ff-autocam', autoCam ? 'on' : 'off'); } catch (x) { /* ignore */ } };

/* ---------- arranging before a kick-off or a goal kick ---------- */
function arrangeArea(t) {
  const d = G.dir[t], C = window.Phys.C, A = G.arrange;
  if (A && A.mode === 'goalkick') { const edge = A.side * (C.HL - C.boxD); return { type: 'rect', x0: A.side > 0 ? -C.HL : edge, x1: A.side > 0 ? edge : C.HL, z0: -C.HW, z1: C.HW }; }   // all but the kicker's end
  return { type: 'rect', x0: d > 0 ? -C.HL : 0, x1: d > 0 ? 0 : C.HL, z0: -C.HW, z1: C.HW };
}
$('#btnReady').onclick = () => { if (G && G.arrange && human(G.arrange.team)) { queue(G.arrange.team, R.cmd.arrangeDone()); V.setZoneHint(null); arrDrag = null; prev.hint = null; } };

/* ---------- moving a set-piece taker ---------- */
function setMoveMode(on) {
  moveMode = on; takerDrag = null;
  $('#btnMove').setAttribute('aria-pressed', String(on)); $('#btnMove').textContent = on ? 'Done' : 'Move taker';
  if (V) { V.setZoneHint(on && G ? G.zone : null); if (on) V.setHover(G.forced); else V.setHover(-1); }
  prev.hint = null;
  if (on) $('#hint').textContent = 'Drag or tap inside the yellow area to place the taker.';
}
$('#btnMove').onclick = () => setMoveMode(!moveMode);

/* ---------- set pieces: place the taker first, then Ready ----------
   People did not find "Move taker". So every set piece you take (free kick, corner, goal kick, throw-in, penalty)
   starts with the taker picked up: the yellow area shows where it may stand, and dragging the lit cap (or tapping
   inside the area) moves it. A small card beside the cap says so and carries the Ready button; after Ready you pull
   back and flick as usual. The same card carries Ready while you arrange your caps for a kick-off or a goal kick.
   Placing is only on this screen: the moves go out as ordinary taker commands, so the other side sees the cap move. */
const place = { key: '', on: false };
function placeKey() {
  if (!G || mode !== 'play' || G.phase !== 'ready' || G.forced === null || !G.zone || G.arrange || G.mode === 'kickoff' || !human(G.turn) || net.watch) return '';
  return `${G.mode}:${G.turn}:${G.forced}:${Math.round(G.w.ball.x * 10)},${Math.round(G.w.ball.z * 10)}`;
}
const placing = () => place.on && !!place.key && place.key === placeKey();
function paintPlacing() {
  const k = placeKey();
  if (k === place.key) return;
  const was = placing();
  place.key = k; place.on = !!k;
  if (place.on) { if (moveMode) setMoveMode(false); V.setZoneHint(G.zone); V.setHover(G.forced); prev.hint = null; }
  else if (was && !moveMode) { V.setZoneHint(null); V.setHover(-1); }
}
function setReady() {
  if (G && G.arrange && human(G.arrange.team)) { $('#btnReady').click(); return; }
  if (!placing()) return;
  place.on = false; takerDrag = null; stage.style.cursor = 'default';
  V.setZoneHint(null); V.setHover(-1); prev.hint = null; paintCard();
}
$('#setReady').onclick = e => { e.stopPropagation(); setReady(); };
/* Keep the card beside its cap, on the side away from the ball, inside the board. Called every frame. */
function paintCard() {
  const card = $('#setCard'), arr = !!(G && G.arrange && G.phase === 'ready' && human(G.arrange.team) && mode === 'play');
  const show = !!V && (placing() || arr);
  if (card.hidden === show) { card.hidden = !show; if (show) $('#setCardTxt').textContent = arr ? 'Drag your caps into place' : 'Drag to move the taker'; }
  if (!show) return;
  const b = G.w.ball, at = arr ? b : G.w.players[G.forced];
  const box = $('#board').getBoundingClientRect(), S = V.toScreen(at.x, 0, at.z), B = V.toScreen(b.x, 0, b.z);
  let dx = S.x - B.x, dy = S.y - B.y; const l = Math.hypot(dx, dy);
  if (arr || l < 4) { dx = 0; dy = -1; } else { dx /= l; dy /= l; }
  const w = card.offsetWidth, h = card.offsetHeight, gap = 26 + Math.abs(dx) * w / 2 + Math.abs(dy) * h / 2;   // clear of the cap, whichever side
  const x = Math.max(w / 2 + 8, Math.min(box.width - w / 2 - 8, S.x - box.left + dx * gap));
  const y = Math.max(h / 2 + 8, Math.min(box.height - h / 2 - 8, S.y - box.top + dy * gap));
  const key = Math.round(x) + ',' + Math.round(y);
  if (card.dataset.at !== key) { card.dataset.at = key; card.style.left = x + 'px'; card.style.top = y + 'px'; }
}

/* ---------- view tips: shown for about three seconds as a match starts ---------- */
let tipT = 0;
function flashGestures() {
  const el = $('#gestTip');
  el.classList.toggle('mouse', !PHONE);
  clearTimeout(tipT); el.hidden = false; void el.offsetWidth; el.classList.add('on');
  const hide = () => { clearTimeout(tipT); el.classList.remove('on'); tipT = setTimeout(() => { el.hidden = true; }, 350); stage.removeEventListener('pointerdown', hide); };
  tipT = setTimeout(hide, 2700);
  stage.addEventListener('pointerdown', hide);            // touching the table means they are off: get out of the way
}

/* ---------- view panel ---------- */
const isFlat = () => V && V.getCam().tilt > 0.93;
$('#btnFlat').onclick = () => { if (!V) return; const p = isFlat() ? 'broadcast' : 'top'; V.setPreset(p); setCamButtons(p); syncCam(true); };
const camEls = { tilt: $('#camTilt'), turn: $('#camTurn'), zoom: $('#camZoom') };
$('#btnView').onclick = () => { const p = $('#viewPanel'); p.hidden = !p.hidden; $('#btnView').setAttribute('aria-expanded', String(!p.hidden)); syncCam(true); };
$$('[data-cam]').forEach(b => b.onclick = () => { if (b.dataset.cam === 'play') { showBestView(); return; } V.setPreset(b.dataset.cam); setCamButtons(b.dataset.cam); });
camEls.tilt.oninput = () => V.setCam({ tilt: camEls.tilt.value / 100 });
camEls.zoom.oninput = () => V.setCam({ zoom: camEls.zoom.value / 100 });
camEls.turn.oninput = () => { V.setCam({ turn: -camEls.turn.value * Math.PI / 180 }); setCamButtons('free'); };
function syncCam(force) {
  if (!V || $('#viewPanel').hidden) return;
  const c = V.getCam(), act = document.activeElement;
  const tilt = Math.round(c.tilt * 100), turn = Math.round(-c.turn * 180 / Math.PI), zoom = Math.round(c.zoom * 100);
  if (force || act !== camEls.tilt) camEls.tilt.value = tilt;
  if (force || act !== camEls.turn) camEls.turn.value = turn;
  if (force || act !== camEls.zoom) camEls.zoom.value = zoom;
  $('#camTiltV').textContent = tilt < 12 ? 'level' : tilt > 92 ? 'overhead' : Math.round(9 + c.tilt * 80) + '°';
  $('#camTurnV').textContent = turn + '°'; $('#camZoomV').textContent = zoom < 35 ? 'close' : zoom > 70 ? 'far' : 'mid';
}
/* ---------- sound menu: master, mute, and a switch, volume and test for each channel ---------- */
function paintSound() {
  const c = S.settings();
  $('#sndMute').checked = c.muted; $('#sndMaster').value = Math.round(c.master * 100);
  for (const row of $$('#soundPanel .sp-row[data-ch]')) {
    const ch = row.dataset.ch, cb = row.querySelector('input[type=checkbox]'), sl = row.querySelector('input[type=range]');
    cb.checked = c[ch].on; sl.value = Math.round(c[ch].vol * 100); row.classList.toggle('off', !c[ch].on || c.muted);
  }
  $('#sndVoiceRow').hidden = !window.speechSynthesis;
  $('#btnSound .lg').textContent = c.muted ? 'Muted' : 'Sound'; $('#btnSound .sm').style.opacity = c.muted ? 0.4 : 1;
}
function fillVoices() {
  const sel = $('#sndVoice'), want = S.settings().voice.voiceName, vs = ATM.voices();
  sel.innerHTML = '<option value="">Automatic</option>' + vs.map(v => `<option value="${esc(v.name)}">${esc(v.name)} (${esc(v.lang)})</option>`).join('');
  sel.value = vs.some(v => v.name === want) ? want : '';
}
if (window.speechSynthesis) window.speechSynthesis.onvoiceschanged = fillVoices;
$('#btnSound').onclick = () => {
  S.init(); const p = $('#soundPanel'); p.hidden = !p.hidden; $('#btnSound').setAttribute('aria-expanded', String(!p.hidden));
  if (!p.hidden) { paintSound(); fillVoices(); }
};
$('#sndMute').onchange = e => { S.set({ muted: e.target.checked }); paintSound(); };
$('#sndMaster').oninput = e => { S.set({ master: e.target.value / 100 }); };
$$('#soundPanel .sp-row[data-ch]').forEach(row => {
  const ch = row.dataset.ch;
  row.querySelector('input[type=checkbox]').onchange = e => { S.set({ [ch]: { on: e.target.checked } }); paintSound(); };
  row.querySelector('input[type=range]').oninput = e => { S.set({ [ch]: { vol: e.target.value / 100 } }); };
  row.querySelector('button').onclick = () => { S.init(); if (ch === 'sfx') S.event({ k: 'whistle', type: 'foul' }); else ATM.test(ch); };
});
$('#sndVoice').onchange = e => { S.set({ voice: { voiceName: e.target.value } }); ATM.test('voice'); };
document.addEventListener('pointerdown', e => {                       // click away closes the menu
  const p = $('#soundPanel'); if (!p.hidden && !p.contains(e.target) && !$('#btnSound').contains(e.target)) { p.hidden = true; $('#btnSound').setAttribute('aria-expanded', 'false'); }
});
paintSound();

/* ---------- keepers: keys and on-screen pads ---------- */
const keys = new Set(), pad = [0, 0];
const KEYMAP = [{ f: 'KeyW', b: 'KeyS', l: 'KeyA', r: 'KeyD', dive: 'Space' }, { f: 'ArrowUp', b: 'ArrowDown', l: 'ArrowLeft', r: 'ArrowRight', dive: 'Enter' }];
function mapsFor(t) { if (!human(t)) return []; return soloTeam() === t ? KEYMAP : [KEYMAP[t]]; }
function keeperDir(t) {
  const az = V ? V.getAz() : 0, up = -Math.cos(az), right = -Math.sin(az); let d = 0;
  for (const m of mapsFor(t)) { if (keys.has(m.f)) d += up; if (keys.has(m.b)) d -= up; if (keys.has(m.r)) d += right; if (keys.has(m.l)) d -= right; }
  d = Math.abs(d) < 0.3 ? 0 : Math.sign(d);
  return d || pad[t];
}
function doDive(t) {
  if (!G || !human(t) || G.phase === 'halftime' || G.phase === 'fulltime') return;
  const k = R.keeperOf(G, t); let d = keeperDir(t);
  if (!d) d = Math.sign(G.w.ball.z - k.z) || 1;
  diveReq[t] = d;
}
window.addEventListener('keydown', e => {
  if (mode !== 'play' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  for (let t = 0; t < 2; t++) for (const m of mapsFor(t)) {
    if (e.code === m.dive) { e.preventDefault(); if (!e.repeat) doDive(t); }
    if (e.code === m.f || e.code === m.b || e.code === m.l || e.code === m.r) { e.preventDefault(); keys.add(e.code); }
  }
  if (e.code === 'Escape') { if (dragging || keeperDrag || moveMode) { cancelDrag(); if (moveMode) setMoveMode(false); } else toggleMenu(); }
  if (e.code === 'KeyM' && !$('#btnMove').hidden) setMoveMode(!moveMode);
  if ((e.code === 'Enter' || e.code === 'NumpadEnter') && !$('#setCard').hidden && e.target.tagName !== 'BUTTON') { e.preventDefault(); setReady(); }
  if (V && !e.repeat) {
    if (e.code === 'KeyQ') { V.orbit(0.2, 0); setCamButtons(V.preset); }
    if (e.code === 'KeyE') { V.orbit(-0.2, 0); setCamButtons(V.preset); }
    if (e.code === 'KeyR') V.orbit(0, 0.12);
    if (e.code === 'KeyF') V.orbit(0, -0.12);
  }
});
window.addEventListener('keyup', e => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());
$$('.pad').forEach(el => {
  const t = +el.dataset.team;
  el.querySelectorAll('button[data-d]').forEach(b => {
    const on = ev => { ev.preventDefault(); S.init(); pad[t] = +b.dataset.d; b.classList.add('on'); try { b.setPointerCapture(ev.pointerId); } catch (x) { /* ignore */ } };
    const off = () => { if (pad[t] === +b.dataset.d) pad[t] = 0; b.classList.remove('on'); };
    b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off); b.addEventListener('pointercancel', off); b.addEventListener('lostpointercapture', off);
  });
  el.querySelector('.dive').addEventListener('pointerdown', ev => { ev.preventDefault(); S.init(); doDive(t); });
});

/* ---------- computer turn: think across ticks, show the aim, then flick ---------- */
function runAI(dt) {
  const cpu = cpuTeam();
  if (cpu < 0 || G.phase !== 'ready' || G.turn !== cpu || G.timeUp || G.arrange) {
    if (aiJob && aiJob.shown) { V.hideAim(); V.setHover(-1); }
    aiJob = null; return;
  }
  if (!aiJob) aiJob = { gen: AI.think(G, cpu, level), t: 0, pick: null, shown: false };
  aiJob.t += dt;
  if (!aiJob.pick) {
    const t0 = performance.now();
    while (performance.now() - t0 < (PHONE ? 4 : 7)) { const r = aiJob.gen.next(); if (r.done) { aiJob.pick = r.value; break; } }
    return;
  }
  if (aiJob.t < 0.3) return;
  const pk = aiJob.pick, p = G.w.players[pk.id];
  if (!aiJob.shown) {
    aiJob.shown = true; aiJob.st = aiJob.t; V.setHover(pk.id);
    if (pk.place) queue(cpu, R.cmd.taker(pk.place[0], pk.place[1]));
    if (pk.q) { const px = pk.place ? pk.place[0] : p.x, pz = pk.place ? pk.place[1] : p.z; let dx = pk.q[0] - px, dz = pk.q[1] - pz; const l = Math.hypot(dx, dz) || 1; pk.dx = dx / l; pk.dz = dz / l; }
  }
  const pw = pullOf(pk.speed), k = Math.min(1, (aiJob.t - aiJob.st) / 0.5);
  V.setAim(p.x, p.z, pk.dx, pk.dz, pw * k, powerColor(pw));
  if (aiJob.t - aiJob.st > 0.8) { V.hideAim(); V.setHover(-1); queue(cpu, R.cmd.flick(pk.id, pk.dx, pk.dz, pk.speed, pk.curl)); aiJob = null; }
}

/* ---------- breaks and help ---------- */
const anyLocal = () => (human(0) ? 0 : 1);
function showBreak() {
  const card = $('#breakCard'), ov = $('#breakOv'); ov.hidden = false;
  const score = `<div class="big">${G.score[0]} – ${G.score[1]}</div><p>${esc(G.names[0])} v ${esc(G.names[1])}</p>`;
  const solo = soloTeam();
  if (net.watch) {
    card.innerHTML = `<h2>${G.phase === 'halftime' ? 'Half-time' : 'Full time'}</h2>${score}<p>${G.phase === 'halftime' ? 'Waiting for the players to start the second half.' : 'Stay for a rematch, or leave.'}</p><button class="btn ghost" id="pick">Leave</button>`;
    $('#pick').onclick = () => { ov.hidden = true; quitToSetup(); };
    return;
  }
  if (G.phase === 'halftime') {
    const k2 = 1 - G.firstKick;
    card.innerHTML = `<h2>Half-time</h2>${score}<p>Sides swap. ${esc(who(k2))} ${solo === k2 ? 'kick' : 'kicks'} off.</p><button class="btn" id="go2">Start second half</button>`;
    $('#go2').onclick = () => { ov.hidden = true; queue(anyLocal(), R.cmd.secondHalf()); };
  } else {
    let w = G.score[0] === G.score[1] ? 'Draw' : (G.score[0] > G.score[1] ? G.names[0] : G.names[1]) + ' win';
    if (solo >= 0 && G.score[0] !== G.score[1]) {
      const won = G.score[solo] > G.score[1 - solo], them = who(1 - solo);
      w = won ? `You beat ${them === 'Computer' ? 'the computer' : them}` : `${them === 'Computer' ? 'The computer' : them} wins`;
    }
    card.innerHTML = `<h2>Full time</h2>${score}<p>${esc(w)}</p><div class="row2"><button class="btn" id="again">Rematch</button><button class="btn ghost" id="pick">${net.session ? 'Leave' : 'Change teams'}</button></div>`;
    $('#again').onclick = () => { ov.hidden = true; queue(anyLocal(), R.cmd.rematch()); };
    $('#pick').onclick = () => { ov.hidden = true; quitToSetup(); };
  }
}
$('#btnHelp').onclick = () => { $('#help').hidden = false; };
/* ---------- pause menu: keep playing, end now with a result, or quit to team selection ---------- */
function showHud(on) { $('#topbar').hidden = !on; $('#ctrl').hidden = !on; $('#btnBest').hidden = !on; if (V) V.resize(); }
function quitToSetup() {
  S.stopIntro(); ATM.stop(); keepAwake(false); exitFullscreen(); $('#setCard').hidden = true; place.on = false;
  leaveOnline('You left the match.');
  $('#menuOv').hidden = true; $('#breakOv').hidden = true; $('#viewPanel').hidden = true; $('#btnView').setAttribute('aria-expanded', 'false');
  showHud(false); $('#setup').hidden = false; mode = 'setup'; net.vis = 'public'; openFirst = true; refreshOpenNow(); cancelDrag(); makeGame(); V.setPreset('free', true);
}
function toggleMenu(force) {
  if (mode !== 'play' || !G) return;
  const ov = $('#menuOv'), show = force !== undefined ? force : ov.hidden;
  if (show && (G.phase === 'fulltime' || !$('#breakOv').hidden)) return;
  ov.hidden = !show;
  $('#menuOv h2').textContent = net.session || net.watch ? 'Menu' : 'Paused';
  $('#mQuit').textContent = net.watch ? 'Stop watching' : net.session ? 'Leave match' : 'Quit to menu';
  $('#mEnd').hidden = !!net.watch;
  if (show) { cancelDrag(); $('#menuScore').textContent = `${G.names[0]} ${G.score[0]} – ${G.score[1]} ${G.names[1]}`; $('#mResume').focus(); }
}
$('#btnMenu').onclick = () => toggleMenu(true);
$('#mResume').onclick = () => toggleMenu(false);
$('#mEnd').onclick = () => { $('#menuOv').hidden = true; queue(anyLocal(), R.cmd.end()); };
$('#mQuit').onclick = quitToSetup;
$('#helpClose').onclick = () => { $('#help').hidden = true; };

/* =====================================================================================================
   Online play
   ===================================================================================================== */
const GAME = 'flick';
const net = {
  name: loadName(), room: null, guest: null, lobby: null, link: null, session: null, peer: null, me: 0,
  via: null, pendingStart: null, seeking: false, tried: [], knock: null, open: false, lastAim: 0,
  code: null, watch: null, watchers: 0, live: null,
  vis: 'public'      // Public: the game is listed (open to challengers, then watchable live). Private: link only
};
function loadName() {
  let n = ''; try { n = localStorage.getItem('pc-name') || ''; } catch (e) { /* private mode */ }
  return n || 'Player ' + (1000 + (crypto.getRandomValues(new Uint16Array(1))[0] % 9000));
}
function saveName(n) { net.name = (n || '').trim().slice(0, 24) || net.name; try { localStorage.setItem('pc-name', net.name); } catch (e) { /* ignore */ } }
/* Arriving to play (an invite link, or Play on someone open to challengers): the name the host and everyone
   watching will see comes first. It is asked once per game in this tab, so a refresh goes straight back in.
   The Join tap also counts as the tap that phones need before they allow full screen. */
function askName(code, then) {
  const flag = 'flick-n-' + code;
  let named = false; try { named = !!sessionStorage.getItem(flag); } catch (e) { /* private mode */ }
  if (named) { enterFullscreen(); then(); return; }
  let typed = ''; try { typed = localStorage.getItem('pc-name') || localStorage.getItem('whot-name') || ''; } catch (e) { /* ignore */ }
  const ov = $('#nameOv'), inp = $('#nameIn');
  $('#nameCode').textContent = code;
  inp.value = typed; ov.hidden = false; inp.focus(); inp.select();
  $('#nameForm').onsubmit = e => {
    e.preventDefault(); ov.hidden = true;
    if (inp.value.trim()) saveName(inp.value);
    try { sessionStorage.setItem(flag, '1'); } catch (x) { /* ignore */ }
    enterFullscreen(); then();
  };
  $('#nameCancel').onclick = () => { ov.hidden = true; refreshOpenNow(); };
}

/* ----- holding a room: invite link and quick-match listing ----- */
function ensureRoom() {
  if (net.room) return net.room;
  const room = net.room = Net.host({
    name: net.name,
    onOpen: code => {
      if (net.lobby && net.lobby.code !== code) unlist();      // the code changed (it was taken): list the new one
      paintOnline(); paintNet(); if (net.open) listInLobby();
    },
    onDown: () => { paintOnline(); paintNet(); },              // it reconnects by itself, under the same code
    onKnock: m => onKnock(m),
    onKnockGone: gid => { if (net.knock && net.knock.gid === gid) { clearTimeout(net.knock.timer); net.knock = null; hideToast(); } },
    onLink: (link, guestName) => { net.link = link; net.peer = guestName; },
    onAudio: st => walkie.heard(st),
    onMessage: m => onNetMessage(m),
    onVia: v => { net.via = v; paintNet(); },
    onLeft: () => peerLeft(),
    onWatchers: (n, join) => onWatchers(n, join),
    onReaction: r => gotReaction(r, 'watcher')
  });
  return room;
}
function listInLobby() {
  if (net.lobby || !net.room || !net.room.code) return;
  net.lobby = Net.listOpen(GAME, net.room.code, net.name, false, 1, net.watchers);
  net.lobby.code = net.room.code;
}
function unlist() { if (net.lobby) { net.lobby.close(); net.lobby = null; } }
function setOpen(on) {
  net.open = on; net.vis = on ? 'public' : 'private';
  if (on) { ensureRoom(); listInLobby(); } else unlist();
  paintOnline(); paintNet();
}

/* Someone knocked. If we asked for players (invite or open to challengers) they join after a short count,
   unless we say not now. */
function onKnock(m) {
  // No side for them: already playing someone, someone else is joining, or two people share this screen. They watch.
  if (net.session || net.knock || net.watch || (mode === 'play' && cpuTeam() < 0)) { net.room.decline(m.gid, true); return; }
  // The opponent who dropped, back (same tab token): straight back in on their old side, no countdown.
  const lg = net.lastGuest;
  if (lg && m.rj && m.rj === lg.rj && Date.now() < lg.until && mode === 'play' && cpuTeam() === lg.team) {
    net.knock = { gid: m.gid, name: m.name, rj: m.rj, timer: null, back: true };
    acceptKnock(); return;
  }
  let n = 4;
  net.knock = { gid: m.gid, name: m.name, rj: m.rj, timer: null };
  const tick = () => {
    if (!net.knock || net.knock.gid !== m.gid) return;
    if (n <= 0) { acceptKnock(); return; }
    toast(`<b>${esc(m.name)}</b> wants to play${mode === 'play' && cpuTeam() >= 0 ? ' and will take over the computer' : ''} · starting in ${n}`,
      [['Play now', () => { enterFullscreen(); acceptKnock(); }], ['Not now', declineKnock]]);
    n--; net.knock.timer = setTimeout(tick, 1000);
  };
  tick(); S.event({ k: 'whistle', type: 'short' });
}
function acceptKnock() {
  const k = net.knock; if (!k) return;
  clearTimeout(k.timer); net.knock = null; hideToast();
  unlist(); net.open = false;                  // a match now: listed for spectators instead, if Public
  net.lastGuest = { rj: k.rj, name: k.name, team: -1, until: 0 };   // to know them again if their connection drops
  net.room.accept(k.gid, k.name);
  startAsHost(k.name, !!k.back);
}
function declineKnock() { const k = net.knock; if (!k) return; clearTimeout(k.timer); net.knock = null; hideToast(); net.room.decline(k.gid); }

/* The host seeds the guest with the match as it stands: a match against the computer carries on with the guest
   taking the computer's side, the setup screen starts a fresh match. */
async function startAsHost(guestName, back) {
  await viewReady;
  if (mode !== 'play') { makeGame(); }
  const me = mode === 'play' ? (cpuTeam() >= 0 ? 1 - cpuTeam() : 0) : 0;
  net.me = me; net.peer = guestName;
  if (net.lastGuest) net.lastGuest.team = 1 - me;
  net.pendingStart = { me };
  closeOnline();
  net.link.send({ t: 'start', state: R.snapshot(G), guestTeam: 1 - me, host: net.name, midstream: mode === 'play', back: !!back }, true);
  toast(back ? `<b>${esc(guestName)}</b> is back. Reconnecting…` : `Connecting to <b>${esc(guestName)}</b>…`);
}
function onGo() {
  const ps = net.pendingStart; if (!ps) return;
  net.pendingStart = null; hideToast();
  beginSession(true, ps.me);
}

/* ----- joining: invite link or quick match ----- */
const WAIT_MS = 60000;      // how long a link waits for its host to come back before it counts as expired
/* Coming back after a dropped connection. A guest whose connection dies without a goodbye plays on against the
   computer here, and keeps knocking on the host's room for REJOIN_MS, sooner when the network or the tab comes back.
   The host knows them again by a token this tab keeps for the code (rj), lets them straight back in on their old
   side, and sends the match as it stands on the host's screen (the host's match is the one that counts). */
const REJOIN_MS = 120000;
const STALL_GIVE_UP = 10;    // seconds without the other side's moves before the computer takes their side (they can come back)
function rejoinToken(code) {
  const k = 'flick-rj-' + code; let t = '';
  try { t = sessionStorage.getItem(k) || ''; } catch (e) { /* private mode */ }
  if (!/^[A-Za-z0-9]{6,32}$/.test(t)) { t = Net.newCode() + Net.newCode(); try { sessionStorage.setItem(k, t); } catch (e) { /* ignore */ } }
  return t;
}
function rejoinNow() {
  const r = net.rejoin; if (!r) return;
  clearTimeout(r.timer);
  if (net.guest && !net.link && net.guest.state === 0) { net.guest.close(); net.guest = null; }   // an attempt hung while offline: start afresh
  if (net.guest || net.session || net.watch) return;     // already back, or doing something else now
  if (Date.now() > r.until) { clearTimeout(r.dl); net.rejoin = null; toast(`Could not get back to ${esc(r.host)}'s game, so you carry on against the computer.`, [['OK', hideToast]], 6000); return; }
  joinRoom(r.code, false, true);
}
function scheduleRejoin() {
  const r = net.rejoin; if (!r) return;
  clearTimeout(r.timer);
  const ms = navigator.onLine === false ? 15000 : Math.min(15000, 1000 * 2 ** r.tries++) * (0.5 + Math.random() * 0.5);
  r.timer = setTimeout(rejoinNow, ms);
}
function joinRoom(code, fromQuick, rejoin) {
  const r = net.rejoin;
  leaveOnline();
  if (rejoin) net.rejoin = r;
  net.code = code;
  const giveUp = () => { clearTimeout(net.joinWait); net.joinWait = null; };
  const hostName = rejoin && r ? r.host : '';
  if (rejoin && r && !r.dl) {      // the whole window, however the knocks go (a host whose socket hangs never answers)
    r.dl = setTimeout(() => { if (net.rejoin !== r || net.link) return; stopRejoin(); toast(`Could not get back to ${esc(r.host)}'s game, so you carry on against the computer.`, [['OK', hideToast]], 6000); }, Math.max(0, r.until - Date.now()));
  }
  net.guest = Net.join(code, {
    name: net.name,
    rj: rejoinToken(code),
    onWaiting: () => {
      if (rejoin) { toast(`Waiting for <b>${esc(hostName)}</b> to come back online…`, [['Stop', stopRejoin]], 8000); return; }   // the knock goes in when they do
      if (fromQuick) { const g = net.guest; net.guest = null; if (g) g.close(); net.tried.push(fromQuick); quickMatch(true); return; }   // quick match does not wait
      showJoin('Waiting for the game to open…<br><small>If your friend just switched apps to send you the link, you are let in as soon as they are back.</small>');
      giveUp();
      net.joinWait = setTimeout(() => {
        net.joinWait = null;
        if (!net.guest || net.link) return;
        net.guest.close(); net.guest = null;
        hideJoin(); toast('That invite has expired or the host has gone.', [['OK', hideToast]]);
        refreshOpenNow();
      }, WAIT_MS);
    },
    onKnocking: hostName => { giveUp(); if (rejoin) toast(`Reconnecting to <b>${esc(hostName)}</b>…`, [['Stop', stopRejoin]], 8000); else showJoin(`Waiting for <b>${esc(hostName)}</b> to let you in…`); },
    onLink: (link, hostName) => { giveUp(); net.link = link; net.peer = hostName; if (!rejoin) showJoin(`Joining <b>${esc(hostName)}</b>…`); },
    onAudio: st => walkie.heard(st),
    onMessage: m => onNetMessage(m),
    onVia: v => { net.via = v; paintNet(); },
    onLeft: c => peerLeft(c === 4001),          // 4001: the host left on purpose, so there is nothing to come back to
    onClose: c => {
      net.guest = null; giveUp();
      if (rejoin) {
        // Still no network (or the room restarting): knock again shortly. The host gone or the side taken: stop.
        const why = c === 4001 || c === 4004 ? `${esc(hostName)} has left that game.` : c === 4003 ? `${esc(hostName)} could not take you back.` : c === 4010 ? `${esc(hostName)} is playing someone else now.` : '';
        if (!why) { scheduleRejoin(); return; }
        clearTimeout(r.dl); net.rejoin = null; toast(why + ' You carry on against the computer.', [['OK', hideToast]], 6000); return;
      }
      if (fromQuick) { net.tried.push(fromQuick); quickMatch(true); return; }
      // Both sides already have a player: watch the match instead. The room says "full" (or "busy" while someone joins).
      if (c === 4010) { watchTable(code, 'Both sides already have a player, so you are watching.'); return; }
      const why = c === 4004 ? 'That invite has expired or the host has gone.' : c === 4001 ? 'The host has left that game.' : c === 4003 ? 'The host could not play right now.' : 'Could not reach that game.';
      hideJoin(); toast(why, [['OK', hideToast]]);
      refreshOpenNow();      // that player may have gone: show the list as it is now
    }
  });
  if (rejoin) {                    // an attempt that has not connected in 8 s has hung: drop it and knock again
    const g = net.guest;
    setTimeout(() => { if (net.guest === g && g.state === 0) { g.close(); net.guest = null; scheduleRejoin(); } }, 8000);
  }
}
async function quickMatch(retry) {
  if (!retry) net.tried = [];
  net.seeking = true;
  showJoin('Looking for someone to play…');
  let m = { code: null };
  try { m = await Net.seek(GAME, net.tried.concat(net.room ? [net.room.code] : [])); } catch (e) { /* offline: play the computer */ }
  if (!net.seeking) return;
  if (m.code) { joinRoom(m.code, m.code); return; }
  // Nobody is free: play the computer now and take the next challenger who turns up.
  net.seeking = false; hideJoin();
  if (mode !== 'play') { vsCPU = true; $$('#oppSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.o === 'cpu'))); syncSetup(); await startMatch(); }
  setOpen(true);
  toast('Nobody is free right now. Play the computer, and the next person looking will join you.', [['OK', hideToast]], 6000);
}
function stopRejoin() { if (net.rejoin) { clearTimeout(net.rejoin.timer); clearTimeout(net.rejoin.dl); net.rejoin = null; } if (net.guest && !net.link) { net.guest.close(); net.guest = null; } hideToast(); }
function onStart(m) {
  // We are the guest: take the host's match exactly as it stands.
  hideJoin();
  if (net.rejoin) { clearTimeout(net.rejoin.timer); clearTimeout(net.rejoin.dl); net.rejoin = null; hideToast(); }
  R.restore(G, m.state); G.sink = onEvent;
  if (V) V.attach(G);
  net.me = m.guestTeam; net.peer = m.host;
  beginSession(false, m.guestTeam);
  net.link.send({ t: 'go' }, true);
  if (PHONE && canFull && !isFull()) toast('Play full screen?', [['Full screen', () => { hideToast(); enterFullscreen(); }], ['No thanks', hideToast]], 8000);
  flashGestures();
  R.say(G, m.back ? 'You are back' : m.midstream ? 'You are in' : 'Kick-off', 'info', m.back ? `Back in the match against ${m.host}, as it stands on their screen.` : m.midstream ? `You take over from the computer against ${m.host}.` : `${G.names[0]} v ${G.names[1]}.`);
}

function beginSession(isHost, me) {
  clearInputs(); cancelDrag(); aiJob = null;
  net.session = Rollback.createSession({
    G, me, host: isHost,
    send: (msg, reliable) => net.link && net.link.send(msg, reliable),
    onEvent
  });
  const c = []; c[me] = 'local'; c[1 - me] = 'remote';
  setControllers(c);
  if (mode !== 'play') enterPlay();
  $('#menuOv').hidden = true; $('#help').hidden = true;
  V.setPreset('broadcast'); setCamButtons('broadcast');
  shownBreak = null;
  showBanner('Online', 'info', `Playing ${net.peer}.`);
  if (isHost) {
    feedKeyframe();
    applyVis();
  }
  paintNet(); paintOnline(); syncBackground();
}
/* Walkie-talkie for the two players: hold the walkie-talkie button (or Space) to talk. The audio rides on the players' own
   connection, so watchers never hear it. The microphone is asked for on the first press and let go after a quiet
   spell. A small waveform shows who is talking: the opponent's badge at the top, your own button while you talk. */
const walkie = (() => {
  let mic = null, held = false, peerOn = false, idle = null, ctx = null, myAn = null, peerAn = null, buf = null, raf = 0, audio = null, hist = { me: [], peer: [] };
  const btn = $('#pttBtn'), badge = $('#talkBadge');
  const ac = () => { if (!ctx) { const A = window.AudioContext || window.webkitAudioContext; if (A) ctx = new A(); } if (ctx && ctx.state === 'suspended') ctx.resume(); return ctx; };
  const analyse = stream => { const c = ac(); if (!c) return null; try { const a = c.createAnalyser(); a.fftSize = 256; c.createMediaStreamSource(stream).connect(a); return a; } catch (e) { return null; } };
  const level = (an, on) => { if (!on) return 0; if (!an) return .25 + Math.random() * .55; buf = buf || new Uint8Array(256); an.getByteTimeDomainData(buf); let s = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; s += v * v; } return Math.min(1, Math.sqrt(s / buf.length) * 4.5); };
  function draw(cv, h, v, color) {
    if (!cv) return; h.push(v); if (h.length > 14) h.shift();
    const g = cv.getContext('2d'), W = cv.width, H = cv.height, bw = W / 14; g.clearRect(0, 0, W, H); g.fillStyle = color;
    for (let i = 0; i < 14; i++) { const x = h[h.length - 14 + i] ?? 0, bh = Math.max(H * .12, x * H); g.fillRect(i * bw + bw * .2, (H - bh) / 2, bw * .6, bh); }
  }
  let tick = 0;
  function loop() {
    raf = 0;
    if (!held && !peerOn) { const c = $('#pttWave'); if (c) c.getContext('2d').clearRect(0, 0, c.width, c.height); S.duck && S.duck(false); return; }
    if (++tick % 3 === 0) { draw($('#talkWave'), hist.peer, level(peerAn, peerOn), '#5ad18a'); draw($('#pttWave'), hist.me, level(myAn, held), 'rgba(255,255,255,.4)'); }
    raf = requestAnimationFrame(loop);
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(loop); };
  function paint() {
    const can = !!(net.session && net.link && net.link.audio);
    btn.hidden = !can; btn.classList.toggle('on', held);
    btn.title = net.via === 'p2p' ? 'Walkie-talkie: hold to talk to ' + (net.peer || 'your opponent') : 'The walkie-talkie needs a direct connection';
    badge.hidden = !(can && peerOn);
    if (peerOn) $('#talkName').textContent = net.peer || 'Opponent';
    kick();
  }
  async function press() {
    if (held || !net.link || !net.link.audio) return;
    held = true; clearTimeout(idle); ac(); paint();
    if (!mic) {
      try { mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
      catch (e) { held = false; paint(); toast('The microphone is blocked. Allow it for this site to talk.', [['OK', hideToast]]); return; }
      mic.getAudioTracks()[0].enabled = false; myAn = analyse(mic);
      await net.link.setMic(mic.getAudioTracks()[0]);
    }
    if (!held) return;
    mic.getAudioTracks()[0].enabled = true;
    net.link.send({ t: 'talk', on: true }, true);
    paint();
  }
  function release() {
    if (!held) return;
    held = false;
    if (mic) mic.getAudioTracks()[0].enabled = false;
    if (net.link) net.link.send({ t: 'talk', on: false }, true);
    paint();
    idle = setTimeout(dropMic, 45000);
  }
  function dropMic() { if (held || !mic) return; if (net.link) net.link.setMic(null); mic.getTracks().forEach(t => t.stop()); mic = null; myAn = null; }
  function heard(stream) {
    if (!audio) { audio = document.createElement('audio'); audio.autoplay = true; audio.setAttribute('playsinline', ''); audio.style.display = 'none'; document.body.appendChild(audio); }
    audio.srcObject = stream; audio.play().catch(() => {});
    peerAn = analyse(stream);
  }
  function peerTalking(on) { peerOn = on; if (S.duck) S.duck(on); paint(); }
  function stop() { held = false; peerOn = false; clearTimeout(idle); if (mic) { mic.getTracks().forEach(t => t.stop()); mic = null; } myAn = peerAn = null; if (audio) audio.srcObject = null; paint(); }
  btn.addEventListener('pointerdown', e => { e.preventDefault(); try { btn.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ } press(); });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(ev => btn.addEventListener(ev, release));
  btn.addEventListener('contextmenu', e => e.preventDefault());
  addEventListener('keydown', e => { if (e.code === 'Space' && !e.repeat && !btn.hidden && !/input|textarea|select/i.test(e.target.tagName)) { e.preventDefault(); press(); } });
  addEventListener('keyup', e => { if (e.code === 'Space' && held) { e.preventDefault(); release(); } });
  addEventListener('blur', release);
  return { press, release, heard, peerTalking, stop, paint, get held() { return held; }, get peerOn() { return peerOn; } };
})();

function onNetMessage(m) {
  switch (m.t) {
    case 'talk': walkie.peerTalking(!!m.on); break;
    case 'start': if (!isHostSide()) onStart(m); break;
    case 'go': onGo(); break;
    case 'aim': remoteAim.recv(m); break;
    case 'hov': remoteAim.hover = m.id; break;
    case 'bye': peerLeft(!m.drop); break;
    case 'watchers': net.watchers = m.n; paintNet(); break;
    case 'react': gotReaction(m.r, isHostSide() ? 'guest' : 'host'); break;
    default: if (net.session) net.session.receive(m);
  }
}
const isHostSide = () => !!net.room && net.room.link === net.link;

/* The other player left or dropped: the computer takes over their side and the match goes on. */
function peerLeft(said) {
  const was = net.session, name = net.peer || 'Your opponent';
  const asGuest = !!net.guest, asHost = !!net.room && !net.guest, code = net.code;
  // Dropped, not a goodbye: the host keeps the side for them a while; the guest keeps knocking to get back.
  if (asHost && net.lastGuest && was) net.lastGuest.until = said ? 0 : Date.now() + REJOIN_MS;   // only when a match ends: a late echo changes nothing
  if (asGuest && was && !said && code && mode === 'play') { net.rejoin = { code, host: name, until: Date.now() + REJOIN_MS, tries: 0, timer: null }; }
  if (net.link && !said) { try { net.link.send({ t: 'bye', drop: true }, true); } catch (e) { /* ignore */ } net.link.close(); }   // drop: we lost them, they may come back
  endSession();
  if (net.guest) { net.guest.close(); net.guest = null; }
  if (net.room && !net.room.link) { /* room stays open for the next knock */ }
  hideJoin();
  if (was && mode === 'play') {
    const c = ctl.map(x => x === 'remote' ? 'ai' : x);
    setControllers(c);
    if (said) R.say(G, `${name} left`, 'info', 'The computer takes over their side.');
    else R.say(G, `${name} lost connection`, 'info', asGuest ? 'The computer plays for them here while you reconnect.' : 'The computer plays their side until they are back.');
    feedKeyframe();
    if (net.rejoin) paintVis(); else applyVis();          // reconnecting: do not open this screen to challengers meanwhile
  }
  paintNet(); paintOnline();
  if (net.rejoin) scheduleRejoin();
}
function endSession() {
  walkie.stop();
  if (G) G.sink = onEvent;
  net.session = null; net.link = null; net.via = null; net.pendingStart = null; remoteAim.reset();
  if (net.live) { net.live.close(); net.live = null; }
  if (!net.room) net.watchers = 0;
  if (V) V.flip = 0;
  localTick = 0; acc = 0; clearInputs(); setTimeout(syncBackground, 0);
}
function leaveOnline() {
  if (net.rejoin) { clearTimeout(net.rejoin.timer); clearTimeout(net.rejoin.dl); net.rejoin = null; }
  net.lastGuest = null;
  if (net.link) { try { net.link.send({ t: 'bye' }, true); } catch (e) { /* ignore */ } }
  endSession();
  if (net.guest) { net.guest.close(); net.guest = null; }
  clearTimeout(net.joinWait); net.joinWait = null;
  if (net.room) { net.room.close(); net.room = null; }
  unlist(); net.open = false; net.seeking = false; net.watchers = 0;
  stopWatchingQuiet();
  if (net.knock) { clearTimeout(net.knock.timer); net.knock = null; hideToast(); }
}

/* ----- the other player's aim arrow and hover, drawn as if they were at this screen ----- */
function sendAim(id, dx, dz, pw, force, released) {
  if (!net.session && !feed.active) return;
  net.aimOut = { t: 'aim', id, dx: +(dx || 0).toFixed(3), dz: +(dz || 0).toFixed(3), p: +(pw || 0).toFixed(3), r: released ? 1 : 0 };
  if (force || released || id === -1) flushAim(true);
}
/* At most 30 aim updates a second, and the latest one always goes out. */
function flushAim(now) {
  if (!net.aimOut) return;
  const t = performance.now();
  if (!now && t - net.lastAim < 33) return;
  net.lastAim = t;
  if (net.link && net.session) net.link.send(net.aimOut, false);
  if (amFeeder()) feedAim(myTeam(), net.aimOut);
  net.aimOut = null;
}
function sendHover(id) { if (net.session && G && G.turn === net.me && G.phase === 'ready') net.link.send({ t: 'hov', id }, false); }
const remoteAim = {
  target: null, cur: null, hover: -1, shown: -1,
  reset() { this.target = this.cur = null; this.hover = this.shown = -1; },
  showHover(id) { if (this.shown !== id && !dragging && !keeperDrag) { this.shown = id; V.setHover(id); } },
  recv(m) {
    if (amFeeder()) feedAim(1 - net.me, m);
    if (m.id < 0) { this.target = null; return; }
    this.target = { id: m.id, dx: m.dx, dz: m.dz, p: m.p };
    if (!this.cur || this.cur.id !== m.id) this.cur = Object.assign({}, this.target);
  },
  frame(dt) {
    if (!net.session || !G) return;
    const them = 1 - net.me, theirTurn = G.phase === 'ready' && G.turn === them;
    if (!theirTurn) { if (this.cur) { this.cur = null; V.hideAim(); } this.target = null; this.hover = -1; this.showHover(-1); return; }
    const t = this.target;
    if (!t) { if (this.cur) { this.cur = null; V.hideAim(); } this.showHover(this.hover); return; }
    const c = this.cur, k = 1 - Math.exp(-dt * 30);           // ease toward the latest sample: smooth at any packet rate
    c.dx += (t.dx - c.dx) * k; c.dz += (t.dz - c.dz) * k; c.p += (t.p - c.p) * k;
    const p = G.w.players[t.id]; if (!p) return;
    const l = Math.hypot(c.dx, c.dz) || 1;
    this.showHover(t.id);
    if (c.p > 0.01) V.setAim(p.x, p.z, c.dx / l, c.dz / l, c.p, powerColor(c.p)); else V.hideAim();
  }
};

/* ----- spectators: feeding them (host) and watching (anyone) ----- */
const feed = Spectate.createFeed(m => net.room && net.room.sendWatch(m));
const amFeeder = () => !!net.room && !net.watch && (!net.session || isHostSide());
const tableNames = () => [0, 1].map(t => ctl[t] === 'local' ? net.name : ctl[t] === 'remote' ? (net.peer || 'Opponent') : 'Computer');
function onWatchers(n, join) {
  net.watchers = n; feed.active = n > 0 && amFeeder();
  if (join) feedKeyframe();
  if (net.link && net.session) net.link.send({ t: 'watchers', n }, true);
  paintNet();
}
/* A keyframe is the match just before the next tick the feed will send. */
function feedKeyframe() {
  if (!feed.active || !G) return;
  const state = net.session ? net.session.confirmedState() : R.snapshot(G);
  feed.wantKey = !state;
  if (state) feed.keyframe(state, { names: tableNames() });
}
const lastFeedAim = [0, 0];
function feedAim(team, m) {
  if (!feed.active) return;
  const t = performance.now();
  if (m.id >= 0 && !m.r && t - lastFeedAim[team] < 100) return;   // 10 a second is plenty: watchers ease between
  lastFeedAim[team] = t; feed.aim(team, m);
}

function watchTable(code, note) {
  enterFullscreen();
  leaveOnline(); closeOnline(); hideToast();
  showJoin('Finding the table…');
  const viewer = Spectate.createViewer(G, { onKeyframe: m => onWatchKeyframe(m) });
  const w = net.watch = { code, viewer, names: null, kits: '', note, wait: null };
  // The players' connection dropped (or is not up yet): keep watching for a while, then call it closed.
  const waiting = () => {
    if (!w.names) showJoin('Waiting for the table to open…');
    else { toast('The players dropped off for a moment. Waiting for them…'); w.toasted = true; }
    clearTimeout(w.wait);
    w.wait = setTimeout(() => { if (net.watch === w) stopWatching('That table has closed.'); }, WAIT_MS);
  };
  w.conn = Net.watch(code, {
    onMessage: m => {
      if (m.t === 'waiting') { waiting(); return; }
      if (m.t === 'watchers') { net.watchers = m.n; paintNet(); return; }
      if (m.t === 'wr') { gotReaction(m.r, 'room'); return; }
      if (w.wait) { clearTimeout(w.wait); w.wait = null; if (w.toasted) { w.toasted = false; hideToast(); } }   // they are back
      viewer.receive(m);
    },
    onClose: c => stopWatching(c === 4004 ? 'That table has closed.' : c === 4010 ? 'That table is full.' : 'The match has ended.')
  });
}
function onWatchKeyframe(m) {
  const w = net.watch; if (!w) return;
  const first = !w.names, kits = G.kits.map(k => k.id + (k.alt ? '*' : '')).join();
  w.names = m.names || G.names.slice();
  G.sink = onEvent;
  if (first || kits !== w.kits) { w.kits = kits; V.attach(G); }
  if (first) {
    hideJoin(); document.body.classList.add('watching'); V.watch = true;
    setControllers(['remote', 'remote']);
    if (mode !== 'play') enterPlay();
    V.setPreset('broadcast'); setCamButtons('broadcast');
    showBanner('Watching', 'info', `${w.names[0]} v ${w.names[1]}. Drag the table to look around.`);
    flashGestures();
    if (w.note) toast(esc(w.note), [['OK', hideToast]], 6000);
  }
  paintHud(true);
}
const watchAim = {
  target: [null, null], cur: null,
  frame(dt) {
    const w = net.watch; if (!w) return;
    for (const a of w.viewer.dueAims()) this.target[a.team] = a.id < 0 ? null : a;
    const t = G.phase === 'ready' ? this.target[G.turn] : null;
    if (!t) { if (this.cur) { this.cur = null; V.hideAim(); V.setHover(-1); } return; }
    if (!this.cur || this.cur.id !== t.id) this.cur = { id: t.id, dx: t.dx, dz: t.dz, p: t.p };
    const c = this.cur, k = 1 - Math.exp(-dt * 20);
    c.dx += (t.dx - c.dx) * k; c.dz += (t.dz - c.dz) * k; c.p += (t.p - c.p) * k;
    const p = G.w.players[t.id]; if (!p) return;
    const l = Math.hypot(c.dx, c.dz) || 1;
    V.setHover(t.id);
    if (c.p > 0.01) V.setAim(p.x, p.z, c.dx / l, c.dz / l, c.p, powerColor(c.p)); else V.hideAim();
  }
};
function stopWatchingQuiet() {
  if (!net.watch) return;
  clearTimeout(net.watch.wait);
  net.watch.conn.close(); net.watch = null; V.watch = false; watchAim.target = [null, null]; watchAim.cur = null;
  document.body.classList.remove('watching');
}
function stopWatching(msg) {
  if (!net.watch) return;
  stopWatchingQuiet(); hideJoin();
  quitToSetup();
  if (msg) toast(msg, [['OK', hideToast]], 6000);
}
/* "Open now" on the start screen: players waiting for an opponent, each one a tap away. Pressing Play knocks on
   their room, the usual way: they are told who wants to play and the game starts after a short count unless they
   decline. Reads the same edge-cached /api/open as the playcity landing page (one lobby lookup per colo every few
   seconds, however many people are looking), refreshes every 20 s, and pauses while the tab is hidden. */
let openT = null, openFirst = true;
async function refreshOpenNow() {
  clearTimeout(openT);
  if ($('#setup').hidden) return;
  if (document.hidden && !openFirst) { openT = setTimeout(refreshOpenNow, 20000); return; }
  openFirst = false;
  try { const r = await fetch('/api/open'); if (r.ok) paintOpenNow((await r.json()).flick); } catch (e) { $('#onStat').textContent = 'Offline'; }
  openT = setTimeout(refreshOpenNow, 20000);
}
/* A few rows show; past that, "Show all" opens the rest (never a button for a single hidden row). */
const LIST_SHOW = 4;
const listOpen = { on: false, live: false };
function capList(ul, lis, key, show = LIST_SHOW) {
  const more = lis.length > show + 1, all = listOpen[key];
  for (const li of more && !all ? lis.slice(0, show) : lis) ul.appendChild(li);
  ul.classList.toggle('long', more && all);
  if (!more) return;
  const li = document.createElement('li'), btn = document.createElement('button');
  li.className = 'more'; btn.type = 'button'; btn.setAttribute('aria-expanded', String(all));
  btn.textContent = all ? 'Show fewer' : 'Show all ' + lis.length;
  btn.onclick = () => { listOpen[key] = !listOpen[key]; ul.textContent = ''; capList(ul, lis, key, show); };
  li.appendChild(btn); ul.appendChild(li);
}
function paintOpenNow(f) {
  const own = net.room && net.room.code;
  const list = f.waiting.filter(w => w.code !== own), matches = (f.matches || []).filter(m => m.code !== own);
  const ul = $('#onList'), mins = since => { const m = Math.round((Date.now() - since) / 60000); return m < 1 ? 'just now' : m + ' min'; };
  ul.textContent = '';
  const lis = [];
  for (const w of list) {
    const li = document.createElement('li'), info = document.createElement('div'), b = document.createElement('b'), sm = document.createElement('small'), btn = document.createElement('button');
    b.textContent = w.name; sm.textContent = 'Waiting for an opponent · ' + mins(w.since);
    btn.type = 'button'; btn.textContent = 'Play'; btn.setAttribute('aria-label', 'Play ' + w.name);
    btn.onclick = () => askName(w.code, () => joinRoom(w.code));
    info.append(b, sm); li.append(info, btn); lis.push(li);
  }
  for (const m of matches) {
    const li = document.createElement('li'), info = document.createElement('div'), b = document.createElement('b'), sm = document.createElement('small'), btn = document.createElement('button');
    b.textContent = m.title; sm.textContent = 'Live match · ' + mins(m.since);
    btn.type = 'button'; btn.className = 'on-watch'; btn.textContent = 'Watch'; btn.setAttribute('aria-label', 'Watch ' + m.title);
    btn.onclick = () => watchTable(m.code);
    info.append(b, sm); li.append(info, btn); lis.push(li);
  }
  capList(ul, lis, 'on');
  if (!list.length && !f.live) {
    const li = document.createElement('li'); li.className = 'on-empty';
    li.textContent = 'Nobody is waiting right now. Press Quick match: you play the computer until someone turns up, and anyone here can join you.';
    ul.appendChild(li);
  }
  $('#onStat').textContent = [list.length ? list.length + ' waiting' : '', f.live ? f.live + ' live' : ''].filter(Boolean).join(' · ') || 'Nothing open';
  $('#openNow').classList.toggle('live', list.length > 0);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshOpenNow(); });

async function refreshLive() {
  const ul = $('#olLive');
  ul.innerHTML = '<li class="ol-empty">Looking…</li>';
  const own = net.room ? net.room.code : net.code;
  const tables = (await Net.liveTables(GAME)).filter(t => t.code !== own);
  if (!tables.length) { ul.innerHTML = '<li class="ol-empty">No public matches right now. Quick match games show up here.</li>'; return; }
  ul.textContent = '';
  $('#olLiveCount').textContent = tables.length > LIST_SHOW + 1 ? '· ' + tables.length : '';
  capList(ul, tables.map(t => {
    const li = document.createElement('li'), span = document.createElement('span'), sm = document.createElement('small'), btn = document.createElement('button');
    span.textContent = t.title + ' '; sm.textContent = '· ' + Math.max(1, Math.round((Date.now() - t.since) / 60000)) + ' min'; span.appendChild(sm);
    btn.type = 'button'; btn.textContent = 'Watch'; btn.setAttribute('aria-label', 'Watch ' + t.title); btn.onclick = () => watchTable(t.code);
    li.append(span, btn); return li;
  }), 'live', 5);
}

/* ----- reactions: claps, cheers and oohs from anyone at the table -----
   Watchers send to the room, which passes them to the host and the other watchers. Players send over their
   direct link, and the host passes things on, so everyone hears everyone. */
const REACT_ICON = { clap: '👏', cheer: '📣', ooh: '😮' };
let lastReact = 0;
function sendReaction(r) {
  const now = performance.now(); if (now - lastReact < 350) return; lastReact = now;
  S.init(); ATM.react(r); floatEmoji(r, true);
  const m = { t: 'wr', r };
  if (net.watch) net.watch.conn.send(m);
  else if (net.session && isHostSide()) { net.room.sendWatch(m); net.link.send({ t: 'react', r }, true); }
  else if (net.session) net.link.send({ t: 'react', r }, true);
  else if (amFeeder() && feed.active) net.room.sendWatch(m);              // playing the computer with people watching
}
function gotReaction(r, from) {
  if (!REACT_ICON[r]) return;
  ATM.react(r); floatEmoji(r, false);
  if (net.session && isHostSide()) {                                        // the host is the hub for its guest
    if (from === 'guest' && feed.active) net.room.sendWatch({ t: 'wr', r });
    if (from === 'watcher') net.link.send({ t: 'react', r }, true);
  }
}
function floatEmoji(r, mine) {
  const box = $('#floaters'); if (!box || box.childElementCount > 40) return;
  const el = document.createElement('span'); el.textContent = REACT_ICON[r];
  el.style.right = (mine ? 30 : 20 + Math.random() * 160) + 'px';
  el.style.setProperty('--dx', (Math.random() * 60 - 30) + 'px');
  if (!mine) el.style.fontSize = (20 + Math.random() * 12) + 'px';
  box.appendChild(el); setTimeout(() => el.remove(), 2300);
}
$$('#react button').forEach(b => b.onclick = () => sendReaction(b.dataset.r));
function paintReact() { const on = mode === 'play' && (!!net.session || !!net.watch || net.watchers > 0); if ($('#react').hidden === on) $('#react').hidden = !on; }

/* ----- smoothing: after a rewind, pieces glide to where they really are instead of jumping ----- */
let smooth = null;
function addSmoothing(off) {
  if (!off) return;
  if (!smooth || smooth.length !== off.length) smooth = off.map(() => [0, 0]);
  for (let i = 0; i < off.length; i++) {
    const dx = off[i][0], dz = off[i][1];
    if (dx * dx + dz * dz > 30 * 30) { smooth[i] = [0, 0]; continue; }     // a restart teleport, not a correction
    smooth[i][0] += dx; smooth[i][1] += dz;
  }
}
function renderWithSmoothing(dt, nowS) {
  if (!smooth) { V.frame(dt, nowS); return; }
  const ps = G.w.players, b = G.w.ball, saved = [];
  for (let i = 0; i < ps.length; i++) { saved.push(ps[i].x, ps[i].z); ps[i].x += smooth[i][0]; ps[i].z += smooth[i][1]; }
  saved.push(b.x, b.z); b.x += smooth[ps.length][0]; b.z += smooth[ps.length][1];
  try { V.frame(dt, nowS); } finally {
    for (let i = 0; i < ps.length; i++) { ps[i].x = saved[2 * i]; ps[i].z = saved[2 * i + 1]; }
    b.x = saved[2 * ps.length]; b.z = saved[2 * ps.length + 1];
  }
  const k = Math.exp(-dt * 14); let any = false;
  for (const s of smooth) { s[0] *= k; s[1] *= k; if (Math.abs(s[0]) + Math.abs(s[1]) > 0.01) any = true; }
  if (!any) smooth = null;
}

/* ----- Public or Private, and Share (shared/share.js) ----- */
/* Make the listings match net.vis. Before a match with someone: open to challengers. During one (as host): listed live for watchers. */
function applyVis() {
  const pub = net.vis === 'public';
  if (net.watch || mode !== 'play') { paintVis(); return; }
  if (net.session) {
    if (isHostSide()) {
      if (pub && !net.live && net.room && net.room.code) { const nm = tableNames(); net.live = Net.listOpen(GAME, net.room.code, `${nm[0]} v ${nm[1]}`, true, 2, net.watchers); }
      if (!pub && net.live) { net.live.close(); net.live = null; }
    }
  } else if (cpuTeam() >= 0) { if (pub !== net.open) setOpen(pub); else if (pub) { ensureRoom(); listInLobby(); } }
  paintVis();
}
const joinUrl = code => location.origin + location.pathname + '?join=' + code;
/* The game's code, whichever side of it we are on: our own room, the host's room we joined, or the table we watch. */
const tableCode = () => net.watch ? net.watch.code : net.session && !isHostSide() ? net.code : net.room && net.room.code || null;
var vis = PCVis.mount($('#visSlot'), {
  title: 'Flick Football',
  state: () => net.vis,
  canToggle: () => !net.watch && (!net.session || isHostSide()),
  onToggle() {
    net.vis = net.vis === 'public' ? 'private' : 'public';
    applyVis(); paintOnline(); paintNet();      // the open panel says what it means
  },
  onShare() { if (!net.session && !net.watch && !net.room) { ensureRoom(); } },
  // One link for everyone: it takes over the computer's side if there is one, and otherwise watches.
  link() { const c = tableCode(); return c ? joinUrl(c) : null; },
  text: () => net.session || net.watch ? 'Come and watch this Flick Football match' : `${net.name} challenges you to Flick Football`,
  watching: () => net.watchers,
  status() {
    const wants = net.session || net.watch || net.open || net.room;       // only say so when the game is meant to be online
    if (!wants) return null;
    if (!navigator.onLine) return 'Offline';
    if (net.session && net.session.waiting()) return 'Reconnecting…';
    if (net.room && !net.room.up && !net.session) return 'Reconnecting…';   // the room dropped; it comes back under the same code
    return null;
  },
  code: tableCode,
  pending: () => !net.watch && !(net.room && net.room.code) && !net.session,
});
addEventListener('online', () => paintVis()); addEventListener('offline', () => paintVis());
/* Shown during a match that can go online: against the computer, with someone online, or watching. Not for two players on one screen. */
function paintVis() { if (!vis) return; vis.hidden = !(mode === 'play' && (net.session || net.watch || cpuTeam() >= 0)); vis.paint(); }

/* ----- online UI ----- */
function openOnline() {
  $('#onlineOv').hidden = false; $('#olName').value = net.name;
  if (!net.watch) ensureRoom();
  paintOnline(); refreshLive();
}
function closeOnline() { $('#onlineOv').hidden = true; }
function paintOnline() {
  const r = net.room, link = r && r.code ? r.url() : '';
  $('#olLink').value = link || 'Opening a room…';
  $('#olCode').textContent = r ? r.code : '·····';
  $('#olOpen').setAttribute('aria-pressed', String(net.open));
  $('#olOpen').textContent = net.open ? 'Open to challengers: on' : 'Open to challengers: off';
  $('#olShare').hidden = !navigator.share;
  const tableCode = net.session ? (isHostSide() ? net.room && net.room.code : net.code) : null;
  $('#olWatchBox').hidden = !tableCode;
  if (tableCode) $('#olWatchLink').value = location.origin + location.pathname + '?watch=' + tableCode;
  paintVis();
}
function paintNet() {
  paintReact(); walkie.paint(); paintVis();
  if (net.lobby) net.lobby.counts(1, net.watchers);            // the landing page shows who is playing and watching
  if (net.live) net.live.counts(2, net.watchers);
  // Through the relay every message is a billed server request: send inputs 30 times a second instead of 60.
  if (net.session) net.session.sendEvery = net.via === 'p2p' ? 15 : 33;
  const el = $('#netPill'); if (!el) return;
  let html = '', cls = '';
  const eye = net.watchers > 0 ? ` · 👁 ${net.watchers}` : '';
  if (net.watch) {
    cls = net.watch.names ? 'good' : 'warn';
    html = net.watch.names ? `<i></i>Watching ${esc(net.watch.names[0])} v ${esc(net.watch.names[1])}${eye}` : '<i></i>Finding the table…';
  } else if (net.session) {
    const s = net.session, ms = s.lag();
    cls = s.waiting() ? 'warn' : net.via === 'p2p' ? 'good' : 'ok';
    html = `<i></i>${esc(net.peer || 'Opponent')} · ${s.waiting() ? 'waiting for connection…' : ms + ' ms'}${net.via === 'p2p' ? '' : net.via === 'relay' ? ' · relay' : ' · connecting'}${eye}`;
  } else if (net.open && mode === 'play') { cls = 'idle'; html = `<i></i>Open to challengers${eye}`; }
  else if (eye && mode === 'play') { cls = 'good'; html = `<i></i>Live${eye}`; }
  if (el.dataset.h !== html) { el.dataset.h = html; el.innerHTML = html; el.className = cls; el.hidden = !html; }
}
let toastTimer = null;
function toast(html, actions, ms) {
  const t = $('#toast'); clearTimeout(toastTimer);
  t.innerHTML = `<span>${html}</span>` + (actions || []).map((a, i) => `<button class="${i ? 'ghost' : ''}" data-i="${i}">${esc(a[0])}</button>`).join('');
  t.querySelectorAll('button').forEach(b => b.onclick = () => actions[+b.dataset.i][1]());
  t.hidden = false;
  if (ms) toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { $('#toast').hidden = true; }
function showJoin(html) { $('#joinOv').hidden = false; $('#joinMsg').innerHTML = html; }
function hideJoin() { $('#joinOv').hidden = true; }

$('#olClose').onclick = closeOnline;
$('#olName').onchange = () => { saveName($('#olName').value); if (net.room) net.room.rename(net.name); };
$('#olCopy').onclick = async () => { try { await navigator.clipboard.writeText(net.room.url()); $('#olCopy').textContent = 'Copied'; setTimeout(() => { $('#olCopy').textContent = 'Copy link'; }, 1500); } catch (e) { $('#olLink').select(); } };
$('#olShare').onclick = () => { if (navigator.share && net.room) navigator.share({ title: 'Flick Football', text: `${net.name} challenges you to Flick Football`, url: net.room.url() }).catch(() => {}); };
$('#olOpen').onclick = () => setOpen(!net.open);
$('#olQuick').onclick = () => { enterFullscreen(); closeOnline(); quickMatch(); };
$('#olLiveRefresh').onclick = () => refreshLive();
$('#olWatchCopy').onclick = async () => { try { await navigator.clipboard.writeText($('#olWatchLink').value); $('#olWatchCopy').textContent = 'Copied'; setTimeout(() => { $('#olWatchCopy').textContent = 'Copy'; }, 1500); } catch (e) { $('#olWatchLink').select(); } };
$('#olJoin').onclick = () => { const c = $('#olJoinCode').value.trim().toUpperCase(); if (/^[A-HJ-NP-Z2-9]{5}$/.test(c)) { closeOnline(); joinRoom(c); } else $('#olJoinCode').focus(); };
$('#joinCancel').onclick = () => {
  net.seeking = false; clearTimeout(net.joinWait); net.joinWait = null;
  if (net.guest) { net.guest.close(); net.guest = null; }
  hideJoin();
  if (net.watch && !net.watch.names) stopWatching();          // gave up on a table that has not opened yet
};
window.addEventListener('pagehide', () => { if (net.link) try { net.link.send({ t: 'bye' }, true); } catch (e) { /* ignore */ } });

/* ---------- main loop ---------- */
function stepLocal() {
  for (let t = 0; t < 2; t++) if (ctl[t] === 'ai') { const c = AI.keeper(G, t, level, TICK, aiKeep); diveReq[t] = c.dive || 0; aiKeep.dir = c.dir; }
  if (G.arrange && ctl[G.arrange.team] === 'ai' && G.phase === 'ready') { AI.arrange(G, G.arrange.team); feedKeyframe(); }   // moved outside inputs
  runAI(TICK);
  const ins = [0, 1].map(t => {
    if (ctl[t] !== 'ai') return inputFor(t, localTick);
    const i = inputFor(t, localTick); i.kd = aiKeep.dir || 0; return i;
  });
  R.simTick(G, ins); localTick++; feed.push(ins);
}
/* Nothing moving, nobody touching, the camera at rest: the picture barely changes, so it is drawn 15 times a
   second instead of 60 (the lit caps still pulse, the lights still twinkle). The game itself ticks at full rate.
   Behind the setup screen the slowly turning table is drawn at 20 frames a second. */
function idle() {
  if (dragging || keeperDrag || orbit || gesture || arrDrag || takerDrag || touches.size || keys.size || aiJob || pad[0] || pad[1]) return false;
  if (G.phase !== 'ready' || remoteAim.target || watchAim.target[0] || watchAim.target[1] || (V.settled && !V.settled())) return false;
  const b = G.w.ball; if (b.vx || b.vz) return false;
  for (const p of G.w.players) if (p.vx || p.vz) return false;
  return true;
}
let drawAcc = 0;
addEventListener('resize', () => { drawAcc = 1; });   // a resize clears the canvas: draw again at once, idle or not
function tick(now) {
  requestAnimationFrame(tick);
  if (bg.on) return;
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (!G || !V) return;
  try {
    if (mode === 'play') {
      advance(dt);
      remoteAim.frame(dt); watchAim.frame(dt); flushAim(false); paintCard();
      ATM.watchers = net.watchers; ATM.update(dt, G); govern(dt);
      paintHud(false); syncCam(false);
    } else if (mode === 'setup') V.orbit(dt * 0.12, 0);
    const every = mode === 'setup' ? 1 / 20 : idle() ? 1 / 15 : 0;
    drawAcc += dt;
    if (drawAcc < every) return;
    renderWithSmoothing(drawAcc, now / 1000); drawAcc = 0;
  } catch (err) { showErr(err.message); throw err; }
}
function advance(dt) {
  const prevPhase = G.phase;
  if (net.watch) {
    net.watch.viewer.update(dt);
  } else if (net.session) {
    addSmoothing(net.session.update(dt, t => inputFor(net.me, t)));
    const done = net.session.takeConfirmed();                 // final ticks: to spectators (host), dropped (guest)
    if (isHostSide()) for (const ins of done) feed.push(ins);
    if (net.session.stalled > STALL_GIVE_UP) { peerLeft(); return; }   // their device went to sleep or lost signal without saying goodbye
  } else if (!net.pendingStart && $('#help').hidden && $('#menuOv').hidden) {
    acc += Math.min(dt, 0.05);
    let n = 0;
    while (acc >= TICK && n < 4) { stepLocal(); acc -= TICK; n++; }
    if (n === 4) acc = 0;
  } else acc = 0;
  if (feed.wantKey) feedKeyframe();
  feed.tick(performance.now());
  if (prevPhase === 'fulltime' && G.phase !== 'fulltime') { aiJob = null; shownBreak = null; }
  if ((G.phase === 'halftime' || G.phase === 'fulltime') && shownBreak !== G.phase + G.half) { shownBreak = G.phase + G.half; showBreak(); }
  if (G.phase !== 'halftime' && G.phase !== 'fulltime' && !$('#breakOv').hidden) { $('#breakOv').hidden = true; shownBreak = null; }
}
/* Browsers stop animation frames in a hidden tab. Online, the match keeps ticking from a worker timer so the
   other player is never left waiting; nothing is drawn until the tab is visible again. */
const bg = { on: false, worker: null };
function syncBackground() {
  const want = document.hidden && !!net.session;
  if (want === bg.on) return;
  bg.on = want; last = performance.now();
  if (want) {
    if (!bg.worker) {
      bg.worker = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 16)'], { type: 'text/javascript' })));
      bg.worker.onmessage = () => {
        if (!bg.on || !G) return;
        const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now;
        try { advance(dt); } catch (err) { console.error(err); }
      };
    }
  } else if (bg.worker) { bg.worker.terminate(); bg.worker = null; }
}
document.addEventListener('visibilitychange', syncBackground);
/* Back from another app (often WhatsApp, after sending the invite): make sure the room is up, so the link works. */
document.addEventListener('visibilitychange', () => { if (!document.hidden && net.room) net.room.wake(); if (!document.hidden && net.rejoin) rejoinNow(); });
addEventListener('online', () => { if (net.room) net.room.wake(); if (net.rejoin) rejoinNow(); });

/* ---------- phones: full screen, landscape, screen awake, and a frame-rate governor ---------- */
const PHONE = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
const docEl = document.documentElement;
const canFull = !!(docEl.requestFullscreen || docEl.webkitRequestFullscreen);
const isFull = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
function goFull() {
  try {
    const r = docEl.requestFullscreen ? docEl.requestFullscreen({ navigationUI: 'hide' }) : docEl.webkitRequestFullscreen();
    Promise.resolve(r).then(() => { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {}); }).catch(() => {});
  } catch (e) { /* refused */ }
}
/* Must run inside a tap: browsers only grant full screen to a user gesture. Phones only; desktop has the button. */
function enterFullscreen() { if (PHONE && canFull && !isFull()) goFull(); }
function exitFullscreen() {
  if (!isFull()) return;
  fullByUs = true;
  try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) { /* ignore */ }
  try { Promise.resolve((document.exitFullscreen || document.webkitExitFullscreen).call(document)).catch(() => {}); } catch (e) { /* ignore */ }
}
/* The full-screen button shows what a tap will do: corners pointing out to go full screen, in to leave it. */
const FULL_ICON = { in: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/></svg>',
                    out: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5"/></svg>' };
function paintFull() {
  const b = $('#btnFull'), on = isFull();
  b.innerHTML = on ? FULL_ICON.out : FULL_ICON.in; b.setAttribute('aria-pressed', String(on));
  b.title = on ? 'Leave full screen' : 'Full screen'; b.setAttribute('aria-label', b.title);
}
$('#btnFull').hidden = !canFull; paintFull();
$('#btnFull').onclick = () => { hideToast(); if (isFull()) exitFullscreen(); else if (canFull) goFull(); };
let fullByUs = false;
function onFullChange() {
  paintFull(); if (V) V.resize();
  // Left full screen during a match on a phone (the back gesture, a swipe, a notification): offer the way back.
  // The offer is a button because only a tap may enter full screen again.
  if (!isFull() && PHONE && canFull && mode === 'play' && !fullByUs) toast('Full screen is off.', [['Back to full screen', () => { hideToast(); goFull(); }], ['Not now', hideToast]], 7000);
  fullByUs = false;
}
document.addEventListener('fullscreenchange', onFullChange);
document.addEventListener('webkitfullscreenchange', onFullChange);

/* Keep the screen on while a match is on. The lock drops when the tab hides, so take it again on return. */
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock && document.visibilityState === 'visible') { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { wakeLock = null; }
}
document.addEventListener('visibilitychange', () => { if (mode === 'play') keepAwake(true); });

/* Frame-rate governor: if frames average under 40 fps for four seconds, render at a lower resolution, then drop
   shadows. It only steps down, so quality never see-saws mid-match. */
const gov = { t: 0, n: 0, slow: 0, warm: 0 };
function govern(dt) {
  if (!V || !V.setScale || document.hidden || dt > 0.25) return;
  if ((gov.warm += dt) < 5) return;                  // shaders compiling and the screen turning: not a fair test
  gov.t += dt; gov.n++;
  if (gov.t < 2) return;
  const avg = gov.t / gov.n; gov.t = 0; gov.n = 0;
  if (avg < 1 / 40) { gov.slow = 0; return; }
  if (++gov.slow < 2) return;                         // two slow windows in a row before giving up any quality
  gov.slow = 0;
  const sc = V.getScale();
  if (sc > 1.01) V.setScale(Math.max(1, Math.round((sc - 0.25) * 4) / 4));
  else if (V.shadows()) V.setShadows(false);
}

/* Browsers only allow sound after a tap or key. Start it on the first one, wherever it lands. */
// Sound starts on the first tap or key, and the 270 KB kick-off sting is fetched then rather than on page load.
['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, () => { S.init(); S.preloadIntro('intro.mp3'); }, { once: true, capture: true }));
ATM.getG = () => G;

/* Setup controls are wired first so they work even while graphics load. */
buildSetup(); paintShot(); makeGame();
if (window.ResizeObserver) new ResizeObserver(() => { if (V) V.resize(); }).observe($('#stage'));
viewReady = initView().then(() => { makeGame(); V.setPreset('free', true); }).catch(e => showErr(e.message));
requestAnimationFrame(tick);

/* Read-only hook for tests and support: the match hash, tick and network stats. */
window.playcity = { toScreen: (x, z) => V && V.toScreen(x, 0, z), state: () => ({ mode: G && G.mode, forced: G && G.forced, cam: V && V.preset, players: G && G.w.players.map(p => [p.id, p.team, +p.x.toFixed(2), +p.z.toFixed(2)]), hash: G && R.hash(G), ball: G && [+G.w.ball.x.toFixed(4), +G.w.ball.z.toFixed(4)], score: G && G.score.slice(), phase: G && G.phase, clock: G && +G.clock.toFixed(2), half: G && G.half, turn: G && G.turn, ctl: ctl.slice(),
  tick: net.session ? net.session.tick : localTick, watchTick: net.watch ? net.watch.viewer.play : null, aimQ: net.watch ? net.watch.viewer.aims.map(a => a.ft) : null, aimT: watchAim.target.map(x => x && x.id), feedActive: feed.active, watchers: net.watchers, code: net.room ? net.room.code : null, rejoin: !!net.rejoin, peer: net.peer || null, feedTick: feed.ft, via: net.via, rtt: net.session ? net.session.lag() : null, stats: net.session ? Object.assign({}, net.session.stats) : null }) };

refreshOpenNow();

/* Opened from a link: ?watch= watches; ?join= asks for a name, then knocks. */
const watchCode = new URLSearchParams(location.search).get('watch');
if (watchCode && /^[A-HJ-NP-Za-hj-np-z2-9]{5}$/.test(watchCode)) {
  history.replaceState(null, '', location.pathname);
  viewReady.then(() => watchTable(watchCode.toUpperCase()));
}
const joinCode = new URLSearchParams(location.search).get('join');
if (joinCode && /^[A-HJ-NP-Za-hj-np-z2-9]{5}$/.test(joinCode)) {
  history.replaceState(null, '', location.pathname);
  const c = joinCode.toUpperCase();
  askName(c, () => viewReady.then(() => joinRoom(c)));        // then: the computer's side if there is one, else watch
}
})();
