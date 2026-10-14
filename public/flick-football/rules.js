/* Flick Football rules: turns, fouls, restarts, goals, clock. Pure logic on top of Phys. */
(function (root) {
'use strict';
const Phys = typeof require !== 'undefined' && typeof module !== 'undefined' ? require('./phys.js') : root.Phys;
const C = Phys.C, hyp = Phys.hyp;

const KITS = [
  { id: 'ngr', name: 'Nigeria',     a: '#0b8a3c', b: '#f2f6f0', shorts: '#0b8a3c', socks: '#f2f6f0', pattern: 'stripes' },
  { id: 'bra', name: 'Brazil',      a: '#ffd400', b: '#0a8f3c', shorts: '#1a47a8', socks: '#f4f4f0', pattern: 'solid' },
  { id: 'arg', name: 'Argentina',   a: '#74b4e6', b: '#f6f6f6', shorts: '#16161a', socks: '#16161a', pattern: 'stripes' },
  { id: 'ger', name: 'Germany',     a: '#f4f4f2', b: '#16161a', shorts: '#16161a', socks: '#f4f4f2', pattern: 'solid' },
  { id: 'fra', name: 'France',      a: '#1c3b8f', b: '#f4f4f2', shorts: '#f4f4f2', socks: '#c8102e', pattern: 'solid' },
  { id: 'ned', name: 'Netherlands', a: '#f57c00', b: '#16161a', shorts: '#16161a', socks: '#f57c00', pattern: 'solid' },
  { id: 'eng', name: 'England',     a: '#f4f4f2', b: '#c8102e', shorts: '#1a2a5e', socks: '#f4f4f2', pattern: 'solid' },
  { id: 'esp', name: 'Spain',       a: '#c60b1e', b: '#f1bf00', shorts: '#1a2a5e', socks: '#c60b1e', pattern: 'solid' },
  { id: 'ita', name: 'Italy',       a: '#0a62b0', b: '#f4f4f2', shorts: '#f4f4f2', socks: '#0a62b0', pattern: 'solid' },
  { id: 'por', name: 'Portugal',    a: '#b80d1b', b: '#0a6b3a', shorts: '#0a6b3a', socks: '#b80d1b', pattern: 'halves' },
  { id: 'cro', name: 'Croatia',     a: '#d6202e', b: '#f4f4f2', shorts: '#f4f4f2', socks: '#1a47a8', pattern: 'checker' },
  { id: 'mar', name: 'Morocco',     a: '#c1272d', b: '#0a6b3a', shorts: '#0a6b3a', socks: '#c1272d', pattern: 'hoops' },
  { id: 'sen', name: 'Senegal',     a: '#f4f4f2', b: '#0b8a3c', shorts: '#f4f4f2', socks: '#0b8a3c', pattern: 'sash' }
];
const KEEPER_COLS = ['#f2c200', '#18b3a4', '#e8591a', '#8d45ff', '#2d3036', '#e83f8d'];
const FORMS = {
  '2-2-2': [[22, -15], [22, 15], [36, -19], [36, 19], [48, -9], [48, 9]],
  '3-2-1': [[22, -20], [20, 0], [22, 20], [37, -12], [37, 12], [48, 0]],
  '2-3-1': [[22, -14], [22, 14], [37, -22], [36, 0], [37, 22], [48, 0]],
  '1-3-2': [[20, 0], [36, -22], [34, 0], [36, 22], [48, -10], [48, 10]],
  '3-1-2': [[22, -20], [20, 0], [22, 20], [35, 0], [48, -10], [48, 10]]
};
const NUMS = [2, 5, 6, 8, 9, 10];

function rgb(h) { return [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)); }
function cdist(a, b) { const x = rgb(a), y = rgb(b); return hyp(x[0] - y[0], x[1] - y[1], x[2] - y[2]); }
function altKit(k) { return Object.assign({}, k, { a: k.b, b: k.a, shorts: k.a, socks: k.b, alt: true }); }

function createGame(opts) {
  const k0 = KITS.find(k => k.id === opts.teams[0].kit), k1 = KITS.find(k => k.id === opts.teams[1].kit);
  let kit0 = Object.assign({}, k0), kit1 = Object.assign({}, k1);
  if (cdist(kit0.a, kit1.a) < 110) kit1 = altKit(k1);
  if (cdist(kit0.a, kit1.a) < 110) kit0 = altKit(k0);
  const used = [kit0.a, kit1.a], kc = [];
  for (let t = 0; t < 2; t++) {
    let best = null, bd = -1;
    for (const c of KEEPER_COLS) { const d = Math.min(...used.map(u => cdist(c, u))); if (d > bd) { bd = d; best = c; } }
    kc.push(best); used.push(best);
  }
  kit0.keeper = kc[0]; kit1.keeper = kc[1];
  const w = Phys.createWorld(), G = {
    w, kits: [kit0, kit1], names: [opts.teams[0].name || kit0.name, opts.teams[1].name || kit1.name],
    forms: [opts.teams[0].form, opts.teams[1].form], dir: [1, -1], score: [0, 0], half: 1, halfLen: opts.halfLen,
    clock: opts.halfLen || 0, firstKick: 0, phase: 'ready', mode: 'kickoff', turn: 0, forced: null, timeUp: false,
    contact: null, flicker: null, fouls: {}, cards: {}, zone: null,
    untimed: !opts.halfLen, stillT: 0, moveT: 0, pending: null, pendT: 0, banner: null, log: [], sink: null, bump: 0,
    opts: JSON.parse(JSON.stringify(opts))
  };
  for (let t = 0; t < 2; t++) {
    for (let i = 0; i < 6; i++) { const p = Phys.makePlayer(t * 7 + i, t, 'p', 0, 0); p.num = NUMS[i]; w.players.push(p); }
    const k = Phys.makePlayer(t * 7 + 6, t, 'k', 0, 0); k.num = 1; w.players.push(k);
  }
  lineup(G, 0);
  return G;
}

function say(G, text, kind, detail) { G.banner = { text, kind: kind || 'info', t: 0, id: ++G.bump }; if (G.sink) G.sink({ k: 'banner', text, kind, detail: detail || '' }); }
function ref(G, call, x, z, card) { if (G.sink) G.sink({ k: 'ref', call, x, z, card: card || null }); }
function booking(G, id) {
  const p = G.w.players[id]; G.fouls[id] = (G.fouls[id] || 0) + 1; const n = G.fouls[id];
  if (n === 2) { G.cards[id] = 'yellow'; return 'yellow'; }
  if (n >= 4 && !p.off && G.w.players.filter(q => q.team === p.team && q.off).length < 2) { G.cards[id] = 'red'; p.off = true; p.x = 900 + id * 10; p.z = 900; p.vx = p.vz = 0; return 'red'; }
  return null;
}
function fmtT(s) { s = Math.round(s); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
function emit(G, e) { if (G.sink) G.sink(e); }
function place(p, x, z) { p.x = x; p.z = z; p.vx = p.vz = p.vy = 0; p.y = 0; p.strike = null; p.diving = false; p.ctl.dir = 0; p.ctl.dive = 0; p.ctl.tx = null; }
function outfield(G, t) { return G.w.players.filter(p => p.team === t && p.kind === 'p' && !p.off); }
function keeperOf(G, t) { return G.w.players.find(p => p.team === t && p.kind === 'k'); }
function setBall(G, x, z) { const b = G.w.ball; Object.assign(b, { x, y: C.bt / 2, z, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, inNet: 0, lastTouch: null, lastPost: 0 }); }
function clampPitch(x, z, m) { return [Math.max(-C.HL + m, Math.min(C.HL - m, x)), Math.max(-C.HW + m, Math.min(C.HW - m, z))]; }

function lineup(G, kickTeam) {
  for (let t = 0; t < 2; t++) {
    const d = G.dir[t], f = FORMS[G.forms[t]], ps = outfield(G, t);
    ps.forEach((p, i) => place(p, -d * (C.HL - f[i][0]), f[i][1]));
    const k = keeperOf(G, t); k.homeX = -d * (C.HL - 3); place(k, k.homeX, 0);
    k.face = d > 0 ? 0 : Math.PI; ps.forEach(p => { p.face = d > 0 ? 0 : Math.PI; });
  }
  setBall(G, 0, 0);
  const d = G.dir[kickTeam], ps = outfield(G, kickTeam);
  ps.sort((a, b) => (Math.abs(a.x) - Math.abs(b.x)) || (Math.abs(a.z) - Math.abs(b.z)));
  const st = ps[0]; place(st, -d * 4.8, 0);
  G.turn = kickTeam; G.forced = st.id; G.mode = 'kickoff'; G.phase = 'ready'; G.contact = null; G.flicker = null;
  G.zone = makeZone(G, 'kickoff', kickTeam, 0, 0);
  G.arrange = { team: 1 - kickTeam };          // the defending side sets up first
}

/* ---------- arranging before a restart ----------
   Kick-off: the defending side may move any of its caps within its own half, outside its own penalty area and
   outside the centre circle. Goal kick: the side that is not kicking may move its caps anywhere on the pitch
   outside the kicker's penalty area. Either way the kick waits until they press Ready. */
function arrangeClamp(G, p, x, z) {
  const d = G.dir[p.team], R = C.pr, cl = (v, a, b) => Math.max(a, Math.min(b, v));
  const gk = !!G.arrange && G.arrange.mode === 'goalkick';
  const gx = gk ? G.arrange.side * C.HL : -d * C.HL, inward = gk ? -G.arrange.side : d;   // the box to keep out of
  x = cl(x, -C.HL + R, C.HL - R); z = cl(z, -C.HW + R, C.HW - R);
  if (!gk && d * x > -R) x = -d * R;                                           // kick-off: own half only
  const inX = Math.abs(x - gx) < C.boxD + R, inZ = Math.abs(z) < C.boxHW + R;   // outside the penalty area
  if (inX && inZ) {
    const outX = C.boxD + R - Math.abs(x - gx), outZ = C.boxHW + R - Math.abs(z);
    if (outX < outZ) x = gx + inward * (C.boxD + R); else z = (Math.sign(z) || 1) * (C.boxHW + R);
  }
  const rc = hyp(x, z), cr = 10 + R;                                            // kick-off: outside the centre circle
  if (!gk && rc < cr) { if (rc < 1e-3) { x = -d * cr; z = 0; } else { x = x / rc * cr; z = z / rc * cr; } if (d * x > -R) x = -d * R; }
  for (const q of G.w.players) {
    if (q.off || q.id === p.id) continue;
    if (hyp(x - q.x, z - q.z) < (q.kind === 'k' ? C.kr : C.pr) + R + 0.3) return null;
  }
  if (hyp(x - G.w.ball.x, z - G.w.ball.z) < R + C.br + 0.4) return null;
  return [x, z];
}
function arrangeMove(G, id, x, z) {
  if (!G.arrange || G.phase !== 'ready') return false;
  const p = G.w.players[id]; if (!p || p.off || p.kind !== 'p' || p.team !== G.arrange.team) return false;
  const r = arrangeClamp(G, p, x, z); if (!r) return false;
  p.x = r[0]; p.z = r[1]; p.vx = p.vz = 0; return true;
}
function arrangeDone(G) { if (G.arrange) G.arrange = null; }

/* ---------- placing and clearing for restarts ---------- */
function keepAway(G, t, cx, cz, R) {
  for (const p of outfield(G, t)) {
    let dx = p.x - cx, dz = p.z - cz, d = hyp(dx, dz);
    if (d < R) { if (d < 1e-3) { dx = 1; dz = 0; d = 1; } p.x = cx + dx / d * (R + 0.4); p.z = cz + dz / d * (R + 0.4); }
  }
}
function clearBox(G, s, ex) {          // push outfield players (except ex) out of the penalty area at x = s*HL
  const gx = s * C.HL, edge = gx - s * (C.boxD + 2.6);
  for (const p of G.w.players) {
    if (p.kind === 'k' || p.off || ex.includes(p.id)) continue;
    if (Math.abs(p.z) < C.boxHW + 2 && s * (p.x - edge) > 0) p.x = edge;
  }
}
function separate(G, fixed) {
  const ps = G.w.players.filter(p => !p.off), b = G.w.ball;
  for (let it = 0; it < 40; it++) {
    let moved = false;
    for (let i = 0; i < ps.length; i++) {
      const a = ps[i], ra = a.kind === 'k' ? C.kr : C.pr;
      if (!fixed.includes(a.id)) {
        const dx = a.x - b.x, dz = a.z - b.z, d = hyp(dx, dz), lim = ra + C.br + 0.5;
        if (d < lim) { const u = d > 1e-3 ? [dx / d, dz / d] : [1, 0]; a.x = b.x + u[0] * lim; a.z = b.z + u[1] * lim; moved = true; }
      }
      for (let j = i + 1; j < ps.length; j++) {
        const c = ps[j], rc = c.kind === 'k' ? C.kr : C.pr, dx = a.x - c.x, dz = a.z - c.z, d = hyp(dx, dz), lim = ra + rc + 0.4;
        if (d >= lim) continue;
        const u = d > 1e-3 ? [dx / d, dz / d] : [0, 1], over = lim - d, fa = fixed.includes(a.id) || a.kind === 'k', fc = fixed.includes(c.id) || c.kind === 'k';
        if (fa && fc) continue;
        const sa = fa ? 0 : fc ? 1 : 0.5, sc = fc ? 0 : fa ? 1 : 0.5;
        a.x += u[0] * over * sa; a.z += u[1] * over * sa; c.x -= u[0] * over * sc; c.z -= u[1] * over * sc; moved = true;
      }
      if (!fixed.includes(a.id) && a.kind === 'p') { const [cx, cz] = clampPitch(a.x, a.z, 2.2); if (cx !== a.x || cz !== a.z) { a.x = cx; a.z = cz; moved = true; } }
    }
    if (!moved) break;
  }
}
function setPiece(G, mode, t, bx, bz, takerPos, opts) {
  opts = opts || {};
  setBall(G, bx, bz);
  const ps = outfield(G, t).slice().sort((p, q) => hyp(p.x - bx, p.z - bz) - hyp(q.x - bx, q.z - bz));
  const taker = ps[0]; place(taker, takerPos[0], takerPos[1]);
  taker.face = Math.atan2(bz - takerPos[1], bx - takerPos[0]);
  const opp = 1 - t;
  keepAway(G, opp, bx, bz, opts.wall || 9);
  if (opts.box) clearBox(G, opts.box, [taker.id]);
  for (const k of [keeperOf(G, 0), keeperOf(G, 1)]) { k.ctl.dir = 0; k.ctl.dive = 0; k.vz = 0; }
  separate(G, [taker.id]);
  G.prevB = null; G.turn = t; G.forced = taker.id; G.mode = mode; G.phase = 'ready'; G.contact = null; G.flicker = null; G.w.ev.length = 0;
  G.zone = makeZone(G, mode, t, bx, bz);
}

/* ---------- where a set-piece taker may stand ----------
   Throw-ins and corners: behind the lines. Goal kicks: anywhere near the ball, including behind the goal line.
   Free kicks: near the ball. Penalties: behind the ball. Kick-off: own half. Nobody may stand inside a goal. */
function makeZone(G, mode, t, bx, bz) {
  const ad = G.dir[t], base = { mode, bx, bz };
  if (mode === 'throw') {
    const s = Math.sign(bz) || 1, inner = C.HW + C.pr + 0.4, outer = C.HW + C.margin - C.pr;
    return Object.assign(base, { type: 'rect', x0: Math.max(-C.HL, bx - 14), x1: Math.min(C.HL, bx + 14), z0: s > 0 ? inner : -outer, z1: s > 0 ? outer : -inner });
  }
  const r = { corner: 12, goalkick: 14, free: 12, penalty: 10, kickoff: 10 }[mode] || 10;
  return Object.assign(base, { type: 'disc', x: bx, z: bz, r, outside: mode === 'corner', behind: mode === 'penalty' ? ad : 0, half: mode === 'kickoff' ? ad : 0 });
}
function zoneClamp(G, x, z, id) {
  const Z = G.zone; if (!Z) return null;
  const ex = C.HL + C.margin - C.pr, ez = C.HW + C.margin - C.pr, cl = (v, a, b) => Math.max(a, Math.min(b, v));
  if (Z.type === 'rect') { x = cl(x, Z.x0, Z.x1); z = cl(z, Z.z0, Z.z1); }
  else { const dx = x - Z.x, dz = z - Z.z, d = hyp(dx, dz); if (d > Z.r) { x = Z.x + dx / d * Z.r; z = Z.z + dz / d * Z.r; } }
  x = cl(x, -ex, ex); z = cl(z, -ez, ez);
  const lx = C.HL + C.pr + 0.3, lz = C.HW + C.pr + 0.3;
  if (Z.outside && Math.abs(x) < lx && Math.abs(z) < lz) {
    if (lx - Math.abs(x) < lz - Math.abs(z)) x = Math.sign(Z.x) * lx; else z = Math.sign(Z.z) * lz;
  }
  if (Z.behind && Z.behind * (x - Z.bx) > -C.pr) x = Z.bx - Z.behind * C.pr;
  if (Z.half && Z.half * x > 0) x = 0;
  if (Math.abs(x) > C.HL - C.pr - 0.6 && Math.abs(z) < C.gw / 2 + C.pr + 0.6) {          // keep out of the goals
    if (Math.abs(x) > C.HL) z = (Math.sign(z) || 1) * (C.gw / 2 + C.pr + 0.6); else x = Math.sign(x) * (C.HL - C.pr - 0.6);
  }
  const bd = hyp(x - Z.bx, z - Z.bz), minD = C.pr + C.br + 0.4;
  if (bd < minD) { if (bd < 1e-3) return null; x = Z.bx + (x - Z.bx) / bd * minD; z = Z.bz + (z - Z.bz) / bd * minD; }
  for (const p of G.w.players) {
    if (p.off || p.id === id) continue;
    if (hyp(x - p.x, z - p.z) < (p.kind === 'k' ? C.kr : C.pr) + C.pr + 0.3) return null;
  }
  return [x, z];
}
function moveTaker(G, x, z) {
  if (G.phase !== 'ready' || G.forced === null || !G.zone) return false;
  const p = G.w.players[G.forced], r = zoneClamp(G, x, z, p.id); if (!r) return false;
  p.x = r[0]; p.z = r[1]; p.vx = p.vz = 0; p.face = Math.atan2(G.w.ball.z - p.z, G.w.ball.x - p.x);
  return true;
}

function endMatch(G) { if (G.phase === 'fulltime') return; G.half = 2; endHalf(G); }

/* ---------- restarts ---------- */
function restartFoul(G, foulTeam, fx, fz, offId) {
  const t = 1 - foulTeam, ad = G.dir[t], gx = -G.dir[foulTeam] * C.HL, off = G.w.players[offId];
  const card = booking(G, offId);
  const who = `Foul by #${off.num} (${G.names[foulTeam]}).`;
  const cardTxt = card === 'red' ? ` Second yellow: #${off.num} is sent off.` : card === 'yellow' ? ` Yellow card for #${off.num}.` : '';
  if (Math.abs(fx - gx) < C.boxD && Math.abs(fz) < C.boxHW) {              // inside own box: penalty
    const sx = gx - ad * 12;
    setPiece(G, 'penalty', t, sx, 0, [sx - ad * 4.8, 0], { wall: 0, box: Math.sign(gx) });
    const dk = keeperOf(G, foulTeam); place(dk, dk.homeX, 0);
    say(G, 'Penalty!', 'foul', `${who} Penalty to ${G.names[t]}.${cardTxt}`); ref(G, 'penalty', sx, 0, card);
  } else {
    const [bx, bz] = clampPitch(fx, fz, 3);
    const [tx, tz] = clampPitch(bx - ad * 4.8, bz, 2.2);
    setPiece(G, 'free', t, bx, bz, [tx, tz], { wall: 10 });
    say(G, card === 'red' ? 'Red card' : card === 'yellow' ? 'Yellow card' : 'Free kick', card ? 'card-' + card : 'foul', `${who} Free kick to ${G.names[t]}.${cardTxt}`);
    ref(G, 'free', bx, bz, card);
  }
}
/* Which line the ball wholly crossed first, and where. Worked out from the last in-play position, so a ball that
   rebounds off the rails afterwards (or runs on past the corner) is still judged by the line it actually left over. */
function outInfo(a, b, lt) {
  const LZ = C.HW + C.br, LX = C.HL + C.br;
  const tz = Math.abs(b.z) > LZ ? (LZ - Math.abs(a.z)) / Math.max(1e-6, Math.abs(b.z) - Math.abs(a.z)) : Infinity;
  const tx = Math.abs(b.x) > LX ? (LX - Math.abs(a.x)) / Math.max(1e-6, Math.abs(b.x) - Math.abs(a.x)) : Infinity;
  const line = tz <= tx ? 'touch' : 'goal', t = Math.max(0, Math.min(1, line === 'touch' ? tz : tx));
  return { line, x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, lt };
}
function restartOut(G) {
  const b = G.w.ball, o = G.out || outInfo(b, b, b.lastTouch ? b.lastTouch.team : G.flickTeam), lt = o.lt;
  G.out = null; G.prevB = null;
  if (o.line === 'touch') {                                                  // touchline: throw-in where it crossed
    const t = 1 - lt, sz = Math.sign(o.z) || 1, x = Math.max(-C.HL + 4, Math.min(C.HL - 4, o.x)), bz = sz * (C.HW - 2.2);
    setPiece(G, 'throw', t, x, bz, [x - G.dir[t] * 1.5, bz + sz * 4.6], { wall: 8 });
    say(G, 'Throw-in', 'info', `Off ${G.names[lt]}. Throw to ${G.names[t]}.`); ref(G, 'throw', x + G.dir[t] * 25, bz);
  } else {                                                                   // goal line
    const s = Math.sign(o.x) || 1, def = G.dir.indexOf(-s), att = 1 - def;
    if (lt === def) {                                                        // defenders last touched it: corner
      const sz = o.z >= 0 ? 1 : -1, cx = s * (C.HL - 1.2), cz = sz * (C.HW - 1.2);   // in the corner arc on the side it went out
      setPiece(G, 'corner', att, cx, cz, [s * (C.HL + 1.4), sz * (C.HW + 1.4)], { wall: 10 });
      say(G, 'Corner', 'info', `Last touch ${G.names[def]}. Corner to ${G.names[att]}.`); ref(G, 'corner', s * C.HL, sz * C.HW);
    } else {
      const bz = Math.max(-9, Math.min(9, o.z)), bx = s * (C.HL - 10);
      setPiece(G, 'goalkick', def, bx, bz, [bx + s * 4.8, bz], { wall: 8, box: s });
      goalKickShape(G, att, s);
      say(G, 'Goal kick', 'info', `Off ${G.names[att]}. Goal kick to ${G.names[def]}.`); ref(G, 'goalkick', bx, bz);
    }
  }
}
function restartKickoff(G, t) { lineup(G, t); }
/* Before a goal kick the other side starts from its own formation and may rearrange (outside the kicker's box),
   then presses Ready, as at a kick-off. */
function goalKickShape(G, t, side) {
  const d = G.dir[t], f = FORMS[G.forms[t]];
  outfield(G, t).forEach((p, i) => { place(p, -d * (C.HL - f[i][0]), f[i][1]); p.face = d > 0 ? 0 : Math.PI; });
  clearBox(G, side, [G.forced]);
  separate(G, [G.forced]);
  G.arrange = { team: t, mode: 'goalkick', side };
}

/* ---------- player actions ---------- */
function canFlick(G, id) { const p = G.w.players[id]; return G.phase === 'ready' && !G.arrange && p && p.kind === 'p' && p.team === G.turn && (G.forced === null || G.forced === id); }
function doFlick(G, id, dx, dz, speed, loft, curl) {
  if (!canFlick(G, id)) return false;
  const p = G.w.players[id];
  Phys.flick(G.w, p, dx, dz, speed, loft, curl);
  G.zone = null;
  G.phase = 'moving'; G.flicker = id; G.flickTeam = p.team; G.contact = null; G.foul = null; G.stillT = 0; G.moveT = 0; G.w.ev.length = 0;
  emit(G, { k: 'flick', v: speed });
  return true;
}
function setKeeper(G, t, dir, dive) { const k = keeperOf(G, t); k.ctl.dir = dir; if (dir) k.ctl.tx = null; if (dive) k.ctl.dive = dive; }
function setKeeperTarget(G, t, x, z) {
  const k = keeperOf(G, t), s = Math.sign(k.homeX);
  const lo = Math.min(s * (C.HL - 1.6), s * (C.HL - C.sixD + 0.8)), hi = Math.max(s * (C.HL - 1.6), s * (C.HL - C.sixD + 0.8));
  k.ctl.tx = Math.max(lo, Math.min(hi, x)); k.ctl.tz = Math.max(-(C.sixHW - 0.8), Math.min(C.sixHW - 0.8, z));
}

/* ---------- main update ---------- */
function update(G) {
  const w = G.w, dt = Phys.TICK;
  if (G.phase === 'halftime' || G.phase === 'fulltime') return;
  if (G.banner) G.banner.t += dt;
  if (!G.untimed && !G.arrange && (G.phase === 'ready' || G.phase === 'moving')) {
    G.clock -= dt;
    if (G.clock <= 0) { G.clock = 0; G.timeUp = true; }
  }
  Phys.advance(w);
  const evs = w.ev.splice(0, w.ev.length);
  for (const e of evs) {
    emit(G, e);
    if (G.phase !== 'moving') continue;
    const f = w.players[G.flicker];
    if (e.k === 'pb' && e.id === G.flicker && G.contact === null) G.contact = 'ball';
    if (e.k === 'pp' && e.v > 4 && G.contact === null && (e.a === G.flicker || e.b === G.flicker)) {
      const o = w.players[e.a === G.flicker ? e.b : e.a];
      if (o.team !== f.team && !o.off) { G.contact = 'foul'; G.foul = { team: f.team, x: f.x, z: f.z, id: f.id }; G.pendT = 0.35; emit(G, { k: 'whistle', type: 'foul' }); }
    }
  }
  const b = w.ball;
  if (G.phase === 'moving') {
    G.moveT += dt;
    if (G.contact === 'foul') {
      G.pendT -= dt;
      if (G.pendT <= 0) restartFoul(G, G.foul.team, G.foul.x, G.foul.z, G.foul.id);
      return;
    }
    if (b.inNet) {                                                           // goal
      const scorer = G.dir.indexOf(b.inNet), og = b.lastTouch && b.lastTouch.team !== scorer && G.w.players[b.lastTouch.id].kind !== 'k';
      G.score[scorer]++; G.phase = 'goal'; G.pendT = 2.4; G.scorer = scorer;
      say(G, og ? 'Own goal!' : 'GOAL!', 'goal', `${G.names[0]} ${G.score[0]} – ${G.score[1]} ${G.names[1]}`); emit(G, { k: 'goal', team: scorer }); emit(G, { k: 'whistle', type: 'goal' }); ref(G, 'goal', 0, 0);
      return;
    }
    if (Math.abs(b.z) > C.HW + C.br || (Math.abs(b.x) > C.HL + C.br)) {     // out of play
      G.out = outInfo(G.prevB || { x: b.x, z: b.z }, b, b.lastTouch ? b.lastTouch.team : G.flickTeam);
      G.phase = 'dead'; G.pendT = 0.7; emit(G, { k: 'whistle', type: 'short' }); return;
    }
    G.prevB = { x: b.x, z: b.z };
    const rest = Phys.atRest(w);
    G.stillT = rest ? G.stillT + dt : 0;
    if (b.y > C.br + 0.4 && hyp(b.vx, b.vz) < 4 && !rest) { b.stuck = (b.stuck || 0) + dt; if (b.stuck > 0.8) { b.vx = 30; b.stuck = 0; } } else b.stuck = 0;
    if (G.stillT > 0.15 || G.moveT > 8) endTurn(G);
  } else if (G.phase === 'goal') {
    G.pendT -= dt; if (G.pendT <= 0) afterStop(G, () => restartKickoff(G, 1 - G.scorer));
  } else if (G.phase === 'dead') {
    G.pendT -= dt; if (G.pendT <= 0) afterStop(G, () => restartOut(G));
  } else if (G.phase === 'ready' && G.timeUp) endHalf(G);
}
function afterStop(G, fn) { if (G.timeUp) { endHalf(G); return; } fn(); }
function endTurn(G) {
  for (const p of G.w.players) { p.strike = null; }
  if (G.contact === null) say(G, 'Missed the ball', 'info', 'No touch on the ball, so the turn passes.');
  G.turn = 1 - G.turn; G.forced = null; G.mode = 'open'; G.phase = 'ready'; G.contact = null; G.flicker = null; G.zone = null;
  for (const k of [keeperOf(G, 0), keeperOf(G, 1)]) { k.ctl.dir = 0; }
  if (G.timeUp) endHalf(G);
}
function endHalf(G) {
  emit(G, { k: 'whistle', type: 'final' });
  const sc = `${G.names[0]} ${G.score[0]} – ${G.score[1]} ${G.names[1]}`;
  if (G.half === 1) { G.phase = 'halftime'; say(G, 'Half-time', 'info', sc); ref(G, 'half', 0, 0); }
  else {
    G.phase = 'fulltime';
    say(G, 'Full time', 'info', sc); ref(G, 'full', 0, 0);
  }
}
function startSecondHalf(G) {
  G.half = 2; G.dir = [-1, 1]; G.clock = G.halfLen; G.timeUp = false; lineup(G, 1 - G.firstKick);
}

/* ---------- ticks, inputs and snapshots ----------
   Everything that changes the match goes through simTick as a per-team input, so a match can run on one screen,
   against the computer, or on two machines that exchange only these inputs and simulate the same thing.
   Input: { kd: keeper slide -1|0|1, dv: dive -1|0|1, c: [commands] }. Commands are arrays of plain numbers. */
const Q = 10000, q = v => Math.round(v * Q), uq = v => v / Q;
const cmd = {
  flick: (id, dx, dz, speed, curl) => { const m = hyp(dx, dz) || 1; return ['f', id, q(dx / m), q(dz / m), Math.round(speed * 100), Math.round(curl * 20)]; },
  arrange: (id, x, z) => ['a', id, q(x), q(z)],
  arrangeDone: () => ['ad'],
  taker: (x, z) => ['t', q(x), q(z)],
  keeperTo: (x, z) => ['kt', q(x), q(z)],
  secondHalf: () => ['h2'],
  rematch: () => ['rm'],
  end: () => ['end']
};
function kickoffCall(G, title, detail) {
  say(G, title, 'info', detail); emit(G, { k: 'whistle', type: 'short' }); emit(G, { k: 'ref', call: 'kickoff', x: 0, z: 0 });
}
function applyInput(G, t, inp) {
  if (!inp) return;
  setKeeper(G, t, inp.kd || 0, inp.dv || 0);
  for (const c of inp.c || []) {
    switch (c[0]) {
      case 'f': { const p = G.w.players[c[1]]; if (p && p.team === t) doFlick(G, c[1], uq(c[2]), uq(c[3]), c[4] / 100, 0, c[5] / 20); break; }
      case 'a': if (G.arrange && G.arrange.team === t) arrangeMove(G, c[1], uq(c[2]), uq(c[3])); break;
      case 'ad': if (G.arrange && G.arrange.team === t) arrangeDone(G); break;
      case 't': if (G.turn === t) moveTaker(G, uq(c[1]), uq(c[2])); break;
      case 'kt': setKeeperTarget(G, t, uq(c[1]), uq(c[2])); break;
      case 'h2': if (G.phase === 'halftime') { startSecondHalf(G); const k = 1 - G.firstKick; kickoffCall(G, 'Second half', `${G.names[k]} to start.`); } break;
      case 'rm': if (G.phase === 'fulltime') { restore(G, snapshot(createGame(G.opts))); kickoffCall(G, 'Kick-off', `${G.names[0]} v ${G.names[1]}. ${G.names[0]} to start.`); } break;
      case 'end': endMatch(G); break;
    }
  }
}
function simTick(G, inputs) { applyInput(G, 0, inputs[0]); applyInput(G, 1, inputs[1]); update(G); }

/* A snapshot is a plain deep copy of the match without the event sink. restore() writes it back into the same
   object, so the views that hold G keep working after a rollback. */
const SHARED = { kits: 1, names: 1, forms: 1, opts: 1, log: 1, sink: 1 };   // never change during a match
function copy(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) { const a = new Array(v.length); for (let i = 0; i < v.length; i++) a[i] = copy(v[i]); return a; }
  const o = {}; for (const k in v) o[k] = copy(v[k]); return o;
}
function snapshot(G) {
  const s = {};
  for (const k in G) if (k !== 'sink') s[k] = SHARED[k] ? G[k] : copy(G[k]);
  return s;
}
function restore(G, s) {
  const sink = G.sink;
  for (const k of Object.keys(G)) if (!(k in s)) delete G[k];
  for (const k in s) G[k] = SHARED[k] ? s[k] : copy(s[k]);
  G.sink = sink || null;
  return G;
}
/* Hash of everything that decides the result. face, banners and timers for effects are left out. */
function hash(G) {
  let h = 2166136261 >>> 0;
  const mix = v => { h = Math.imul(h ^ (v | 0), 16777619) >>> 0; };
  const num = v => mix(Math.round((v || 0) * 1000));
  const b = G.w.ball; [b.x, b.z, b.vx, b.vz, b.wy, b.inNet].forEach(num);
  for (const p of G.w.players) { [p.x, p.z, p.vx, p.vz, p.diveCD].forEach(num); mix(p.off ? 1 : 0); mix(p.diving ? 1 : 0); }
  G.score.forEach(mix); [G.turn, G.forced === null ? -1 : G.forced, G.half].forEach(mix); num(G.clock);
  for (const ch of G.phase + G.mode) mix(ch.charCodeAt(0));
  return h;
}

const API = { cmd, applyInput, simTick, snapshot, restore, hash, kickoffCall, KITS, FORMS, createGame, update, canFlick, doFlick, setKeeper, setKeeperTarget, moveTaker, zoneClamp, fmtT, endMatch, arrangeMove, arrangeDone, arrangeClamp, startSecondHalf, keeperOf, outfield, lineup, say };
if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.Rules = API;
})(typeof self !== 'undefined' ? self : this);

