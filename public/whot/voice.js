/* Check Up Whot walkie-talkie: hold the button, talk to the other people on the table's walkie-talkie.

   By default that is the seated players. The table's owner can open it to everyone, watchers included. Either
   way the table decides who is in the group and tells each member the others' public voice ids (vid); it only
   passes connection setup between members, and no audio ever touches the server. Audio goes browser to browser
   (WebRTC), one link per pair (at most 7 each). Each link carries an audio track that is silent until you hold
   the button; holding switches your microphone on for every link at once, with no renegotiation.

   The microphone is only requested on the first press, and released after a quiet spell, so phones do not
   stay in "call mode" all game. */

const IDLE_MIC_MS = 45_000;        // release the microphone after this long without talking
const TALK_MAX_MS = 60_000;        // a "talking" flag that is never switched off expires after this

export function createVoice({ send, onChange, toast }) {
  const peers = new Map();         // vid -> { pc, vid, audio, analyser, data, stream, sender, timer }
  const talking = new Map();       // vid -> since (ms): who is holding their button right now
  let me = null, enabled = true, ice = null, mic = null, micTimer = null, live = false, held = false;
  let ctx = null, myAnalyser = null, myData = null;
  const muted = new Set();         // vids this listener has muted
  const hist = new Map();          // vid -> recent levels for the little waveform

  const audioCtx = () => {
    if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) ctx = new AC(); }
    if (ctx && ctx.state === 'suspended') ctx.resume();
    return ctx;
  };
  async function iceServers() {
    if (ice) return ice;
    try { const r = await fetch('/api/ice'); ice = (await r.json()).iceServers; } catch (e) { ice = [{ urls: 'stun:stun.cloudflare.com:3478' }]; }
    return ice;
  }

  function close(seat) {
    const p = peers.get(seat); if (!p) return;
    clearTimeout(p.timer);
    try { if (p.pc) p.pc.close(); } catch (e) { /* closed */ }
    if (p.audio) { p.audio.srcObject = null; p.audio.remove(); }
    peers.delete(seat); talking.delete(seat); hist.delete(seat);
  }

  async function open(seat, vid, initiator) {
    close(seat);
    // Claim the seat first, so a second update while we fetch ICE servers does not open a duplicate link.
    const p = { pc: null, vid, sender: null, audio: null, analyser: null, data: null, timer: null };
    peers.set(seat, p);
    const servers = await iceServers();
    if (peers.get(seat) !== p) return null;
    const pc = new RTCPeerConnection({ iceServers: servers });
    const tr = pc.addTransceiver('audio', { direction: 'sendrecv' });
    p.pc = pc; p.sender = tr.sender;
    if (mic) tr.sender.replaceTrack(mic.getAudioTracks()[0]).catch(() => {});
    pc.onicecandidate = e => { if (e.candidate) send({ t: 'rtc', to: seat, d: { ice: e.candidate.toJSON() } }); };
    pc.ontrack = e => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      const a = document.createElement('audio');
      a.autoplay = true; a.setAttribute('playsinline', ''); a.srcObject = stream; a.muted = muted.has(seat);
      a.style.display = 'none'; document.body.appendChild(a);
      a.play().catch(() => {});
      p.audio = a;
      const c = audioCtx();
      if (c) { try { const src = c.createMediaStreamSource(stream); p.analyser = c.createAnalyser(); p.analyser.fftSize = 256; p.data = new Uint8Array(p.analyser.fftSize); src.connect(p.analyser); } catch (err) { /* level unavailable: the wave animates anyway */ } }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && peers.get(seat) === p) {
        p.timer = setTimeout(() => { if (peers.get(seat) === p && me !== null && me < seat) open(seat, vid, true); }, 2000);
      }
    };
    if (initiator) {
      await pc.setLocalDescription(await pc.createOffer());
      send({ t: 'rtc', to: seat, d: { sdp: pc.localDescription.toJSON() } });
    }
    return p;
  }

  /* The table told us who is in the group: { me: our vid or null, peers: [{ vid }] }. Keep one link to every other
     member; the lower vid calls. */
  function update(state) {
    me = state.me;
    const want = new Map();
    if (enabled && state.online && me) for (const x of state.peers) want.set(x.vid, x.vid);
    for (const [vid, p] of peers) if (!want.has(vid)) close(vid);
    for (const [vid] of want) if (!peers.has(vid) && me < vid) open(vid, vid, true);
    for (const vid of [...talking.keys()]) if (!want.has(vid) && vid !== me) talking.delete(vid);
    if (!want.size) releaseMic();
    onChange();
  }

  /* Setup messages are handled strictly in order: an ICE candidate must never overtake the offer it belongs to. */
  let chain = Promise.resolve();
  function receive(m) { chain = chain.then(() => handle(m)).catch(() => {}); }
  async function handle(m) {
    if (!enabled || !me) return;
    const seat = m.from;
    let p = peers.get(seat);
    if (m.d.sdp) {
      if (m.d.sdp.type === 'offer') { if (!p || !p.pc || p.pc.signalingState !== 'stable') p = await open(seat, seat, false); }
      if (!p || !p.pc) return;
      await p.pc.setRemoteDescription(m.d.sdp).catch(() => {});
      if (m.d.sdp.type === 'offer') { await p.pc.setLocalDescription(await p.pc.createAnswer()); send({ t: 'rtc', to: seat, d: { sdp: p.pc.localDescription.toJSON() } }); }
    } else if (m.d.ice && p && p.pc) {
      await p.pc.addIceCandidate(m.d.ice).catch(() => {});
    }
  }

  async function ensureMic() {
    if (mic) return true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('Voice needs a browser with microphone support.'); return false; }
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      toast('The microphone is blocked. Allow it for this site to talk.', 4200); return false;
    }
    const track = mic.getAudioTracks()[0]; track.enabled = false;
    for (const p of peers.values()) if (p.sender) p.sender.replaceTrack(track).catch(() => {});
    const c = audioCtx();
    if (c) { try { const src = c.createMediaStreamSource(mic); myAnalyser = c.createAnalyser(); myAnalyser.fftSize = 256; myData = new Uint8Array(256); src.connect(myAnalyser); } catch (e) { /* no level */ } }
    return true;
  }
  function releaseMic() {
    clearTimeout(micTimer);
    if (!mic || held) return;
    for (const p of peers.values()) if (p.sender) p.sender.replaceTrack(null).catch(() => {});
    mic.getTracks().forEach(t => t.stop()); mic = null; myAnalyser = null;
  }

  async function press() {
    if (held || !me || !peers.size) return;
    held = true; clearTimeout(micTimer);
    audioCtx();
    if (!(await ensureMic()) || !held) { held = false; onChange(); return; }
    mic.getAudioTracks()[0].enabled = true;
    live = true; send({ t: 'talk', on: true });
    talking.set(me, Date.now()); onChange();
  }
  function release() {
    if (!held) return;
    held = false;
    if (mic) mic.getAudioTracks()[0].enabled = false;
    if (live) { live = false; send({ t: 'talk', on: false }); }
    talking.delete(me); onChange();
    micTimer = setTimeout(releaseMic, IDLE_MIC_MS);
  }
  function heard(m) { if (m.on) talking.set(m.vid, Date.now()); else talking.delete(m.vid); onChange(); }

  /* 0..1 loudness of a seat right now (from the real audio when available). */
  function level(seat) {
    const now = Date.now();
    const since = talking.get(seat);
    if (since !== undefined && now - since > TALK_MAX_MS) talking.delete(seat);
    if (!talking.has(seat)) return 0;
    const an = seat === me ? myAnalyser : peers.get(seat)?.analyser;
    const data = seat === me ? myData : peers.get(seat)?.data;
    if (an && data) {
      an.getByteTimeDomainData(data);
      let sum = 0; for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
      return Math.min(1, Math.sqrt(sum / data.length) * 4.5);
    }
    return 0.25 + Math.random() * 0.55;   // no audio level (blocked or still connecting): animate anyway
  }
  /* Draw a small bar waveform of recent levels into a canvas. */
  function draw(seat, canvas, color) {
    if (!canvas) return;
    const h = hist.get(seat) || []; h.push(level(seat)); if (h.length > 14) h.shift(); hist.set(seat, h);
    const g = canvas.getContext('2d'), W = canvas.width, H = canvas.height, n = 14, bw = W / n;
    g.clearRect(0, 0, W, H); g.fillStyle = color || '#5ad18a';
    for (let i = 0; i < n; i++) {
      const v = h[h.length - n + i] ?? 0, bh = Math.max(H * 0.12, v * H);
      g.fillRect(i * bw + bw * 0.2, (H - bh) / 2, bw * 0.6, bh);
    }
  }

  return {
    talking, update, receive, press, release, heard, draw,
    get held() { return held; },
    get connected() { return [...peers.values()].some(p => p.pc && p.pc.connectionState === 'connected'); },
    get peerCount() { return peers.size; },
    setEnabled(on) { enabled = on; if (!on) { for (const s of [...peers.keys()]) close(s); release(); releaseMic(); } onChange(); },
    get enabled() { return enabled; },
    mute(seat, on) { if (on) muted.add(seat); else muted.delete(seat); const p = peers.get(seat); if (p && p.audio) p.audio.muted = on; },
    isMuted: seat => muted.has(seat),
    stop() { for (const s of [...peers.keys()]) close(s); held = false; releaseMic(); talking.clear(); }
  };
}
