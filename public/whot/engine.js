/* Check Up Whot: the rules engine. Pure state in, state out, no DOM.
   The same file runs in the browser (offline play, and reading the views the server sends) and inside the
   WhotTable Durable Object, which is the only authority for an online table. Hidden cards never leave the
   server: seatView() gives each person their own hand, card counts for everyone else, and the market as a number. */

export const SHAPES=['circle','triangle','cross','square','star'];
export const SYMCH={circle:'●',triangle:'▲',cross:'✚',square:'■',star:'★'};
const NUMS={
  circle:[1,2,3,4,5,7,8,10,11,12,13,14],
  triangle:[1,2,3,4,5,7,8,10,11,12,13,14],
  cross:[1,2,3,5,7,10,11,13,14],
  square:[1,2,3,5,7,10,11,13,14],
  star:[1,2,3,4,5,7,8]
};
const SPECIAL_NUMS=[1,2,5,8,14,20];
const LOW_MARKET=8;      // reshuffle played cards into the market when it gets this low
const BIG_DISCARD=28;    // ...or when the played pile gets this big
export const DECK_SIZE=54;
export const LOG_KEEP=40;

export function rand(n){
  if(typeof crypto!=='undefined'&&crypto.getRandomValues){
    const a=new Uint32Array(1), lim=Math.floor(4294967296/n)*n; let x;
    do{crypto.getRandomValues(a); x=a[0];}while(x>=lim);
    return x%n;
  }
  return Math.floor(Math.random()*n);
}
const chance=p=>rand(1e6)<p*1e6;   // one random source everywhere, crypto backed
export function buildDeck(){
  const d=[]; let id=0;
  for(const sh of SHAPES) for(const n of NUMS[sh]) d.push({id:id++,shape:sh,n});
  for(let i=0;i<5;i++) d.push({id:id++,shape:'whot',n:20});
  return d; // 54 cards
}
const DECK=buildDeck();

/* ---------------- shuffling ----------------
   Two promises, each exact rather than approximate:
   1. The hands are dealt from a uniform shuffle: every order of the 54 cards is equally likely, so what you are dealt
      does not depend on how many sit at the table or where you sit.
   2. The market (what is left after the deal, and every reshuffle of played cards) is uniform among the orders in which
      no two cards of the same number sit side by side, so picking 2 or 3 never hands over a clump like 7, 7, 7.
      This is rejection sampling: shuffle uniformly, and shuffle again if two neighbours match. Every allowed order
      stays exactly as likely as every other, which a "nudge the clumps apart" pass cannot promise.
   (The earlier pass swapped cards until neighbours up to 3 apart differed. Hands are dealt round the table, so one
   player's cards sit 2, 3 or 4 apart in the deck, and that pass changed hands differently by table size: fewer pairs
   with 2 or 3 players, more pairs and more double Whots with 4.)
   Random numbers come from crypto in batches of 256: a whole deal takes a handful of calls, not thousands. */
const POOL=new Uint32Array(256); let poolAt=POOL.length;
const hasCrypto=()=>typeof crypto!=='undefined'&&!!crypto.getRandomValues;
/* A uniform integer in [0, n), unbiased (values past the last whole multiple of n are drawn again). */
function below(n){
  if(!hasCrypto()) return rand(n);
  const lim=Math.floor(4294967296/n)*n; let x;
  do{ if(poolAt>=POOL.length){crypto.getRandomValues(POOL); poolAt=0;} x=POOL[poolAt++]; }while(x>=lim);
  return x%n;
}
/* Fisher-Yates: uniform over every order. */
function shuffleUniform(a){
  for(let i=a.length-1;i>0;i--){const j=below(i+1); const t=a[i]; a[i]=a[j]; a[j]=t;}
  return a;
}
/* Same-number neighbours, counting the seam with `after` (the card that will sit just past the end of a). */
export function clumps(a,after){
  let c=0;
  for(let i=1;i<a.length;i++) if(a[i].n===a[i-1].n) c++;
  if(after&&a.length&&a[a.length-1].n===after.n) c++;
  return c;
}
const MARKET_TRIES=2000;   // a market of 33 to 43 cards passes about 1 try in 8 to 1 in 20: this cap is never reached when an order exists
/* Uniform among orders with no same-number neighbours. Should no such order exist (a pile of three 2s and one 7),
   the order with the fewest is kept. */
export function shuffleMarket(a,after){
  let best=null, bc=Infinity;
  for(let t=0;t<MARKET_TRIES;t++){
    shuffleUniform(a);
    const c=clumps(a,after);
    if(c===0) return a;
    if(c<bc){bc=c; best=a.slice();}
  }
  return best;
}
export function cardText(c){return c.n===20?'Whot':SYMCH[c.shape]+' '+c.n;}
/* Verb agreement for a player's name: offline the person at the screen is called "You" ("You play", not "You plays"). */
export const vb=(name,one,you)=>name==='You'?you:one;
export function say(s,msg,kind){s.log.push({msg,kind:kind||''}); if(s.log.length>80) s.log.shift();}

export function newGame(seats,starter){
  const n=seats.length;
  const s={
    players:seats.map(x=>({name:x.name,type:x.type,hand:[]})),
    market:shuffleUniform(buildDeck()), discard:[], current:starter%n,
    shape:null, pending:null, hold:false, checkup:null,
    over:false, winner:null, losers:[], stalemate:false,
    log:[], events:[], passes:0, turns:0, starter:starter%n
  };
  for(let r=0;r<5;r++) for(let i=0;i<n;i++) s.players[(starter+i)%n].hand.push(s.market.pop());
  // The first card to turn up that is not a special one starts the pile (a uniformly random ordinary card). Specials
  // turned up on the way go back into the market, which is then shuffled under the no-clumps rule above.
  let k=s.market.length-1;
  while(SPECIAL_NUMS.includes(s.market[k].n)) k--;
  const first=s.market.splice(k,1)[0];
  s.market=shuffleMarket(s.market);
  s.discard.push(first); s.shape=first.shape;
  say(s,s.players[s.current].name+' '+vb(s.players[s.current].name,'starts','start')+'.');
  return s;
}
export function topCard(s){return s.discard[s.discard.length-1];}
export function isPlayable(s,card){
  if(s.pending) return card.n===s.pending.n;
  if(card.n===20) return true;
  return card.shape===s.shape||card.n===topCard(s).n;
}
export function playableCards(s,i){
  const p=s.players[i===undefined?s.current:i];
  return p.hand.filter(c=>isPlayable(s,c));
}
/* Shuffle every played card (except the top one) back under whatever is left in the market. */
function refill(s){
  if(s.discard.length<=1) return false;
  const t=s.discard.pop(); const rest=s.discard;
  s.discard=[t]; s.market=shuffleMarket(rest,s.market[0]).concat(s.market);   // no clump at the seam either
  s.events.push({type:'reshuffle',moved:rest.length});
  say(s,'Market is low. Played cards were shuffled back in.');
  return true;
}
function replenish(s){
  if(s.over) return;
  if((s.market.length<=LOW_MARKET&&s.discard.length>=6)||s.discard.length>=BIG_DISCARD) refill(s);
}
function drawCards(s,i,k){
  let got=0;
  if(s.market.length<k) refill(s);   // market not enough: shuffle the played cards in first
  for(let j=0;j<k;j++){
    if(!s.market.length) refill(s);
    if(!s.market.length) break;
    const c=s.market.pop();
    s.players[i].hand.push(c); got++;
    s.events.push({type:'draw',player:i,id:c.id,at:s.players[i].hand.length-1});
  }
  return got;
}
function advance(s,steps){
  s.current=(s.current+(steps||1))%s.players.length;
  s.hold=false; s.turns++;
}
function finish(s,w){
  s.over=true; s.winner=w; s.pending=null; s.checkup=null; s.hold=false;
  const info=s.players.map((p,i)=>({i,count:p.hand.length,pts:p.hand.reduce((a,c)=>a+c.n,0)}));
  const others=info.filter(x=>x.i!==w);
  const mp=Math.max(...others.map(x=>x.pts));
  let cand=others.filter(x=>x.pts===mp);
  if(cand.length>1){const mc=Math.max(...cand.map(x=>x.count)); cand=cand.filter(x=>x.count===mc);}
  s.losers=cand.map(x=>x.i);
  say(s,s.players[w].name+' checked up!','ok');
}
/* Knock-out rounds. With three or more players, at least two of them people, whoever holds the most points when
   someone checks up is out, and the rest carry on until two are left; that last round crowns the champion.
   `out` is how many have already gone. Returns what happens next:
     round    these seats (elim) go out, then the rest play on
     tie      the losers tie so closely that going out would leave under two players, or nobody who is a person: play again
     final    the last two have played after others went out: the winner is the champion, and the next game brings everyone back
     rematch  an ordinary table (two players, or one person against the computer): play again with everyone */
export function tourPlan(s,out){
  if(!s.over) return {mode:'none',elim:[]};
  const n=s.players.length;
  if(n===2&&out>0) return {mode:'final',elim:[]};
  if(n<3||s.players.filter(p=>p.type==='human').length<2) return {mode:'rematch',elim:[]};
  const elim=s.losers.slice();
  const keep=s.players.map((p,i)=>i).filter(i=>!elim.includes(i));
  if(keep.length<2||!keep.some(i=>s.players[i].type==='human')) return {mode:'tie',elim:[]};
  return {mode:'round',elim};
}
function stalemate(s){
  const info=s.players.map((p,i)=>({i,count:p.hand.length,pts:p.hand.reduce((a,c)=>a+c.n,0)}));
  info.sort((a,b)=>a.count-b.count||a.pts-b.pts);
  s.stalemate=true; say(s,'Nobody can move. The player with the fewest cards wins.','warn');
  finish(s,info[0].i);
}

/* cardIds: one id, or an array of ids played in that order.
   All cards must share a number and the FIRST one must fit the top card; the LAST one sets the shape. */
export function play(s,cardIds,askShape){
  if(s.over) return {ok:false,reason:'over'};
  const ids=Array.isArray(cardIds)?cardIds:[cardIds];
  const me=s.current, p=s.players[me], n=s.players.length;
  if(ids.length<1||new Set(ids).size!==ids.length) return {ok:false,reason:'count'};
  const cards=ids.map(id=>p.hand.find(c=>c.id===id));
  if(cards.some(c=>!c)) return {ok:false,reason:'nocard'};
  if(cards.some(c=>c.n!==cards[0].n)) return {ok:false,reason:'pair'};
  if(!isPlayable(s,cards[0])) return {ok:false,reason:'illegal'};
  const k=cards.length, card=cards[k-1], num=card.n;
  if(s.pending&&num===5&&k>s.pending.amount/3) return {ok:false,reason:'toomany'};
  if(num===20&&!SHAPES.includes(askShape)) return {ok:false,reason:'shape'};
  const ck=s.checkup; s.checkup=null;
  let ckFail=false, ckWin=false;
  cards.forEach(c=>{const i=p.hand.findIndex(x=>x.id===c.id); p.hand.splice(i,1); s.discard.push(c);});
  s.events.push({type:'play',player:me,cards:cards.map(c=>({id:c.id,shape:c.shape,n:c.n}))});
  s.passes=0;
  s.shape=num===20?askShape:card.shape;
  say(s,p.name+' played '+cards.map(cardText).join(' + ')+'.');
  if(p.hand.length===1) say(s,p.name+' '+vb(p.name,'has','have')+' one card left!','warn');
  switch(num){
    case 2:{
      const amt=(s.pending?s.pending.amount:0)+2*k;
      s.pending={n:2,amount:amt};
      say(s,(amt>2*k?p.name+' passed it on. Pick ':p.name+' '+vb(p.name,'says','say')+' pick ')+amt+'!','hit');
      ckFail=!!ck; advance(s); break;
    }
    case 5:{
      if(s.pending){
        const rem=s.pending.amount-3*k;
        s.pending=null;
        if(rem<=0) say(s,p.name+' blocked the pick 3.','ok');
        else{
          say(s,p.name+' blocked '+(3*k)+' and '+vb(p.name,'picks','pick')+' '+rem+'.','warn');
          drawCards(s,me,rem);
        }
        // Blocking is not a defence against a check up: only a 2 passed on brings the checker back in (ckFail, below).
        // Whether the block was whole or partial, the player who checked up wins.
        ckWin=!!ck;
      }else{s.pending={n:5,amount:3*k}; say(s,p.name+' '+vb(p.name,'says','say')+' pick '+(3*k)+'!','hit');}
      advance(s); break;
    }
    case 8:{
      const skip=Math.min(k,n-1);
      const names=[]; for(let j=1;j<=skip;j++) names.push(s.players[(me+j)%n].name);
      say(s,names.join(' and ')+(skip>1?' are':' '+vb(names[0],'is','are'))+' suspended.','hit');
      advance(s,skip+1); break;
    }
    case 1:{
      s.hold=true; s.turns++;
      say(s,'Hold on! '+p.name+' '+vb(p.name,'plays','play')+' again.','hit'); break;
    }
    case 14:{
      if(s.market.length<(n-1)*k) refill(s);
      for(let j=1;j<n;j++) drawCards(s,(me+j)%n,k);
      s.hold=true; s.turns++;
      say(s,'General market! Everyone else picks '+k+'. '+p.name+' '+vb(p.name,'plays','play')+' again.','hit'); break;
    }
    case 20:{
      say(s,p.name+' '+vb(p.name,'asks','ask')+' for '+SYMCH[askShape]+' '+askShape+'.');
      advance(s); break;
    }
    default: advance(s);
  }
  if(ck){
    if(ckWin){finish(s,ck.player); return {ok:true,cards,emptied:false};}
    if(ckFail){
      // The checker is back in the game and takes only the penalty that was passed on, when it reaches them. They are
      // not handed an extra card for being defended against: in a two-player game they simply pick the passed-on 4
      // (or 6, ...), and with three or more it travels round the table like any other penalty.
      const checker=s.players[ck.player];
      say(s,p.name+' defended it. '+checker.name+' '+vb(checker.name,'is','are')+' back in the game: pick '+s.pending.amount+' is coming.','warn');
    }
  }
  const emptyNow=p.hand.length===0;   // after any picks (a partial block can refill the hand)
  if(emptyNow){
    if(s.pending){
      s.checkup={player:me};
      say(s,p.name+' '+vb(p.name,'is','are')+' out of cards! '+s.players[s.current].name+' must defend or lose.','warn');
    }else finish(s,me);
  }
  replenish(s);
  return {ok:true,cards,emptied:emptyNow};
}

export function market(s){
  if(s.over) return {ok:false};
  const me=s.current, p=s.players[me];
  if(s.pending){
    const amt=s.pending.amount; drawCards(s,me,amt); s.pending=null;
    say(s,p.name+' '+vb(p.name,'picks','pick')+' '+amt+'.','warn');
    if(s.checkup){const ck=s.checkup; s.checkup=null; finish(s,ck.player); return {ok:true};}
    advance(s); replenish(s); return {ok:true};
  }
  const got=drawCards(s,me,1);
  say(s,p.name+(got?' '+vb(p.name,'goes','go')+' to market.':' cannot pick: market is empty.'));
  if(got===0){s.passes++; if(s.passes>=s.players.length){stalemate(s); return {ok:true};}}
  else s.passes=0;
  advance(s); replenish(s); return {ok:true};
}

export function pickShape(hand){
  const cnt={}; SHAPES.forEach(x=>cnt[x]=0);
  hand.forEach(c=>{if(c.n!==20) cnt[c.shape]++;});
  const mx=Math.max(...SHAPES.map(x=>cnt[x]));
  const best=SHAPES.filter(x=>cnt[x]===mx);
  return best[rand(best.length)];
}
export function aiMove(s){
  const me=s.current, p=s.players[me], n=s.players.length;
  const pl=playableCards(s);
  if(!pl.length) return {type:'market'};
  if(s.pending){
    const lim=s.pending.n===5?s.pending.amount/3:pl.length;
    return {type:'play',cardId:pl.slice(0,lim).map(c=>c.id)};
  }
  if(pl.every(c=>c.n===20)&&p.hand.length>3&&chance(0.7)) return {type:'market'};
  const nextP=s.players[(me+1)%n];
  const threat=nextP.hand.length<=2;
  const minOpp=Math.min(...s.players.filter((_,i)=>i!==me).map(x=>x.hand.length));
  let best=null,bs=-1e9;
  for(const c of pl){
    let sc=rand(600)/1000;
    const rest=p.hand.length-1;
    if(c.n===2||c.n===5) sc+=threat?6:3;
    else if(c.n===8) sc+=threat?5:2;
    else if(c.n===14) sc+=minOpp<=2?2:-1;
    else if(c.n===1) sc+=2;
    else if(c.n===20) sc+=rest===0?20:-5;
    sc+=p.hand.filter(x=>x.id!==c.id&&x.shape===c.shape).length*0.6;
    sc+=c.n/20*0.8;
    if(rest===0) sc+=10;
    if(rest===1&&p.hand.some(x=>x.id!==c.id&&x.n===c.n)) sc+=10;
    if(sc>bs){bs=sc; best=c;}
  }
  let ids=best.id;
  const partners=p.hand.filter(x=>x.id!==best.id&&x.n===best.n);
  if(partners.length&&best.n!==1&&best.n!==20&&(best.n!==14||minOpp<=2)&&(p.hand.length===2||chance(0.75))){
    partners.sort((a,b)=>p.hand.filter(x=>x.shape===b.shape).length-p.hand.filter(x=>x.shape===a.shape).length);
    ids=[best.id,partners[0].id];
  }
  const mv={type:'play',cardId:ids};
  if(best.n===20) mv.shape=pickShape(p.hand.filter(x=>x.id!==best.id));
  return mv;
}
/* The computer's move for the seat whose turn it is, decided from that seat's view only: its own hand, the
   top cards, the shape, any penalty, and everyone else's card COUNT. It is never handed another hand or the
   market order, so it cannot cheat even by accident. (aiMove reads nothing more today; this makes it structural.) */
export function aiMoveFair(s){return aiMove(hydrate(seatView(s,s.current)));}
/* Apply an aiMove result. */
export function applyMove(s,mv){return mv.type==='play'?play(s,mv.cardId,mv.shape):market(s);}

/* ---------------- online helpers ---------------- */

/* Id of a face-down card in someone else's hand, by its position. Positions are stable within one action
   (cards leave a hand before any are drawn into it), so a draw event and the next view agree. */
export const hiddenId=(seat,at)=>-(1+seat*100+at);

/* What one seat may see. seat is a player index, or null for someone watching.
   Other hands become counts, the market becomes a count, the played pile keeps its top two cards.
   When the round is over every hand is shown, as at a real table. */
export function seatView(s,seat){
  const open=s.over;
  return {
    players:s.players.map((p,i)=>(open||i===seat)
      ?{name:p.name,type:p.type,hand:p.hand.map(c=>({id:c.id,shape:c.shape,n:c.n})),count:p.hand.length}
      :{name:p.name,type:p.type,count:p.hand.length}),
    mk:s.market.length, discard:s.discard.slice(-2), current:s.current,
    shape:s.shape, pending:s.pending, hold:s.hold, checkup:s.checkup,
    over:s.over, winner:s.winner, losers:s.losers, stalemate:s.stalemate,
    log:s.log.slice(-LOG_KEEP), turns:s.turns, starter:s.starter
  };
}
/* The same filter for animation events: someone else's draw shows a face-down card at its hand position. */
export function seatEvents(events,seat,over){
  return events.map(e=>e.type==='draw'&&e.player!==seat&&!over?{type:'draw',player:e.player,id:hiddenId(e.player,e.at)}:e);
}
/* The browser's working copy of a view: the same shape as a full game, so one renderer serves both. */
export function hydrate(v){
  return Object.assign({},v,{
    market:{length:v.mk}, events:[],
    players:v.players.map((p,i)=>p.hand?p:{name:p.name,type:p.type,hand:Array.from({length:p.count},(_,k)=>({id:hiddenId(i,k)}))})
  });
}

/* A game handed over by a browser (someone playing the computer who opens their table midstream).
   Rebuilt from card ids only, so a bad or tampered state is refused rather than trusted: every one of the
   54 cards must appear exactly once across the hands, the market and the played pile. Returns a clean state or null. */
export function adoptState(x,names){
  try{
    if(!x||typeof x!=='object'||x.over) return null;
    const n=x.players&&x.players.length;
    if(!(n>=2&&n<=4)||!Array.isArray(names)||names.length!==n) return null;
    const seen=new Set(), take=a=>{
      if(!Array.isArray(a)||a.length>DECK_SIZE) throw 0;
      return a.map(c=>{const id=c&&c.id; if(!Number.isInteger(id)||id<0||id>=DECK_SIZE||seen.has(id)) throw 0; seen.add(id); return {...DECK[id]};});
    };
    const hands=x.players.map(p=>take(p.hand));
    const mk=take(x.market), disc=take(x.discard);
    if(seen.size!==DECK_SIZE||!disc.length) return null;
    const int=(v,lo,hi)=>Number.isInteger(v)&&v>=lo&&v<=hi;
    if(!int(x.current,0,n-1)||!SHAPES.includes(x.shape)) return null;
    let pending=null;
    if(x.pending){const {n:pn,amount}=x.pending; if(!((pn===2||pn===5)&&int(amount,1,200))) return null; pending={n:pn,amount};}
    let checkup=null;
    if(x.checkup){if(!pending||!int(x.checkup.player,0,n-1)) return null; checkup={player:x.checkup.player};}
    const s={
      players:names.map((p,i)=>({name:p.name,type:p.type,hand:hands[i]})),
      market:mk, discard:disc, current:x.current, shape:x.shape, pending, hold:!!x.hold, checkup,
      over:false, winner:null, losers:[], stalemate:false, log:[], events:[],
      passes:int(x.passes,0,8)?x.passes:0, turns:int(x.turns,0,1e6)?x.turns:0, starter:int(x.starter,0,n-1)?x.starter:0
    };
    say(s,'The table is open. Play carries on.');
    return s;
  }catch(e){return null;}
}
