/* Floodlight FC data model: stats, positions, playing styles, skills, moves, formations, team playstyles, managers
   and squads. Pure data and pure functions (no DOM, no three.js), shared by the match engine, the team screen
   and the Node tests. The model follows docs/floodlight-fc.md, which is built on the design research. */
import { clamp, lerp, mulberry32, hashStr } from './vec.js';

// ------------------------------------------------------------------ stats
/* 26 stats on a 40–99 scale, in four groups. `use` says what each one drives in the engine. */
export const STATS = [
  ['offAwa', 'Attacking Awareness', 'Attack', 'How often and how well a player times forward runs'],
  ['ballCtl', 'Ball Control', 'Attack', 'First touch: a fast ball sticks instead of bouncing away'],
  ['drib', 'Dribbling', 'Attack', 'Speed with the ball, and how hard the player is to tackle'],
  ['tightPos', 'Tight Possession', 'Attack', 'Turn rate with the ball at the feet'],
  ['lowPass', 'Low Pass', 'Attack', 'Accuracy of ground passes and through balls'],
  ['loftPass', 'Lofted Pass', 'Attack', 'Accuracy of lofted passes and crosses'],
  ['finish', 'Finishing', 'Attack', 'Shot accuracy'],
  ['heading', 'Heading', 'Attack', 'Header accuracy, and who wins the header'],
  ['setPiece', 'Set Piece Taking', 'Attack', 'Accuracy of free kicks, corners and penalties'],
  ['curl', 'Curl', 'Attack', 'Bend on finesse shots, free kicks and crosses'],
  ['defAwa', 'Defensive Awareness', 'Defence', 'How tightly a player marks, and how hard he is to fool with a feint'],
  ['tackling', 'Tackling', 'Defence', 'Chance that a tackle wins the ball'],
  ['aggr', 'Aggression', 'Defence', 'How often the computer goes in for the tackle'],
  ['defEng', 'Defensive Engagement', 'Defence', 'How far out the computer starts to press'],
  ['gkAwa', 'GK Awareness', 'Goalkeeping', 'Positioning, and when to come off the line'],
  ['gkCatch', 'GK Catching', 'Goalkeeping', 'Holds the shot instead of parrying it'],
  ['gkParry', 'GK Parrying', 'Goalkeeping', 'Pushes saves wide instead of back into play'],
  ['gkReflex', 'GK Reflexes', 'Goalkeeping', 'Saves from close range, and reading penalties'],
  ['gkReach', 'GK Reach', 'Goalkeeping', 'How far a dive covers'],
  ['speed', 'Speed', 'Physical', 'Top running speed'],
  ['accel', 'Acceleration', 'Physical', 'How fast top speed is reached'],
  ['kickPow', 'Kicking Power', 'Physical', 'Shot speed and the range of long passes'],
  ['jump', 'Jumping', 'Physical', 'How high a player reaches for a header'],
  ['physical', 'Physical Contact', 'Physical', 'Shielding, shoulder charges and holding off a tackle'],
  ['balance', 'Balance', 'Physical', 'Recovers faster after being beaten or bumped'],
  ['stamina', 'Stamina', 'Physical', 'How slowly match fitness drains'],
].map(([k, name, group, use]) => ({ k, name, group, use }));
export const STAT_KEYS = STATS.map(s => s.k);
/* Four characteristics. Weak foot is 1–4, Form is 1–8, Injury Resistance is 1–3. */
export const TRAITS = [
  ['wfUse', 'Weak Foot Usage', 4, 'How wide an angle the player will take on with the weaker foot'],
  ['wfAcc', 'Weak Foot Accuracy', 4, 'How much a kick with the weaker foot loses'],
  ['form', 'Form', 8, 'How steady the condition arrow is from match to match'],
  ['injRes', 'Injury Resistance', 3, 'How much fitness a foul costs'],
].map(([k, name, max, use]) => ({ k, name, max, use }));

// ------------------------------------------------------------------ positions
export const POSITIONS = ['GK', 'CB', 'LB', 'RB', 'DMF', 'CMF', 'LMF', 'RMF', 'AMF', 'LWF', 'RWF', 'SS', 'CF'];
export const LINE = { GK: 'GK', CB: 'DF', LB: 'DF', RB: 'DF', DMF: 'MF', CMF: 'MF', LMF: 'MF', RMF: 'MF', AMF: 'MF', LWF: 'FW', RWF: 'FW', SS: 'FW', CF: 'FW' };
const LINE_ORDER = { GK: 0, DF: 1, MF: 2, FW: 3 };
/* What a typical player in each position looks like, in STAT_KEYS order. */
const BASE = {
  GK: [45, 58, 48, 48, 62, 64, 40, 45, 50, 50, 50, 45, 50, 50, 82, 80, 81, 83, 82, 60, 60, 76, 78, 76, 62, 66],
  CB: [52, 66, 58, 56, 68, 66, 48, 80, 52, 52, 84, 84, 80, 82, 40, 40, 40, 40, 40, 70, 66, 74, 82, 84, 66, 74],
  LB: [68, 74, 74, 72, 74, 74, 56, 62, 62, 68, 76, 76, 74, 78, 40, 40, 40, 40, 40, 82, 82, 72, 70, 70, 76, 84],
  DMF: [64, 76, 70, 72, 80, 78, 58, 70, 62, 64, 82, 82, 80, 82, 40, 40, 40, 40, 40, 72, 70, 76, 74, 80, 74, 84],
  CMF: [74, 80, 76, 78, 82, 80, 66, 64, 68, 70, 72, 72, 72, 74, 40, 40, 40, 40, 40, 74, 74, 76, 68, 72, 78, 84],
  LMF: [76, 80, 80, 78, 78, 78, 68, 58, 68, 74, 62, 62, 64, 68, 40, 40, 40, 40, 40, 82, 82, 74, 64, 66, 80, 82],
  AMF: [82, 84, 82, 84, 84, 78, 74, 56, 74, 78, 50, 50, 56, 58, 40, 40, 40, 40, 40, 76, 78, 76, 60, 62, 84, 74],
  LWF: [82, 82, 86, 84, 74, 72, 76, 56, 68, 78, 46, 46, 54, 56, 40, 40, 40, 40, 40, 88, 88, 76, 62, 62, 84, 76],
  SS: [84, 82, 82, 82, 76, 70, 82, 66, 68, 74, 46, 46, 56, 56, 40, 40, 40, 40, 40, 82, 84, 80, 68, 68, 80, 74],
  CF: [86, 78, 76, 76, 68, 62, 86, 80, 62, 68, 42, 42, 58, 54, 40, 40, 40, 40, 40, 80, 80, 84, 80, 80, 74, 74],
};
BASE.RB = BASE.LB; BASE.RMF = BASE.LMF; BASE.RWF = BASE.LWF;
/* How much each stat counts toward the overall rating in a position. */
const WEIGHT = {
  GK: { gkAwa: 3, gkCatch: 2, gkParry: 2, gkReflex: 3, gkReach: 3, jump: 1, lowPass: 0.5 },
  CB: { defAwa: 3, tackling: 3, physical: 2, heading: 2, jump: 1.5, aggr: 1, defEng: 1.5, speed: 1, lowPass: 1 },
  LB: { defAwa: 2, tackling: 2, speed: 2, accel: 1.5, stamina: 2, loftPass: 1.5, lowPass: 1, drib: 1, defEng: 1, ballCtl: 1 },
  DMF: { defAwa: 3, tackling: 2.5, lowPass: 2, ballCtl: 1.5, physical: 1.5, stamina: 1.5, defEng: 1.5, loftPass: 1, aggr: 1 },
  CMF: { lowPass: 3, ballCtl: 2.5, loftPass: 1.5, stamina: 2, drib: 1.5, tightPos: 1.5, offAwa: 1.5, defAwa: 1.5, tackling: 1 },
  LMF: { speed: 2, accel: 1.5, drib: 2.5, ballCtl: 2, lowPass: 1.5, loftPass: 2, stamina: 1.5, offAwa: 1.5, curl: 1 },
  AMF: { offAwa: 2.5, ballCtl: 3, lowPass: 3, drib: 2.5, tightPos: 2.5, finish: 1.5, curl: 1, balance: 1 },
  LWF: { speed: 3, accel: 2.5, drib: 3, tightPos: 2, ballCtl: 2, finish: 2, offAwa: 2, curl: 1, balance: 1 },
  SS: { offAwa: 3, finish: 3, ballCtl: 2, drib: 2, speed: 1.5, accel: 1.5, lowPass: 1.5, tightPos: 1.5, kickPow: 1 },
  CF: { finish: 3.5, offAwa: 3, heading: 1.5, physical: 1.5, speed: 1.5, accel: 1.5, kickPow: 1.5, ballCtl: 1.5, jump: 1 },
};
WEIGHT.RB = WEIGHT.LB; WEIGHT.RMF = WEIGHT.LMF; WEIGHT.RWF = WEIGHT.LWF;
const PHYSICAL = new Set(['speed', 'accel', 'kickPow', 'jump', 'physical', 'balance', 'stamina']);

// ------------------------------------------------------------------ playing styles
/* Behaviour numbers read by the engine (formationTarget, runs, pressing):
   adv      metres further forward when the team attacks (negative holds back)
   advDef   metres further forward when the team defends
   wide     >0 hugs the touchline, <0 comes inside
   runs     how often the player runs in behind (multiplies the team playstyle's runs per minute)
   drop     0–1, comes short toward the ball carrier to receive
   press    multiplies how eagerly the player presses
   flags    holdLine, box, anchor, hold, late, decoy, holdUp, sweep */
export const NEUTRAL_STYLE = { adv: 0, advDef: 0, wide: 0, runs: 0.6, drop: 0, press: 1 };
const st = (pos, desc, b) => ({ pos, desc, b: { ...NEUTRAL_STYLE, ...b } });
export const STYLES = {
  'Attacking Goalkeeper': st(['GK'], 'Sweeps behind the defence to cut out through balls', { sweep: 1 }),
  'Defensive Goalkeeper': st(['GK'], 'Stays on the line; positioning and shot-stopping', { sweep: 0 }),
  'Build Up': st(['CB'], 'Plays out from the back instead of clearing', { adv: 2, drop: 0.3 }),
  'Extra Frontman': st(['CB'], 'Pushes forward to join attacks late on', { adv: 3, late: 1, runs: 0.4 }),
  'The Destroyer': st(['CB', 'DMF', 'CMF'], 'Presses, tackles and wins physical duels', { press: 1.5, advDef: 1.5 }),
  'Attacking Full-back': st(['LB', 'RB'], 'Overlaps down the flank for width', { adv: 15, wide: 1, runs: 1.2 }),
  'Defensive Full-back': st(['LB', 'RB'], 'Stays back; rarely joins attacks', { adv: -4, hold: 1, runs: 0 }),
  'Full-back Finisher': st(['LB', 'RB'], 'Cuts inside toward the box', { adv: 13, wide: -0.6, runs: 1 }),
  'Anchor Man': st(['DMF'], 'Screens the back line; rarely runs forward', { adv: -6, anchor: 1, runs: 0 }),
  'Orchestrator': st(['DMF', 'CMF'], 'Sits deep and sets the tempo with passing', { adv: -3, drop: 0.5, runs: 0.2 }),
  'Box-to-Box': st(['DMF', 'CMF', 'LMF', 'RMF'], 'Covers both boxes', { adv: 6, advDef: -3, runs: 0.8, press: 1.2 }),
  'Classic No. 10': st(['AMF', 'SS'], 'Creates through passing and position, not running', { drop: 0.35, runs: 0.2, press: 0.5 }),
  'Hole Player': st(['AMF', 'SS', 'CMF', 'LMF', 'RMF'], 'Bursts into space to reach scoring positions', { adv: 6, runs: 1.6 }),
  'Creative Playmaker': st(['AMF', 'SS', 'LWF', 'RWF', 'LMF', 'RMF'], 'Drifts into pockets to receive and create', { drop: 0.45, wide: -0.5, runs: 0.5 }),
  'Roaming Flank': st(['LWF', 'RWF', 'LMF', 'RMF'], 'Leaves the touchline to combine centrally', { wide: -0.8, drop: 0.3, runs: 0.7 }),
  'Cross Specialist': st(['LWF', 'RWF', 'LMF', 'RMF'], 'Holds width and crosses', { wide: 1, adv: 3, runs: 0.5 }),
  'Prolific Winger': st(['LWF', 'RWF'], 'Stays wide, then drives at goal', { wide: 0.7, adv: 6, runs: 1.4 }),
  'Goal Poacher': st(['CF'], "Lives on the last defender's shoulder and runs in behind", { adv: 8, holdLine: 1, runs: 2 }),
  'Fox in the Box': st(['CF'], 'Stays in the box for crosses and rebounds', { adv: 8, box: 1, runs: 0.8 }),
  'Target Man': st(['CF'], 'Holds the ball up and brings others in', { adv: 3, drop: 0.25, runs: 0.3, holdUp: 1 }),
  'Deep-lying Forward': st(['CF', 'SS'], 'Drops short to link with midfield', { adv: -5, drop: 0.6, runs: 0.4 }),
  'Dummy Runner': st(['CF', 'SS', 'AMF'], 'Decoy runs that pull defenders away', { adv: 4, decoy: 1, runs: 1.4 }),
};
const STYLE_STATS = {
  'Goal Poacher': { offAwa: 5, speed: 4, accel: 5, finish: 3, physical: -6, heading: -4 },
  'Fox in the Box': { finish: 4, heading: 4, offAwa: 4, speed: -4, loftPass: -4 },
  'Target Man': { physical: 8, heading: 7, jump: 6, speed: -9, accel: -9, drib: -5, balance: -4 },
  'Deep-lying Forward': { lowPass: 8, ballCtl: 5, tightPos: 4, speed: -4, heading: -5, finish: -3 },
  'Dummy Runner': { offAwa: 4, stamina: 8, speed: 3, finish: -4 },
  'Prolific Winger': { finish: 5, speed: 3, curl: 4, loftPass: -4, defAwa: -4 },
  'Roaming Flank': { lowPass: 6, ballCtl: 4, tightPos: 3, speed: -3, curl: 3 },
  'Cross Specialist': { loftPass: 9, curl: 5, stamina: 4, finish: -6, tightPos: -3 },
  'Creative Playmaker': { lowPass: 4, tightPos: 4, drib: 3, physical: -5, defAwa: -4 },
  'Classic No. 10': { lowPass: 6, loftPass: 5, curl: 4, setPiece: 6, speed: -8, accel: -6, stamina: -8, defEng: -8 },
  'Hole Player': { offAwa: 6, finish: 6, accel: 3, lowPass: -4, defAwa: -3 },
  'Box-to-Box': { stamina: 9, tackling: 4, defAwa: 3, finish: 2, tightPos: -3 },
  'Orchestrator': { lowPass: 6, loftPass: 7, ballCtl: 3, speed: -6, accel: -5, offAwa: -4 },
  'Anchor Man': { defAwa: 5, physical: 4, defEng: 4, offAwa: -10, drib: -5, speed: -3 },
  'The Destroyer': { tackling: 5, aggr: 8, physical: 5, defEng: 5, lowPass: -6, ballCtl: -5, balance: -2 },
  'Build Up': { lowPass: 9, loftPass: 8, ballCtl: 7, aggr: -6, physical: -3 },
  'Extra Frontman': { heading: 6, jump: 5, finish: 8, offAwa: 10, speed: 2, lowPass: -3 },
  'Attacking Full-back': { speed: 3, loftPass: 5, offAwa: 6, drib: 3, defAwa: -5, tackling: -4 },
  'Defensive Full-back': { defAwa: 6, tackling: 6, physical: 5, offAwa: -10, drib: -6, loftPass: -4 },
  'Full-back Finisher': { finish: 10, offAwa: 8, kickPow: 5, curl: 3, defAwa: -4, loftPass: -3 },
  'Attacking Goalkeeper': { gkAwa: 4, lowPass: 8, speed: 6, gkCatch: -3, gkReach: -2 },
  'Defensive Goalkeeper': { gkReflex: 3, gkCatch: 3, gkReach: 2, lowPass: -4 },
};
const STYLE_SKILLS = {
  'Goal Poacher': ['First-time Shot', 'Acrobatic Finishing', 'Attack Trigger'],
  'Fox in the Box': ['Heading', 'First-time Shot', 'Acrobatic Finishing'],
  'Target Man': ['Heading', 'Bullet Header', 'Aerial Superiority', 'Fighting Spirit'],
  'Deep-lying Forward': ['One-touch Pass', 'Through Passing', 'Weighted Pass'],
  'Dummy Runner': ['Attack Trigger', 'One-touch Pass', 'Track Back'],
  'Prolific Winger': ['Long-range Curler', 'Acceleration Burst', 'Chip Shot Control'],
  'Roaming Flank': ['Through Passing', 'Outside Curler', 'Sole Control'],
  'Cross Specialist': ['Pinpoint Crossing', 'Edged Crossing', 'Low Lofted Pass'],
  'Creative Playmaker': ['Through Passing', 'Weighted Pass', 'No Look Pass', 'Visionary Pass'],
  'Classic No. 10': ['Through Passing', 'Weighted Pass', 'Long-range Shooting', 'Game-changing Pass'],
  'Hole Player': ['First-time Shot', 'Long-range Shooting', 'One-touch Pass'],
  'Box-to-Box': ['Track Back', 'Interception', 'Fighting Spirit', 'Long-range Shooting'],
  'Orchestrator': ['One-touch Pass', 'Weighted Pass', 'Game-changing Pass', 'Visionary Pass'],
  'Anchor Man': ['Interception', 'Blocker', 'Man Marking'],
  'The Destroyer': ['Sliding Tackle', 'Man Marking', 'Blocker', 'Fighting Spirit'],
  'Build Up': ['Interception', 'Weighted Pass', 'Game-changing Pass'],
  'Extra Frontman': ['Heading', 'Aerial Superiority', 'Acrobatic Clearance'],
  'Attacking Full-back': ['Pinpoint Crossing', 'Track Back', 'Acceleration Burst'],
  'Defensive Full-back': ['Man Marking', 'Interception', 'Sliding Tackle'],
  'Full-back Finisher': ['Long-range Shooting', 'Track Back', 'One-touch Pass'],
  'Attacking Goalkeeper': ['GK Long Throw', 'GK Low Punt'],
  'Defensive Goalkeeper': ['GK High Punt', 'GK Penalty Saver', 'GK Directing Defence'],
};

/* AI playing styles: what a computer-controlled player does on the ball. */
export const AI_STYLES = {
  'Trickster': { desc: 'Feints and step-overs', b: { trick: 1 }, stats: { drib: 4, tightPos: 4 } },
  'Mazing Run': { desc: 'Dribbles through traffic', b: { maze: 1 }, stats: { drib: 5, balance: 4 } },
  'Speeding Bullet': { desc: 'Pace into space', b: { knock: 1 }, stats: { speed: 4, accel: 4, physical: -4 } },
  'Incisive Run': { desc: 'Cuts inside', b: { cutIn: 1 }, stats: { accel: 3, finish: 2 } },
  'Long Ball Expert': { desc: 'Switches play', b: { longBall: 1 }, stats: { loftPass: 5 } },
  'Early Crosser': { desc: 'Crosses early from deep', b: { earlyCross: 1 }, stats: { loftPass: 4, curl: 3 } },
  'Long Ranger': { desc: 'Shoots from distance', b: { longShot: 1 }, stats: { kickPow: 6 } },
};

// ------------------------------------------------------------------ skills
/* All 55 skills. `fx` is what the skill does in this engine; null means it is listed but has no effect yet. */
const sk = (cat, list) => list.map(([name, fx]) => [name, { cat, fx }]);
export const SKILLS = Object.fromEntries([
  ...sk('Dribbling', [
    ['Scissors Feint', 'Unlocks the Step-over'], ['Double Touch', 'Unlocks the Double Touch'], ['Flip Flap', 'Unlocks the Elastico'],
    ['Marseille Turn', 'Unlocks the Roulette'], ['Sombrero', 'Unlocks the Rainbow Flick'], ['Chop Turn', 'Unlocks the Heel Chop'],
    ['Cut Behind & Turn', 'Drag-back is quicker and fools more defenders'], ['Scotch Move', null],
    ['Sole Control', 'Shorter wait between skill moves'], ['Momentum Dribbling', 'Turns faster with the ball at speed'],
    ['Acceleration Burst', 'Longer burst after a knock-on'],
  ]),
  ...sk('Passing', [
    ['One-touch Pass', 'First-time passes lose no accuracy'], ['Through Passing', 'More accurate through balls'],
    ['Weighted Pass', 'Passes arrive softer and are easier to control'], ['Pinpoint Crossing', 'More accurate crosses from wide'],
    ['Edged Crossing', 'More accurate Stunning crosses'], ['Outside Curler', 'No weak-foot penalty on passes'],
    ['Rabona', 'Halves the weak-foot penalty on shots and lofted passes'], ['No Look Pass', 'No penalty for passing against the way he faces'],
    ['Game-changing Pass', 'More accurate long lofted passes'], ['Visionary Pass', null],
    ['Phenomenal Pass', 'Passes lose no accuracy under pressure'], ['Low Lofted Pass', 'Lofted passes fly lower and arrive sooner'],
    ['Heel Trick', null],
  ]),
  ...sk('Shooting', [
    ['Heading', 'More accurate headers'], ['Bullet Header', 'Faster headers'], ['Long-range Curler', 'More accurate finesse shots from outside the box'],
    ['Blitz Curler', 'Faster finesse shots'], ['Chip Shot Control', 'More accurate chip shots'], ['Knuckle Shot', 'Stunning shots swerve and are harder to save'],
    ['Dipping Shot', 'Stunning shots and free kicks dip sharply'], ['Rising Shot', 'Slightly faster power shots'],
    ['Long-range Shooting', 'More accurate from over 20 metres'], ['Acrobatic Finishing', 'More accurate volleys'],
    ['First-time Shot', 'More accurate first-time shots'], ['Phenomenal Finishing', 'Shots lose no accuracy under pressure'],
  ]),
  ...sk('Defending', [
    ['Man Marking', 'Marks tighter'], ['Track Back', 'Forwards drop deeper when defending'], ['Interception', 'Longer reach to cut out passes'],
    ['Blocker', 'Blocks more shots'], ['Aerial Superiority', 'Wins more headers'], ['Sliding Tackle', 'Slide tackles win more and foul less'],
    ['Acrobatic Clearance', null],
  ]),
  ...sk('Goalkeeping', [
    ['GK Low Punt', 'Goal kicks fly lower and faster'], ['GK High Punt', 'Goal kicks travel further'], ['GK Long Throw', 'Quick, long passes out of the hands'],
    ['GK Penalty Saver', 'Reads penalties more often'], ['GK Directing Defence', null],
  ]),
  ...sk('Other', [
    ['Long Throw', 'Longer throw-ins'], ['Penalty Specialist', 'More accurate penalties'], ['Gamesmanship', 'Wins more fouls'],
    ['Attack Trigger', 'Makes more runs in behind'], ['Captaincy', 'As captain, the whole team tires more slowly'],
    ['Super-sub', null], ['Fighting Spirit', 'Half the penalty from fatigue'],
  ]),
].map(([name, v]) => [name, v]));

// ------------------------------------------------------------------ skill moves
/* A move needs enough skill-move stars and, where one is named, the matching skill. */
export const MOVES = {
  knockon: { name: 'Knock-on', stars: 1, skill: null, dur: 0.22, slot: false, how: 'Double-tap Sprint' },
  fakeshot: { name: 'Fake Shot', stars: 1, skill: null, dur: 0.34, slot: true, how: 'Swipe left off Shoot' },
  ballroll: { name: 'Ball Roll', stars: 2, skill: null, dur: 0.34, slot: true },
  bodyfeint: { name: 'Body Feint', stars: 2, skill: null, dur: 0.3, slot: true },
  dragback: { name: 'Drag-back', stars: 2, skill: null, dur: 0.42, slot: true },
  stepover: { name: 'Step-over', stars: 2, skill: 'Scissors Feint', dur: 0.5, slot: true },
  chop: { name: 'Heel Chop', stars: 3, skill: 'Chop Turn', dur: 0.3, slot: true },
  roulette: { name: 'Roulette', stars: 3, skill: 'Marseille Turn', dur: 0.6, slot: true },
  doubletouch: { name: 'Double Touch', stars: 3, skill: 'Double Touch', dur: 0.34, slot: true },
  rainbow: { name: 'Rainbow Flick', stars: 4, skill: 'Sombrero', dur: 0.32, slot: true },
  elastico: { name: 'Elastico', stars: 5, skill: 'Flip Flap', dur: 0.38, slot: true },
};
export const SLOT_DIRS = ['up', 'down', 'left', 'right'];
export const DEFAULT_MOVES = { up: 'stepover', down: 'dragback', left: 'ballroll', right: 'roulette' };
export function canDo(pl, id) { const m = MOVES[id]; return !!m && pl.stars >= m.stars && (!m.skill || pl.skills.includes(m.skill)); }
export function moveNeeds(id) { const m = MOVES[id]; return m.stars + '★' + (m.skill ? ' + ' + m.skill : ''); }

// ------------------------------------------------------------------ formations
/* Each slot: position, depth (−1 own goal line … 0 halfway) and width (−1 left touchline … +1 right). */
const B4 = [['LB', -0.66, -0.62], ['CB', -0.72, -0.2], ['CB', -0.72, 0.2], ['RB', -0.66, 0.62]];
const B5 = [['LB', -0.6, -0.66], ['CB', -0.72, -0.3], ['CB', -0.75, 0], ['CB', -0.72, 0.3], ['RB', -0.6, 0.66]];
const GKS = [['GK', -0.95, 0]];
export const FORMATIONS = {
  '4-2-3-1': { why: 'The safe all-rounder: a double pivot protects the back four', slots: [...GKS, ...B4, ['DMF', -0.5, -0.17], ['DMF', -0.5, 0.17], ['LMF', -0.26, -0.58], ['AMF', -0.26, 0], ['RMF', -0.26, 0.58], ['CF', -0.05, 0]] },
  '4-3-3': { why: 'Midfield triangles to escape the press; full-backs overlap', slots: [...GKS, ...B4, ['CMF', -0.4, -0.28], ['DMF', -0.52, 0], ['CMF', -0.4, 0.28], ['LWF', -0.12, -0.6], ['CF', -0.05, 0], ['RWF', -0.12, 0.6]] },
  '4-2-1-3': { why: 'A 10 feeds three forwards straight after a turnover', slots: [...GKS, ...B4, ['DMF', -0.5, -0.18], ['DMF', -0.5, 0.18], ['AMF', -0.3, 0], ['LWF', -0.12, -0.6], ['CF', -0.05, 0], ['RWF', -0.12, 0.6]] },
  '4-3-1-2': { why: 'Two strikers and a 10; narrow, so full-backs give the width', slots: [...GKS, ...B4, ['CMF', -0.44, -0.34], ['DMF', -0.52, 0], ['CMF', -0.44, 0.34], ['AMF', -0.26, 0], ['CF', -0.06, -0.17], ['CF', -0.06, 0.17]] },
  '5-2-1-2': { why: 'A deep, compact block that breaks through two strikers', slots: [...GKS, ...B5, ['CMF', -0.44, -0.2], ['CMF', -0.44, 0.2], ['AMF', -0.26, 0], ['CF', -0.06, -0.17], ['CF', -0.06, 0.17]] },
  '5-2-3': { why: 'Wing-backs plus a front three', slots: [...GKS, ...B5, ['CMF', -0.44, -0.2], ['CMF', -0.44, 0.2], ['LWF', -0.12, -0.56], ['CF', -0.05, 0], ['RWF', -0.12, 0.56]] },
  '4-4-2': { why: 'Wingers and full-backs double up on the flanks', slots: [...GKS, ...B4, ['LMF', -0.36, -0.6], ['CMF', -0.44, -0.18], ['CMF', -0.44, 0.18], ['RMF', -0.36, 0.6], ['CF', -0.06, -0.17], ['CF', -0.06, 0.17]] },
};

// ------------------------------------------------------------------ team playstyles
/* line      0 deep … 1 high defensive line
   compact   0 loose … 1 tight block when defending
   pressDist metres from the ball carrier at which the nearest defender goes to press
   passLen   −1 short and patient … +1 long and direct (computer passing, and how far support stands)
   runs      runs in behind per forward per minute
   cp        counter-press window: seconds of extra pressing right after losing the ball
   width     attacking width
   overload  0–1, how far the team shifts to the ball side when attacking */
export const NEUTRAL_PLAY = { line: 0.5, compact: 0.6, pressDist: 10, passLen: 0, runs: 8, cp: 1.5, width: 0.94, overload: 0 };
export const PLAYSTYLES = {
  possession: { name: 'Possession Game', inPoss: 'Compact shape and short passes', outPoss: 'High line, quick counter-press', line: 0.75, compact: 0.7, pressDist: 14, passLen: -0.8, runs: 5, cp: 4, width: 0.86, overload: 0 },
  quickCounter: { name: 'Quick Counter', inPoss: 'Vertical surge right after winning the ball', outPoss: 'High line; swarms the ball carrier', line: 0.8, compact: 0.5, pressDist: 18, passLen: 0.15, runs: 14, cp: 5, width: 0.92, overload: 0 },
  longBallCounter: { name: 'Long Ball Counter', inPoss: 'Long balls to runners breaking the line', outPoss: 'Deep, compact block; conservative pressing', line: 0.2, compact: 0.88, pressDist: 7, passLen: 0.8, runs: 12, cp: 0, width: 0.84, overload: 0 },
  outWide: { name: 'Out Wide', inPoss: 'Width, overlaps and early crosses', outPoss: 'Protects the channels; wingers drop back', line: 0.5, compact: 0.45, pressDist: 10, passLen: 0.2, runs: 8, cp: 1.5, width: 1.12, overload: 0 },
  longBall: { name: 'Long Ball', inPoss: 'Direct balls to a focal striker', outPoss: 'Deeper line; contests aerials', line: 0.35, compact: 0.6, pressDist: 9, passLen: 1, runs: 7, cp: 1, width: 0.96, overload: 0 },
  overload: { name: 'Overload', inPoss: 'Shifts players to the ball side', outPoss: 'Compact; closes the carrier fast', line: 0.6, compact: 0.9, pressDist: 13, passLen: -0.4, runs: 8, cp: 3, width: 0.82, overload: 1 },
};
export const PLAY_KEYS = Object.keys(PLAYSTYLES);
/* A manager's proficiency (50–89) scales how much of a playstyle the team actually plays. */
export const profFactor = prof => clamp((prof - 40) / 49, 0.2, 1);
export function tacticParams(playstyle, prof) {
  const P = PLAYSTYLES[playstyle], f = profFactor(prof), out = {};
  for (const k of Object.keys(NEUTRAL_PLAY)) out[k] = lerp(NEUTRAL_PLAY[k], P[k], f);
  return out;
}

// ------------------------------------------------------------------ link-up plays
/* Scripted combinations a manager unlocks at proficiency 89 in the active playstyle. */
export const LINKUPS = {
  overTop: { name: 'Over-the-Top Pass', desc: 'A deep player lofts the ball over the line for a striker running in behind', from: ['CB', 'DMF', 'LB', 'RB'], to: ['CF', 'SS'], kind: 'loft' },
  breakthrough: { name: 'Breakthrough Pass', desc: 'A midfielder slides a through ball to a forward on a diagonal run', from: ['AMF', 'CMF', 'SS', 'DMF'], to: ['CF', 'LWF', 'RWF', 'SS'], kind: 'through' },
  buildDeep: { name: 'Build-Up (Deep)', desc: 'A midfielder drops beside the centre-backs to start the move', from: ['CB', 'GK'], to: ['DMF', 'CMF'], kind: 'pass' },
  centring: { name: 'Aggressive Centring', desc: 'When a wide player has the ball high up, a striker attacks the near post for the cross', from: ['LWF', 'RWF', 'LMF', 'RMF', 'LB', 'RB'], to: ['CF', 'SS'], kind: 'loft' },
};
export const LINKUP_AT = 89;

// ------------------------------------------------------------------ managers (invented names)
export const MANAGERS = [
  { id: 'bankole', name: 'Ade Bankole', note: 'Sits deep and springs two strikers', prof: { possession: 62, quickCounter: 78, longBallCounter: 89, outWide: 66, longBall: 80, overload: 58 }, boost: ['finish', 'defAwa'], affinity: 'DF', linkUp: 'overTop' },
  { id: 'verhoeven', name: 'Ilse Verhoeven', note: 'Keeps the ball and wins it back at once', prof: { possession: 89, quickCounter: 82, longBallCounter: 55, outWide: 70, longBall: 52, overload: 80 }, boost: ['speed', 'aggr'], affinity: 'MF', linkUp: 'buildDeep' },
  { id: 'ridl', name: 'Tomas Ridl', note: 'Wins it high and goes straight for goal', prof: { possession: 74, quickCounter: 89, longBallCounter: 70, outWide: 84, longBall: 60, overload: 66 }, boost: ['ballCtl', 'finish'], affinity: 'Young', linkUp: 'breakthrough' },
  { id: 'okonjo', name: 'Sade Okonjo', note: 'Stretches the pitch and floods the box', prof: { possession: 68, quickCounter: 72, longBallCounter: 64, outWide: 89, longBall: 76, overload: 60 }, boost: ['loftPass', 'heading'], affinity: 'FW', linkUp: 'centring' },
  { id: 'grange', name: 'Hollis Grange', note: 'Direct football to a big striker', prof: { possession: 50, quickCounter: 68, longBallCounter: 82, outWide: 78, longBall: 88, overload: 54 }, boost: ['physical', 'stamina'], affinity: 'Veteran', linkUp: null },
  { id: 'delmar', name: 'Rafa Delmar', note: 'Crowds one side, then switches', prof: { possession: 84, quickCounter: 70, longBallCounter: 52, outWide: 62, longBall: 50, overload: 89 }, boost: ['tightPos', 'lowPass'], affinity: 'Star', linkUp: 'breakthrough' },
  { id: 'morrow', name: 'Kenji Morrow', note: 'No favourite system: steady at everything', prof: { possession: 80, quickCounter: 80, longBallCounter: 80, outWide: 80, longBall: 80, overload: 80 }, boost: ['stamina', 'balance'], affinity: 'Young', linkUp: null },
];
export const managerById = id => MANAGERS.find(m => m.id === id) || MANAGERS[0];

// ------------------------------------------------------------------ individual instructions
export const INSTR = {
  att: { defensive: ['Defensive', 'Stays back when the team attacks'], attacking: ['Attacking', 'Joins every attack and runs more'], anchoring: ['Anchoring', 'Stays in the middle of the pitch'] },
  def: { tight: ['Tight Marking', 'Sticks close to the nearest attacker'], man: ['Man Marking', "Shadows the other side's best attacker"], counter: ['Counter Attack', 'Stays forward when the team defends'], deep: ['Deep Line', 'Drops into the back line'] },
};
export const LEVELS = ['Full defence', 'Defensive', 'Balanced', 'Attacking', 'Full attack'];

// ------------------------------------------------------------------ squads
const P = (num, name, pos, fam, style, ai, o = {}) => ({ num, name, pos, fam, style, ai, foot: 1, age: 26, tier: 0, stars: 2, wfUse: 2, wfAcc: 2, form: 5, injRes: 2, plus: [], minus: [], ...o });
const RAW = [
  {
    id: 'eko', name: 'Eko Stars', short: 'EKO', shirt: 0x16a35a, shorts: 0xf2f4f7, gk: 0xf5c400, css: '#1fbf6a',
    players: [
      P(1, 'Okafor', 'GK', [], 'Defensive Goalkeeper', null, { age: 31, stars: 1, form: 7, injRes: 3 }),
      P(3, 'Nwosu', 'LB', ['CB', 'LMF'], 'Defensive Full-back', null, { foot: -1, age: 29, form: 6 }),
      P(5, 'Bello', 'CB', ['DMF'], 'The Destroyer', null, { age: 28, stars: 1, tier: 2, wfAcc: 1, plus: ['Captaincy'] }),
      P(4, 'Eze', 'CB', ['DMF', 'RB'], 'Build Up', 'Long Ball Expert', { age: 24, wfUse: 3, wfAcc: 3 }),
      P(2, 'Adeyemi', 'RB', ['RMF', 'RWF'], 'Attacking Full-back', 'Early Crosser', { age: 23, stars: 3, form: 4 }),
      P(6, 'Ibe', 'DMF', ['CB', 'CMF'], 'Anchor Man', null, { age: 30, stars: 2, injRes: 3, form: 7 }),
      P(8, 'Balogun', 'CMF', ['DMF', 'AMF', 'RMF'], 'Box-to-Box', 'Long Ranger', { age: 26, stars: 3, tier: 1, wfUse: 3, wfAcc: 3 }),
      P(10, 'Akinola', 'AMF', ['SS', 'CMF', 'LMF'], 'Classic No. 10', 'Long Ranger', { age: 29, stars: 4, tier: 3, wfUse: 3, wfAcc: 3, form: 3, plus: ['Double Touch', 'Penalty Specialist', 'Dipping Shot', 'Phenomenal Pass'] }),
      P(11, 'Uche', 'LWF', ['LMF', 'SS'], 'Roaming Flank', 'Trickster', { age: 21, stars: 5, tier: 2, wfUse: 4, wfAcc: 3, form: 2, injRes: 1, plus: ['Gamesmanship', 'Momentum Dribbling'] }),
      P(7, 'Lawal', 'RWF', ['RMF', 'SS'], 'Prolific Winger', 'Speeding Bullet', { foot: -1, age: 24, stars: 4, tier: 1, wfUse: 1, wfAcc: 1, minus: ['Sombrero'], plus: ['Blitz Curler'] }),
      P(9, 'Obi', 'CF', ['SS'], 'Goal Poacher', 'Incisive Run', { age: 25, stars: 3, tier: 3, form: 6, plus: ['Phenomenal Finishing', 'Rising Shot'] }),
      P(16, 'Danjuma', 'GK', [], 'Attacking Goalkeeper', null, { age: 22, stars: 1, tier: -2, form: 3 }),
      P(15, 'Okonkwo', 'CB', ['RB'], 'Extra Frontman', null, { age: 33, stars: 1, tier: -1, form: 6, plus: ['Bullet Header'] }),
      P(14, 'Salako', 'CMF', ['DMF', 'AMF'], 'Orchestrator', 'Long Ball Expert', { foot: -1, age: 32, stars: 2, wfAcc: 3, form: 8, plus: ['Pinpoint Crossing'] }),
      P(17, 'Ajayi', 'SS', ['AMF', 'CF', 'RWF'], 'Hole Player', 'Mazing Run', { age: 20, stars: 4, tier: -1, form: 2 }),
      P(19, 'Emenike', 'CF', [], 'Target Man', null, { age: 30, stars: 2, tier: 1, wfAcc: 1, injRes: 3, plus: ['Knuckle Shot'] }),
    ],
  },
  {
    id: 'nbk', name: 'Northbank', short: 'NBK', shirt: 0xd23440, shorts: 0x1a2040, gk: 0x7b5cff, css: '#e3444f',
    players: [
      P(1, 'Hughes', 'GK', [], 'Attacking Goalkeeper', null, { age: 27, stars: 1, tier: 1, form: 5 }),
      P(3, 'Mensah', 'LB', ['LMF', 'LWF'], 'Attacking Full-back', 'Speeding Bullet', { foot: -1, age: 24, stars: 3, tier: 1 }),
      P(5, 'Patel', 'CB', ['DMF'], 'Build Up', 'Long Ball Expert', { age: 27, wfUse: 3, wfAcc: 3, form: 6 }),
      P(4, 'Walsh', 'CB', ['RB'], 'The Destroyer', null, { age: 31, stars: 1, tier: 2, wfAcc: 1, injRes: 3, plus: ['Captaincy', 'Aerial Superiority'] }),
      P(2, 'Clarke', 'RB', ['RMF', 'CB'], 'Full-back Finisher', null, { age: 26, stars: 3 }),
      P(6, 'Reid', 'DMF', ['CMF', 'CB'], 'Orchestrator', 'Long Ball Expert', { age: 30, stars: 2, tier: 2, wfUse: 3, wfAcc: 4, form: 7 }),
      P(8, 'Doyle', 'CMF', ['DMF', 'RMF'], 'Box-to-Box', null, { age: 25, stars: 3, form: 6, injRes: 3 }),
      P(10, 'Okoro', 'AMF', ['SS', 'LWF', 'CMF'], 'Creative Playmaker', 'Mazing Run', { foot: -1, age: 23, stars: 5, tier: 3, wfUse: 2, wfAcc: 2, form: 3, plus: ['Penalty Specialist', 'Long-range Curler'] }),
      P(11, 'Barker', 'LWF', ['LMF', 'SS'], 'Prolific Winger', 'Incisive Run', { age: 22, stars: 4, tier: 2, wfUse: 2, wfAcc: 2, injRes: 1 }),
      P(7, 'Fletcher', 'RWF', ['RMF', 'RB'], 'Cross Specialist', 'Early Crosser', { age: 28, stars: 3, tier: 1, form: 6 }),
      P(9, 'Shaw', 'CF', ['SS'], 'Fox in the Box', null, { age: 29, stars: 2, tier: 3, wfUse: 3, wfAcc: 3, form: 6, plus: ['Phenomenal Finishing', 'Bullet Header'] }),
      P(13, 'Lowe', 'GK', [], 'Defensive Goalkeeper', null, { age: 34, stars: 1, tier: -1, form: 7 }),
      P(15, 'Whitaker', 'CB', ['LB'], 'Extra Frontman', null, { foot: -1, age: 22, stars: 2, tier: -1 }),
      P(14, 'Kovac', 'CMF', ['AMF', 'DMF'], 'Hole Player', 'Long Ranger', { age: 27, stars: 3, plus: ['Knuckle Shot'] }),
      P(18, 'Ferreira', 'SS', ['CF', 'AMF', 'RWF'], 'Deep-lying Forward', 'Trickster', { age: 21, stars: 4, tier: -1, form: 2 }),
      P(19, 'Brandt', 'CF', [], 'Target Man', null, { age: 32, stars: 2, wfAcc: 1, injRes: 3, plus: ['Fighting Spirit'] }),
    ],
  },
];
const DRIB_BY_STARS = [[], [], ['Scissors Feint'], ['Scissors Feint', 'Marseille Turn', 'Chop Turn'], ['Scissors Feint', 'Marseille Turn', 'Chop Turn', 'Sombrero', 'Sole Control'],
  ['Scissors Feint', 'Marseille Turn', 'Chop Turn', 'Sombrero', 'Double Touch', 'Flip Flap', 'Sole Control', 'Cut Behind & Turn']];
function makePlayer(raw, teamId, idx) {
  const rng = mulberry32(hashStr(teamId + ':' + raw.name));
  const base = BASE[raw.pos], sd = STYLE_STATS[raw.style] || {}, ad = (raw.ai && AI_STYLES[raw.ai].stats) || {};
  const stats = {};
  STAT_KEYS.forEach((k, i) => {
    const gk = k.startsWith('gk');
    const noise = (rng() + rng() - 1) * 5;
    const v = base[i] + (sd[k] || 0) + (ad[k] || 0) + noise + (gk && raw.pos !== 'GK' ? 0 : raw.tier * 1.6);
    stats[k] = Math.round(clamp(v, 40, 99));
  });
  const skills = [...new Set([...(STYLE_SKILLS[raw.style] || []), ...DRIB_BY_STARS[raw.stars], ...raw.plus])].filter(s => !raw.minus.includes(s));
  for (const s of skills) if (!SKILLS[s]) throw new Error('Unknown skill: ' + s);
  if (!STYLES[raw.style].pos.includes(raw.pos)) throw new Error(raw.name + ': ' + raw.style + ' is not a style for ' + raw.pos);
  return { id: teamId + idx, idx, num: raw.num, name: raw.name, pos: raw.pos, fam: raw.fam, style: raw.style, ai: raw.ai, foot: raw.foot, age: raw.age, stars: raw.stars,
    wfUse: raw.wfUse, wfAcc: raw.wfAcc, form: raw.form, injRes: raw.injRes, stats, skills, skin: Math.floor(rng() * (teamId === 'eko' ? 5 : 7)) };
}
export const SQUADS = RAW.map(t => ({ id: t.id, name: t.name, short: t.short, shirt: t.shirt, shorts: t.shorts, gk: t.gk, css: t.css, players: t.players.map((r, i) => makePlayer(r, t.id, i)) }));
export const squadById = id => SQUADS.find(s => s.id === id);

// ------------------------------------------------------------------ ratings, position fit, condition
/* How well a player's stats carry over to a slot: 1 in his own position, less the further away it is. */
export function posFit(pl, pos) {
  if (pl.pos === pos) return 1;
  if (pl.fam.includes(pos)) return 0.96;
  const a = LINE[pl.pos], b = LINE[pos];
  if (a === 'GK' || b === 'GK') return 0.5;
  const gap = Math.abs(LINE_ORDER[a] - LINE_ORDER[b]);
  return gap === 0 ? 0.9 : gap === 1 ? 0.82 : 0.72;
}
export const fitLabel = f => f >= 1 ? 'Natural' : f >= 0.95 ? 'Familiar' : f >= 0.88 ? 'Awkward' : 'Out of position';
/* The stats a player actually brings to a match: position fit scales the technical stats (not the physical ones),
   then the manager's two +1 boosters and the condition arrow (−2…+2 steps, two points each) are added. */
export function effStats(pl, pos, manager, cond = 0) {
  const f = posFit(pl, pos), out = {};
  for (const k of STAT_KEYS) {
    let v = pl.stats[k];
    if (!PHYSICAL.has(k)) v = 40 + (v - 40) * f;
    if (manager && manager.boost.includes(k)) v += 1;
    out[k] = clamp(v + cond * 2, 40, 99);
  }
  return out;
}
export function rate(stats, pos) {
  const w = WEIGHT[pos]; let sum = 0, tot = 0;
  for (const k in w) { sum += stats[k] * w[k]; tot += w[k]; }
  return Math.round(sum / tot);
}
/* Overall rating in a slot. It includes the out-of-position penalty but never the condition arrow. */
export const ovr = (pl, pos = pl.pos) => rate(effStats(pl, pos, null, 0), pos);
export const COND = [{ sym: '↓', label: 'Terrible', css: '#e3444f' }, { sym: '↘', label: 'Poor', css: '#f0913a' }, { sym: '→', label: 'Normal', css: '#e8d24a' }, { sym: '↗', label: 'Good', css: '#7fd4f0' }, { sym: '↑', label: 'Excellent', css: '#5be08f' }];
/* Condition for one match: −2…+2. High Form keeps the arrow near the middle and above; low Form swings widely. */
export function rollCondition(pl, rng) {
  const t = (pl.form - 1) / 7;
  const lo = [0.16, 0.22, 0.24, 0.22, 0.16], hi = [0.02, 0.1, 0.5, 0.28, 0.1];
  let r = rng(), i = 0;
  for (; i < 4; i++) { r -= lerp(lo[i], hi[i], t); if (r < 0) break; }
  return i - 2;
}

// ------------------------------------------------------------------ line-ups
/* Fill a formation from a list of players: best fit first, slot by slot. Returns one player per slot. */
export function assignSlots(players, formation) {
  const slots = FORMATIONS[formation].slots, left = players.slice(), out = new Array(slots.length).fill(null);
  const pairs = [];
  slots.forEach((s, si) => left.forEach(pl => pairs.push({ si, pl, v: posFit(pl, s[0]) * 100 + ovr(pl, s[0]) / 10 })));
  pairs.sort((a, b) => b.v - a.v);
  const used = new Set();
  for (const p of pairs) { if (out[p.si] || used.has(p.pl)) continue; out[p.si] = p.pl; used.add(p.pl); }
  return out;
}
/* The strongest eleven for a formation, slot by slot (greedy on the rating in the slot). */
export function autoXI(squad, formation) {
  const slots = FORMATIONS[formation].slots, out = new Array(slots.length).fill(null), used = new Set();
  const pairs = [];
  slots.forEach((s, si) => squad.players.forEach(pl => pairs.push({ si, pl, v: ovr(pl, s[0]) + (pl.pos === s[0] ? 0.5 : 0) })));
  pairs.sort((a, b) => b.v - a.v);
  for (const p of pairs) { if (out[p.si] || used.has(p.pl)) continue; out[p.si] = p.pl; used.add(p.pl); }
  return out.map(pl => pl.idx);
}
export function bestTaker(xi, key) { let b = 0; xi.forEach((pl, i) => { if (pl.pos !== 'GK' && pl.stats[key] + (key === 'setPiece' && pl.skills.includes('Penalty Specialist') ? 2 : 0) > xi[b].stats[key] || xi[b].pos === 'GK') b = i; }); return b; }

/* A team's saved choices. `xi` is eleven squad indexes in the slot order of tactic A's formation. */
export function defaultSetup(teamId, o = {}) {
  const squad = squadById(teamId);
  const formation = o.formation || '4-2-3-1', playstyle = o.playstyle || 'possession';
  const xi = autoXI(squad, formation), pls = xi.map(i => squad.players[i]);
  const cap = pls.findIndex(p => p.skills.includes('Captaincy'));
  return {
    team: teamId, manager: o.manager || 'verhoeven',
    tactics: [{ formation, playstyle }, { formation: o.formationB || '4-3-3', playstyle: o.playstyleB || 'quickCounter' }],
    xi, instr: { att: [null, null], def: [null, null] },
    captain: xi[cap < 0 ? 0 : cap], takers: { fk: xi[bestTaker(pls, 'setPiece')], ck: xi[bestTaker(pls, 'loftPass')], pk: xi[bestTaker(pls, 'setPiece')] },
    cbUp: 1, moves: { ...DEFAULT_MOVES },
  };
}
/* Repair a saved setup so that it always describes a legal team (a save from an older version, a hand-edited one). */
export function cleanSetup(s, teamId) {
  const d = defaultSetup(teamId), squad = squadById(teamId), n = squad.players.length;
  if (!s || typeof s !== 'object') return d;
  const out = { ...d, ...s, team: teamId };
  if (!MANAGERS.some(m => m.id === out.manager)) out.manager = d.manager;
  out.tactics = [0, 1].map(i => { const t = (s.tactics || [])[i] || {}; return { formation: FORMATIONS[t.formation] ? t.formation : d.tactics[i].formation, playstyle: PLAYSTYLES[t.playstyle] ? t.playstyle : d.tactics[i].playstyle }; });
  const ok = Array.isArray(out.xi) && out.xi.length === 11 && new Set(out.xi).size === 11 && out.xi.every(i => Number.isInteger(i) && i >= 0 && i < n);
  if (!ok) out.xi = autoXI(squad, out.tactics[0].formation);
  const inXI = i => out.xi.includes(i);
  if (!inXI(out.captain)) out.captain = out.xi[1];
  out.takers = { ...d.takers, ...(s.takers || {}) };
  const pls = out.xi.map(i => squad.players[i]);
  for (const k of ['fk', 'ck', 'pk']) if (!inXI(out.takers[k]) || squad.players[out.takers[k]].pos === 'GK' && k !== 'pk') out.takers[k] = out.xi[bestTaker(pls, k === 'ck' ? 'loftPass' : 'setPiece')];
  const instr = { att: [null, null], def: [null, null] };
  for (const side of ['att', 'def']) ((s.instr || {})[side] || []).slice(0, 2).forEach((v, i) => { if (v && inXI(v.p) && INSTR[side][v.type]) instr[side][i] = { p: v.p, type: v.type }; });
  out.instr = instr;
  out.cbUp = clamp(out.cbUp | 0, 0, 2);
  out.moves = { ...DEFAULT_MOVES };
  for (const dir of SLOT_DIRS) if (s.moves && MOVES[s.moves[dir]] && MOVES[s.moves[dir]].slot) out.moves[dir] = s.moves[dir];
  return out;
}

/* Everything the engine needs to field a team: eleven players with their slot and effective stats in each
   of the two sub-tactics, the tactic numbers, and the set-piece and instruction choices. */
export function buildTeam(setup, conds = {}) {
  const squad = squadById(setup.team), manager = managerById(setup.manager);
  const xiPl = setup.xi.map(i => squad.players[i]);
  const tactics = setup.tactics.map((t, ti) => {
    const order = ti === 0 ? xiPl : assignSlots(xiPl, t.formation);
    const prof = manager.prof[t.playstyle];
    return { ...t, prof, T: tacticParams(t.playstyle, prof), linkUp: prof >= LINKUP_AT ? manager.linkUp : null, order };
  });
  const xi = xiPl.map(pl => {
    const cond = conds[pl.idx] || 0;
    const tac = tactics.map(t => {
      const si = t.order.indexOf(pl), s = FORMATIONS[t.formation].slots[si];
      return { pos: s[0], fx: s[1], fz: s[2], fit: posFit(pl, s[0]), s: effStats(pl, s[0], manager, cond), styleOn: STYLES[pl.style].pos.includes(s[0]) };
    });
    return { pl, cond, tac };
  });
  const at = i => Math.max(0, setup.xi.indexOf(i));
  const instr = { att: {}, def: {} };
  for (const side of ['att', 'def']) for (const v of setup.instr[side]) if (v) instr[side][at(v.p)] = v.type;
  return { id: squad.id, name: squad.name, short: squad.short, shirt: squad.shirt, shorts: squad.shorts, gk: squad.gk, css: squad.css, manager,
    tactics: tactics.map(({ order, ...t }) => t), xi, instr, captain: at(setup.captain),
    takers: { fk: at(setup.takers.fk), ck: at(setup.takers.ck), pk: at(setup.takers.pk) }, cbUp: setup.cbUp, moves: { ...setup.moves } };
}
/* The team strength shown on the menu: the average rating of the eleven in their slots. */
export function teamRating(setup) {
  const squad = squadById(setup.team), slots = FORMATIONS[setup.tactics[0].formation].slots;
  return Math.round(setup.xi.reduce((a, i, si) => a + ovr(squad.players[i], slots[si][0]), 0) / 11);
}
