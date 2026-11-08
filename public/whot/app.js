/* Check Up Whot: the table screen. Offline it runs the engine here (against the computer, or pass-and-play).
   Online it runs nothing: the WhotTable Durable Object owns the game, and this file draws the view it is sent,
   animates each move, and sends taps back as moves. One renderer serves both, because a view the server sends
   is shaped like a full game with other players' cards face down (engine.hydrate). */
import {SHAPES,cardText,newGame,isPlayable,play,market,aiMoveFair,rand,hydrate,vb,tourPlan} from './engine.js';
import {Sound} from './sound.js';
import {createVoice} from './voice.js';

/* ---------------------------  UI  --------------------------- */
const $=(s,r)=>(r||document).querySelector(s);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const reduce=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const TAGS={1:'HOLD',2:'PICK 2',5:'PICK 3',8:'SKIP',14:'MARKET'};
const HAND_W=64;
const DRAW_GAP=170;   // ms between cards leaving the market

let G=null, cfg=[], tally=[], starter=0;
/* Offline knock-out rounds: everyone who sat down ({name,type,w,l,out}). cfg and tally below are the people still in,
   and tally holds these same objects, so a win or loss is counted once. Online, the table keeps the same book. */
let field=[];
const outCount=()=>field.filter(f=>f.out).length;
const ui={phase:'setup',sel:[],revealed:null,hint:'',lastTop:null,seen:new Set(),timer:null,token:0,busy:false,
  inflight:new Set(),flyPlay:new Set(),mktShown:null,note:'',shuffling:false};
const setup={count:2,seats:[
  {type:'human',name:'',dirty:false},{type:'cpu',name:'',dirty:false},
  {type:'cpu',name:'',dirty:false},{type:'cpu',name:'',dirty:false}]};

/* Online session. Everything here comes from the table; nothing is kept after leaving. */
let vis=null;     // the Public/Private and Share control in the top bar (shared/share.js)
const net={on:false,ws:null,code:null,you:null,seats:[],out:[],listed:false,lister:false,tally:null,round:0,watching:0,
  queue:[],pumping:false,pre:null,dl:0,dlTurn:-1,retry:0,closing:false,create:null,sit:false,shownRound:-1,
  lobby:null,lobbyKey:'',ping:null,state:'',watchdog:null,retryT:null,downSince:0,rx:0,pingAt:0,probeAt:0,
  key:'',trusted:false,asks:[],asking:null,seenAsks:new Set(),wasAsking:false,
  move:null,quietNopeUntil:0,           // move: the last move sent that the table has not answered yet (see sendMove)
  cup:null,cupMeta:null,cupEnd:0};     // cup: a Whot Cup table ({slug,code,token,back}); cupMeta: the table's cup state
const baseTitle=document.title;

function sym(sh,cls){return '<svg class="sym '+(cls||'')+'" viewBox="0 0 24 24" aria-hidden="true"><use href="#s-'+sh+'"/></svg>';}
function cardLabel(c){return c.n===20?'Whot':c.n+' of '+c.shape+'s';}
function cardHTML(c,o){
  o=o||{};
  const tagName=o.as||'div';
  const cls='card '+(c.n===20?'s-whot':'s-'+c.shape)+(o.cls?' '+o.cls:'');
  const corner=pos=>'<span class="corner '+pos+'"><b>'+c.n+'</b>'+(c.n===20?'':sym(c.shape))+'</span>';
  const sp=!!TAGS[c.n];
  const mid=c.n===20
    ?'<span class="mid joker"><i>WHOT</i><span class="row">'+SHAPES.map(x=>sym(x,'c-'+x)).join('')+'</span></span>'
    :'<span class="mid'+(sp?' sp':'')+'">'+sym(c.shape,'pip')+(sp?'<span class="tag">'+TAGS[c.n]+'</span>':'')+'</span>';
  return '<'+tagName+' class="'+cls+'"'+(o.attrs?' '+o.attrs:'')+(o.style?' style="'+o.style+'"':'')+(tagName==='button'?' type="button"':'')+'>'+corner('tl')+mid+corner('br')+'</'+tagName+'>';
}
function backHTML(o){o=o||{}; return '<div class="card back'+(o.cls?' '+o.cls:'')+'"'+(o.style?' style="'+o.style+'"':'')+' aria-hidden="true"></div>';}
let toastT=null;
/* The walkie-talkie. Only seated people at an online table are ever connected (the table enforces it). */
const voice=createVoice({send:o=>netSend(o),toast:(m,ms)=>toast(m,ms),onChange:()=>{if(G&&!$('#game').hidden) renderSeats(); paintPtt(); paintTalkNote(); kickWaves();}});
/* The walkie-talkie group as the table last told us: me (our voice id, or null when we are not in it), peers,
   whether the owner has opened it to everyone, and whether we are the owner. */
let voiceState={online:false,me:null,peers:[],all:false,owner:false};
const seatVid=i=>i===net.you?voiceState.me:(voiceState.peers.find(x=>x.seat===i)||{}).vid;
const vidSeat=v=>v===voiceState.me?net.you:(voiceState.peers.find(x=>x.vid===v)||{}).seat;
try{if(localStorage.getItem('whot-voice')==='off') voice.setEnabled(false);}catch(e){/* ignore */}
function paintPtt(){
  const b=$('#pttBtn'); if(!b) return;
  const others=net.on&&!!voiceState.me&&voiceState.peers.length>0;
  const show=others&&voice.enabled;
  b.hidden=!show; const ac=$('.actions'), watcher=net.on&&net.you===null;
  ac.classList.toggle('voice',show); ac.classList.toggle('watch',watcher&&show); if(watcher) ac.hidden=!show;   // a watcher on the walkie-talkie gets just that button
  b.classList.toggle('on',voice.held);
  b.setAttribute('aria-pressed',String(voice.held));
  b.title=voice.peerCount?'Walkie-talkie: hold to talk to the other players':'Walkie-talkie: connecting…';
}
let waveRaf=0, waveTick=0;
function waveLoop(){
  waveRaf=0;
  const pw=$('#pttWave');
  if(!voice.talking.size){ if(pw) pw.getContext('2d').clearRect(0,0,pw.width,pw.height); Sound.duck(false); return; }
  if(++waveTick%3===0){
    for(const vid of voice.talking.keys()) voice.draw(vid,document.querySelector('#seats .seat[data-seat="'+vidSeat(vid)+'"] canvas.wave'),'#5ad18a');
    if(voice.held&&pw) voice.draw(voiceState.me,pw,'rgba(255,255,255,.35)');
  }
  Sound.duck([...voice.talking.keys()].some(v=>v!==voiceState.me));
  waveRaf=requestAnimationFrame(waveLoop);
}
/* Someone on the walkie-talkie who has no seat (a watcher) has no seat chip to light up: name them here. */
function paintTalkNote(){
  const el=$('#talkNote'); if(!el) return;
  const names=[...voice.talking.keys()].filter(v=>v!==voiceState.me&&vidSeat(v)===null).map(v=>{const x=voiceState.peers.find(p=>p.vid===v); return x?x.name:'Someone';});
  el.textContent=names.length?names.join(', ')+(names.length>1?' are':' is')+' talking':''; el.hidden=!names.length;
}
function kickWaves(){if(!waveRaf) waveRaf=requestAnimationFrame(waveLoop);}
function toast(msg,ms){const t=$('#toast'); t.textContent=msg; t.classList.remove('off'); clearTimeout(toastT); toastT=setTimeout(()=>t.classList.add('off'),ms||2600);}

/* --- setup screen --- */
function defaultName(i,type){
  if(type==='human') return i===0?'You':'Player '+(i+1);
  let k=0; for(let j=0;j<=i;j++) if(setup.seats[j].type==='cpu') k++;
  return k===1?'Computer':'Computer '+k;
}
function syncNames(){setup.seats.forEach((s,i)=>{if(!s.dirty) s.name=defaultName(i,s.type);});}
function renderSetup(){
  syncNames();
  $('#countSeg').innerHTML=[2,3,4].map(n=>'<button type="button" role="radio" aria-checked="'+(n===setup.count)+'" data-n="'+n+'">'+n+'</button>').join('');
  $('#seatList').innerHTML=setup.seats.slice(0,setup.count).map((s,i)=>
    '<div class="seat-row"><span class="seat-no">'+(i+1)+'</span>'+
    '<input type="text" id="name-'+i+'" maxlength="14" value="'+esc(s.name)+'" aria-label="Seat '+(i+1)+' name" autocomplete="off">'+
    '<div class="seg small" role="radiogroup" aria-label="Seat '+(i+1)+' type">'+
    '<button type="button" role="radio" aria-checked="'+(s.type==='human')+'" data-i="'+i+'" data-type="human">Human</button>'+
    '<button type="button" role="radio" aria-checked="'+(s.type==='cpu')+'" data-i="'+i+'" data-type="cpu">Computer</button></div></div>').join('');
  const humans=setup.seats.slice(0,setup.count).filter(s=>s.type==='human').length;
  $('#setupNote').textContent=humans===0?'Add at least one human player.':(humans>1?'Pass the phone between turns. Hands stay hidden until each player taps to reveal. Online, the other human seats start as open seats.':'');
  $('#setupNote').style.color=humans===0?'var(--danger)':'var(--muted)';
  $('#startBtn').disabled=humans===0;
}
function renderHeroFan(){
  const cs=[{id:1,shape:'circle',n:8},{id:2,shape:'whot',n:20},{id:3,shape:'triangle',n:2}];
  const rot=[-16,0,16];
  $('#heroFan').innerHTML=cs.map((c,i)=>cardHTML(c,{style:'transform:rotate('+rot[i]+'deg) translateY('+(i===1?-6:0)+'px)'})).join('');
}

/* --- sheets --- */
function openSheet(html,onClose){
  ui.sheet=''; $('#sheetBody').innerHTML=html; $('#sheet').hidden=false;
  ui.sheetClose=onClose||null; $('#sheetClose').focus();
}
function closeSheet(){
  $('#sheet').hidden=true; $('#sheetBody').innerHTML=''; ui.sheet='';
  const f=ui.sheetClose, byUser=ui.userClose; ui.sheetClose=null; ui.userClose=false; if(f) f(byUser);      // byUser: closed by the person (×, Escape, a button), not by the game moving on
}
function rulesHTML(){
  return '<h2>How to play</h2>'+
  '<p class="rules-p">Match the top card by <b>shape</b> or <b>number</b>. Can’t or won’t? Go to the <b>market</b>: pick 1 and your turn ends. Everyone starts with 5 cards.</p>'+
  '<ul class="rules-list">'+
  '<li><span class="rule-badge">1</span><div><b>Hold on</b><br><span>Everyone else is held. You play again.</span></div></li>'+
  '<li><span class="rule-badge">2</span><div><b>Pick two</b><br><span>Next player picks 2, or plays 2s to pass it on. Penalties add up: 4, 6, 8…</span></div></li>'+
  '<li><span class="rule-badge">5</span><div><b>Pick three</b><br><span>Next player picks 3, or blocks it with 5s. Penalties add up too: 6, 9…</span></div></li>'+
  '<li><span class="rule-badge">8</span><div><b>Suspension</b><br><span>The next player misses their turn.</span></div></li>'+
  '<li><span class="rule-badge">14</span><div><b>General market</b><br><span>Every other player picks 1 card, then you play again.</span></div></li>'+
  '<li><span class="rule-badge">20</span><div><b>Whot</b><br><span>Play it any time (not on a penalty). Ask for any shape.</span></div></li>'+
  '</ul>'+
  '<p class="rules-p"><b>Play several at once.</b> Tap cards that share a number, in the order you want to play them. The first one must fit the top card, the rest can be any shape, and the last one sets the shape in play. Specials add up: three 2s make pick 6, three 5s make pick 9, two 8s suspend two players, two 14s make everyone else pick 2 (then you play again).</p>'+
  '<p class="rules-p"><b>Blocking pick three.</b> Each 5 you play blocks 3 cards of the penalty. If three 5s were sent and you block with one, you pick the other six. Block with as many 5s as were sent and nobody picks.</p>'+
  '<p class="rules-p"><b>Check up</b> by playing your last card. If it is a 2 or a 5, the next player gets one chance to defend. Only passing a pick 2 on with another 2 is a defence: you pick 1 and the game goes on. Blocking a pick 3 with a 5 does not bring you back in, and neither does picking up the penalty: either way, you win.</p>'+
  '<p class="rules-p"><b>Loser:</b> whoever holds the highest points when someone checks up (add up the numbers on your cards; Whot counts 20). A tie is broken by the most cards.</p>'+
  '<p class="rules-p"><b>Market refill:</b> if the market can’t cover a pick, or it runs low, or the played pile gets big, the played cards are shuffled and added to the market.</p>'+
  '<p class="rules-p"><b>Online:</b> computer seats are open seats. Anyone at the table can take one and carry on with its cards. Leave, or drop your connection, and the computer plays your cards until you come back. Each turn has a 45 second clock.</p>';
}
function showRules(){openSheet(rulesHTML());}
function showSound(){
  const c=Sound.settings();
  openSheet('<h2>Sound</h2>'+
    '<label class="check"><input type="checkbox" id="sndFx"'+(c.fx?' checked':'')+'> Card sounds and the check up bang</label>'+
    '<label class="check"><input type="checkbox" id="sndVoice"'+(c.voice?' checked':'')+(Sound.hasVoice()?'':' disabled')+'> Commentary on special cards'+(Sound.hasVoice()?'':' (not available in this browser)')+'</label>'+
    '<label class="vol">Volume <input type="range" id="sndVol" min="0" max="1" step="0.05" value="'+c.vol+'"></label>'+
    (net.on&&(voiceState.me||voiceState.all||voiceState.owner)?'<label class="check"><input type="checkbox" id="vcOn"'+(voice.enabled?' checked':'')+'> Walkie-talkie: hear and talk to the others at the table</label>'+
      voiceState.peers.map(x=>'<label class="check" style="padding-left:30px"><input type="checkbox" data-vmute="'+esc(x.vid)+'"'+(voice.isMuted(x.vid)?' checked':'')+'> Mute '+esc(x.name)+(x.seat===null?' (watching)':'')+'</label>').join('')+
      (voiceState.owner?'<label class="check"><input type="checkbox" id="vcAll"'+(voiceState.all?' checked':'')+'> Open the walkie-talkie to everyone, including people watching</label>':
        voiceState.all?'<p class="rules-p">The table owner has opened the walkie-talkie to everyone, watchers too.</p>':''):'')+
    '<p class="rules-p">Saved on this device. Everyone at an online table sets their own.</p>'+
    '<div class="sheet-actions"><button class="btn" type="button" id="sndTest">Test</button><button class="btn primary" type="button" id="stayBtn">Done</button></div>');
}
function paintSoundBtn(){
  const c=Sound.settings(), off=!c.vol||(!c.fx&&!c.voice), b=$('#soundBtn'); if(!b) return;
  b.innerHTML='<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/>'+(off?'<path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>':'<path d="M16 8.5a5 5 0 010 7M18.5 6a8.5 8.5 0 010 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>')+'</svg>';
  b.setAttribute('aria-label',off?'Sound off. Open sound settings':'Sound settings');
}
function showLog(){
  const items=G?G.log.slice().reverse().slice(0,40):[];
  openSheet('<h2>Move log</h2><ul class="log-list">'+(items.length?items.map(l=>'<li class="'+l.kind+'">'+esc(l.msg)+'</li>').join(''):'<li>Nothing yet.</li>')+'</ul>');
}
function showLeave(){
  if(net.cup){
    const seated=net.you!==null&&G&&!G.over;
    openSheet('<h2>Leave the table?</h2><p class="rules-p">'+(seated?'This is a cup table: the computer plays your cards while you are away, and if you are not back soon you forfeit it and finish last.':'You can come back to the cup page any time.')+'</p>'+
      '<div class="sheet-actions"><button class="btn" type="button" id="stayBtn">'+(seated?'Keep playing':'Stay')+'</button><button class="btn danger" type="button" id="leaveYes">Leave</button></div>');
    return;
  }
  if(net.on){
    const seated=net.you!==null;
    openSheet('<h2>Leave the table?</h2><p class="rules-p">'+(seated?'The computer takes over your cards. You can come back to your seat with the same link while the computer still has it.':'You are watching this table.')+'</p>'+
      '<div class="sheet-actions">'+(seated?'<button class="btn" type="button" id="standBtn">Watch instead</button>':'<button class="btn" type="button" id="stayBtn">Keep watching</button>')+
      '<button class="btn danger" type="button" id="leaveYes">Leave</button></div>');
    return;
  }
  openSheet('<h2>Leave this game?</h2><p class="rules-p">The current round will be lost. Your win and loss tally also resets.</p>'+
    '<div class="sheet-actions"><button class="btn" type="button" id="stayBtn">Keep playing</button><button class="btn danger" type="button" id="leaveYes">Leave</button></div>');
}

/* --- animation helpers --- */
function rectOf(el){
  const r=el.getBoundingClientRect();
  return {x:r.left,y:r.top,w:r.width,h:r.height,cx:r.left+r.width/2,cy:r.top+r.height/2};
}
function clearFlyers(){document.querySelectorAll('.flyer').forEach(e=>e.remove());}
function fly(from,to,html,o){
  o=o||{};
  const dur=o.dur||460;
  const el=document.createElement('div');
  el.className='flyer';
  el.style.cssText='left:'+from.x+'px;top:'+from.y+'px;width:'+from.w+'px;height:'+from.h+'px';
  el.innerHTML=html; document.body.appendChild(el);
  if(!el.animate){el.remove(); return Promise.resolve();}
  const sc=to.w/from.w;
  const a=el.animate([
    {transform:'translate(0px,0px) scale(1) rotate(0deg)'},
    {transform:'translate('+(to.cx-from.cx)+'px,'+(to.cy-from.cy)+'px) scale('+sc+') rotate('+(o.rot||0)+'deg)'}
  ],{duration:dur,easing:'cubic-bezier(.25,.8,.3,1)',fill:'forwards'});
  return Promise.race([a.finished,wait(dur+400)]).then(()=>el.remove(),()=>el.remove());
}
function marketRect(){
  const el=$('.stack .card:last-child');
  return el?rectOf(el):{x:20,y:200,w:84,h:126,cx:62,cy:263};
}
function discRect(){
  const el=$('.disc');
  return el?rectOf(el):{x:140,y:190,w:104,h:156,cx:192,cy:268};
}
/* where a player's cards sit on screen: their seat chip, or the hand area for the viewer */
function anchorRect(i,w){
  const v=viewer();
  const h=w*1.5;
  if(i===v){
    const r=rectOf($('#hand'));
    return {x:r.cx-w/2,y:r.cy-h/2,w,h,cx:r.cx,cy:r.cy};
  }
  const seat=document.querySelector('.seat[data-seat="'+i+'"]');
  if(seat){const r=rectOf(seat); return {x:r.cx-w/2,y:r.cy-h/2,w,h,cx:r.cx,cy:r.cy};}
  const r=rectOf($('#hand'));
  return {x:r.cx-w/2,y:r.cy-h/2,w,h,cx:r.cx,cy:r.cy};
}
function drawTarget(i,id){
  if(i===viewer()){
    const el=document.querySelector('#hand .card[data-id="'+id+'"]');
    if(el) return rectOf(el);
    return anchorRect(i,HAND_W);
  }
  return anchorRect(i,24);
}
function updateCounts(){
  renderSeats();
  const v=viewer();
  if(v!==null&&handVisible(v)) renderHandLabel(v);
}
function launchDraw(ev,tok){
  const from=marketRect(), to=drawTarget(ev.player,ev.id);
  Sound.fx('card');
  if(ui.mktShown!==null){
    ui.mktShown=Math.max(0,ui.mktShown-1);
    const m=$('#mktCount'); if(m) m.textContent=ui.mktShown;
  }
  return fly(from,to,backHTML({style:'--w:'+from.w+'px'}),{rot:rand(21)-10}).then(()=>{
    if(tok!==ui.token) return;
    ui.inflight.delete(ev.id); ui.seen.add(ev.id);
    const el=document.querySelector('#hand .card[data-id="'+ev.id+'"]');
    if(el){el.classList.remove('incoming'); el.classList.add('fresh');}
    updateCounts();
  });
}
async function doPlayFlight(ev,pre,tok){
  const to=discRect(), ps=[];
  ev.cards.forEach((c,k)=>{
    const from=pre.src[c.id]||anchorRect(ev.player,30);
    ps.push(wait(k*160).then(()=>{
      if(tok!==ui.token) return;
      return fly(from,to,cardHTML(c,{style:'--w:'+from.w+'px'}),{rot:k?7:-4,dur:430}).then(()=>Sound.fx('play'));
    }));
  });
  await Promise.all(ps);
  if(tok!==ui.token) return;
  ev.cards.forEach(c=>ui.flyPlay.delete(c.id));
  renderTable();
  commentate(ev);
}
/* A sting and a line from the commentator when a special card lands, or someone is down to their last card.
   G is already the state after this play, so pick amounts and the asked-for shape are known. */
const oneOf=a=>a[rand(a.length)];
function commentate(ev){
  if(!G||G.over) return;                       // check up has its own moment
  const c=ev.cards[ev.cards.length-1], k=ev.cards.length, p=G.players[ev.player], nm=p.name;
  let fx=null, line=null, prio=1;
  switch(c.n){
    case 20: fx='whot'; line=oneOf(['Whot! '+nm+' '+vb(nm,'wants','want')+' '+G.shape+'s.','Whot! '+G.shape+' is the shape now.','Whot card! '+G.shape+'s, please.']); break;
    case 14: fx='market'; line=k>1?'Double general market! Everyone picks '+k+'.':oneOf(['General market! Everybody, go to market.','General market! Everyone picks one.']); break;
    case 2: {
      fx='pick2'; const a=G.pending&&G.pending.n===2?G.pending.amount:2*k;
      line=a>2*k?oneOf(['Passed on! Pick '+a+'!','It is stacking up. Pick '+a+'!']):k>1?'Pick '+a+'!':oneOf(['Pick two!',nm+' '+vb(nm,'says','say')+' pick two!']);
      break;
    }
    case 5:
      if(G.pending&&G.pending.n===5){fx='pick3'; const a=G.pending.amount; line=a>3?'Pick '+a+'!':oneOf(['Pick three!','Ouch. Pick three!']);}
      else{fx='block'; line=oneOf(['Blocked!','Blocked it!','No way. Blocked!']);}
      break;
    case 8: fx='suspend'; line=k>1?'Double suspension!':oneOf(['Suspension!','Suspended! Sit this one out.','Suspension! Wait your turn.']); break;
    case 1: fx='hold'; line=oneOf(['Hold on!','Hold on! '+nm+' '+vb(nm,'goes','go')+' again.']); break;
  }
  const left=p.hand.length;
  if(left===0&&G.checkup){fx=fx||'last'; line=nm+' '+vb(nm,'is','are')+' out of cards! '+G.players[G.current].name+', defend or lose!'; prio=2;}
  else if(left===1&&!line){fx='last'; line=oneOf(['Last card for '+nm+'!',nm+' '+vb(nm,'is','are')+' down to one card!']);}
  if(fx) Sound.fx(fx);
  if(line) Sound.say(line,prio);
}

/* Nudges: when a person takes a while over their turn, the commentator sometimes hurries them along.
   Never the computer, never someone who is reconnecting, at most a few times a turn, and never over another line. */
const nudge={key:null,next:0,n:0,clock:false};
function nudgeLine(nm,pass){
  if(pass) return oneOf([nm+', your turn. Take the phone.','Pass it over to '+nm+'.']);
  if(nm==='You') return oneOf(['Your turn!','Oya, your turn. Play something!','We are waiting on you.','Take your time. But not all day!']);
  return oneOf([nm+', it is your turn.','Oya '+nm+', play something!','We are waiting on '+nm+'.',nm+' '+vb(nm,'is','are')+' thinking hard about this one.','Come on '+nm+', the table is waiting!']);
}
function nudgeTick(){
  if(!G||G.over||ui.phase!=='play'||ui.busy||document.hidden){nudge.key=null; return;}
  const p=G.players[G.current];
  if(p.type!=='human'||heldSeat(G.current)||(net.on&&net.grace&&net.grace.seat===G.current)){nudge.key=null; return;}
  const key=G.turns+':'+G.current, now=Date.now();
  if(key!==nudge.key){Object.assign(nudge,{key,n:0,clock:false,next:now+12000+rand(8000)}); return;}
  const left=clockLeft();
  if(left!==null&&left<=10&&left>=5&&!nudge.clock){      // online turn clock running low
    nudge.clock=true; Sound.say(p.name==='You'?'Hurry, the clock is running out!':oneOf([p.name+', the clock is ticking!','Hurry up, '+p.name+'!']),0.5); return;
  }
  if(now<nudge.next||nudge.n>=3) return;
  nudge.n++; nudge.next=now+18000+rand(12000);
  if(Math.random()<.3) return;                           // only sometimes
  Sound.say(nudgeLine(p.name,needsPass()),0.5);
}

/* Check up: a full-screen moment with a bang before the results. Tap to skip. */
function celebrate(){
  return new Promise(done=>{
    if(!G||!G.over){done(); return;}
    const nm=G.players[G.winner].name, stale=G.stalemate;
    if(!stale){
      Sound.fx('bang');
      Sound.say(nm==='You'?oneOf(['Check up! You win it!','Check up! Brilliant, you did it!']):oneOf(['Check up! '+nm+' wins it!','Check up! That is the game for '+nm+'!']),3);
    }else Sound.say('Nobody can move. '+nm+' '+vb(nm,'wins','win')+' on fewest cards.',3);
    if(document.hidden){done(); return;}
    const el=document.createElement('div');
    el.className='bang'; el.setAttribute('role','status');
    el.innerHTML='<div class="bang-rays"></div><div class="bang-flash"></div><div class="bang-text"><b>'+(stale?'Game over':'Check up!')+'</b><span>'+esc(nm)+' '+(stale?vb(nm,'wins','win')+' on fewest cards':'checked up!')+'</span></div>';
    document.body.appendChild(el);
    if(!reduce&&el.animate){
      const app=$('#app');
      app.animate([{transform:'none'},{transform:'translate(-11px,7px)'},{transform:'translate(10px,-8px)'},{transform:'translate(-7px,5px)'},{transform:'translate(5px,-3px)'},{transform:'none'}],{duration:520,easing:'ease-out'});
      const burst=(n,delay)=>{
        const R=Math.min(innerWidth,innerHeight);
        for(let i=0;i<n;i++){
          const b=document.createElement('span'); b.className='bit';
          const sh=SHAPES[i%SHAPES.length];
          b.innerHTML=i%9===0?backHTML({style:'--w:20px'}):sym(sh,'c-'+sh);
          el.appendChild(b);
          const a=Math.random()*Math.PI*2, d=R*(.28+Math.random()*.45), x=Math.cos(a)*d, y=Math.sin(a)*d*.8, r=(Math.random()-.5)*900;
          b.animate([
            {transform:'translate(0,0) scale(.2) rotate(0deg)',opacity:1},
            {transform:'translate('+x+'px,'+y+'px) scale(1) rotate('+r/2+'deg)',opacity:1,offset:.45},
            {transform:'translate('+x*1.12+'px,'+(y+R*.45)+'px) scale(.85) rotate('+r+'deg)',opacity:0}
          ],{duration:1700+rand(900),delay:delay+rand(120),easing:'cubic-bezier(.15,.7,.3,1)',fill:'both'});
        }
      };
      burst(54,0); burst(36,450);
    }
    let finished=false;
    const end=()=>{if(finished) return; finished=true; el.classList.add('out'); setTimeout(()=>el.remove(),320); done();};
    const t=setTimeout(end,reduce?1200:2700);
    el.addEventListener('pointerdown',()=>{clearTimeout(t); end();});
  });
}
async function doReshuffle(ev,tok){
  ui.note='Market is low. Shuffling the played cards back in…';
  renderStatus(); Sound.fx('shuffle');
  const from=discRect(), to=marketRect(), ps=[];
  const k=Math.min(7,Math.max(3,ev.moved));
  for(let i=0;i<k;i++){
    ps.push(wait(i*110).then(()=>{
      if(tok!==ui.token) return;
      return fly(from,to,backHTML({style:'--w:'+from.w+'px'}),{rot:(i%2?1:-1)*(8+i*4),dur:520});
    }));
  }
  await Promise.all(ps);
  if(tok!==ui.token) return;
  if(ui.mktShown!==null) ui.mktShown+=ev.moved;
  ui.shuffling=true; renderTable();
  await wait(1100);
  if(tok!==ui.token) return;
  ui.shuffling=false; ui.note=''; renderTable(); renderStatus();
}
async function runEvents(events,pre,tok){
  let batch=[];
  const flush=async()=>{if(batch.length){const b=batch; batch=[]; await Promise.all(b);}};
  for(const ev of events){
    if(tok!==ui.token) return;
    if(ev.type==='draw'){batch.push(launchDraw(ev,tok)); await wait(DRAW_GAP);}
    else if(ev.type==='play'){await flush(); await doPlayFlight(ev,pre,tok);}
    else if(ev.type==='reshuffle'){await flush(); await doReshuffle(ev,tok);}
  }
  await flush();
}

/* --- game flow --- */
function showGame(){$('#setup').hidden=true; $('#game').hidden=false;}
/* how: 'new' from the setup screen; 'next' the round after one (people knocked out stay out); 'all' everyone back in */
function startGame(how){
  ui.token++; const tok=ui.token;
  clearFlyers(); clearTimeout(ui.timer);
  if(how==='new'){
    const seen={};
    field=setup.seats.slice(0,setup.count).map(s=>{
      let nm=(s.name||'').trim()||'Player';
      seen[nm]=(seen[nm]||0)+1;
      if(seen[nm]>1) nm=nm+' '+seen[nm];
      return {name:nm,type:s.type,w:0,l:0,out:false};
    });
    starter=rand(field.length);
  }else{
    const was=field.filter(f=>!f.out), plan=tourPlan(G,outCount()), prev=starter;
    if(how==='all'||plan.mode==='final') field.forEach(f=>{f.out=false;});
    else plan.elim.forEach(i=>{was[i].out=true;});
    const now=field.filter(f=>!f.out);
    // first to play: the next player after the last first player who is still in
    starter=0;
    for(let k=1;k<=was.length;k++){const j=now.indexOf(was[(prev+k)%was.length]); if(j>=0){starter=j; break;}}
  }
  const now=field.filter(f=>!f.out);
  cfg=now.map(f=>({name:f.name,type:f.type}));
  tally=now;
  G=newGame(cfg,starter);
  beginDeal(tok);
  if(how==='new'&&canOpenOnline()) goOnlineAuto(true);      // Public by default: everyone can see a game is on
}
/* Shuffle on screen, then deal. Shared by offline games and online rounds (the table deals, we animate). */
function beginDeal(tok,fast){
  Object.assign(ui,{phase:'shuffle',sel:[],revealed:null,hint:'',lastTop:null,seen:new Set(),
    inflight:new Set(),flyPlay:new Set([G.discard[G.discard.length-1].id]),mktShown:54,busy:true,note:'',shuffling:false});
  showGame();
  if(!$('#sheet').hidden) closeSheet();
  render();
  if(!fast){Sound.fx('shuffle'); setTimeout(()=>Sound.fx('shuffle'),700);}
  return wait(fast?0:reduce?250:1300).then(()=>{
    if(tok!==ui.token) return;
    if(reduce||fast){
      Object.assign(ui,{phase:'play',busy:false,flyPlay:new Set(),mktShown:null}); render(); schedule(300);
    }else return dealAnimation(tok);
  });
}
async function dealAnimation(tok){
  const n=G.players.length, first=G.discard[G.discard.length-1];
  ui.inflight=new Set(); G.players.forEach(p=>p.hand.forEach(c=>ui.inflight.add(c.id)));
  ui.phase='play'; ui.note='Dealing…'; render();
  const ps=[];
  for(let r=0;r<5;r++){
    for(let i=0;i<n;i++){
      if(tok!==ui.token) return;
      const pi=(G.starter+i)%n, c=G.players[pi].hand[r];
      if(c) ps.push(launchDraw({player:pi,id:c.id},tok));
      await wait(90);
    }
  }
  await Promise.all(ps);
  if(tok!==ui.token) return;
  await wait(120);
  ui.note='';
  renderStatus();
  const from=marketRect(), to=discRect();
  if(ui.mktShown!==null){ui.mktShown=Math.max(0,ui.mktShown-1); const m=$('#mktCount'); if(m) m.textContent=ui.mktShown;}
  await fly(from,to,cardHTML(first,{style:'--w:'+from.w+'px'}),{dur:520,rot:-3});
  if(tok!==ui.token) return;
  Object.assign(ui,{flyPlay:new Set(),inflight:new Set(),mktShown:null,busy:false});
  render(); schedule(500);
}
function schedule(extra){
  clearTimeout(ui.timer);
  if(net.on||!G||G.over||ui.phase!=='play'||ui.busy) return;
  if(G.players[G.current].type==='cpu'){
    ui.timer=setTimeout(cpuAct,extra||(reduce?350:800+rand(500)));
  }
}
function cpuAct(){
  if(net.on||!G||G.over||ui.phase!=='play'||ui.busy) return;
  if(G.players[G.current].type!=='cpu') return;
  const mv=aiMoveFair(G);   // the computer sees only what its seat may see
  perform(()=>{if(mv.type==='play') play(G,mv.cardId,mv.shape); else market(G);});
}
/* Offline: run one engine action, then replay what happened (cards drawn, played, reshuffled) as animation. */
async function perform(fn){
  if(!G||ui.busy) return;
  const tok=ui.token, prev=G.current;
  const pre={src:{},mkt:G.market.length};
  ui.sel.forEach(id=>{
    const el=document.querySelector('#hand .card[data-id="'+id+'"]');
    if(el) pre.src[id]=rectOf(el);
  });
  G.events=[]; fn();
  const events=G.events; G.events=[];
  await animate(events,pre,tok,false);
  if(tok!==ui.token) return;
  if(G.current!==prev) ui.revealed=null;
  render();
  if(G.over){clearTimeout(ui.timer); celebrate().then(()=>{if(tok===ui.token) showResult();}); return;}
  schedule();
}
async function animate(events,pre,tok,fast){
  ui.sel=[]; ui.hint='';
  if(!reduce&&!fast&&events.length){
    ui.inflight=new Set(events.filter(e=>e.type==='draw').map(e=>e.id));
    ui.flyPlay=new Set();
    events.filter(e=>e.type==='play').forEach(e=>e.cards.forEach(c=>ui.flyPlay.add(c.id)));
    ui.mktShown=pre.mkt; ui.busy=true;
    render();
    await runEvents(events,pre,tok);
    if(tok!==ui.token) return;
  }
  Object.assign(ui,{inflight:new Set(),flyPlay:new Set(),mktShown:null,busy:false,note:'',shuffling:false});
}
/* A move from this screen: played here offline, sent to the table online. */
function act(a){
  if(!net.on){perform(()=>a.t==='play'?play(G,a.ids,a.shape):market(G)); return;}
  if(ui.busy||!net.ws) return;
  const pre={src:{}};
  ui.sel.forEach(id=>{const el=document.querySelector('#hand .card[data-id="'+id+'"]'); if(el) pre.src[id]=rectOf(el);});
  net.move={msg:Object.assign({},a,{turn:G.turns}),pre,tries:0,at:Date.now()};
  if(net.ws.readyState!==1){          // not connected right now: keep the move and send it as soon as the table is back
    toast('Reconnecting… your move will be sent when you are back.'); probe(true); return;
  }
  net.pre=pre; ui.busy=true; render();
  sendMove();
}
/* Sending a move on a poor network.
   The table answers every move (the new state, or a refusal). If nothing comes back, the move is sent again instead of
   leaving the card stuck until the player taps it again: a few times while the socket still looks open, and once more
   right after a reconnect if the table says it is still our turn (resumeMove).
   Sending a move twice is safe: every move names the turn it was made on, and the table refuses a turn it has already
   played ("stale" or "not-your-turn"). onNope stays quiet about those refusals for a moment after a resend. */
const MOVE_RETRY_MS=2000, MOVE_TRIES=3, MOVE_KEEP_MS=20000;   // 3 sends over 6 s, as long as the screen used to stay locked
function sendMove(isResend){
  const mv=net.move; if(!mv) return;
  mv.tries++;
  if(isResend||mv.tries>1) net.quietNopeUntil=Date.now()+4000;
  netSend(mv.msg);
  clearTimeout(net.watchdog);
  net.watchdog=setTimeout(moveSilent,MOVE_RETRY_MS);
}
function moveSilent(){
  const mv=net.move; if(!mv) return;
  if(mv.tries>=MOVE_TRIES){           // still nothing: free the screen, but keep the move for a reconnect (resumeMove)
    net.pre=null; ui.busy=false; if(G) render(); return;
  }
  probe(false);                       // a dead socket is found within seconds and replaced, instead of waiting for the next ping
  sendMove();
}
/* Back on the table with a fresh state: send the held move again if it never arrived and it is still our turn. */
function resumeMove(){
  const mv=net.move; if(!mv) return;
  const stillOurTurn=!G.over&&net.you!==null&&G.current===net.you&&G.turns===mv.msg.turn;
  if(!stillOurTurn){net.move=null; return;}     // the table moved on: the move did arrive, or the computer covered the turn
  if(Date.now()-mv.at>MOVE_KEEP_MS){net.move=null; toast('That move was not sent. Tap again.'); return;}
  if(!net.ws||net.ws.readyState!==1) return;
  if(net.pre) return;                           // still waiting on a live connection (an unrelated update arrived): the timer above handles it
  mv.tries=0; net.pre=mv.pre; ui.busy=true; render();
  sendMove(true);
}
function humansIdx(){return G.players.map((p,i)=>p.type==='human'?i:-1).filter(i=>i>=0);}
function viewer(){
  if(net.on) return net.you;
  const cur=G.players[G.current];
  if(cur.type==='human') return G.current;
  const h=humansIdx();
  return h.length===1?h[0]:null;
}
function needsPass(){
  return !net.on&&ui.phase==='play'&&!ui.busy&&!G.over&&humansIdx().length>1&&G.players[G.current].type==='human'&&ui.revealed!==G.current;
}
function handVisible(v){
  if(v===null||ui.phase==='shuffle') return false;
  return net.on||humansIdx().length===1||ui.revealed===v;
}
function myTurn(v){
  return ui.phase==='play'&&!ui.busy&&!G.over&&v!==null&&v===G.current&&(net.on||G.players[G.current].type==='human')&&handVisible(v);
}
function sortedHand(h){
  const order={circle:0,triangle:1,cross:2,square:3,star:4,whot:5};
  return h.slice().sort((a,b)=>order[a.shape]-order[b.shape]||a.n-b.n);
}
function selCards(v){
  if(v===null) return [];
  return ui.sel.map(id=>G.players[v].hand.find(c=>c.id===id)).filter(Boolean);
}
function maxBlock(){return G.pending&&G.pending.n===5?G.pending.amount/3:99;}
function selValid(cards){
  if(!cards.length) return false;
  if(cards.some(c=>c.n!==cards[0].n)) return false;
  if(!isPlayable(G,cards[0])) return false;
  return cards.length<=maxBlock();
}
/* Seconds left on the turn clock, online, or null. */
function clockLeft(){
  if(!net.on||!G||G.over||!net.dl||net.dlTurn!==G.turns) return null;
  return Math.max(0,Math.ceil((net.dl-Date.now())/1000));
}
const nobodySeated=()=>net.on&&!net.seats.some(s=>s.human);

/* --- rendering --- */
function render(){
  if(!G) return;
  renderSeats(); renderTable(); renderStatus(); renderHand(); renderActions(); renderPass(); renderTop();
}
/* Invite-link holders sit down at once; so does anyone when nobody is seated (there is no one to ask). */
const canSitNow=()=>net.trusted||nobodySeated();
let titleFlash=null;
function noticeAsks(){
  let fresh=null;
  for(const a of net.asks) if(!net.seenAsks.has(a.rid)){net.seenAsks.add(a.rid); fresh=a;}
  if(fresh){
    toast(fresh.name+' asks to join the table.',3500);
    if(navigator.vibrate) try{navigator.vibrate([90,60,90]);}catch(e){/* not allowed */}
  }
  clearInterval(titleFlash); titleFlash=null;
  if(net.asks.length&&document.hidden){
    let on=false;
    const set=()=>{document.title=(on=!on)?'('+net.asks.length+') Seat request':baseTitle;};
    set(); titleFlash=setInterval(set,1200);
  }else document.title=baseTitle;
  renderAsks();
}
/* The request bar. Seated players see who is asking and answer; the person asking sees where it stands. */
function renderAsks(){
  const el=$('#asks'); if(!el) return;
  const now=Date.now();
  let html='';
  if(net.on&&net.asking){
    const left=Math.max(0,Math.ceil((net.asking.until-now)/1000));
    const seat=net.asking.seat>=0&&net.seats[net.asking.seat]?net.seats[net.asking.seat].name+'’s seat':'a seat';
    html='<div class="ask-text"><b>Asking for '+esc(seat)+'</b><span>The players have been asked. If nobody answers you are in after '+left+'s.</span></div>'+
      '<div class="ask-btns"><button class="chip-btn" type="button" id="cancelAsk">Cancel</button></div>';
  }else if(net.on&&net.you!==null&&net.asks.length){
    const a=net.asks[0], left=Math.max(0,Math.ceil((a.until-now)/1000));
    const seat=a.seat>=0&&net.seats[a.seat]?net.seats[a.seat].name+'’s seat':'a seat';
    html='<div class="ask-text"><b>'+esc(a.name)+' asks for '+esc(seat)+'</b><span>Joins in '+left+'s unless someone says not now'+(net.asks.length>1?' · +'+(net.asks.length-1)+' more':'')+'</span></div>'+
      '<div class="ask-btns"><button class="chip-btn" type="button" data-ans="'+esc(a.rid)+'" data-ok="0">Not now</button><button class="chip-btn primary" type="button" data-ans="'+esc(a.rid)+'" data-ok="1">Accept</button></div>';
  }
  if(html!==el._html){el.innerHTML=html; el._html=html;}
  el.hidden=!html;
}
function renderTop(){
  const tag=$('#netTag');
  /* Next to the name: how many are watching, nothing else (the code is in the Public panel). A lost connection shows instead. */
  const down=net.on&&net.state==='down', w=net.on&&net.watching?net.watching:0;
  tag.hidden=!(down||w);
  tag.textContent=down?'Reconnecting…':w+' watching';
  tag.title=down?'':w+(w===1?' person is':' people are')+' watching';
  tag.className='net-tag'+(net.state==='down'?' warn':'');
  /* Public or Private, and Share. A game against the computer goes online, Public, as it starts. */
  if(vis){vis.hidden=!!net.cup||!(net.on||canOpenOnline()); vis.paint();}
  if(net.cup){                         // a cup table: the table clock, and the preset phrases
    const left=net.cupEnd&&G&&!G.over?Math.max(0,Math.ceil((net.cupEnd-Date.now())/1000)):null;
    if(left!==null||down){tag.hidden=false; tag.textContent=down?'Reconnecting…':'Table '+Math.floor(left/60)+':'+String(left%60).padStart(2,'0')+(w?' · '+w+' watching':''); tag.className='net-tag'+(down||left<=60?' warn':'');}
    $('#sayBtn').hidden=!(net.you!==null&&net.cupMeta&&net.cupMeta.chat.length&&G&&!G.over);
  }
  renderAsks();
  welcomeBack();
}
/* Who sits where around the table, seen from this screen. You are at the bottom (your hand is your seat);
   play passes to your left, so the next player sits on your left, then across, then on your right.
   Someone watching sees every seat, with seat 1 at the bottom. */
function seatPlan(){
  const n=G.players.length, v=viewer(), base=v===null?0:v;
  const others=[]; for(let k=1;k<n;k++) others.push((base+k)%n);
  const P={1:['top'],2:['left','right'],3:['left','top','right']}[others.length]||[];
  return [{i:base,pos:'bottom',me:v!==null}].concat(others.map((i,k)=>({i,pos:P[k],me:false})));
}
const heldSeat=i=>{const s=net.on&&net.seats[i]; return !!(s&&s.until&&s.until>Date.now());};
function renderSeats(){
  const left=clockLeft();
  $('#seats').innerHTML=seatPlan().map(({i,pos,me})=>{
    const p=G.players[i];
    const fl=p.hand.filter(c=>ui.inflight.has(c.id)).length;
    const shown=ui.phase==='shuffle'?0:p.hand.length-fl;
    const active=i===G.current&&!G.over&&ui.phase==='play';
    const talking=voice.talking.has(seatVid(i));
    const backs=me?'':Array.from({length:Math.min(shown,7)},()=>backHTML()).join('')+(shown>7?'<span class="more">+'+(shown-7)+'</span>':'');
    const clock=active&&left!==null&&p.type==='human'&&left<=20?'<span class="clock'+(left<=8?' low':'')+'">0:'+String(left).padStart(2,'0')+'</span>':'';
    const held=heldSeat(i);       // their connection dropped: the seat is kept for them, so nobody can sit here
    const sit=net.on&&!net.cup&&net.you===null&&p.type==='cpu'&&!held?'<button class="sit-btn" type="button" data-sit="'+i+'"'+(net.asking?' disabled':'')+'>'+(canSitNow()?'Sit here':'Ask to sit')+'</button>':'';
    const initial=(p.name.trim()[0]||'?').toUpperCase();
    const cm=net.cup&&net.cupMeta;      // a cup table says who is away or forfeited
    const kind=cm?(cm.forfeit[i]?'forfeited':!cm.here[i]?'away':''):held?'<span class="reconn" title="Reconnecting. The seat is kept for them, and the computer plays for them meanwhile.">offline</span>':p.type==='cpu'&&net.on?'open':'';   // the CPU badge on the avatar already says computer
    return '<div class="seat pos-'+pos+(active?' active':'')+(talking?' talking':'')+(me?' me':'')+'" data-seat="'+i+'">'+
      '<div class="avatar s'+(i%4)+(held?' away':'')+'">'+esc(initial)+(p.type==='cpu'&&!held?'<i class="cpu">CPU</i>':'')+'</div>'+
      '<div class="seat-info"><span class="seat-name">'+esc(me&&p.name!=='You'?p.name+' (you)':p.name)+'</span>'+
        '<span class="seat-sub">'+(me?(net.cup?cupClock():'Your seat'):'<b class="count">'+shown+'</b> card'+(shown===1?'':'s'))+(shown===1&&!me?'<span class="last">1!</span>':'')+(kind&&!me?' · '+kind:'')+clock+'</span>'+
        '<canvas class="wave" width="120" height="32" aria-hidden="true"></canvas></div>'+
      (backs?'<div class="mini-fan">'+backs+'</div>':'')+sit+'</div>';
  }).join('');
  // fresh canvases: draw the speakers' waves now, so a re-render never blinks them
  for(const vid of voice.talking.keys()) voice.draw(vid,document.querySelector('#seats .seat[data-seat="'+vidSeat(vid)+'"] canvas.wave'),'#5ad18a');
}
function renderTable(){
  if(!G) return;
  const vis=G.discard.filter(c=>!ui.flyPlay.has(c.id));
  const t=vis.length?vis[vis.length-1]:null, under=vis.length>1?vis[vis.length-2]:null;
  const land=t&&ui.lastTop!==null&&ui.lastTop!==t.id;
  ui.lastTop=t?t.id:null;
  const mk=ui.mktShown===null?G.market.length:ui.mktShown;
  const shapeName=G.shape;
  $('#table').innerHTML=
    '<div class="piles"><div class="pile"><div class="stack'+(ui.phase==='shuffle'||ui.shuffling?' shuffling':'')+(mk<=0?' empty':'')+'">'+backHTML()+backHTML()+backHTML()+'</div>'+
    '<span class="pile-label">Market <span class="mono" id="mktCount">'+mk+'</span></span></div>'+
    '<div class="pile"><div class="disc">'+(t?(under?cardHTML(under,{cls:'under'}):'')+cardHTML(t,{cls:land?'land':''}):'<div class="slot"></div>')+'</div>'+
    '<span class="pile-label">Play on this</span></div></div>'+
    '<div class="shape-chip'+(t?'':' off')+'">Shape in play '+sym(shapeName,'c-'+shapeName)+'<b>'+shapeName+'</b></div>';
}
function renderStatus(){
  const b=$('#banner'), tk=$('#ticker');
  const cur=G.players[G.current];
  const v=viewer();
  const left=clockLeft();
  const clk=left!==null&&left<=15?' · '+left+'s':'';
  let txt='', cls='banner';
  if(ui.phase==='shuffle'){txt='Shuffling the deck…';}
  else if(G.over){txt=G.players[G.winner].name+' checked up!';}
  else if(net.on&&net.state==='down'){txt=(net.you!==null||net.wasSeated?'Reconnecting… your seat is kept for you.'+(net.move?' Your move goes through when you are back.':''):'Reconnecting…'); cls+=' alert';}
  else if(ui.note){txt=ui.note;}
  else if(ui.hint){txt=ui.hint; cls+=' hint';}
  else if(G.pending&&myTurn(v)){
    const ckn=G.checkup?G.players[G.checkup.player].name+' is out of cards. ':'';
    txt=ckn+'Pick '+G.pending.amount+' is coming. '+(G.pending.n===2
      ?'Play 2s to pass it on, or pick up.'
      :G.checkup?'Blocking with a 5 will not bring them back in.'
      :'Each 5 you play blocks 3 of it. Block less and you pick the rest.')+clk; cls+=' alert';
  }
  else if(net.cup&&net.you===null){txt='Watching '+(net.cupMeta?net.cupMeta.delay:3)+' moves behind the table. No hidden cards are shown.';}
  else if(nobodySeated()&&!net.cup){txt='Table paused. Take a seat to carry on.';}
  else if(net.on&&net.grace&&net.grace.seat===G.current&&net.grace.until>Date.now()){txt='Waiting for '+net.grace.name+' to reconnect… '+Math.max(0,Math.ceil((net.grace.until-Date.now())/1000))+'s';}
  else if(heldSeat(G.current)){txt=cur.name+' is reconnecting. The computer plays for them meanwhile.';}
  else if(cur.type==='cpu'){txt=cur.name+' is thinking…';}
  else if(net.on&&G.current!==v){txt=(G.hold?cur.name+' '+vb(cur.name,'plays','play')+' again.':'Waiting for '+cur.name+'…')+clk;}
  else if(G.hold){txt=(humansIdx().length>1&&!net.on?cur.name+' '+vb(cur.name,'plays','play')+' again.':'Play again, or go to market.')+clk;}
  else{
    const sc=myTurn(v)?selCards(v):[];
    if(sc.length>1){
      txt='Order: '+sc.map(cardText).join(', then ')+'. The last card sets the shape.'; cls+=' hint';
    }else{txt=(humansIdx().length>1&&!net.on?cur.name+', your turn.':'Your turn.')+clk; if(clk) cls+=' alert';}
  }
  b.className=cls; b.textContent=txt;
  const last=G.log.length?G.log[G.log.length-1]:null;
  tk.className='ticker'+(last&&last.kind?' '+last.kind:''); tk.textContent=last?last.msg:'';
}
/* ---- a big hand stays easy to read: wrap into rows, scrub to look ---- */
const SHAPE_ORDER={circle:0,triangle:1,cross:2,square:3,star:4,whot:5};
function sortHand(h){
  return h.slice().sort((a,b)=>SHAPE_ORDER[a.shape]-SHAPE_ORDER[b.shape]||a.n-b.n);
}
const MIN_SHOW=32;   // px of each card left visible: enough for its number and small shape
/* Rows needed so no card shows less than MIN_SHOW px (up to 3; past that the hand scrolls sideways). */
function handRows(n){
  const avail=$('#hand').clientWidth-8;
  for(let r=1;r<=3;r++){const per=Math.ceil(n/r); if(per<=1||(avail-HAND_W)/(per-1)>=MIN_SHOW) return r;}
  return 3;
}
function renderHandLabel(v){
  const p=G.players[v], lab=$('#handLabel');
  lab.innerHTML=p.name==='You'||net.on?'':'<b>'+esc(p.name+'’s hand')+'</b><span></span>';      // your own hand needs no caption
}
function renderHand(){
  const v=viewer(), el=$('#hand'), lab=$('#handLabel');
  const prevScroll=el.scrollLeft;
  if(ui.phase==='shuffle'){
    lab.innerHTML='<b>Dealing…</b><span></span>';
    el.innerHTML='<div class="hand-note">Everyone gets 5 cards.</div>'; return;
  }
  if(v===null&&net.on){
    const open=G.players.map((p,i)=>({p,i})).filter(x=>x.p.type==='cpu');
    lab.innerHTML='<b>Watching</b><span></span>';
    el.innerHTML='<div class="hand-note"><div class="watch-note">'+(open.length
      ?(net.asking?'<span>Your request is with the table. You can keep watching.</span>'
        :'<span>'+(canSitNow()?'Take over a computer seat to play. Its cards become yours.':'Ask to take over a computer seat. The players are asked, and its cards become yours.')+'</span>')+
        '<div class="sits">'+open.map(x=>'<button class="chip-btn primary" type="button" data-sit="'+x.i+'"'+(net.asking?' disabled':'')+'>'+(canSitNow()?'Sit as ':'Ask for ')+esc(x.p.name)+'</button>').join('')+'</div>'
      :'<span>Every seat has a person in it. Enjoy the game.</span>')+'</div></div>'; return;
  }
  if(v===null){
    lab.innerHTML='<b>Hands hidden</b><span></span>';
    el.innerHTML='<div class="hand-note">Waiting for '+esc(G.players[G.current].name)+'…</div>'; return;
  }
  const p=G.players[v];
  if(!handVisible(v)){
    lab.innerHTML='<b>'+esc(p.name)+'</b><span class="mono">hidden</span>';
    el.innerHTML='<div class="hand-note">Tap reveal when only '+esc(p.name)+' is looking.</div>'; return;
  }
  renderHandLabel(v);
  const hand=sortHand(p.hand);
  const btn=c=>{
    let cls='';
    const inc=ui.inflight.has(c.id);
    if(ui.sel.includes(c.id)) cls+=' sel';
    if(inc) cls+=' incoming';
    else if(!ui.seen.has(c.id)) cls+=' fresh';
    const ord=ui.sel.length>1?ui.sel.indexOf(c.id)+1:0;
    return cardHTML(c,{as:'button',cls:cls.trim(),attrs:(ord?'data-ord="'+ord+'" ':'')+'data-id="'+c.id+'" aria-label="'+cardLabel(c)+'" aria-pressed="'+ui.sel.includes(c.id)+'"'});
  };
  const rows=handRows(hand.length), per=Math.ceil(hand.length/rows);
  let html='<div class="fan'+(rows>1?' multi':'')+'">';
  for(let r=0;r<rows;r++) html+='<div class="fan-row">'+hand.slice(r*per,(r+1)*per).map(btn).join('')+'</div>';
  el.innerHTML=html+'</div>';
  ui.seen=new Set(p.hand.filter(c=>!ui.inflight.has(c.id)).map(c=>c.id));
  layoutHand(); el.scrollLeft=prevScroll;
}
function layoutHand(){
  const sc=$('#hand'), fan=sc.firstElementChild;
  if(!fan||!fan.classList.contains('fan')) return;
  const avail=sc.clientWidth-8, gap=6;
  for(const row of fan.querySelectorAll('.fan-row')){
    const cs=[...row.children], n=cs.length; if(!n) continue;
    let ml=gap;
    if(n>1){const step=(avail-HAND_W)/(n-1); ml=Math.max(Math.min(step-HAND_W,gap),26-HAND_W);}
    cs.forEach((c,i)=>{c.style.marginLeft=i?ml+'px':'0';});
  }
  // Sideways panning only when the hand truly overflows; otherwise a sideways slide scrubs through the cards.
  sc.style.touchAction=sc.scrollWidth>sc.clientWidth+2?'auto':'pan-y';
}
/* Touch scrubbing: slide along the hand and the card under your finger pops up, enlarged, above it.
   Lift to pick it. Hit-testing uses where cards sit before any pop-up, so the raised card never gets in the way. */
const scrub={on:false,moved:false,x:0,y:0,rects:[],id:null,swallow:false};
function peekAt(x,y){
  let hit=null;
  for(const r of scrub.rects) if(x>=r.l&&x<=r.r&&y>=r.t&&y<=r.b) hit=r;   // the last match is the one in front
  const id=hit?hit.id:null;
  if(id===scrub.id) return;
  document.querySelectorAll('#hand .card.peek').forEach(e=>e.classList.remove('peek'));
  scrub.id=id;
  if(id!==null){const el=document.querySelector('#hand .card[data-id="'+id+'"]'); if(el){el.classList.add('peek'); Sound.fx('card');}}
}
function endScrub(pick){
  if(!scrub.on) return;
  scrub.on=false;
  const id=scrub.id;
  document.querySelectorAll('#hand .card.peek').forEach(e=>e.classList.remove('peek'));
  scrub.id=null;
  if(pick&&scrub.moved&&id!==null){scrub.swallow=true; setTimeout(()=>{scrub.swallow=false;},350); toggleCard(+id);}
}
const handEl=$('#hand');
handEl.addEventListener('pointerdown',e=>{
  if(e.pointerType==='mouse'||!e.target.closest('.card[data-id]')) return;
  scrub.on=true; scrub.moved=false; scrub.x=e.clientX; scrub.y=e.clientY; scrub.id=null;
  scrub.rects=[...handEl.querySelectorAll('.card[data-id]')].map(el=>{const r=el.getBoundingClientRect(); return {id:el.dataset.id,l:r.left,r:r.right,t:r.top,b:r.bottom};});
});
handEl.addEventListener('pointermove',e=>{
  if(!scrub.on) return;
  if(!scrub.moved&&Math.hypot(e.clientX-scrub.x,e.clientY-scrub.y)<8) return;
  scrub.moved=true; peekAt(e.clientX,e.clientY);
});
handEl.addEventListener('pointerup',()=>endScrub(true));
handEl.addEventListener('pointercancel',()=>endScrub(false));
function renderActions(){
  const v=viewer(), mine=myTurn(v);
  const mb=$('#marketBtn'), pb=$('#playBtn');
  const watching=net.on&&v===null;   // watchers have no cards to play, only (maybe) the walkie-talkie
  $('.actions').hidden=watching&&$('#pttBtn').hidden; mb.hidden=pb.hidden=watching;
  mb.textContent=G.pending?'Pick '+G.pending.amount:'Go to market';
  mb.className='btn'+(G.pending?' danger':'');
  mb.disabled=!mine;
  const cards=mine?selCards(v):[];
  let label='Play card';
  if(cards.length===1) label=cards[0].n===20?'Play Whot':'Play '+cardText(cards[0]);
  else if(cards.length>1) label='Play '+cards.length+' cards';
  pb.textContent=label;
  pb.disabled=!(mine&&selValid(cards));
}
function renderPass(){
  const el=$('#pass');
  if(!needsPass()){el.hidden=true; el.innerHTML=''; return;}
  const p=G.players[G.current];
  const last=G.log.length?G.log[G.log.length-1].msg:'';
  el.innerHTML='<div class="pass-box"><p class="eyebrow">Pass the phone</p><h2>'+esc(p.name)+', it’s your turn</h2>'+
    '<p>Your cards are hidden. Make sure nobody else is looking.</p>'+(last?'<p class="recap">Last move: '+esc(last)+'</p>':'')+
    '<button class="btn primary" id="revealBtn" type="button">Show my cards</button></div>';
  el.hidden=false;
  const b=$('#revealBtn'); if(b) b.focus();
}

/* --- player actions --- */
function onHandClick(e){
  if(scrub.swallow) return;                 // the scrub already picked this card
  const el=e.target.closest('.card'); if(!el||!el.dataset.id) return;
  toggleCard(+el.dataset.id);
}
function toggleCard(id){
  const v=viewer(); if(!myTurn(v)) return;
  const hand=G.players[v].hand, c=hand.find(x=>x.id===id); if(!c) return;
  let sel=ui.sel.slice();
  ui.hint='';
  if(sel.includes(id)){
    sel=sel.filter(x=>x!==id);
  }else if(sel.length){
    const f=hand.find(x=>x.id===sel[0]);
    if(c.n===f.n){
      if(sel.length>=maxBlock()) return;
      sel.push(id);
    }else if(isPlayable(G,c)) sel=[id];
    else return;
  }else if(isPlayable(G,c)){
    sel=[id];
  }else return;
  ui.sel=sel; render();
}
function onPlay(){
  const v=viewer(); if(!myTurn(v)) return;
  const cards=selCards(v); if(!selValid(cards)) return;
  if(cards.some(c=>c.n===20)){showShapePicker(); return;}
  act({t:'play',ids:ui.sel.slice()});
}
function showShapePicker(){
  // No "best shape" hint: choosing is the player's decision, and the game does not advise anyone.
  openSheet('<h2>Ask for a shape</h2><p class="rules-p">The next player must follow your shape, or play a Whot.</p><div class="shape-grid">'+
    SHAPES.map(s=>'<button type="button" class="shape-btn s-'+s+'" data-shape="'+s+'">'+sym(s)+s+'</button>').join('')+'</div>');
}
function onMarket(){
  const v=viewer(); if(!myTurn(v)) return;
  act({t:'market'});
}

/* --- results --- */
function showResult(){
  if(!G||!G.over) return;
  if(!net.on){G.losers.forEach(i=>tally[i].l++); tally[G.winner].w++;}
  renderResult();
}
/* The end-of-round sheet. With three or more players (two or more of them people) it is a knock-out: the loser goes
   out and the rest are asked to continue without them, round after round, until a champion is left. */
function renderResult(){
  if(net.cup) return renderCupResult();
  const T=net.on?net.tally:tally;
  const outNames=net.on?(net.out||[]):field.filter(f=>f.out).map(f=>f.name);
  const plan=tourPlan(G,outNames.length);
  const meOut=net.on&&net.you!==null&&plan.elim.includes(net.you);
  const rows=G.players.map((p,i)=>{
    const isW=i===G.winner, isL=G.losers.includes(i), isOut=plan.elim.includes(i);
    const pts=p.hand.reduce((a,c)=>a+c.n,0);
    return '<li class="'+(isW?'win':isL?'lose':'')+'"><div class="res-head">'+(isW?'<span class="badge w">'+(plan.mode==='final'?'Champion':'Winner')+'</span>':isOut?'<span class="badge l">Out</span>':isL?'<span class="badge l">Loser</span>':'')+
      '<b>'+esc(p.name)+'</b><span class="mono">'+p.hand.length+' card'+(p.hand.length===1?'':'s')+(p.hand.length?' · '+pts+' pts':'')+'</span></div>'+
      (p.hand.length?'<div class="minis">'+sortedHand(p.hand).map(c=>cardHTML(c,{cls:'mini'})).join('')+'</div>':'')+'</li>';
  }).join('');
  const loserNames=G.losers.map(i=>G.players[i].name).join(' and ');
  const elimNames=plan.elim.map(i=>G.players[i].name).join(' and ');
  const mc=G.players[G.losers[0]].hand.reduce((a,c)=>a+c.n,0);
  const wn=G.players[G.winner].name;
  const watching=net.on&&net.you===null;
  const leave='<button class="btn" type="button" id="changeBtn">'+(net.on?'Leave table':'Change players')+'</button>';
  let head=esc(wn)+' '+(G.stalemate?vb(wn,'wins','win')+' the round':'checked up!');
  let note='<b>'+esc(loserNames)+'</b> '+(G.losers.length>1?'tie for the highest points, ':vb(loserNames,'is','are')+' left with the highest points, ')+mc+'.';
  if(G.stalemate) note='Nobody could move, so the player with the fewest cards wins. '+note;
  let ask='', buttons;
  if(plan.mode==='round'){
    note='<b>'+esc(elimNames)+'</b> '+(plan.elim.length>1?'tie for':vb(elimNames,'has','have'))+' the highest points, '+mc+', so '+(plan.elim.length>1?'they are':vb(elimNames,'is','are'))+' out.';
    ask=meOut?'<p class="rules-p tour">You are out. The others can carry on without you, and you can keep watching.</p>'
      :'<p class="rules-p tour"><b>Continue without '+esc(elimNames)+'?</b> The rest play on until one player is left.</p>';
  }else if(plan.mode==='final'){
    head=esc(wn)+' '+vb(wn,'is','are')+' the champion!';
    note='Last one standing after '+(outNames.length+1)+' round'+(outNames.length?'s':'')+'. <b>'+esc(loserNames)+'</b> '+(G.losers.length>1?'were':vb(loserNames,'was','were'))+' left with the highest points, '+mc+'.'+(outNames.length?' Out earlier: '+esc(outNames.join(', '))+'.':'');
  }else if(plan.mode==='tie'){
    ask='<p class="rules-p tour">Too close to call, so nobody goes out. Play another round.</p>';
  }
  if(watching) buttons='<button class="btn" type="button" id="stayBtn">Keep watching</button>'+leave;
  else if(meOut) buttons='<button class="btn" type="button" id="stayBtn">Keep watching</button>'+leave;
  else{
    const again=plan.mode==='round'?'Continue without '+elimNames:plan.mode==='final'?'New tournament':'Play again';
    buttons='<button class="btn primary" type="button" id="againBtn">'+esc(again)+'</button>'+
      (plan.mode==='round'?'<button class="btn" type="button" id="allBtn">Everyone plays again</button>':'')+leave;
  }
  const html='<h2>'+head+'</h2><p class="rules-p">'+note+'</p>'+ask+
    '<ul class="res">'+rows+'</ul>'+
    '<table class="score"><thead><tr><th>Player</th><th>Wins</th><th>Losses</th></tr></thead><tbody>'+
    G.players.map((p,i)=>'<tr><td>'+esc(p.name)+'</td><td>'+T[i].w+'</td><td>'+T[i].l+'</td></tr>').join('')+'</tbody></table>'+
    '<div class="sheet-actions">'+buttons+'</div>';
  if(ui.sheet==='result'&&!$('#sheet').hidden&&ui.resultHTML===html) return;
  openSheet(html);
  ui.sheet='result'; ui.resultHTML=html;
  $('#sheetClose').hidden=!!(G&&G.over&&(!net.on||net.you!==null)&&!meOut);
}
function toSetup(){
  if(net.cup){const back=net.cup.back; leaveOnline(); location.href=back; return;}      // a cup table: back to the cup page
  ui.token++; clearFlyers(); clearTimeout(ui.timer);
  if(net.on) leaveOnline();
  G=null; ui.phase='setup'; ui.busy=false;
  Object.assign(ui,{inflight:new Set(),flyPlay:new Set(),mktShown:null,note:'',shuffling:false,sel:[]});
  $('#sheetClose').hidden=false;
  if(!$('#sheet').hidden) closeSheet();
  $('#pass').hidden=true; $('#game').hidden=true; $('#setup').hidden=false;
  renderSetup(); refreshTables();
}

/* =====================  ONLINE  ===================== */
const CODE_RE=/^[A-HJ-NP-Z2-9]{5}$/;
const CUP_CODE_RE=/^[A-HJ-NP-Z2-9]{10}$/;      // a Whot Cup table (see WHOT CUP TABLES below)
const PLACE=['','1st','2nd','3rd','4th'];
function newCode(){const A='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s=''; for(let i=0;i<5;i++) s+=A[rand(A.length)]; return s;}
function myId(){
  let id=''; try{id=localStorage.getItem('whot-id')||'';}catch(e){/* private mode */}
  if(!/^[A-Za-z0-9_-]{8,40}$/.test(id)){id=crypto.randomUUID(); try{localStorage.setItem('whot-id',id);}catch(e){/* ignore */}}
  return id;
}
function storedName(){let n=''; try{n=localStorage.getItem('whot-name')||'';}catch(e){/* ignore */} return n;}
/* A name the person picked for their own seat on the setup screen (not the stand-ins "You", "Player 2", "Computer"). */
const GENERIC=/^(you|player( \d)?|computer( \d)?)$/i;
function chosenName(){
  const seats=G&&!net.on?cfg:setup.seats.slice(0,setup.count);
  const me=seats.find(s=>s.type==='human'&&s.name&&!GENERIC.test(s.name.trim()));
  return me?me.name.trim().slice(0,14):'';
}
function myName(){
  const v=chosenName().trim().slice(0,14);      // only a name you can see in your seat box: nothing is applied behind your back
  if(v) try{localStorage.setItem('whot-name',v);}catch(e){/* ignore */}
  return v||'Player';
}
const wsBase=()=>(location.protocol==='https:'?'wss://':'ws://')+location.host;
const tableLink=(code,key)=>location.origin+location.pathname+'?t='+code+(key?'&k='+key:'');
const keyStore={
  get(code){try{return sessionStorage.getItem('whot-k-'+code)||'';}catch(e){return '';}},
  set(code,k){try{sessionStorage.setItem('whot-k-'+code,k);}catch(e){/* private mode */}}
};
function canOpenOnline(){return !net.on&&G&&!G.over&&cfg.filter(c=>c.type==='human').length===1;}
function netSend(o){if(net.ws&&net.ws.readyState===1) net.ws.send(JSON.stringify(o));}

/* Open a table: fresh from the setup screen, or carrying on the game in front of you (seed). */
function openTable(opts){
  const seats=opts.seats, me=seats.findIndex(s=>s.type==='human');
  net.create={t:'create',seats:seats.map(s=>({name:s.name,type:s.type})),me:Math.max(0,me),listed:!!opts.listed,seed:opts.seed||undefined,tally:opts.tally||undefined};
  net.key='';
  const code=newCode(); try{sessionStorage.setItem('whot-n-'+code,'1');}catch(e){/* ignore */}
  connect(code,{create:true});
}
function joinTable(code,sit,key){
  code=(code||'').toUpperCase().trim();
  if(!CODE_RE.test(code)){$('#codeIn').focus(); return;}
  net.create=null; net.key=key||keyStore.get(code);
  connect(code,{create:false,sit:sit!==false});
}
/* Staying connected on a poor network.
   - Every PING_MS the browser pings (answered by the server without waking the table, which reads the time of the
     last ping to tell a live player from a dead socket). If nothing at all comes back within DEAD_MS of a ping, the
     socket is dead even if it says it is open (common on phones after losing signal): drop it and connect again.
   - Coming back to the tab, or the network coming back, checks the socket at once instead of waiting.
   - Reconnecting backs off (0.5 s doubling to 15 s, with jitter so a whole table does not retry in step), waits for
     the network while the device says it is offline, and keeps trying for as long as the table keeps an empty seat
     for us (GIVE_UP_MS) before going back to the setup screen. The seat is held by the table meanwhile. */
const PING_MS=10000, DEAD_MS=6000, CONNECT_MS=8000, GIVE_UP_MS=10*60*1000;   // CONNECT_MS: an attempt that has not opened by then is hung
function liveTick(ws){
  if(net.ws!==ws||ws.readyState!==1) return;
  const now=Date.now();
  if(net.probeAt&&net.rx<net.probeAt&&now-net.probeAt>(net.probeMs||DEAD_MS)){dead(ws); return;}
  if(now-net.pingAt>=PING_MS){
    try{ws.send('ping');}catch(e){/* closing */}
    net.pingAt=now; if(!net.probeAt||net.rx>=net.probeAt){net.probeAt=now; net.probeMs=DEAD_MS;}
  }
}
/* Check the connection now: ping and expect an answer quickly, or reconnect straight away if it is already down. */
function probe(now){
  if(!net.on||net.closing) return;
  const ws=net.ws;
  if(ws&&ws.readyState===1){
    try{ws.send('ping');}catch(e){/* closing */}
    net.pingAt=net.probeAt=Date.now(); net.probeMs=4000;
    return;
  }
  if(ws&&ws.readyState===0&&Date.now()-net.openAt<2000) return;   // just started connecting
  if(ws&&ws.readyState===0){dead(ws); net.retry=0; clearTimeout(net.retryT); connect(net.code,{create:false,sit:false}); return;}   // a hung attempt: start afresh
  if(now||net.state==='down'){net.retry=0; clearTimeout(net.retryT); connect(net.code,{create:false,sit:false});}
}
function dead(ws){
  if(net.ws!==ws) return;
  ws.onclose=null; ws.onopen=null; try{ws.close(4000,'no answer');}catch(e){/* ignore */}
  dropped(ws);
}
/* The connection went: show it, and come back as soon as we can. */
function dropped(ws){
  clearInterval(net.ping);
  if(net.ws!==ws||!net.on) return;
  if(net.state!=='down'){net.state='down'; net.downSince=net.downSince||Date.now(); net.wasSeated=net.you!==null; if(G) render();}
  if(net.pre){net.pre=null; ui.busy=false; clearTimeout(net.watchdog); if(G) render();}   // the move may not have arrived: the next state says
  updateLobby();
  if(Date.now()-net.downSince>GIVE_UP_MS){toast('Lost the connection to the table.'); toSetup(); return;}
  const base=Math.min(15000,500*2**Math.min(net.retry++,5));
  const ms=navigator.onLine===false?15000:base*(0.5+Math.random()*0.5);   // offline: the 'online' event retries sooner
  clearTimeout(net.retryT);
  net.retryT=setTimeout(()=>{if(net.on&&net.ws===ws) connect(net.code,{create:false,sit:false});},ms);
}
function connect(code,o){
  clearTimeout(net.retryT);
  if(net.ws){net.ws.onclose=null; try{net.ws.close();}catch(e){/* ignore */}}
  Object.assign(net,{on:true,code,closing:false,state:net.state==='down'?'down':'connecting',sit:!!o.sit});
  const q=new URLSearchParams({name:myName(),id:myId()});
  if(o.create) q.set('create','1');
  if(o.sit) q.set('sit','1');
  if(net.key) q.set('k',net.key);
  const ws=new WebSocket(net.cup?wsBase()+'/ws/cup/'+net.cup.slug+'/'+net.cup.code+(net.cup.token?'?token='+encodeURIComponent(net.cup.token):''):wsBase()+'/ws/whot/'+code+'?'+q);
  net.ws=ws; net.openAt=Date.now();
  clearTimeout(net.openT);
  net.openT=setTimeout(()=>{if(net.ws===ws&&ws.readyState===0) dead(ws);},CONNECT_MS);     // a poor network can leave an attempt hanging
  ws.onopen=()=>{
    if(net.ws!==ws) return;
    clearTimeout(net.openT);
    net.state='up'; net.retry=0; net.downSince=0; net.rx=net.pingAt=Date.now(); net.probeAt=0;
    clearInterval(net.ping); net.ping=setInterval(()=>liveTick(ws),2500);
    if(G) render();
  };
  ws.onmessage=e=>{
    if(net.ws===ws) net.rx=Date.now();
    if(e.data==='pong') return;
    let m; try{m=JSON.parse(e.data);}catch(err){return;}
    if(m.t==='empty'){if(net.create) ws.send(JSON.stringify(net.create)); return;}
    if(m.t==='nope'){onNope(m); return;}
    if(m.t==='rtc'){voice.receive(m); return;}
    if(m.t==='wait'){cupWait(m); return;}
    if(m.t==='chat'){toast(m.name+': '+m.text,2600); return;}
    if(m.t==='moved'){if(net.cup) net.cup.token=null; toast('You opened this table on another device, so this one is watching.',4200); return;}
    if(m.t==='talk'){voice.heard(m); return;}
    if(m.t==='denied'){
      net.asking=null; renderAsks();
      toast(m.reason==='full'?'That seat is gone. Every seat has a person now.':(m.by||'The table')+' said not now. You can keep watching.',4200);
      return;
    }
    m.recv=Date.now();
    net.queue.push(m); pump();
  };
  ws.onclose=e=>{
    if(net.ws!==ws||net.closing) return;
    clearInterval(net.ping);
    if(net.offline&&net.offline.G){stayOffline(); return;}       // never got online: carry on offline
    if(e.code===4009&&net.create){connect(newCode(),{create:true}); return;}            // code taken: draw another
    if(net.cup&&e.code>=4000){cupClosed(e.code,e.reason); return;}
    if(e.code===4004||e.code===4010){
      const msg=e.code===4004?'No table with that code. It may have closed.':'That table is full.';
      net.on=false; net.ws=null;
      if(G){toast(msg); toSetup();} else{$('#onlineNote').textContent=msg; history.replaceState(null,'',location.pathname);}
      return;
    }
    if(e.code===4011){              // this browser opened the table again somewhere else, which now has the seat
      net.on=false; net.ws=null; toast('This table is open in another tab or window, so you play there.',4200); toSetup(); return;
    }
    // dropped (4008: the table stopped hearing us): come back quietly; the table kept the seat for this browser
    dropped(ws);
  };
  history.replaceState(null,'',net.cup?'?cup='+net.cup.slug+(net.cup.token?'':'&watch='+net.cup.code):'?t='+code);
}
function leaveOnline(){
  net.closing=true; clearInterval(net.ping); clearTimeout(net.watchdog); clearTimeout(net.retryT); clearTimeout(net.openT); net.downSince=0; voice.stop();
  if(net.ws) try{netSend({t:'stand'}); net.ws.close(1000,'leave');}catch(e){/* ignore */}   // standing first: no reconnect grace
  Object.assign(net,{on:false,ws:null,code:null,you:null,seats:[],out:[],queue:[],pre:null,move:null,dl:0,create:null,shownRound:-1,state:'',key:'',trusted:false,asks:[],asking:null,wasAsking:false});
  clearInterval(titleFlash); titleFlash=null; document.title=baseTitle; renderAsks();
  updateLobby();
  history.replaceState(null,'',location.pathname);
}
function onNope(m){
  if((m.reason==='stale'||m.reason==='not-your-turn')&&Date.now()<net.quietNopeUntil) return;   // refusing our resent copy: the first one already got there
  clearTimeout(net.watchdog); net.move=null;
  if(m.reason==='bad-create'&&net.create&&net.create.seed){
    toast('Could not carry this game over, so a fresh round is dealt.');
    net.create.seed=undefined; netSend(net.create); return;
  }
  if(net.pre){net.pre=null; ui.busy=false;}
  const msgs={'not-your-turn':'Not your turn yet.','stale':'The table moved on. Try again.','seat-taken':'Someone just took that seat.','seat-held':'That seat is kept for a player who is reconnecting.','seated':'You already have a seat.',
    'cooldown':'You asked a moment ago. Give it a little while.','busy':'Several people are asking already. Try again in a moment.','asking':''};
  if(m.reason!=='asking') toast(msgs[m.reason]||'That move was not allowed.');
  if(G) render();
}
/* Messages are applied one at a time, in order, each with its animation. A backlog plays fast. */
async function pump(){
  if(net.pumping) return; net.pumping=true;
  try{
    while(net.queue.length){
      const m=net.queue.shift();
      try{await applyMsg(m,net.queue.length);}catch(err){console.error(err);}
    }
  }finally{net.pumping=false;}
}
async function applyMsg(m,backlog){
  if(net.offline&&net.offline.G){clearTimeout(net.offlineT); net.offline=null;}
  const was=net.you;
  net.mine=m.mine||null; if(!net.mine) net.welcomed='';
  Object.assign(net,{you:m.you,seats:(m.seats||[]).map(x=>x.held?Object.assign({},x,{until:m.recv+x.held}):x),out:m.out||[],listed:m.listed,lister:m.lister,tally:m.tally,round:m.round,watching:m.watching,
    grace:m.grace?{seat:m.grace.seat,name:m.grace.name,until:m.recv+m.grace.left}:null,
    trusted:!!m.trusted,asking:m.asking?{seat:m.asking.seat,until:m.recv+m.asking.left}:null,
    asks:(m.asks||[]).map(a=>({rid:a.rid,name:a.name,seat:a.seat,until:m.recv+a.left}))});
  if(m.invite&&m.invite!==net.key){net.key=m.invite; keyStore.set(net.code,m.invite);}
  if(m.you!==null&&m.you!==undefined&&(was===null||was===undefined)&&net.wasAsking){toast('You are in. Good luck!',3200);}
  net.wasAsking=!!net.asking;
  if(net.sit&&m.seats){        // came to sit (a link, a tile, a code): say so when every seat already has a person
    net.sit=false;
    if((m.you===null||m.you===undefined)&&!net.asking&&!net.mine&&m.seats.every(x=>x.human)) toast('Every seat has a player, so you are watching. Tap a seat when one frees up.',4200);
  }
  noticeAsks();
  voiceState={online:true,me:m.voice.me,peers:m.voice.peers,all:!!m.voice.all,owner:!!m.voice.owner};
  voice.update(voiceState);
  if(m.left!==undefined){net.dl=m.recv+m.left; net.dlTurn=m.dlTurn;}
  if(m.cup){net.cupMeta=m.cup; net.cupEnd=m.cup.endsIn!=null?m.recv+m.cup.endsIn:0;}
  if(!net.cup&&was!==null&&was!==undefined&&m.you===null&&G&&!G.over&&!m.mine) toast('You are watching now. The computer has your cards.');
  if(m.kind==='deal'&&was!==null&&was!==undefined&&m.you===null) toast('You are out of this one. You can keep watching.',4200);
  updateLobby();
  const tok=ui.token, fast=reduce||backlog>3||document.hidden;
  if(m.t==='sync'||(!G&&m.kind!=='deal')){
    clearTimeout(ui.timer);
    const keep=ui.sel;
    G=hydrate(m.v);
    if(ui.phase!=='play'||$('#game').hidden){Object.assign(ui,{phase:'play',busy:false,revealed:null,lastTop:null,seen:new Set(),inflight:new Set(),flyPlay:new Set(),mktShown:null,note:''}); showGame(); if(!$('#sheet').hidden&&ui.sheet!=='name') closeSheet();}
    const mine=net.you!==null?new Set(G.players[net.you].hand.map(c=>c.id)):new Set();
    ui.sel=keep.filter(id=>mine.has(id));
    if(!net.pre) ui.busy=false;
    render(); afterState(); resumeMove(); return;
  }
  if(m.kind==='deal'){
    net.move=null;
    ui.token++;
    if(ui.sheet==='result') closeSheet();
    G=hydrate(m.v);
    await beginDeal(ui.token,fast);
    afterState(); return;
  }
  if(m.cpu&&!fast){render(); await wait(650+rand(450));}     // the computer "thinks" here, not on the server
  if(tok!==ui.token) return;
  const mineMove=m.actor===net.you&&net.pre;
  const pre=mineMove?net.pre:{src:{}};
  if(mineMove){net.pre=null; clearTimeout(net.watchdog);}
  pre.mkt=G.market.length;
  G=hydrate(m.v);
  if(net.move&&(mineMove||G.turns!==net.move.msg.turn)) net.move=null;   // answered, or the turn has passed on its own
  await animate(m.ev||[],pre,tok,fast);
  if(tok!==ui.token) return;
  render(); afterState();
}
function afterState(){
  if(G&&G.over&&net.on&&ui.sheet==='result'&&!$('#sheet').hidden) renderResult();   // someone joined or left: the sheet's choices may change
  if(G&&G.over&&net.shownRound!==net.round){
    net.shownRound=net.round;
    const tok=ui.token;
    celebrate().then(()=>{if(tok===ui.token&&G&&G.over) showResult();});
  }
}
/* The first seated person keeps the table in the lobby's list while it has open seats. */
function updateLobby(){
  const free=net.seats.filter(s=>!s.human).length;
  const want=net.on&&net.lister&&net.listed&&net.state!=='down';   // full tables stay listed: people can watch
  const host=(net.seats.find(s=>s.human)||{name:'Someone'}).name;
  const title=host+'’s table · '+net.seats.length+' seats';
  const key=want?net.code+'|'+free+'|'+title:'';
  const players=net.seats.filter(s=>s.human).length, watching=net.watching||0;
  if(key===net.lobbyKey){       // same listing: just tell the lobby how many are playing and watching, if that changed
    const n=players+'/'+watching, l=net.lobby;
    if(l&&l.readyState===1&&l._n!==n){l._n=n; l.send(JSON.stringify({t:'n',p:players,w:watching}));}
    return;
  }
  net.lobbyKey=key;
  if(net.lobby){const l=net.lobby; net.lobby=null; l.onclose=null; clearInterval(l._ping); try{l.close();}catch(e){/* ignore */}}
  if(!want) return;
  const l=new WebSocket(wsBase()+'/ws/lobby?'+new URLSearchParams({code:net.code,game:'whot',live:'1',name:title,free:String(free),players:String(players),watching:String(watching)}));
  l._n=players+'/'+watching;
  l._ping=setInterval(()=>{if(l.readyState===1) l.send('ping');},30000);
  l.onclose=e=>{clearInterval(l._ping); if(net.lobby!==l) return; net.lobby=null; net.lobbyKey=''; if(e.code!==4009) setTimeout(updateLobby,5000);};
  net.lobby=l;
}
/* Tables with open seats, for the setup screen. A few rows show; with more, "Show all" opens the rest. */
let tablesT=null;
let tablesFirst=true;
const IC={
  eye:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  bolt:'<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 2L4 14h6l-1 8 9-12h-6z"/></svg>',
  chair:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3v9M17 3v9M5 12h14v4H5zM7 16v5M17 16v5"/></svg>'
};
/* Live tables as small tiles: who sits there (filled = a person, dashed = a free seat the computer is playing), how many watch,
   and one tap to sit or watch. Many tables scroll inside their own box. */
function paintTables(){
  const box=$('#tables'), open=box._data;
  if(!open) return;
  const free=open.filter(t=>t.free>0);
  box.classList.toggle('none',!open.length);
  const tile=t=>{
    const people=Math.max(1,t.players!=null?t.players:1), seats=people+t.free, w=t.watching||0;
    const host=String(t.title).replace(/\s*·.*$/,'').replace(/[’']s table$/,'')||'Table';
    const dots=Array.from({length:Math.min(seats,6)},(_,i)=>'<i class="'+(i<people?'':'free')+'"></i>').join('');
    const code=esc(t.code);
    return '<div class="tile'+(t.free>0?' open':'')+'">'+
      '<button class="tile-main" type="button" data-join="'+code+'" data-sit="'+(t.free>0?1:0)+'" aria-label="'+(t.free>0?'Ask to sit at ':'Watch ')+esc(host)+'’s table, '+people+' playing, '+w+' watching">'+
        '<span class="seatrow" aria-hidden="true">'+dots+'</span><b>'+esc(host)+'</b>'+
        '<span class="tmeta"><span title="'+t.free+' free seat'+(t.free===1?'':'s')+'">'+IC.chair+t.free+'</span><span class="'+(w?'w':'')+'" title="'+w+' watching">'+IC.eye+w+'</span></span>'+
        '<span class="tact">'+(t.free>0?'Sit in':'Watch')+'</span></button>'+
      (t.free>0?'<button class="tile-eye" type="button" data-join="'+code+'" data-sit="0" aria-label="Just watch '+esc(host)+'’s table" title="Just watch">'+IC.eye+'</button>':'')+
      '</div>';
  };
  box.innerHTML='<div class="tables-head"><h2 class="field-title" id="h-online">Live tables</h2><span class="count">'+open.length+'</span>'+
      (free.length?'<button class="chip-btn primary" type="button" id="quickBtn" title="Take the first free seat">'+IC.bolt+'Quick seat</button>':'')+'</div>'+
    '<div class="tscroll" id="tscroll"><div class="tgrid">'+(open.length?open.map(tile).join(''):'<div class="tile none"><span class="ring"></span><span>No live tables yet. Deal a game and it shows up here for everyone.</span></div>')+'</div></div>';
  box._open=free;
  const sc=$('#tscroll'); sc.classList.toggle('more',sc.scrollHeight>sc.clientHeight+4);
  sc.onscroll=()=>sc.classList.toggle('more',sc.scrollTop+sc.clientHeight<sc.scrollHeight-4);
}
async function refreshTables(){
  clearTimeout(tablesT);
  if($('#setup').hidden) return;
  if(document.hidden&&!tablesFirst){tablesT=setTimeout(refreshTables,20000); return;}      // nobody is looking: do not ask
  tablesFirst=false;
  let open=null;
  try{const r=await fetch('/api/open',{cache:'no-store'}); if(r.ok) open=(await r.json()).whot.tables;}catch(e){/* offline */}
  if(open){$('#tables')._data=open; paintTables();}
  tablesT=setTimeout(refreshTables,20000);
}
/* Put the game in front of you online, carrying on exactly where it is: the computer seats become seats anyone can take.
   listed: Public (shown to everyone) or Private (only people with the link). If the table cannot be reached the game
   simply carries on offline, private. */
function goOnlineAuto(listed){
  if(!canOpenOnline()||net.offline) return;
  const seed=()=>{
    if(!canOpenOnline()) return;
    clearTimeout(ui.timer);
    const s=JSON.parse(JSON.stringify(G)); s.events=[]; s.log=[];
    net.offline={G,listed};
    openTable({seats:cfg,listed,seed:s,tally});
    net.offlineT=setTimeout(stayOffline,8000);
    ui.busy=true; render();
  };
  net.offline={pending:true,listed};
  const go=()=>{net.offline=null; seed();};
  if(ui.busy){const t=setInterval(()=>{if(!ui.busy){clearInterval(t); go();}},100);} else go();
  renderTop();
}
/* The table never answered: drop the connection and keep playing the same game here. */
function stayOffline(){
  const o=net.offline; if(!o||!o.G) return;
  clearTimeout(net.offlineT); net.offline=null;
  leaveOnline();
  G=o.G; ui.busy=false; render(); schedule(400);
  toast('Could not go online, so this game is private for now.',3600);
}

/* Who can see the table, and sharing its link. */
vis=PCVis.mount($('#visSlot'),{
  title:'Check Up Whot',
  state:()=>net.on?(net.create&&net.state==='connecting'&&!net.seats.length?(net.create.listed?'public':'private'):(net.listed?'public':'private')):(net.offline&&net.offline.listed?'public':'private'),
  canToggle:()=>net.on?net.you!==null:canOpenOnline(),
  onToggle(){
    if(net.on&&net.you!==null){
      net.listed=!net.listed; netSend({t:'list',on:net.listed}); renderTop();      // the open panel says what it means
    }else if(!net.on) goOnlineAuto(true);
  },
  onShare(){if(!net.on) goOnlineAuto(false);},           // sharing a private game: take it online, still private
  link:()=>!net.on||!net.code||net.state==='connecting'?null:net.you!==null?(net.key?tableLink(net.code,net.key):null):tableLink(net.code,''),
  text:()=>net.you!==null?'Take a seat at my Whot table':'Watch this Whot table',
  watching:()=>net.on?net.watching||0:0,
  code:()=>net.on&&net.code?net.code:null,
  status:()=>!net.on?null:!navigator.onLine?'Offline':net.state==='down'?'Reconnecting…':null,
  pending:()=>!!net.offline||(net.on&&(net.state==='connecting'||(net.you!==null&&!net.key))),
});
vis.hidden=true;

addEventListener('online',()=>{probe(true); if(G) renderTop();}); addEventListener('offline',()=>{if(G) renderTop();});

/* Hold to talk: the button (touch or mouse), or hold Space on a keyboard. */
const ptt=$('#pttBtn');
ptt.addEventListener('pointerdown',e=>{e.preventDefault(); try{ptt.setPointerCapture(e.pointerId);}catch(err){/* ignore */} voice.press();});
['pointerup','pointercancel','lostpointercapture'].forEach(ev=>ptt.addEventListener(ev,()=>voice.release()));
ptt.addEventListener('contextmenu',e=>e.preventDefault());
addEventListener('keydown',e=>{
  if(e.code!=='Space'||e.repeat||ptt.hidden||/input|textarea|select/i.test(e.target.tagName)||!$('#sheet').hidden) return;
  e.preventDefault(); voice.press();
});
addEventListener('keyup',e=>{if(e.code==='Space'&&voice.held){e.preventDefault(); voice.release();}});
addEventListener('blur',()=>voice.release());

/* --- wiring --- */
document.addEventListener('click',e=>{
  const t=e.target;
  const cnt=t.closest('#countSeg button'); if(cnt){setup.count=+cnt.dataset.n; renderSetup(); return;}
  const ty=t.closest('#seatList [data-type]'); if(ty){
    const i=+ty.dataset.i; setup.seats[i].type=ty.dataset.type; renderSetup(); return;}
  if(t.closest('#startBtn')){startGame('new'); return;}
  if(t.closest('#rulesBtn')||t.closest('#rulesBtn2')){showRules(); return;}
  if(t.closest('#soundBtn')){showSound(); return;}
  if(t.closest('#sndTest')){Sound.fx('whot'); Sound.say('Whot! Stars, please.',2); return;}
  if(t.closest('#logBtn')){showLog(); return;}
  if(t.closest('#sayBtn')){showSay(); return;}
  const say=t.closest('[data-say]'); if(say){netSend({t:'chat',id:+say.dataset.say}); closeSheet(); return;}
  if(t.closest('#leaveBtn')){showLeave(); return;}
  if(t.closest('#standBtn')){closeSheet(); netSend({t:'stand'}); return;}
  if(t.closest('#stayBtn')||t.closest('#sheetBack')||t.closest('#sheetClose')){if(!G||!G.over||ui.sheet!=='result'||(net.on&&net.you===null)||!$('#sheetClose').hidden){ui.userClose=true; closeSheet();} return;}
  if(t.closest('#leaveYes')){toSetup(); return;}
  if(t.closest('#againBtn')||t.closest('#allBtn')){
    const all=!!t.closest('#allBtn');
    $('#sheetClose').hidden=false; closeSheet();
    if(net.on) netSend(all?{t:'again',all:true}:{t:'again'}); else startGame(all?'all':'next'); return;}
  if(t.closest('#changeBtn')){toSetup(); return;}
  if(t.closest('#revealBtn')){ui.revealed=G.current; render(); return;}
  if(t.closest('#wbGo')){const m=net.mine; closeSheet(); if(m) netSend({t:'sit',seat:m.seat}); return;}
  if(t.closest('#wbKeep')){closeSheet(); return;}
  const sit=t.closest('[data-sit]:not([data-join])'); if(sit&&net.on){if(net.mine) netSend({t:'sit',seat:+sit.dataset.sit}); else sitSheet(+sit.dataset.sit); return;}
  const ans=t.closest('[data-ans]'); if(ans){netSend({t:'answer',rid:ans.dataset.ans,ok:ans.dataset.ok==='1'}); net.asks=net.asks.filter(a=>a.rid!==ans.dataset.ans); renderAsks(); return;}
  if(t.closest('#cancelAsk')){netSend({t:'cancel'}); net.asking=null; renderAsks(); return;}
  const jn=t.closest('[data-join]'); if(jn){joinNamed(jn.dataset.join,jn.dataset.sit==='1'); return;}
  if(t.closest('#quickBtn')){const o=$('#tables')._open||[]; if(o.length) joinNamed(o[o.length-1].code,true); return;}
  const sb=t.closest('.shape-btn'); if(sb){
    const shape=sb.dataset.shape, ids=ui.sel.slice(); closeSheet();
    act({t:'play',ids,shape}); return;}
  if(t.closest('#playBtn')){onPlay(); return;}
  if(t.closest('#marketBtn')){onMarket(); return;}
  if(t.closest('#hand')){onHandClick(e); return;}
});
/* The code box: letters and numbers only, and once all five are in, the Join button turns green if a live table has that
   code and red if none does. Only public tables are listed, so a private table can read red and still be joinable. */
let codeSeq=0;
async function checkCode(){
  const inp=$('#codeIn'), btn=$('#joinBtn'), v=inp.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g,'').slice(0,5), seq=++codeSeq;
  if(inp.value!==v) inp.value=v;
  btn.classList.remove('ok','bad'); btn.removeAttribute('title'); $('#onlineNote').textContent='';
  if(v.length<5) return;
  let live=($('#tables')._data||[]).some(t=>t.code===v);
  if(!live){try{const r=await fetch('/api/live?game=whot',{cache:'no-store'}); if(r.ok) live=(await r.json()).some(t=>t.code===v);}catch(e){/* offline: go by the list on screen */}}
  if(seq!==codeSeq) return;       // typed on since
  btn.classList.add(live?'ok':'bad');
  btn.title=live?'A live table has this code':'No public table has this code. A private table can still be joined if the code is right.';
}
document.addEventListener('input',e=>{
  const id=e.target.id;
  if(id==='codeIn'){checkCode(); return;}
  if(id==='vcOn'){voice.setEnabled(e.target.checked); try{localStorage.setItem('whot-voice',e.target.checked?'on':'off');}catch(err){/* ignore */} voice.update(voiceState); return;}
  if(e.target.dataset&&e.target.dataset.vmute!==undefined){voice.mute(e.target.dataset.vmute,e.target.checked); return;}
  if(id==='vcAll'){netSend({t:'voiceall',on:e.target.checked}); return;}
  if(id==='sndFx'||id==='sndVoice'||id==='sndVol'){
    Sound.set(id==='sndVol'?{vol:+e.target.value}:{[id==='sndFx'?'fx':'voice']:e.target.checked});
    if(id==='sndFx'&&e.target.checked) Sound.fx('play');
    paintSoundBtn(); return;
  }
  const m=/^name-(\d)$/.exec(e.target.id||''); if(!m) return;
  const s=setup.seats[+m[1]]; s.name=e.target.value; s.dirty=e.target.value.trim()!=='';
});
document.addEventListener('submit',e=>{if(e.target.id==='codeForm'){e.preventDefault(); joinNamed($('#codeIn').value,true);}});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&!$('#sheet').hidden&&(!G||!G.over)){ui.userClose=true; closeSheet();}
});
window.addEventListener('resize',()=>{if(G) renderHand();});   // the number of rows depends on the width
// the turn clock: redraw once a second while one is running
setInterval(()=>{
  nudgeTick();
  if(net.on&&G&&!ui.busy&&(clockLeft()!==null||net.grace||net.seats.some(x=>x.until))){renderSeats(); renderStatus();}
  if(net.cup&&G&&!G.over&&!ui.busy){renderTop(); renderSeats();}   // the table clock
  if(net.cup&&ui.sheet==='cupwait'&&net.cupMeta) cupWait(null);    // the deal countdown
  if(net.cup&&ui.sheet==='result'&&net.cupAfter){const o=net.cupAfter.me.live&&net.cupAfter.me.live.offer, r=$('#cupRing');
    if(o&&r){const left=Math.max(0,Math.ceil((o.expires-Date.now())/1000)); r.textContent=left+'s'; if(!left) paintCupAfter();}}
  if(net.cup&&net.cupEnd&&G&&!G.over){const left=Math.ceil((net.cupEnd-Date.now())/1000); if(left<=60&&left>55&&!net.minuteSaid){net.minuteSaid=true; announce('One minute left on the table clock.');}}
  if(net.on&&(net.asking||net.asks.length)) renderAsks();      // the countdowns
},1000);
document.addEventListener('visibilitychange',()=>{
  if(!document.hidden&&net.on) probe(true);       // back from another app: is the socket really alive?
  if(net.on) noticeAsks();
  if(!document.hidden&&!$('#setup').hidden) refreshTables();
});

renderHeroFan();
{const n=storedName(); if(n){setup.seats[0].name=n; setup.seats[0].dirty=true;}}      // a name you used before is shown in your seat box, where you can change it
renderSetup();
paintSoundBtn();
const qs=new URLSearchParams(location.search), qt=qs.get('t'), qk=qs.get('k');
if(qk&&qt) keyStore.set(qt.toUpperCase(),qk);
/* A small sheet that asks for the name you will have at a table, prefilled with the one you used last, and hands it back.
   Closing it (×, Escape) goes ahead with whatever is in the box. */
function nameSheet({title,intro,cta,onDone}){
  let typed=storedName(), done=false;
  const go=byUser=>{
    if(done) return; done=true;
    if(!byUser) return;       // the game moved on and cleared the sheet: nothing was asked for
    const v=typed.trim().slice(0,14);
    if(v){setup.seats[0].name=v; setup.seats[0].dirty=true; try{localStorage.setItem('whot-name',v);}catch(e){/* ignore */}}
    onDone(v||chosenName()||'Player');
  };
  openSheet('<h2>'+esc(title)+'</h2><p class="rules-p">'+intro+'</p>'+
    '<form id="nameForm"><input type="text" id="linkName" maxlength="14" value="'+esc(typed)+'" placeholder="Your name" aria-label="Your name" autocomplete="nickname">'+
    '<div class="sheet-actions"><button class="btn primary" type="submit">'+esc(cta)+'</button></div></form>',go);
  ui.sheet='name';        // a state message from the table does not wipe it away while someone is typing
  const inp=$('#linkName'); inp.addEventListener('input',()=>{typed=inp.value;}); inp.focus(); inp.select();
  $('#nameForm').addEventListener('submit',e=>{e.preventDefault(); typed=inp.value; ui.userClose=true; closeSheet();});
}
/* Joining a table (a link, a tile, a code): ask for the name first. It asks once per table in this tab, so a refresh does not ask again. */
function askName(code,watching,then){
  const flag='whot-n-'+code.toUpperCase();
  let named=false; try{named=!!sessionStorage.getItem(flag);}catch(e){/* ignore */}
  if(named){then(); return;}
  nameSheet({title:watching?'Watch this table':'Join this table',cta:watching?'Watch':'Join',
    intro:'Table <b class="mono">'+esc(code.toUpperCase())+'</b>. This is the name the others will see.',
    onDone:()=>{try{sessionStorage.setItem(flag,'1');}catch(e){/* ignore */} then();}});
}
function joinNamed(code,sit,key){
  code=(code||'').toUpperCase().trim();
  if(!CODE_RE.test(code)){joinTable(code,sit,key); return;}      // it says what is wrong with the code
  askName(code,sit===false,()=>joinTable(code,sit,key));
}
/* A watcher takes a computer's seat: give a name and sit, in one step. */
function sitSheet(seat){
  const p=net.seats[seat]; if(!p) return;
  nameSheet({title:'Take a seat',cta:canSitNow()?'Sit down':'Ask to sit',
    intro:canSitNow()?'You take over <b>'+esc(p.name)+'</b>’s cards and play from here. This is the name the others will see.'
      :'You take over <b>'+esc(p.name)+'</b>’s cards. The players are asked first. This is the name the others will see.',
    onDone:name=>netSend({t:'sit',seat,name})});
}
/* Back after being away long enough for the computer to take over: ask before taking the seat again. */
function welcomeBack(){
  const m=net.mine;
  if(!m||net.you!==null||(G&&G.over)||document.hidden||!$('#sheet').hidden) return;
  const key=m.seat+':'+m.name; if(net.welcomed===key) return;
  net.welcomed=key;
  openSheet('<h2>Welcome back, '+esc(m.name)+'</h2>'+
    '<p class="rules-p">You were away, so the computer has been playing your cards. Pick up where you left off?</p>'+
    '<div class="sheet-actions"><button class="btn" type="button" id="wbKeep">Keep watching</button><button class="btn primary" type="button" id="wbGo">Continue as '+esc(m.name)+'</button></div>');
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden) welcomeBack();});
if(qs.get('cup')) cupJoin(qs.get('cup'),qs.get('watch'));       // a Whot Cup table: your seat, or watching one
else if(qt) joinNamed(qt,qs.get('w')!=='1',qk||undefined); else refreshTables();   // w=1: arrived to watch

/* =====================  WHOT CUP TABLES  =====================
   /whot/?cup=<slug> opens your table in that cup (the seat token comes from /api/cups/<slug>/me, never the URL);
   /whot/?cup=<slug>&watch=<code> watches a table, a few moves behind with no hidden cards. The cup table speaks the
   same messages as a free table, so everything above draws it; what differs: no seat requests, invites, rematches
   or sharing, a table clock, forfeits, preset phrases, and a result that shows the table's pay. */
function cupNote(msg,back){
  openSheet('<h2>Whot Cup</h2><p class="rules-p">'+esc(msg)+'</p><div class="sheet-actions"><a class="btn primary" href="'+esc(back)+'">Back to the cup</a></div>');
  ui.sheet='cupnote';
}
async function cupJoin(slug,watch){
  slug=String(slug).toLowerCase().replace(/[^a-z0-9-]/g,'').slice(0,48);
  const back='/cup/?c='+encodeURIComponent(slug);
  if(watch){
    watch=String(watch).toUpperCase();
    if(!CUP_CODE_RE.test(watch)) return cupNote('That table link is not complete.',back);
    net.cup={slug,code:watch,token:null,back}; connect(watch,{create:false}); return;
  }
  let r=null; try{r=await fetch('/api/cups/'+slug+'/me',{cache:'no-store'});}catch(e){/* offline */}
  if(!r) return cupNote('Could not reach the cup. Check your connection and try again.',back);
  if(r.status===401){location.href='/account/?next='+encodeURIComponent(location.pathname+location.search); return;}
  const j=r.ok?await r.json():null, tb=j&&j.live&&j.live.table;
  if(!tb||!tb.token) return cupNote('You have no table in this cup right now.',back);
  if(tb.done) return cupNote('Your table has finished: you came '+(PLACE[tb.place]||'')+'.',back);
  net.cup={slug,code:tb.code,token:tb.token,back,fresh:true}; connect(tb.code,{create:false});
}
/* Before the deal (and for watchers, before there is anything to show yet). */
function cupWait(m){
  if(m){net.cupMeta=m.cup; net.you=m.you; net.seats=m.seats; net.watching=m.watching; net.recvWait=Date.now(); net.waitIn=m.cup.dealIn;}
  const c=net.cupMeta; if(!c) return;
  if(c.phase==='done'&&!G) return cupNote('This table has finished.',net.cup.back);
  if(G) return;                       // the game is on screen: nothing to wait for
  let html;
  if(c.watch) html='<h2>Watching a cup table</h2><p class="rules-p">Watchers see the game '+c.delay+' moves behind, and never anyone\'s cards until the table ends. The first moves appear shortly.</p>';
  else{
    const left=c.dealIn!=null?Math.max(0,Math.ceil((net.waitIn-(Date.now()-net.recvWait))/1000)):0;
    const what=c.draw==='GF'?'The Grand Final':c.draw==='L'?'Second Chance table':'Main draw table';
    html='<h2>Your table</h2><p class="rules-p">'+what+'. '+(c.draw==='GF'?'Grand Final prizes are paid when the cup ends.':'1st gets <b>'+c.pay1+'</b> coins'+(net.seats.length>1?', 2nd gets <b>'+c.pay2+'</b>':'')+'.')+
      ' The cards are dealt when everyone is here, or in '+left+'s.</p><ul class="res">'+
      net.seats.map((s,i)=>'<li><div class="res-head"><b>'+esc(s.name)+(s.me?' (you)':'')+'</b><span class="mono">'+(c.here[i]?'here':'not here yet')+'</span></div></li>').join('')+'</ul>';
  }
  html+='<div class="sheet-actions"><a class="btn" href="'+esc(net.cup.back)+'">Back to the cup</a></div>';
  if(ui.sheet==='cupwait'&&ui.waitHTML===html) return;
  openSheet(html); ui.sheet='cupwait'; ui.waitHTML=html;
}
function cupClosed(code,reason){
  const back=net.cup.back;
  net.on=false; net.ws=null;
  if(code===4001){location.href='/account/?next='+encodeURIComponent(location.pathname+location.search); return;}
  if(code===4003&&net.cup.fresh){net.cup.fresh=false; cupJoin(net.cup.slug); return;}      // a token from before a reload: fetch a new one, once
  if(G&&G.over) return;              // the result stays on screen
  cupNote(code===4004||code===4005?'This table has finished.':code===4011?'This cup doesn\'t allow watchers.':code===4010?'This table has as many watchers as it can take.':'You can\'t sit at this table ('+reason+').',back);
}
/* The end of a cup table: places, points and this table's pay. */
function renderCupResult(){
  const c=net.cupMeta||{}, places=c.places||[], mine=net.you!==null?places.indexOf(net.you):-1;
  const pay=k=>c.draw==='GF'?0:k===0?c.pay1:k===1?c.pay2:0;
  const rows=places.map((i,k)=>{
    const p=G.players[i], open=p.hand.every(x=>x.shape), pts=open?p.hand.reduce((a,x)=>a+x.n,0):null, coins=pay(k);   // a watcher may not be shown the hands
    return '<li class="'+(k===0?'win':'')+'"><div class="res-head"><span class="badge '+(k<2?'w':'l')+'">'+PLACE[k+1]+'</span><b>'+esc(p.name)+(i===net.you?' (you)':'')+'</b>'+
      '<span class="mono">'+(c.forfeit&&c.forfeit[i]?'forfeited · ':'')+p.hand.length+' card'+(p.hand.length===1?'':'s')+(pts!==null?' · '+pts+' pts':'')+(coins?' · +'+coins+' coins':'')+'</span></div>'+
      (p.hand.length&&open?'<div class="minis">'+sortedHand(p.hand).map(x=>cardHTML(x,{cls:'mini'})).join('')+'</div>':'')+'</li>';
  }).join('');
  const how=c.how==='clock'?'The table clock ran out, so the fewest points wins.':c.how==='forfeit'?'The others forfeited.':c.how==='stalemate'?'Nobody could move, so the fewest cards wins.':esc(G.players[places[0]].name)+' checked up.';
  const head=mine===0?'You won the table!':mine>0?'You finished '+PLACE[mine+1]:esc(G.players[places[0]].name)+' wins the table';
  const paid=mine>=0&&pay(mine)?'<p class="rules-p"><b>'+pay(mine)+' coins</b> are in your wallet.</p>':c.draw==='GF'&&mine>=0?'<p class="rules-p">Grand Final prizes are paid when the cup ends.</p>':'';
  const html='<h2>'+head+'</h2><p class="rules-p">'+how+'</p>'+paid+'<div id="cupAfter" aria-live="polite"></div><ul class="res">'+rows+'</ul>'+
    '<div class="sheet-actions"><a class="btn primary" href="'+esc(net.cup.back)+'">Back to the cup</a></div>';
  if(ui.sheet==='result'&&!$('#sheet').hidden&&ui.resultHTML===html) return;
  openSheet(html); ui.sheet='result'; ui.resultHTML=html;
  $('#sheetClose').hidden=false;
  announce(head.replace(/<[^>]+>/g,'')+'. '+how.replace(/<[^>]+>/g,''));
  if(mine>=0) cupAfter(); else paintCupAfter();
}
/* After a cup table (PX-3): the cup's net so far, always, and what comes next: a Second Chance offer with its
   countdown, "through", or the end of your cup. The table doesn't know your wallet, so this asks the cup. */
async function cupAfter(){
  const slug=net.cup.slug, code=net.cup.code;
  for(let i=0;i<4;i++){
    let me=null,cup=null;
    try{
      const [a,b]=await Promise.all([fetch('/api/cups/'+slug+'/me',{cache:'no-store'}),fetch('/api/cups/'+slug)]);
      me=a.ok?await a.json():null; cup=b.ok?(await b.json()).cup:null;
    }catch(e){/* offline: try again */}
    if(me&&me.entry&&cup){net.cupAfter={me,cup,code}; paintCupAfter(); if((me.history||[]).some(h=>h.code===code)) return;}
    await wait(1500);           // the director may not have the result yet
  }
}
function paintCupAfter(){
  const el=$('#cupAfter'), a=net.cupAfter; if(!el||!a||a.code!==net.cup.code) return;
  const e=a.me.entry, l=a.me.live||{}, c=a.cup, f=x=>Number(x).toLocaleString('en-NG');
  const staked=c.entryFee+(e.sc_bought?c.scFee:0), won=e.won||0, nett=won-staked;
  let html='<div class="cup-net" aria-label="Your cup so far"><span>Staked '+f(staked)+'</span><span>Won '+f(won)+'</span><b class="'+(nett<0?'neg':'pos')+'">Net '+(nett<0?'−':'+')+f(Math.abs(nett))+'</b></div>';
  const o=l.offer, reported=(a.me.history||[]).some(h=>h.code===a.code);
  if(o&&!o.bought&&o.expires>Date.now()){
    const left=Math.max(0,Math.ceil((o.expires-Date.now())/1000));
    const from=o.payFromWinnings==='off'?'Paid from your wallet: this cup\'s winnings can\'t be used for it.':won>=o.fee?'Paid from what you\'ve won in this cup.':'Paid from your wallet.';
    html+='<div class="cup-offer"><b>Second Chance: '+f(o.fee)+' coins</b><span>Play other first-time losers. Win your table to stay in; 2nd is still paid. '+from+'</span>'+
      '<div class="sheet-actions"><span class="ring" id="cupRing" role="timer" aria-label="Seconds left">'+left+'s</span><button class="btn primary" type="button" id="cupBuy">Buy back in for '+f(o.fee)+'</button></div><span id="cupBuyMsg" role="status"></span></div>';
    if(!net.offerSaid){net.offerSaid=true; announce('Second Chance offer: buy back in for '+o.fee+' coins within '+left+' seconds.');}
  }else if(o&&o.bought) html+='<p class="rules-p">You\'re in Second Chance. Your next table comes after the break.</p>';
  else if(!reported) html+='<p class="rules-p">Checking with the cup…</p>';
  else if(c.state==='running'&&(l.finish||(net.cupMeta&&net.cupMeta.draw==='GF'))) html+='<p class="rules-p">'+(net.cupMeta&&net.cupMeta.draw==='GF'?'Grand Final prizes are paid when the cup ends.':'Your cup is over. Thanks for playing.')+'</p>';
  else if(c.state==='running') html+='<p class="rules-p">You\'re through. Your next table comes after the break, and we\'ll tell you when it\'s ready.</p>';
  el.innerHTML=html;
  const b=$('#cupBuy'); if(b) b.onclick=async()=>{
    b.disabled=true;
    const r=await fetch('/api/cups/'+net.cup.slug+'/second-chance',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).catch(()=>null);
    if(r&&r.ok){announce('You bought a Second Chance.'); cupAfter(); return;}
    const j=r?await r.json().catch(()=>({})):{};
    $('#cupBuyMsg').textContent=j.error==='insufficient-funds'?'Not enough coins for that.':j.error==='offer-closed'?'The offer has closed.':'That didn\'t work. Try again.';
    b.disabled=false;
  };
}
/* Screen readers hear results, offers and the last minute of the table clock (PX-6). */
function announce(text){const el=$('#sr'); if(!el) return; el.textContent=''; setTimeout(()=>{el.textContent=text;},60);}
/* The table clock, on your own seat (the top bar has no room for it on a phone). */
function cupClock(){
  const left=net.cupEnd&&G&&!G.over?Math.max(0,Math.ceil((net.cupEnd-Date.now())/1000)):null;
  return left===null?'Your seat':'<span class="'+(left<=60?'last':'')+'">Table '+Math.floor(left/60)+':'+String(left%60).padStart(2,'0')+'</span>';
}
function showSay(){
  const p=(net.cupMeta&&net.cupMeta.chat)||[];
  openSheet('<h2>Say to the table</h2><div class="sheet-actions" style="flex-wrap:wrap">'+p.map((t,i)=>'<button class="btn" type="button" data-say="'+i+'">'+esc(t)+'</button>').join('')+'</div>');
}
// a read-only hook for tests and debugging
window.whot={state:()=>({online:net.on,code:net.code,you:net.you,seats:net.seats,phase:ui.phase,busy:ui.busy,current:G&&G.current,turns:G&&G.turns,over:G&&G.over,hand:G&&net.you!==null&&G.players[net.you]?G.players[net.you].hand.map(c=>c.id):null,voice:{peers:voice.peerCount,connected:voice.connected,talking:[...voice.talking.keys()],ptt:!$('#pttBtn').hidden}})};
