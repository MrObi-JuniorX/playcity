/* Flick Football sound: everything is synthesised, nothing is downloaded.

   A small mixer. Every sound goes to one of five channels, each with its own switch and volume, under a master:
     sfx       ball, caps, posts, rails, whistles
     crowd     murmur, oohs, cheers, applause (atmosphere.js)
     organ     stadium organ interludes (atmosphere.js) and the kick-off intro music
     voice     commentary (browser speech; volume applied per line)
     reactions claps and cheers sent by people watching or playing
   Settings are kept per device in localStorage, so each player and spectator sets their own. */
(function (root) {
'use strict';
const CHANNELS = ['sfx', 'crowd', 'organ', 'voice', 'reactions'];
const DEFAULTS = { muted: false, master: 0.8, sfx: { on: true, vol: 1 }, crowd: { on: true, vol: 0.7 }, organ: { on: true, vol: 0.5 }, voice: { on: true, vol: 0.9, voiceName: '' }, reactions: { on: true, vol: 0.8 } };
let ctx = null, master = null, buses = {}, last = {}, noiseBuf = null, ducked = false;
let cfg = load();

function load() {
  let s = null; try { s = JSON.parse(localStorage.getItem('pc-sound') || 'null'); } catch (e) { /* private mode */ }
  const c = JSON.parse(JSON.stringify(DEFAULTS));
  if (s && typeof s === 'object') {
    if (typeof s.muted === 'boolean') c.muted = s.muted;
    if (typeof s.master === 'number') c.master = s.master;
    for (const k of CHANNELS) if (s[k]) Object.assign(c[k], s[k]);
  }
  return c;
}
function save() { try { localStorage.setItem('pc-sound', JSON.stringify(cfg)); } catch (e) { /* ignore */ } }
/* Effective level of a channel, 0..1, after master and mute. */
function level(ch) { if (cfg.muted) return 0; const c = cfg[ch]; return c && c.on ? cfg.master * c.vol : 0; }
function applyLevels() {
  if (!ctx) return;
  const t = ctx.currentTime;
  master.gain.setTargetAtTime(cfg.muted ? 0 : ducked ? 0.35 : 1, t, 0.03);
  for (const k of CHANNELS) if (buses[k]) buses[k].gain.setTargetAtTime(level(k), t, 0.05);
  if (root.speechSynthesis && !level('voice')) root.speechSynthesis.cancel();
}

function init() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  const AC = root.AudioContext || root.webkitAudioContext; if (!AC) return;
  ctx = new AC();
  // A gentle limiter on the master so a goal with a full crowd and organ never clips.
  const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -10; comp.knee.value = 8; comp.ratio.value = 6; comp.attack.value = 0.005; comp.release.value = 0.2;
  master = ctx.createGain(); master.connect(comp); comp.connect(ctx.destination);
  for (const k of CHANNELS) { const g = ctx.createGain(); g.connect(master); buses[k] = g; }
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  applyLevels();
}
function ok(key, gap) { const n = performance.now(); if (last[key] && n - last[key] < gap) return false; last[key] = n; return true; }
function tone(f, dur, vol, type, f2, out) {
  if (!ctx) return; const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type || 'sine'; o.frequency.setValueAtTime(f, t); if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur); o.connect(g); g.connect(out || buses.sfx); o.start(t); o.stop(t + dur + 0.02);
}
function noise(dur, vol, freq, q, type, attack, out, at) {
  if (!ctx) return; const t = at || ctx.currentTime, s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  s.buffer = noiseBuf; f.type = type || 'bandpass'; f.frequency.value = freq; f.Q.value = q || 1;
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + (attack || 0.005)); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f); f.connect(g); g.connect(out || buses.sfx); s.start(t, Math.random()); s.stop(t + dur + 0.05);
}
function blow(start, dur) {
  for (const f of [2750, 2930]) {
    const t = ctx.currentTime + start, o = ctx.createOscillator(), g = ctx.createGain(), l = ctx.createOscillator(), lg = ctx.createGain();
    o.frequency.value = f; l.frequency.value = 26; lg.gain.value = 80; l.connect(lg); lg.connect(o.frequency);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.09, t + 0.02); g.gain.setValueAtTime(0.09, t + dur - 0.06); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(buses.sfx); o.start(t); l.start(t); o.stop(t + dur + 0.05); l.stop(t + dur + 0.05);
  }
}
/* Kick-off intro: a short recorded sting (intro.mp3, 8.5 s). Fetched early, decoded once audio is allowed,
   played for 7 s from the Kick off press, fading out over the last 2 s as the board settles. */
let introBytes = null, introBuf = null, introSrc = null;
function preloadIntro(url) {
  if (introBytes || !root.fetch) return;
  introBytes = fetch(url).then(r => r.ok ? r.arrayBuffer() : null).catch(() => null);
}
async function playIntro(total, fade) {
  if (!ctx || !introBytes) return;
  const asked = ctx.currentTime;
  if (!introBuf) {
    const bytes = await introBytes; if (!bytes) return;
    try { introBuf = await ctx.decodeAudioData(bytes.slice(0)); } catch (e) { return; }
  }
  stopIntro();
  const T = total || 7, F = fade || 2, late = ctx.currentTime - asked;      // if decoding took a moment, keep the 7 s
  if (late >= T - 0.5) return;
  const t = ctx.currentTime, src = ctx.createBufferSource(), g = ctx.createGain();
  src.buffer = introBuf; src.connect(g); g.connect(buses.organ);
  const end = t + T - late;
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.9, t + 0.08);
  g.gain.setValueAtTime(0.9, Math.max(t + 0.1, end - F)); g.gain.exponentialRampToValueAtTime(0.0001, end);
  src.start(t, late); src.stop(end + 0.05); introSrc = src;
}
function stopIntro() { if (introSrc) { try { introSrc.stop(); } catch (e) { /* already stopped */ } introSrc = null; } }

const Sound = {
  init, CHANNELS, level, preloadIntro, playIntro, stopIntro,
  /* Lower everything while a player is talking on the walkie-talkie. */
  duck(on) { if (ducked === on) return; ducked = on; applyLevels(); },
  get ctx() { return ctx; }, get noiseBuf() { return noiseBuf; }, bus: k => buses[k],
  settings: () => JSON.parse(JSON.stringify(cfg)),
  set(patch) {
    if (typeof patch.muted === 'boolean') cfg.muted = patch.muted;
    if (typeof patch.master === 'number') cfg.master = Math.max(0, Math.min(1, patch.master));
    for (const k of CHANNELS) if (patch[k]) Object.assign(cfg[k], patch[k]);
    save(); applyLevels();
  },
  toggle() { Sound.set({ muted: !cfg.muted }); return cfg.muted; }, isMuted: () => cfg.muted,
  event(e) {
    if (!ctx || cfg.muted) return;
    if (e.k === 'pb' && ok('pb', 40)) { const v = Math.min(1, e.jn / 500); tone(160 + 80 * (1 - v), 0.09, 0.25 + 0.4 * v, 'triangle', 70); noise(0.05, 0.12 + 0.3 * v, 1800, 1.2); }
    else if (e.k === 'kb' && ok('kb', 60)) { noise(0.12, 0.3, 500, 0.8); tone(120, 0.1, 0.2, 'sine', 60); }
    else if (e.k === 'post' && ok('post', 80)) { const v = Math.min(1, e.jn / 400); tone(1180, 0.5, 0.18 + 0.3 * v, 'sine'); tone(1770, 0.35, 0.08 + 0.12 * v, 'sine'); noise(0.03, 0.2, 3000, 2); }
    else if (e.k === 'bounce' && ok('bounce', 50)) { tone(240, 0.05, Math.min(0.22, e.v / 600), 'triangle', 150); }
    else if (e.k === 'pp' && e.v > 4 && ok('pp', 60)) { noise(0.04, Math.min(0.3, e.v / 400), 2600, 1.5); tone(300, 0.04, 0.1, 'square', 220); }
    else if (e.k === 'net' && ok('net', 200)) { noise(0.5, 0.25, 900, 0.5, 'bandpass', 0.04); }
    else if (e.k === 'flick' && ok('flick', 60)) { noise(0.06, 0.18, 1400, 1, 'bandpass'); }
    else if (e.k === 'whistle') {
      const pat = { short: [[0, 0.28]], foul: [[0, 0.14], [0.2, 0.42]], goal: [[0, 0.7]], final: [[0, 0.32], [0.45, 0.32], [0.9, 0.95]] }[e.type || 'short'] || [[0, 0.3]];
      for (const [st, du] of pat) blow(st, du);
    }
    else if (e.k === 'wall' && ok('wall', 50)) { const v = Math.min(1, e.v / 220); tone(e.ball ? 260 : 150, 0.12, 0.12 + 0.35 * v, 'triangle', e.ball ? 160 : 80); noise(0.08, 0.1 + 0.25 * v, 600, 0.9, 'lowpass'); }
    else if (e.k === 'tick') { tone(e.n === 1 ? 1320 : 990, 0.07, 0.16, 'square'); }
    else if (e.k === 'goal') { tone(220, 1.0, 0.14, 'sawtooth', 210); tone(330, 1.0, 0.1, 'sawtooth', 320); }   // the roar is the crowd's job now
  },
  /* For atmosphere.js: the same helpers, aimed at a channel. */
  tone: (f, dur, vol, type, f2, ch) => tone(f, dur, vol, type, f2, buses[ch]),
  noise: (dur, vol, freq, q, type, attack, ch, at) => noise(dur, vol, freq, q, type, attack, buses[ch], at)
};
root.Sound = Sound;
})(typeof self !== 'undefined' ? self : this);
