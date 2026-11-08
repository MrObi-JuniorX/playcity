/* Check Up Whot sound: card effects synthesised with Web Audio (nothing to download) and spoken commentary
   from the browser's own voices. Settings are per device. Audio starts on the first tap, as browsers require. */

const KEY='whot-sound';
const cfg=Object.assign({fx:true,voice:true,vol:0.8},(()=>{try{return JSON.parse(localStorage.getItem(KEY)||'{}');}catch(e){return {};}})());
let ctx=null, out=null, noise=null, voice=null, last={}, ducked=false;

function save(){try{localStorage.setItem(KEY,JSON.stringify(cfg));}catch(e){/* private mode */}}
function init(){
  if(ctx){if(ctx.state==='suspended') ctx.resume(); return;}
  const AC=window.AudioContext||window.webkitAudioContext; if(!AC) return;
  ctx=new AC();
  const comp=ctx.createDynamicsCompressor(); comp.threshold.value=-12; comp.ratio.value=5; comp.attack.value=.004; comp.release.value=.2;
  out=ctx.createGain(); out.gain.value=cfg.vol; out.connect(comp); comp.connect(ctx.destination);
  noise=ctx.createBuffer(1,ctx.sampleRate*2,ctx.sampleRate);
  const d=noise.getChannelData(0); for(let i=0;i<d.length;i++) d[i]=Math.random()*2-1;
}
['pointerdown','keydown','touchstart'].forEach(e=>addEventListener(e,()=>{init(); warm();},{passive:true}));

const T=()=>ctx.currentTime;
const ok=(k,gap)=>{const n=performance.now(); if(last[k]&&n-last[k]<gap) return false; last[k]=n; return true;};
function tone(f,dur,vol,type,f2,at,attack){
  const t=at??T(), o=ctx.createOscillator(), g=ctx.createGain();
  o.type=type||'sine'; o.frequency.setValueAtTime(f,t); if(f2) o.frequency.exponentialRampToValueAtTime(f2,t+dur);
  g.gain.setValueAtTime(.0001,t); g.gain.exponentialRampToValueAtTime(vol,t+(attack||.006)); g.gain.exponentialRampToValueAtTime(.0001,t+dur);
  o.connect(g); g.connect(out); o.start(t); o.stop(t+dur+.05);
}
function hiss(dur,vol,freq,q,type,at,attack,f2){
  const t=at??T(), s=ctx.createBufferSource(), f=ctx.createBiquadFilter(), g=ctx.createGain();
  s.buffer=noise; f.type=type||'bandpass'; f.frequency.setValueAtTime(freq,t); if(f2) f.frequency.exponentialRampToValueAtTime(f2,t+dur); f.Q.value=q||1;
  g.gain.setValueAtTime(.0001,t); g.gain.exponentialRampToValueAtTime(vol,t+(attack||.004)); g.gain.exponentialRampToValueAtTime(.0001,t+dur);
  s.connect(f); f.connect(g); g.connect(out); s.start(t,Math.random()*1.5); s.stop(t+dur+.05);
}

/* ---------------- effects ---------------- */
const FX={
  /* one card leaving the deck: a papery flick */
  card(){ if(!ok('card',35)) return; const t=T(); hiss(.05,.28,2600+Math.random()*900,1.4,'bandpass',t); tone(190,.04,.08,'triangle',120,t); },
  /* a card landing on the pile */
  play(){ const t=T(); hiss(.09,.5,1500,.8,'lowpass',t); tone(130,.08,.22,'sine',70,t); },
  /* a riffle shuffle: clicks speeding up, then the bridge */
  shuffle(){
    if(!ok('shuffle',600)) return;
    let t=T();
    for(let i=0;i<30;i++){ t+=.045-i*.0009; hiss(.03,.12+Math.random()*.12,3000+Math.random()*1800,2,'bandpass',t); }
    hiss(.35,.22,900,.7,'bandpass',t+.03,.06,3000);
    tone(120,.12,.1,'sine',80,t+.32);
  },
  /* stings for the special cards */
  hold(){ const t=T(); tone(880,.22,.18,'triangle',null,t); tone(1320,.3,.16,'triangle',null,t+.11); },
  pick2(){ const t=T(); tone(523,.16,.16,'square',null,t); tone(392,.28,.16,'square',null,t+.15); },
  pick3(){ const t=T(); [587,494,392].forEach((f,i)=>tone(f,.2,.15,'square',null,t+i*.13)); },
  block(){ const t=T(); hiss(.12,.4,700,1,'bandpass',t); tone(220,.18,.25,'triangle',440,t); },
  suspend(){ const t=T(); tone(150,.32,.18,'square',null,t); tone(155,.32,.14,'sawtooth',null,t); },
  market(){ const t=T(); tone(2400,.5,.12,'sine',null,t+.02); tone(3600,.4,.08,'sine',null,t+.06); hiss(.18,.25,5000,2,'bandpass',t); tone(1200,.08,.15,'square',900,t); },
  whot(){ const t=T(); tone(420,.55,.16,'sine',1680,t,.03); [1320,1760,2093,2637].forEach((f,i)=>tone(f,.35,.06,'sine',null,t+.18+i*.07)); },
  last(){ const t=T(); tone(1000,.06,.12,'square',null,t); tone(750,.06,.12,'square',null,t+.16); },
  /* check up: a boom, a crash, fireworks crackle and a fanfare */
  bang(){
    const t=T();
    tone(120,.9,.9,'sine',32,t,.004);                         // the boom
    hiss(.25,.9,1800,.6,'lowpass',t,.002,200);                // its thump
    hiss(1.6,.35,7000,.5,'highpass',t+.02,.01);               // the crash cymbal
    for(let i=0;i<34;i++) hiss(.03,.18+Math.random()*.25,2000+Math.random()*5000,3,'bandpass',t+.35+Math.random()*1.5);   // crackle
    const fan=[[523,0],[659,.12],[784,.24],[1047,.38]];
    fan.forEach(([f,d])=>{ tone(f,.28,.11,'sawtooth',null,t+.2+d,.02); tone(f*2,.28,.04,'square',null,t+.2+d,.02); });
    [1047,1319,1568].forEach(f=>tone(f,1.3,.09,'sawtooth',null,t+.6,.04));   // the held chord
  }
};

/* ---------------- commentary ---------------- */
function pickVoice(){
  if(!('speechSynthesis' in window)) return null;
  const vs=speechSynthesis.getVoices(); if(!vs.length) return null;
  // Whot is Nigeria's card game: a Nigerian English voice where the device has one, then any English voice.
  return vs.find(v=>/en[-_]NG/i.test(v.lang))||vs.find(v=>/en[-_]GB/i.test(v.lang))||vs.find(v=>/^en/i.test(v.lang))||vs[0];
}
if('speechSynthesis' in window){ speechSynthesis.onvoiceschanged=()=>{voice=pickVoice();}; voice=pickVoice(); }
/* Get the speech engine ready before the game needs it. Some browsers load their voices and engine only on the
   first line, which can hold that line back several seconds, and iOS only lets speech start from a tap. So on the
   first tap (and again when a game starts) speak a silent, empty line: after that the first real line is instant. */
let warmed=false;
function warm(){
  if(warmed||!('speechSynthesis' in window)) return;
  warmed=true;
  try{
    voice=voice||pickVoice();
    const u=new SpeechSynthesisUtterance(' '); u.volume=0; if(voice) u.voice=voice;
    speechSynthesis.speak(u);
  }catch(e){ warmed=false; }
}
let speaking=0;
function say(text,prio){
  if(!cfg.voice||!cfg.vol||!('speechSynthesis' in window)||document.hidden) return;
  if(speechSynthesis.speaking&&(prio||1)<speaking) return;   // a big moment is not cut off by a small one
  speechSynthesis.cancel(); speechSynthesis.resume();         // Chrome can leave the queue paused
  const u=new SpeechSynthesisUtterance(text);
  voice=voice||pickVoice(); if(voice) u.voice=voice;
  u.rate=1.08; u.pitch=1.05; u.volume=Math.min(1,cfg.vol*1.1);
  speaking=prio||1; u.onend=()=>{speaking=0;};
  speechSynthesis.speak(u);
}

export const Sound={
  fx(name){ if(!cfg.fx||!cfg.vol||document.hidden) return; init(); if(!ctx||ctx.state!=='running') return; FX[name]&&FX[name](); },
  say, warm,
  settings:()=>Object.assign({},cfg),
  /* Lower the game while someone is talking on the walkie-talkie. */
  duck(on){ if(ducked===on) return; ducked=on; if(out) out.gain.setTargetAtTime(cfg.vol*(on?.3:1),T(),.08); },
  set(p){
    Object.assign(cfg,p); save();
    if(out) out.gain.setTargetAtTime(cfg.vol*(ducked?.3:1),T(),.05);
    if(!cfg.voice&&'speechSynthesis' in window) speechSynthesis.cancel();
  },
  hasVoice:()=>'speechSynthesis' in window
};
