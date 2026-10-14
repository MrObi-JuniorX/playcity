# Floodlight FC: review, and what was built from the design research

Source reviewed: `~/Downloads/Floodlight FC.html` (one 112 KB file, 1,939 lines). Design input: `~/Downloads/Football Game Design Research.md` (13 Oct 2026). The game now lives in `public/floodlight-fc/`, split into modules, with the research's nine steps built on top.

It is a single-player game served as static files. The Worker never runs for it, so it adds nothing to the Cloudflare bill (see [cloudflare-cost-protocol.md](cloudflare-cost-protocol.md)).

## What the original did well

- A full 11-a-side match in one file: stadium, crowd, GPU particles, bloom, synthesised sound, a contextual touch pad and swipe skills.
- The controls already matched the mobile standard the research describes: floating stick, buttons that change meaning between attack and defence, first-time play, one-twos.
- Tuning was careful. Shot power has a sweet spot, the keeper narrows the angle, and passes are weighted to arrive at walking pace.

## Problems found

| # | Issue | Effect | Fixed |
|---|---|---|---|
| 1 | The ball was only checked against the lines while loose | A player could dribble three metres off the pitch and play went on. Walking the ball into the net was not a goal | A carried ball is out, or a goal, like a kicked one |
| 2 | A defender standing beside the kicker took the ball the instant it was kicked | In computer v computer play about half of all passes were "intercepted" at the passer's feet | For 0.3 s after a kick, only an opponent the ball is travelling toward can stop it. Pass completion went from about 50% to about 70% |
| 3 | The keeper only reacted to a ball moving at over 5 m/s toward the goal line | Slow or angled efforts (headers, shots from the byline) went in with the keeper standing still | He now reacts from 2.5 m/s, and has longer to cover a shot he sees from range |
| 4 | Shot error was a fraction of the gap to the post | The computer never missed the target: every shot was a save or a goal, so there were no goal kicks and no corners | Wider error. About 70% of shots are now on target, and a strong parry can go behind for a corner |
| 5 | The simulation, three.js and the page were one closure, using `Math.random` | Nothing could be tested or replayed. Balance could only be judged by playing | `sim.js` is pure: no DOM, no three.js, a seeded random source. Node tests play whole matches |
| 6 | Step size followed the screen: one step a frame, two if the frame was long | The game played differently at 60 Hz and 144 Hz | Equal steps of at most 10 ms |
| 7 | A keeper holding the ball in his hands could be tackled | Cheap goals | He cannot be tackled in his own box |
| 8 | The keeper could never touch the ball outside his box | A loose ball two metres outside the area was ignored | Outside the box he plays it with his feet, and clears at once |
| 9 | The sprint bar refilled fully in 22 seconds, for ever | Stamina meant nothing over a match | Match fitness drains with running and caps the sprint bar (see Stats) |
| 10 | Kick-off picked "the forward with `fz === 0`" and "player 7" | It breaks as soon as a formation has two strikers | The two most advanced players take it |
| 11 | Team 1 was mirrored front to back but not side to side | Their left-back played on the right | Mirrored both ways |
| 12 | Crowd noise kept playing when the game was paused or the tab hidden. The screen wake lock was never released | Battery, and sound from a hidden tab | Audio suspends with the game. The wake lock is released on pause and full time |
| 13 | The file was an exported artifact: a wrapper `<head>` with a light colour scheme, and `<title>` inside `<body>` | Invalid page | A normal page, with a link back to playcity |
| 14 | No fouls, no offside, no set pieces. A corner or throw-in just handed a player the ball | The research lists these as missing | See Controls and Set pieces |

## How it is put together

```
index.html   page, HUD, menus (markup and CSS)
app.js       menus, touch and keyboard input, sound, the frame loop
view.js      three.js: stadium, players, ball, particles, camera presets
team.js      the team screen: line-up, tactics, roles, skill moves
sim.js       the match engine. Pure: createMatch(cfg, onEvent) → { step, press, release, … }
data.js      the data model: stats, styles, skills, formations, playstyles, managers, squads
vec.js       a small vector and a seeded random source
```

The engine reports everything through one callback (`on('goal', …)`, `on('tag', …)`). The app turns those into sound, particles and banners, and the view only reads the match. That is what lets `test/game/floodlight.test.mjs` run whole matches in Node. One engine step costs about 25 µs.

## What was built, by the research's nine steps

### 1. Player data model

- **26 stats** on a 40–99 scale, in the research's four groups. Each one drives something:

  | Stat | Drives |
  |---|---|
  | Speed, Acceleration | Top speed and how fast it is reached |
  | Dribbling, Tight Possession | Speed with the ball and resistance to tackles; turn rate with the ball |
  | Ball Control | First touch: a fast ball may bounce away ("heavy touch") |
  | Low Pass, Lofted Pass, Set Piece Taking, Curl | Pass, cross, free-kick, corner and penalty accuracy; bend |
  | Finishing, Kicking Power, Heading, Jumping | Shot accuracy and speed; header accuracy; who wins a header |
  | Attacking Awareness | How often a player runs in behind |
  | Defensive Awareness, Tackling, Aggression, Defensive Engagement | Marking and reading passes; tackle success; how often and how far out the computer presses |
  | GK Awareness, Catching, Parrying, Reflexes, Reach | Positioning, hold or parry, where a parry goes, close saves and penalties, dive range |
  | Physical Contact, Balance | Shielding and shoulder charges; recovery after being beaten |
  | Stamina | How fast match fitness drains |

- **Four characteristics.** Weak Foot Usage and Accuracy: a kick toward the player's weaker side loses accuracy and power, so a defender can show him onto it. Form sets how much the condition arrow swings. Injury Resistance sets how much fitness a foul costs.
- **55 skills.** 49 change something in the engine. Six are listed but do nothing yet, and the team screen shows them with a dashed outline: Scotch Move, Visionary Pass, Heel Trick, Acrobatic Clearance, GK Directing Defence and Super-sub.
- **13 positions, 22 playing styles, 7 AI playing styles.** A playing style only works in the positions it belongs to.
- **Out of position.** Technical stats scale by fit: natural 100%, familiar 96%, same line 90%, one line away 82%, further 72%. Physical stats do not change. The rating shown in a slot includes this.
- **Squads.** Two squads of 16 with invented names. Stats come from the position, the playing style and a fixed per-player seed, so a player is the same in every session.

### 2. Skill gating

A move needs the stars and, where one is named, the skill. Eleven moves, from Knock-on (1★) to Elastico (5★ and Flip Flap). A player who cannot do a move gets a message saying what it needs, and nothing happens. Four swipe slots (up, down, left, right) are chosen on the team screen, which lists who in the eleven can do each one.

### 3. Formations and roles

The seven formations from the research. Playing styles move players in `formationTarget`: a Goal Poacher sits on the offside line, an Anchor Man stays behind the ball, a Cross Specialist hugs the touchline, a Target Man holds the ball up.

### 4. Team playstyles

Six playstyles, each eight numbers: line height, compactness, press trigger distance, pass length, runs per minute, counter-press window, width and ball-side overload. They feed `formationTarget`, `assignRoles` and `carrierAI`. A test checks that it shows on the pitch: a Long Ball Counter side holds its back line more than two metres deeper than a Quick Counter side.

### 5. Managers

Seven invented managers. Each has a proficiency of 50–89 in every playstyle, two +1 boosters and a coaching affinity. Proficiency scales how much of the playstyle the team plays. At 89 the manager's Link-Up Play switches on: a runner is triggered and ringed in blue, and Through or Loft finds him.

Coaching affinity is stored and shown but does nothing. It speeds up player development, and there is no progression mode yet.

### 6. Match levers

Top left during a match: the attack and defence dial (five levels), the sub-tactic switch (A/B, each with its own formation and playstyle) and the offside trap. On the team screen: two attacking and two defensive instructions, captain, free-kick, corner and penalty takers, and how many centre-backs go up for corners.

### 7. Controls

| Added | Touch | Keyboard |
|---|---|---|
| Stunning pass, through ball, cross, shot | Slide right off the button | C with J, L or I; P to shoot |
| Lofted through ball | Slide up off Through | H |
| Fake shot | Slide left off Shoot, or Pass during the wind-up | B |
| Shield | Hold Skill | Z |
| Quick stop, facing goal | Double-tap the stick side | X |
| Shoulder charge | Double-tap the stick side when defending | X |
| Call for Pressure | Slide up off Press | N |
| Keeper rush | Slide up off 2nd Man | G |

Labels appear around a held button to show what each slide does. The shot slides follow FC Mobile: up chip, down finesse, right Stunning, left fake. The old "drag sideways for finesse" is gone because sideways now means two different things.

**Set pieces.** Fouls come from slides and challenges from behind. A foul gives a free kick, or a penalty in the box. Corners, free kicks, penalties, goal kicks and throw-ins are all dead-ball phases: players take up positions, the taker aims with the stick, and the computer takes its own after a second or two. Direct free kicks have a wall that blocks a flat shot. On a penalty against you, the stick picks the side your keeper dives.

**Offside** is judged when the pass is played, and can be turned off in the menu.

### 8. Camera

Five presets: Dynamic Wide (the default, and what the game did before), Duel, Wide, Broadcast and Vertical. Three sliders: height, zoom and ball tracking. All saved in the browser. Portrait always uses Vertical.

### 9. Condition

A five-step arrow per player, rolled before each match, worth up to ±4 stat points. High Form keeps it near the middle. It shows on the line-up screen and next to the controlled player's name. It never changes the overall rating.

## Not built

- **Online play.** The engine is input-driven and seeded, which is the right shape for it, but it uses `Math.sin`, `Math.atan2` and `Math.exp`, which can differ in the last bit between browsers. Rollback netcode like Flick Football's would first need those replaced.
- **Fluid formations.** Shape changes between attack and defence come only from playing styles and instructions.
- **Cards, injuries, substitutions and advantage.** A foul always stops play and nobody is booked. Super-sub therefore has nothing to do.
- **Progression.** No player development, so coaching affinity is idle.
- **Smart Assist beyond what existed** (auto-switch and shot aim). eFootball's version also corrects dribbling direction.

## Balance, measured

Computer v computer over 5-minute matches (Possession 4-2-3-1 v Long Ball Counter 4-3-1-2):

| Per match | Value |
|---|---|
| Goals | about 2.5 |
| Shots (on target) | 8 (5.6) |
| Pass completion | about 70% |
| Fouls | 3 |
| Offsides | 0.2 (the computer holds its runs; a person will be caught more often) |

Set pieces taken by the computer, 150 each: penalties scored 84%, a central free kick from 25 m 12%, a corner 9%.

**Difficulty.** In the original, difficulty changed the computer's tackling, its keeper and its accuracy, but not how many chances it took or how well your own side defended. It now also sets how readily the computer shoots, how good your keeper is, and (with Smart Assist on) how early a teammate goes to press for you: from just inside your own half on Amateur, your own third on Pro, only deep in your box on Legend.

A scripted stand-in for a person (it chases the ball, tackles at random and shoots without aiming) loses 1.0–2.9 on Amateur, 0.5–4.1 on Pro and 0.5–4.4 on Legend. That shows the levels are ordered. It does not show they are right.

These numbers describe the computer playing itself or a script. How it feels in the hand, and the difficulty against a real person, still need play-testing on a phone.

## Testing

```bash
npm run test:game
```

25 tests in `test/game/floodlight.test.mjs` cover the data model, whole matches (no NaN, repeatable from a seed, cost per step), playstyles, sub-tactics, the dial, skill gating, offside, fouls, the wall, penalties, the two out-of-play bugs, Stunning shots, shielding and fatigue.

The 3D view was checked in headless Chrome with software rendering (menu, match, team screen, penalty, portrait). It has not been run on a real GPU or a phone.

## Rigged players (prototype)

Menu → **Players: Rigged (prototype) / Simple**. Rigged is the default; Simple is the original shape-built players, and the game falls back to it if the model fails to load.

- **Model:** `public/floodlight-fc/assets/xbot.glb` (2.9 MB), Adobe Mixamo's "X Bot" from the three.js examples (github.com/mrdoob/three.js, r184). It has a 67-bone Mixamo skeleton and about 49k triangles. Mixamo characters and animations are royalty-free for games. For a public release, swap in a proper footballer model; the code stays the same.
- **Kit:** `rig.js` labels each vertex by the bone that moves it most (head and forearms skin, spine and upper arms shirt, thighs shorts, shins socks, feet boots). A shader then paints it in the team's colours, so any Mixamo-rigged model gets a kit with no texture work.
- **Movement:** the motion-captured idle, walk and run clips are crossfaded by the player's speed, and each clip is sped up to match the stride. Root drift is removed, because the match engine moves the player.
- **Football actions:** kicks (with the player's preferred foot), wind-ups, skill moves, standing and sliding tackles, headers, keeper dives, shielding, falling when fouled and celebrations. These are layered on top of the mocap by turning bones about world axes, so they work on any Mixamo skeleton. They are hand-made poses, not mocap.
- **Not done yet:** shirt numbers and names, faces, hair, a level-of-detail model for distant players, and mocap clips for the actions. Adding a Mixamo clip with the same skeleton means dropping it into the glb and naming it.
- **Cost:** 22 players come to about 1.1 million triangles plus shadows. That's fine on a desktop GPU, but likely too much for mid-range phones until a lighter model or LOD exists. Choose Simple there.

Checked in headless Chrome with software rendering: kit colours, locomotion, kick, slide, fall, keeper dive, header and celebration poses, and a 150-second match with no errors. Not yet seen on a real GPU or a phone.
