/* playcity connection layer: invite rooms, quick match, and a direct line between two players.

   Talking to the server is only for finding each other. A guest knocks on the host's room, the host accepts,
   and the two swap WebRTC offers through the room. From then on game traffic goes straight from one browser to
   the other over two data channels: "u" (unordered, no retransmits: inputs and aim, where a late packet is
   useless and the next one carries the same data) and "r" (reliable: match setup, hashes, resyncs).
   If a direct path cannot be found in a few seconds, the same messages flow through the room instead. */
(function (root) {
'use strict';
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const P2P_TIMEOUT = 5000, PING_MS = 25000;

function newCode() { const b = crypto.getRandomValues(new Uint8Array(5)); return Array.from(b, v => ALPHA[v & 31]).join(''); }
function wsUrl(path) { return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + path; }
let iceCache = null;
async function iceServers() {
  if (iceCache && iceCache.until > Date.now()) return iceCache.list;
  try {
    const r = await fetch('/api/ice'); const j = await r.json();
    iceCache = { list: j.iceServers, until: Date.now() + 4 * 60 * 1000 };
  } catch (e) { iceCache = { list: [{ urls: 'stun:stun.cloudflare.com:3478' }], until: Date.now() + 30000 }; }
  return iceCache.list;
}
function keepAlive(ws) { const id = setInterval(() => { if (ws.readyState === 1) ws.send('ping'); }, PING_MS); ws.addEventListener('close', () => clearInterval(id)); }

/* A link to the other player. Starts on the room WebSocket and upgrades to WebRTC when it can. */
function createLink(ws, initiator, h) {
  const L = { via: 'relay', closed: false, pc: null, u: null, r: null, audio: null, remote: null };
  const emit = m => { if (!L.closed) h.onMessage(m); };
  async function startRtc() {
    if (!root.RTCPeerConnection) return;
    const pc = L.pc = new RTCPeerConnection({ iceServers: await iceServers() });
    const ready = () => { if (L.u && L.r && L.u.readyState === 'open' && L.r.readyState === 'open' && L.via !== 'p2p') { L.via = 'p2p'; h.onVia && h.onVia('p2p'); } };
    const wire = ch => {
      ch.onopen = ready;
      ch.onmessage = e => { try { emit(JSON.parse(e.data)); } catch (x) { /* ignore junk */ } };
      ch.onclose = () => { if (L.via === 'p2p' && !L.closed) { L.via = 'relay'; h.onVia && h.onVia('relay'); if (L.onP2pLost) L.onP2pLost(); } };
      if (ch.label === 'u') L.u = ch; else L.r = ch;
    };
    pc.onicecandidate = e => { if (e.candidate) send({ t: 'sig', cand: e.candidate.toJSON() }, true, true); };
    pc.ondatachannel = e => wire(e.channel);
    // Walkie-talkie: one audio track rides on the same connection, silent until a player holds the talk button.
    // Watchers are never on this connection, so they can never hear the players.
    pc.ontrack = e => { if (e.track.kind !== 'audio') return; L.remote = e.streams[0] || new MediaStream([e.track]); h.onAudio && h.onAudio(L.remote); };
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' && L.via === 'p2p') { L.via = 'relay'; h.onVia && h.onVia('relay'); } };
    if (initiator) {
      wire(pc.createDataChannel('u', { ordered: false, maxRetransmits: 0 }));
      wire(pc.createDataChannel('r', { ordered: true }));
      L.audio = pc.addTransceiver('audio', { direction: 'sendrecv' });
      await pc.setLocalDescription(await pc.createOffer());
      send({ t: 'sig', sdp: pc.localDescription.toJSON() }, true, true);
    }
  }
  const queued = [];
  let starting = null;
  const ensure = () => starting || (starting = startRtc());
  async function onSig(m) {
    try {
      await ensure();
      const pc = L.pc; if (!pc) return;
      if (m.sdp) {
        await pc.setRemoteDescription(m.sdp);
        for (const c of queued.splice(0)) await pc.addIceCandidate(c).catch(() => {});
        if (m.sdp.type === 'offer') {
          const tr = pc.getTransceivers().find(t => t.receiver && t.receiver.track && t.receiver.track.kind === 'audio');
          if (tr) { tr.direction = 'sendrecv'; L.audio = tr; }
          await pc.setLocalDescription(await pc.createAnswer()); send({ t: 'sig', sdp: pc.localDescription.toJSON() }, true, true);
        }
      } else if (m.cand) {
        if (pc.remoteDescription) await pc.addIceCandidate(m.cand).catch(() => {}); else queued.push(m.cand);
      }
    } catch (e) { console.warn('webrtc', e); }
  }
  function send(m, reliable, forceWs) {
    if (L.closed) return;
    const s = JSON.stringify(m);
    if (!forceWs && L.via === 'p2p') {
      const ch = reliable ? L.r : L.u;
      if (ch && ch.readyState === 'open' && ch.bufferedAmount < 256 * 1024) { ch.send(s); return; }
    }
    if (ws.readyState === 1) ws.send(s);
  }
  L.send = send;
  /* Put a microphone track on the audio channel (null takes it off). No renegotiation: the channel already exists. */
  L.setMic = track => L.audio ? L.audio.sender.replaceTrack(track).then(() => true, () => false) : Promise.resolve(false);
  L.wsMessage = m => { if (m.t === 'sig') onSig(m); else emit(m); };
  L.close = () => { L.closed = true; try { L.pc && L.pc.close(); } catch (e) { /* ignore */ } };
  L.start = () => { if (initiator) ensure(); };
  // No direct path within a few seconds (or no WebRTC at all): carry on through the room relay.
  if (!root.RTCPeerConnection) setTimeout(() => h.onVia && h.onVia('relay'), 0);
  else setTimeout(() => { if (L.via !== 'p2p' && !L.closed) h.onVia && h.onVia('relay'); }, P2P_TIMEOUT);
  return L;
}

/* Host: hold a room open. Knocks arrive through onKnock; accept() starts the link.
   The code is for keeps: if the connection drops (a phone switching apps to send the invite link loses it within
   seconds), the room is opened again under the same code, so a link already sent still works. Guests who arrive
   meanwhile wait in the room and knock once the host is back.
   h: { name, code?, onOpen(code), onDown(), onKnock({gid,name}), onKnockGone(gid), onLink(link, guestName), onLeft(), onClose(code) } */
function host(h) {
  let ws = null, code = h.code || newCode(), link = null, tries = 0, closed = false, up = false, retry = 0, timer = null, probe = null;
  const hid = newCode() + newCode();          // this host, across reconnects: lets the room swap a stale connection for a fresh one
  const R = { get code() { return code; }, get link() { return link; }, get up() { return up; } };
  R.url = () => location.origin + location.pathname + '?join=' + code;
  function open() {
    if (closed) return;
    clearTimeout(timer); clearTimeout(probe);
    const q = `role=host&name=${encodeURIComponent(h.name || 'Player')}&hid=${hid}` + (link && link.gid ? `&in=${link.gid}` : '');
    const me = ws = new WebSocket(wsUrl(`/ws/room/${code}?${q}`));
    keepAlive(me);
    me.onmessage = e => {
      if (me !== ws) return;
      if (e.data === 'pong') { clearTimeout(probe); return; }
      let m; try { m = JSON.parse(e.data); } catch (x) { return; }
      if (m.t === 'hosting') { up = true; retry = 0; tries = 0; h.onOpen && h.onOpen(code); return; }
      if (m.t === 'knock') { h.onKnock(m); return; }
      if (m.t === 'watchers') { h.onWatchers && h.onWatchers(m.n, m.join); return; }
      if (m.t === 'wr') { h.onReaction && h.onReaction(m.r); return; }
      if (m.t === 'peer-left') {
        if (m.wasIn && link) { link.close(); link = null; h.onLeft && h.onLeft(); }
        else if (!m.wasIn) h.onKnockGone && h.onKnockGone(m.gid);      // gave up waiting before we answered
        return;
      }
      if (link) link.wsMessage(m);
    };
    me.onclose = e => { if (me === ws) dropped(e.code); };
  }
  function dropped(c) {
    if (closed) return;
    up = false; ws = null;
    if (c === 4009 && tries++ < 5) { code = newCode(); open(); h.onOpen && h.onOpen(code); return; }   // code held by someone else: pick another
    if (link && link.via === 'p2p') { const l = link; l.onP2pLost = () => { if (link === l) { l.close(); link = null; h.onLeft && h.onLeft(); } }; }
    else if (link) { link.close(); link = null; h.onLeft && h.onLeft(); }
    h.onDown && h.onDown(c);
    timer = setTimeout(open, Math.min(15000, 1000 * 2 ** retry++));
  }
  /* Back in front of the person (tab shown again, network back): reconnect now rather than at the next backoff, and
     check a socket that claims to be open really is (a phone asleep can leave one that never says it closed). */
  R.wake = () => {
    if (closed) return;
    if (!ws) { retry = 0; open(); return; }
    if (ws.readyState === 1) {
      try { ws.send('ping'); } catch (e) { /* closing */ }
      clearTimeout(probe);
      const w = ws;
      probe = setTimeout(() => { if (w === ws) { w.onclose = null; try { w.close(); } catch (e) { /* ignore */ } dropped(1006); } }, 4000);
    }
  };
  /* A new name for the knock message: the same room on a fresh connection, which replaces this one. */
  R.rename = name => { h.name = name; if (!closed && !link) { const w = ws; ws = null; if (w) { w.onclose = null; w.onmessage = null; } open(); if (w) setTimeout(() => { try { w.close(1000); } catch (e) { /* ignore */ } }, 3000); } };
  R.accept = (gid, guestName) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'accept', gid }));
    link = createLink(ws, true, { onMessage: m => h.onMessage(m), onVia: v => h.onVia && h.onVia(v), onAudio: st => h.onAudio && h.onAudio(st) });
    link.gid = gid;
    link.start();
    h.onLink && h.onLink(link, guestName);
  };
  R.decline = (gid, full) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(full ? { t: 'decline', gid, full: true } : { t: 'decline', gid })); };
  R.sendWatch = m => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };   // spectator feed: the room fans it out
  R.close = () => { closed = true; clearTimeout(timer); clearTimeout(probe); if (link) link.close(); link = null; try { ws && ws.close(1000); } catch (e) { /* ignore */ } };
  open();
  return R;
}

/* Guest: knock on a room. h: { name, onWaiting(), onKnocking(hostName), onLink(link, hostName), onLeft(), onClose(code) }
   onWaiting: nobody holds the code right now (the host may be switching apps); the knock goes in when they are back. */
function join(code, h) {
  let link = null, closed = false;
  const ws = new WebSocket(wsUrl(`/ws/room/${code}?role=guest&name=${encodeURIComponent(h.name || 'Player')}`));
  keepAlive(ws);
  ws.onmessage = e => {
    if (e.data === 'pong') return;
    let m; try { m = JSON.parse(e.data); } catch (x) { return; }
    if (m.t === 'waiting') { if (!link) h.onWaiting && h.onWaiting(); return; }
    if (m.t === 'knocking') { h.onKnocking && h.onKnocking(m.host); return; }
    if (m.t === 'accepted') {
      link = createLink(ws, false, { onMessage: mm => h.onMessage(mm), onVia: v => h.onVia && h.onVia(v), onAudio: st => h.onAudio && h.onAudio(st) });
      h.onLink && h.onLink(link, m.host); return;
    }
    if (link) link.wsMessage(m);
  };
  ws.onclose = e => {
    if (closed) return;
    // The room going away (a server restart, a deploy) is not the other player leaving: if the direct link is up,
    // play on. A real departure arrives as "bye", a closed data channel, or the stall timeout.
    if (link && link.via === 'p2p' && e.code !== 4001) { link.onP2pLost = () => { link.close(); link = null; h.onLeft && h.onLeft(e.code); }; return; }
    if (link) { link.close(); link = null; h.onLeft && h.onLeft(e.code); } else h.onClose && h.onClose(e.code);
  };
  return { close() { closed = true; if (link) link.close(); try { ws.close(1000); } catch (e) { /* ignore */ } } };
}

/* Spectator: listen to a table. h: { onMessage(m), onClose(code) } */
function watch(code, h) {
  let closed = false;
  const ws = new WebSocket(wsUrl(`/ws/room/${code}?role=watch`));
  keepAlive(ws);
  ws.onmessage = e => { if (e.data === 'pong') return; try { h.onMessage(JSON.parse(e.data)); } catch (x) { /* ignore junk */ } };
  ws.onclose = e => { if (!closed) h.onClose && h.onClose(e.code); };
  return {
    send(m) { if (ws.readyState === 1) ws.send(JSON.stringify(m)); },   // reactions only; the room drops anything else
    close() { closed = true; try { ws.close(1000); } catch (e) { /* ignore */ } }
  };
}
async function liveTables(game) {
  try { const r = await fetch(`/api/live?game=${encodeURIComponent(game)}`); return r.ok ? r.json() : []; } catch (e) { return []; }
}

/* Quick match. seek() returns a room code to knock on, or null if nobody is open right now. */
async function seek(game, exclude) {
  const r = await fetch(`/api/match?game=${encodeURIComponent(game)}&exclude=${encodeURIComponent((exclude || []).join(','))}`);
  return r.ok ? r.json() : { code: null };
}
/* Stay listed as open to challengers while this returned handle is open. */
function listOpen(game, code, name, live, players, watching) {
  let ws, closed = false, retry = 1000, timer = null, sent = '';
  const n = { p: players || 0, w: watching || 0 };
  const open = () => {
    if (closed) return;                       // cancelled while a reconnect was waiting: stay down
    ws = new WebSocket(wsUrl(`/ws/lobby?game=${encodeURIComponent(game)}&code=${code}&name=${encodeURIComponent(name || 'Player')}${live ? '&live=1' : ''}&players=${n.p}&watching=${n.w}`));
    keepAlive(ws); sent = n.p + '/' + n.w;
    ws.onopen = () => { retry = 1000; push(); };
    ws.onclose = e => { if (!closed && e.code !== 4009) timer = setTimeout(open, retry = Math.min(30000, retry * 2)); };
  };
  // how many are playing and watching, shown on the landing page; sent only when it changes
  const push = () => { const k = n.p + '/' + n.w; if (k !== sent && ws && ws.readyState === 1) { sent = k; ws.send(JSON.stringify({ t: 'n', p: n.p, w: n.w })); } };
  open();
  return {
    counts(p, w) { n.p = p; n.w = w; push(); },
    close() { closed = true; clearTimeout(timer); try { ws.close(1000); } catch (e) { /* ignore */ } }
  };
}

root.Net = { host, join, watch, liveTables, seek, listOpen, newCode };
})(self);
