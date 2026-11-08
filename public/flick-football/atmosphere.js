/* Flick Football atmosphere: crowd, stadium organ and a commentator. Needs Sound.

   It listens to the same match events that drive the whistles and clacks, so every screen (both players and
   every spectator) hears the crowd and commentary in step with what it shows. Nothing is downloaded: the crowd
   and organ are synthesised, and the commentator is the browser's own speech voice.
     crowd  oohs, groans, boos, cheers, applause and rhythmic claps when something happens (no constant murmur)
     organ  short original riffs in dead time: set pieces, after goals, half-time. Never while the ball moves.
     voice  short lines for goals, saves, the woodwork, fouls, cards and the breaks, with team names
   Each has its own channel in Sound, so anyone can turn any of them down or off. */
(function (root) {
'use strict';
const S = root.Sound;
const rnd = (a, b) => a + Math.random() * (b - a), pick = a => a[Math.floor(Math.random() * a.length)];
const A = { getG: () => null, watchers: 0 };
const pendingTimers = [];
const later = (fn, ms) => { const t = setTimeout(() => { pendingTimers.splice(pendingTimers.indexOf(t), 1); fn(); }, ms); pendingTimers.push(t); };

/* ================= crowd ================= */
let hush = 0;
/* How big the crowd sounds: a little louder with every real spectator, gently. */
const size = () => 1 + Math.min(1.5, Math.log2(1 + A.watchers) * 0.35);

function formant(dur, vol, path, q, ch, at) {      // a crowd vowel: noise through a moving band
  const ctx = S.ctx; if (!ctx) return;
  const t = at || ctx.currentTime, s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  s.buffer = S.noiseBuf; f.type = 'bandpass'; f.Q.value = q || 3;
  f.frequency.setValueAtTime(path[0], t);
  for (let i = 1; i < path.length; i++) f.frequency.linearRampToValueAtTime(path[i], t + dur * i / (path.length - 1));
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + dur * 0.25); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f); f.connect(g); g.connect(S.bus(ch || 'crowd')); s.start(t, Math.random()); s.stop(t + dur + 0.05);
}
function ooh(v, ch) { const k = (v || 1) * size(); formant(1.4, 0.22 * k, [330, 620, 560, 380], 3.5, ch); formant(1.3, 0.12 * k, [800, 1150, 1000, 820], 4, ch); }
function groan(v) { const k = (v || 1) * size(); formant(1.2, 0.18 * k, [420, 330, 240], 3); }
function boo() { const k = size(); formant(1.6, 0.16 * k, [260, 240, 250, 230], 5); formant(1.5, 0.08 * k, [520, 480, 500], 5); }
function cheer(v, dur, ch) {
  const k = (v || 1) * size(), d = dur || 3;
  S.noise(d, 0.32 * k, 700, 0.5, 'bandpass', 0.18, ch || 'crowd');
  S.noise(d * 0.85, 0.2 * k, 1500, 0.6, 'bandpass', 0.25, ch || 'crowd');
  S.noise(d * 0.6, 0.1 * k, 3000, 0.9, 'bandpass', 0.3, ch || 'crowd');
  formant(d * 0.7, 0.12 * k, [500, 900, 800, 700], 2.5, ch);           // the "yeah" in the roar
}
function applause(dur, density, vol, ch, at0) {      // many hands, each clap a tiny noise burst
  const ctx = S.ctx; if (!ctx) return;
  const t0 = at0 || ctx.currentTime, n = Math.min(260, Math.round(dur * density * size()));
  for (let i = 0; i < n; i++) {
    const u = Math.pow(Math.random(), 1.4), at = t0 + u * dur;          // thicker at the start, thinning out
    S.noise(0.035, (vol || 0.12) * (1 - u * 0.7) * rnd(0.5, 1), rnd(1100, 2600), 1.6, 'bandpass', 0.002, ch || 'crowd', at);
  }
}
function rhythmClaps() {                              // clap, clap, clap-clap-clap, twice
  const ctx = S.ctx; if (!ctx) return;
  const beats = [0, 0.42, 0.84, 1.05, 1.26], t0 = ctx.currentTime + 0.1;
  for (const rep of [0, 1.8]) for (const b of beats) for (let h = 0; h < 18; h++)
    S.noise(0.04, 0.05 * rnd(0.6, 1), rnd(1200, 2400), 1.5, 'bandpass', 0.002, 'crowd', t0 + rep + b + rnd(-0.025, 0.025));
}

/* ================= organ ================= */
let organBusy = 0, lastOrgan = -1e9;
const NOTE = n => 261.63 * Math.pow(2, n / 12);       // semitones from middle C
function organNote(notes, t, dur, vol) {
  const ctx = S.ctx, out = ctx.createGain(), lp = ctx.createBiquadFilter(), trem = ctx.createOscillator(), td = ctx.createGain();
  lp.type = 'lowpass'; lp.frequency.value = 3200; out.connect(lp); lp.connect(S.bus('organ'));
  out.gain.setValueAtTime(0.0001, t); out.gain.exponentialRampToValueAtTime(vol, t + 0.02);
  out.gain.setValueAtTime(vol, t + Math.max(0.03, dur - 0.06)); out.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.08);
  trem.frequency.value = 6.4; td.gain.value = vol * 0.22; trem.connect(td); td.connect(out.gain);   // the spinning-speaker wobble
  const bars = [[0.5, 0.45], [1, 1], [2, 0.55], [3, 0.3], [4, 0.22], [6, 0.1]];                       // drawbars
  for (const n of [].concat(notes)) for (const [h, a] of bars) {
    const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = NOTE(n) * h; g.gain.value = a / 4;
    o.connect(g); g.connect(out); o.start(t); o.stop(t + dur + 0.12);
  }
  trem.start(t); trem.stop(t + dur + 0.12);
}
/* Original riffs. A note is semitones from middle C, an array is a chord, null is a rest. */
const RIFFS = {
  rally:   [[0, .16], [4, .16], [7, .16], [12, .32], [null, .08], [7, .16], [12, .55]],
  stabs:   [[[0, 4, 7], .14], [null, .06], [[0, 4, 7], .14], [null, .06], [[0, 4, 7], .14], [null, .1], [[5, 9, 12], .55]],
  bounce:  [[7, .2], [5, .2], [4, .2], [5, .2], [7, .38], [12, .38], [11, .2], [7, .55]],
  stroll:  [[0, .3], [2, .3], [4, .3], [7, .45], [9, .15], [7, .3], [4, .3], [2, .3], [0, .6]],
  celebrate: [[[0, 4, 7], .2], [[2, 5, 9], .2], [[4, 7, 11], .2], [[5, 9, 12], .45], [null, .1], [[7, 11, 14], .2], [[5, 9, 12], .2], [[4, 7, 12], .7]],
  waltz:   [[-12, .4], [[4, 7], .25], [[4, 7], .25], [-5, .4], [[5, 9], .25], [[5, 9], .25], [-12, .4], [[4, 7], .25], [[4, 7], .25], [-5, .4], [[2, 7], .25], [[2, 5], .5]]
};
function playRiff(name, key, vol) {
  const ctx = S.ctx; if (!ctx || !S.level('organ')) return 0;
  let t = ctx.currentTime + 0.05; const k = key || 0, v = vol || 0.14;
  for (const [n, d] of RIFFS[name]) { if (n !== null) organNote(Array.isArray(n) ? n.map(x => x + k) : n + k, t, d * 0.92, v); t += d; }
  lastOrgan = performance.now(); organBusy = t;
  return t - ctx.currentTime;
}
function medley(names) {
  let delay = 0;
  for (const n of names) { later(() => playRiff(n, pick([0, -3, 2])), delay * 1000); delay += RIFFS[n].reduce((s, x) => s + x[1], 0) + 0.6; }
}
const organReady = gap => performance.now() - lastOrgan > gap && (!S.ctx || S.ctx.currentTime > organBusy);

/* ================= commentary ================= */
const LINES = {
  kickoff: ['And we are under way.', '{A} get us started.', "Here we go. {A} against {B}."],
  secondhalf: ['The second half is under way.', 'Back out for the second half.'],
  goal: ['Goal! {S} score!', "It's in! {S} find the net!", 'What a finish from {S}!', 'Into the back of the net! {S}!'],
  owngoal: ["Oh no, it's an own goal!", 'Into their own net! A gift for {S}.'],
  post: ['Off the post!', 'Agonisingly close! It hits the woodwork.', 'The post comes to the rescue!'],
  save: ['Great save!', 'Kept out by the {K} keeper!', 'What a stop!', 'Denied!'],
  foul: ['Foul. The referee saw that one.', "That's a foul. Free kick."],
  penalty: ['Penalty! The referee points to the spot!', "It's a penalty!"],
  yellow: ['Yellow card.', 'A booking for that challenge.'],
  red: ['Red card! Sent off!', "That's a second booking. Off they go."],
  corner: ['Corner kick.', 'Out for a corner.'],
  goalkick: ['Goal kick.', 'Wide of the target.', 'That one drifts wide.'],
  throw: ['Throw-in.'],
  bigflick: ['Struck with real power!', 'What a strike!', 'They really hit that one.'],
  halftime: ["That's half-time. {A} {sa}, {B} {sb}.", 'The referee blows for half-time.'],
  fulltime: ["It's all over! {result}", "Full time. {result}"],
  miss: ['Missed the ball completely!', 'Oh, that was an air shot.'],
  idle: ['Plenty of thought going into this one.', 'Taking their time over this.', 'The crowd waits.']
};
const PRIORITY = { goal: 5, owngoal: 5, red: 4, penalty: 4, halftime: 4, fulltime: 4, save: 3, post: 3, yellow: 2, foul: 2, kickoff: 2, secondhalf: 2, miss: 1, bigflick: 1, corner: 1, goalkick: 1, throw: 0, idle: 0 };
let speaking = null, lastLine = {}, lastSpoke = 0, voiceCache = null;
function voice() {
  const ss = root.speechSynthesis; if (!ss) return null;
  const want = S.settings().voice.voiceName, all = ss.getVoices();
  if (want) { const v = all.find(x => x.name === want); if (v) return v; }
  if (voiceCache && all.includes(voiceCache)) return voiceCache;
  const en = all.filter(v => /^en/i.test(v.lang));
  voiceCache = en.find(v => /GB/i.test(v.lang) && /Daniel|Arthur|Male|George|Oliver/i.test(v.name)) || en.find(v => /GB/i.test(v.lang)) || en.find(v => v.default) || en[0] || all[0] || null;
  return voiceCache;
}
function fill(text, x) {
  const G = A.getG(); if (!G) return text;
  const [a, b] = G.names, x2 = Object.assign({ A: a, B: b, sa: G.score[0], sb: G.score[1] }, x || {});
  if (!x2.result) x2.result = G.score[0] === G.score[1] ? `${a} and ${b} share it, ${G.score[0]} all.` : `${G.score[0] > G.score[1] ? a : b} win it, ${Math.max(...G.score)} ${Math.min(...G.score)}.`;
  return text.replace(/\{(\w+)\}/g, (_, k) => x2[k] !== undefined ? x2[k] : '');
}
function say(kind, extra) {
  const ss = root.speechSynthesis, lvl = S.level('voice');
  if (!ss || !lvl || document.hidden) return;
  const p = PRIORITY[kind] || 0, now = performance.now();
  if (speaking && ss.speaking) { if (p <= speaking.p) return; ss.cancel(); }       // a goal talks over a throw-in
  if (p < 2 && now - lastSpoke < 4000) return;                                        // leave room between small lines
  const opts = LINES[kind].filter(l => l !== lastLine[kind]), line = pick(opts.length ? opts : LINES[kind]);
  lastLine[kind] = line;
  const u = new SpeechSynthesisUtterance(fill(line, extra));
  const v = voice(); if (v) { u.voice = v; u.lang = v.lang; }
  const excited = p >= 4;
  u.rate = excited ? 1.15 : 1.04; u.pitch = excited ? 1.12 : 0.96; u.volume = Math.min(1, lvl * 1.1);
  speaking = { p }; lastSpoke = now;
  u.onend = u.onerror = () => { speaking = null; };
  ss.speak(u);
}

/* ================= reacting to the match ================= */
let prevPhase = null, readySince = 0, lastIdle = 0;
A.event = function (e) {
  if (!S.ctx || S.isMuted()) return;
  const G = A.getG();
  switch (e.k) {
    case 'banner': {
      const t = e.text;
      if (t === 'GOAL!') say('goal', { S: G ? G.names[G.scorer] : '' });
      else if (t === 'Own goal!') say('owngoal', { S: G ? G.names[G.scorer] : '' });
      else if (t === 'Penalty!') { say('penalty'); boo(); hush = 1; }
      else if (t === 'Red card') { say('red'); boo(); }
      else if (t === 'Yellow card') { say('yellow'); if (Math.random() < 0.6) boo(); }
      else if (t === 'Free kick') { say('foul'); if (Math.random() < 0.3) boo(); }
      else if (t === 'Corner') { say('corner'); if (Math.random() < 0.5) ooh(0.6); }
      else if (t === 'Goal kick') { say('goalkick'); if (Math.random() < 0.4) groan(0.7); }
      else if (t === 'Throw-in') { if (Math.random() < 0.3) say('throw'); }
      else if (t === 'Kick-off') say('kickoff');
      else if (t === 'Second half') { say('secondhalf'); applause(3, 40, 0.1); }
      else if (t === 'Missed the ball') { say('miss'); groan(0.6); }
      else if (t === 'Half-time') {
        say('halftime'); applause(5, 45, 0.12);
        if (S.level('organ')) later(() => medley([pick(['stroll', 'waltz']), pick(['bounce', 'rally'])]), 3500);
      } else if (t === 'Full time') {
        say('fulltime'); cheer(0.8, 3); applause(7, 55, 0.13);
        if (S.level('organ')) later(() => medley(['celebrate', 'stroll']), 4000);
      }
      break;
    }
    case 'goal': cheer(1.3, 3.2); applause(6, 60, 0.14, 'crowd', S.ctx.currentTime + 1.5); hush = 0; break;
    case 'post': if (e.jn > 80) { say('post'); ooh(1.2); } break;
    case 'kb':
      if (G && e.jn > 70) {
        const k = G.w.players[e.id], b = G.w.ball, toward = k && Math.sign(k.homeX) === Math.sign(b.x);
        if (toward) { say('save', { K: G.names[k.team] }); ooh(0.9); applause(2, 30, 0.08); }
      }
      break;
    case 'flick': if (e.v > 175 && Math.random() < 0.35) say('bigflick'); break;
  }
};

/* Every frame: the organ fills dead time now and then, and the commentator fills a long think.
   There is no constant crowd bed: the crowd only reacts to things that happen. */
A.update = function (dt, G) {
  if (!S.ctx || !G) return;
  const now = performance.now();
  if (G.phase !== 'ready') hush = Math.max(0, hush - dt);
  // dead time: the organ or the claps sometimes start up, and the commentator fills a long think
  if (G.phase === 'ready' && prevPhase !== 'ready') {
    readySince = now;
    if (G.mode === 'kickoff' && prevPhase === 'goal' && organReady(20000) && Math.random() < 0.6) later(() => playRiff(pick(['celebrate', 'stabs'])), 900);
    else if ((G.mode === 'corner' || G.mode === 'free') && organReady(40000) && Math.random() < 0.4) later(() => playRiff(pick(['rally', 'stabs']), pick([0, 2, -2])), 1200);
    else if (G.mode === 'corner' && Math.random() < 0.35) later(rhythmClaps, 800);
  }
  if (G.phase === 'ready' && now - readySince > 11000 && organReady(60000) && Math.random() < dt * 0.3) playRiff(pick(['bounce', 'stroll']), pick([0, -3]), 0.1);
  if (G.phase === 'ready' && now - readySince > 14000 && now - lastIdle > 30000) { lastIdle = now; say('idle'); }
  prevPhase = G.phase;
};

/* ================= reactions from real people ================= */
let recent = [];
A.react = function (kind) {
  if (!S.ctx || !S.level('reactions')) return;
  const now = performance.now(); recent = recent.filter(t => now - t < 2500); recent.push(now);
  const swell = recent.length >= 4;                    // lots of people at once: the whole crowd joins in
  if (kind === 'clap') { applause(1.2, 14, 0.1, 'reactions'); if (swell) applause(2.5, 40, 0.1); }
  else if (kind === 'cheer') { cheer(0.45, 1.2, 'reactions'); if (swell) cheer(0.6, 2); }
  else if (kind === 'ooh') { ooh(0.6, 'reactions'); if (swell) ooh(0.9); }
};

/* Leaving a match: silence the commentator and any organ still playing. */
A.stop = function () {
  if (root.speechSynthesis) root.speechSynthesis.cancel();
  speaking = null; organBusy = 0; prevPhase = null;
  for (const t of pendingTimers.splice(0)) clearTimeout(t);
  const b = S.bus('organ'), c = S.bus('crowd');
  if (S.ctx && b && c) {           // fade out what is already scheduled, then restore the channel levels
    const t = S.ctx.currentTime;
    for (const g of [b, c]) { g.gain.cancelScheduledValues(t); g.gain.setTargetAtTime(0, t, 0.08); }
    setTimeout(() => S.set({}), 600);
  }
};

/* Voices load late in some browsers; the Sound menu lists them. */
A.voices = () => (root.speechSynthesis ? root.speechSynthesis.getVoices().filter(v => /^en/i.test(v.lang)) : []);
A.test = ch => {
  if (ch === 'voice') say('goal', { S: (A.getG() || { names: ['Nigeria'] }).names[0] });
  else if (ch === 'crowd') { cheer(0.8, 2); applause(3, 40, 0.12, 'crowd', S.ctx && S.ctx.currentTime + 0.8); }
  else if (ch === 'organ') playRiff(pick(Object.keys(RIFFS)));
  else if (ch === 'reactions') { A.react('clap'); A.react('cheer'); }
};
root.Atmosphere = A;
})(typeof self !== 'undefined' ? self : this);
