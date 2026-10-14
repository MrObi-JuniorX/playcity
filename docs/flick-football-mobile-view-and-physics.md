# Flick Football on phones: view controls and physics research

Research notes, 2026-10-12. Each section covers what the game does today (read from the code), what other games and sources do, and what we should change, in priority order.

**Built so far (2026-10-12):** R3 (the best view at each set piece, plus a button and a double tap for it), R5 (one finger slides the table on touch; two fingers slide up or down to tilt; twisting now turns the table the same way as the fingers) (moving a set-piece taker without the button was tried and reverted: the taker is moved with Move taker again).

---

## Part 1: Moving the view on a phone

### 1.1 What the game does today

| Gesture | Today | Where |
|---|---|---|
| One finger on a lit cap | Pull back to flick. Power = pull length **in table cm** (full power at 22 cm) | `app.js` pointer input, `MAX_PULL` |
| One finger on empty table | **Orbit** (turn and tilt), with fling | `orbit` in `app.js` |
| Two fingers | Pinch zoom toward the fingers, drag to pan, twist to turn (dead zones per part) | `gesture` in `app.js`, `V.zoomAt` / `V.pan` |
| Double tap on empty table | Reset to the broadcast view | `V.reset` |
| View panel | 5 presets + tilt / turn / zoom sliders | `#viewPanel` |
| Camera after a pan or zoom | Pinned: it stops following the ball | `pinned` in `view3d.js` |

The camera itself is good. It has smoothing, zoom toward the fingers, dead zones so a pinch never spins, and a portrait refit. **The problem is mostly the shot gesture, not the camera.**

### 1.2 Why it feels bad on a phone

1. **The pull is anchored to the cap.** You must put your finger on the cap and drag *behind* it. When the cap is near the screen edge, there is no screen left behind it to pull into. That is exactly the "ball too near the edge" complaint. Your finger also covers the cap and the start of the aim arrow.
2. **Power is measured in table centimetres, not screen pixels.** Zoomed out on a phone, 22 cm of table can be a very short swipe, so power is twitchy. Zoomed in, 22 cm can be longer than the screen, so full power is impossible. The same flick feels different at every zoom level.
3. **One finger on empty table orbits.** A touch that just misses a cap (the touch radius is 6.5 cm) tilts and spins the table. That is the most disorienting thing a view can do. Maps and board games use one finger to *pan*.
4. **The useful view moves are hidden.** Presets live in a panel, and the two-finger twist is hard to do one-handed.
5. **Nothing frames the shot for you.** When it becomes your turn the camera does not bring the next play into a comfortable place, so players fix the view by hand before every flick.

### 1.3 What other games do

- **8 Ball Pool (Miniclip)** splits the shot into three separate controls: drag the cue (or anywhere) for coarse aim, an **Aiming Wheel** for fine adjustment, and a separate **Power Bar** that you drag down and release. Aim and power never fight over one finger. ([Miniclip support](https://support.miniclip.com/hc/en-us/articles/35451942766865-Basic-Controls-Improving-your-skills-8-Ball-Pool), [Aiming Wheel](https://support.miniclip.com/hc/en-us/articles/203747546))
- **The lift-off nudge.** A review of an earlier pool game names a classic flaw: lifting your thumb moves the aim line. Any drag-to-aim needs a lift-off that does not change the shot. ([PocketGamer](https://www.pocketgamer.com/pool/review/))
- **Angry Birds** treats the finger as "a blunt tool of intent", not a precision instrument, and gives the pull an elastic, capped feel. ([Game Developer: Kinect controls for Angry Birds](https://www.gamedeveloper.com/design/in-depth-creating-kinect-controls-for-em-angry-birds-em-)) A common slingshot pattern caps the pull at a maximum distance from the anchor. ([Unity discussion](https://discussions.unity.com/t/how-do-i-implement-touch-controls-for-a-2d-slingshot-game/860520))
- **Golf Clash** uses one drag-and-release with a landing ring. It is quick to learn, and the skill is in reading conditions. ([West Games](https://west-games.com/golf-clash-controls/))
- **Other flick games** set power from the speed or length of the flick, and add curl from a curved swipe or an after-touch swipe. ([Flick Soccer review](https://www.appspy.com/review/5030/flick-soccer), [Flick Football review](https://www.appspy.com/reviews/flick-football-review/))
- **Touch camera practice.** Clamp orbit, tilt and zoom. Give gestures their own zone, separate from action input. Offer a reset. Keep the objective and its interaction cues in frame. Avoid gestures with three or more fingers, because the OS may own them (Android uses three fingers for screenshots). ([Three.js game-camera guide](https://tessl.io/registry/skills/github/MengTo/Skills/build-game-camera-controls), [PlayCanvas forum](https://forum.playcanvas.com/t/solved-orbitcamera-touchinput-help/15424), [Unity forum](https://forum.unity.com/threads/mobile-touch-to-orbit-pan-and-zoom-camera-without-fix-target-in-one-script.522607/))
- **Library option: `camera-controls` (yomotsu).** It has smooth transitions (`smoothTime`, a separate `draggingSmoothTime`), `fitToBox` with padding, a set-orbit-point example, and fully remappable one-, two- and three-finger gestures. ([npm](https://npmjs.com/package/camera-controls), [docs](https://tessl.io/registry/tessl/npm-camera-controls/3.1.0/files/docs/core-controls.md))

### 1.4 Recommendations, in priority order

**R1. Select, then drag anywhere (the fix for the edge problem).**
- A tap, or a press, on a lit cap *selects* it. The cap stays lit and gets a ring.
- Then a drag that starts **anywhere** on the board aims it, slingshot style. The shot is the opposite of the finger's movement from where it touched down, not from the cap. A cap at the edge can be shot from the middle of the screen, and the finger no longer covers it.
- Keep today's "press the cap and pull" as a shortcut. It is the same gesture whenever there is room.
- Tapping another lit cap moves the selection. Tapping empty table, or a cancel chip, clears it.

**R2. Measure power in screen space.**
- Full power = a pull of about **30% of the screen's short side**, so roughly 110 px on a phone in landscape and 250 px on a laptop.
- Power is then the same at every zoom, and full power always fits on screen.
- Direction still comes from projecting the drag onto the table (`pickPlane` at the touchdown and current points), so aim stays true at any tilt.

**R3. Frame the shot automatically.**
- When a cap is selected, ease the camera (about 0.4 s) so the cap sits about 35% in from the edge facing away from the opponent's goal. That leaves room for the pull and for the arrow ahead of it.
- Zoom so the cap, the ball and the goal mouth all fit, with padding. This is what `fitToBox` does.
- If the player has pinned the view, show a small **"Frame shot"** chip instead of moving the camera on its own. A camera that moves by itself after the player placed it feels broken.

**R4. Pan when the drag reaches an edge.**
- While aiming, a finger within about 40 px of the screen edge pans the view slowly in that direction, the way a file manager scrolls during drag-select.
- This covers pulls that are long on purpose.

**R5. One finger pans; two fingers turn and tilt.**
- On touch screens only, one-finger drag on empty table becomes **pan**, which is what maps do.
- Two fingers: pinch to zoom (as now), twist to turn (as now), and **two fingers dragged up or down together tilts**. That is the Google Maps and Apple Maps convention, and it replaces one-finger orbit.
- Mouse controls stay as they are: left-drag orbits, right-drag pans and the wheel zooms.

**R6. Fine aim after the pull.**
- After the pull holds still for about 250 ms, small sideways finger moves turn the aim at about a quarter of the normal rate. That is precision mode.
- Two on-screen ‹ › nudge buttons give ±0.5°. The lone power bar becomes optional.
- Remove the lift-off nudge: fire with the aim and power from about 60 ms *before* the finger lifts.

**R7. Camera buttons on screen.**
- Put a slim cluster of view buttons on the board: **Fit** (the whole table), **Behind** (the camera behind the selected cap, looking at goal) and **Top**.
- They replace hunting through the View panel. The panel stays for fine control.

**R8. Keep the custom camera rather than adopting `camera-controls`.**
- Ours already has zoom toward the fingers, dead zones, pinning, fling and the portrait refit.
- Borrow two ideas: a `fitToBox`-style "frame these points with padding" helper for R3 and R7, and separate smoothing times for drags and for programmatic moves.
- Adding the library would add a dependency to replace code that mostly works.

**Test plan for Part 1:** a phone in portrait and in landscape. A cap in each corner and against each rail. Zoomed fully in and fully out. A one-handed player. Check that the shot does not change on lift-off. Check that a 2-finger pinch never turns into a flick.

---

## Part 2: Board and player physics

### 2.1 What the game uses today (`phys.js`, units cm, g, s)

| Thing | Value now | Meaning |
|---|---|---|
| Pitch | 120 × 80 cm, 8 cm margin to the rails | |
| Ball | flat button, Ø 2.0 cm, 0.3 cm thick, **1.0 g** | slides flat and never lifts |
| Player cap | Ø 3.2 cm, 0.8 cm tall, **2.8 g** ("hammered crown cap") | |
| Keeper | a cap standing on edge, held in place | infinite mass in collisions |
| Cap sliding friction μ | **0.27** | stopping deceleration μg = 265 cm/s² |
| Button sliding friction μ | **0.18** | 177 cm/s² |
| Spin decay | a constant 200 rad/s², separate from sliding | |
| Curl | Magnus-style bend `kS·ω×v` | |
| Restitution | cap→button 0.64, cap→cap 0.70, rails 0.55, posts 0.68 | |
| Flick speed | 28 to 214 cm/s | |
| Step | 1/480 s, 8 sub-steps per 1/60 s tick, deterministic arithmetic only | |

### 2.2 What real objects weigh and measure

- **Crown cap:** the standard size is **26 mm across and 6 mm tall** (EN 17177), and about **2.1 g** of plated steel. ([Pelliconi](https://pelliconi.com/product/crown-bottle-caps-26mm), [Creopack, 2.1 g](https://creopack.se/en/product/crown-cap-26mm), [SIS, EN 17177](https://www.sis.se/produkter/forpackningar-och-distribution/flaskor-trag/ss-en-171772019))
  - A cap flattened with a hammer spreads to about 30–32 mm, which matches our Ø 3.2 cm.
  - 2.8 g is a little heavy for a bare cap. It is about right for a cap with its plastic liner, or a lightly filled one.
  - Players often fill caps with wax or putty, which takes them to 4–6 g. That is a real "heavier player" option.
- **Brazilian button football (futebol de botão)** is the closest real game. Its tables are about 190 × 123 cm. In the one-touch rules the "ball" is a **1 cm disc**, and other rules use a felt ball or a small acrylic cube. ([Acessa](https://www.acessa.com/esporte/arquivo/esse/2006/11/01-futmesa/amp/index.html), [Unicamp](https://prp.unicamp.br/inscricao-congresso/resumos/2016P11733A29697O28.pdf))
  - Our 2 cm button on a 120 cm pitch is a reasonable scale-down.
- **Subbuteo** moved from heavy lead-weighted bases to light, flat-bottomed hemispherical ones, and the figures *slide* when flicked. ([V&A](https://collections.vam.ac.uk/item/O180063/subbuteo-table-soccer-table-game-adolph-peter-a), [Sheffield Home of Football](https://sheffieldhomeoffootball.org/museum/subbuteo))
- **Friction:** published values for metal on clean wood run from about 0.2 to 0.5. Hard plastic on wood is about 0.2–0.3 kinetic. No reliable values exist for lacquered wood or felt, and tables of friction coefficients are known to be unreliable, so we should measure our own. ([mech wiki](https://mech.subwiki.org/wiki/Coefficient_of_dynamic_friction), [LibreTexts](https://phys.libretexts.org/Courses/Prince_Georges_Community_College/General_Physics_I%3A_Classical_Mechanics/20%3A__Friction/20.05%3A_The_Coefficient_of_Friction), [UF design lab](https://web.mae.ufl.edu/designlab/Class%20Projects/Background%20Information/Friction%20coefficients.htm))
  - Our 0.27 (cap) and 0.18 (button) sit on the slick end of that range. That means lacquered wood or a smooth game board, which is right for a fast, fun game.
- **Restitution:** steel on steel is quoted from about 0.6 to 0.95, and it falls as impact speed rises. No carrom or cap measurements were found. ([Oradea paper](https://www.imt.uoradea.ro/auo.fmte/files-2014-v3/Ciornei%20Florina%20Carmen-THE%20EFFECTS%20OF%20GEOMETRY%20AND%20MATERIAL%20PROPERTIES%20ON%20THE%20COEFFICIENT%20OF%20RESTITUTION.pdf), [elastic disks](https://arxiv.org/abs/cond-mat/9808258)) Our 0.64 to 0.70 is in range.
- **Spinning while sliding:** Farkas et al. showed that friction force and friction torque on a sliding, spinning flat disc are **coupled**, and that the disc **stops sliding and spinning at the same moment**. They confirmed it with a CD on fabric. ([arXiv physics/0210024](https://arxiv.org/abs/physics/0210024), *Phys. Rev. Lett.* 90, 248302)
  - Their model: friction force = μmg·F(ε), torque = μmgR·T(ε), with ε = v/(Rω).
  - F rises from 0 at ε = 0 (pure spin) to 1 at large ε (pure slide), with F(1) = 8/(3π) ≈ 0.85.
  - T falls from 2/3 at ε = 0 to 0, with T(1) = 8/(9π) ≈ 0.28.
  - In short, **a spinning button slides further**. The spin "uses up" some of the friction.

### 2.3 What the current numbers produce

Stopping distance on a free slide is d = v² / (2μg). Head-on, the button leaves at (1+e)·m_cap/(m_cap+m_button) times the cap's speed.

| Case | Number |
|---|---|
| Cap at full flick (214 cm/s), no contact | slides **86 cm**, about ¾ of the pitch |
| Cap at half pull (about 106 cm/s) | 21 cm |
| Button after a full-power head-on hit | leaves at **1.21×** the cap's speed (259 cm/s) and would slide **190 cm**: rail to rail and back |
| Cap after that hit | keeps 0.57× its speed |

How mass changes a head-on hit (e = 0.64, button 1 g):

| Cap mass | Button leaves at | Cap keeps | Feel |
|---|---|---|---|
| 2.1 g (bare cap) | 1.11× | 0.47× | lively, cap follows through less |
| **2.8 g (now)** | **1.21×** | **0.57×** | |
| 4 g (filled cap) | 1.31× | 0.67× | heavy: hits harder, rolls on after |

Two takeaways:
- **"Weight" is mostly the cap-to-button mass ratio plus restitution.** Heavier caps push the ball harder and carry on after contact.
- **"Speed of the table" is μ alone.** It scales every distance as 1/μ.

### 2.4 Recommendations, in priority order

**P1. Couple spin and slide for the button, using the Farkas model.**
- Replace the constant spin decay and the separate sliding deceleration with the coupled pair, so a curled shot glides a little further and stops spinning and sliding together.
- The exact F and T need elliptic integrals. Use rational stand-ins that keep the end points and the value at ε = 1, using only + − × ÷ so the game stays deterministic. For example:
  - F(ε) ≈ ε / (ε + 0.178)
  - T(ε) ≈ (2/3) · 0.737 / (ε + 0.737)
  - Then dv/dt = −μg·F(ε) and dω/dt = −(2μg/R)·T(ε), using I = ½mR² for a uniform disc.
- Fit the two constants against a slow numerical reference in a test before shipping.

**P2. Keep curl as a gameplay effect, and label it as such.**
- For a flat disc under even pressure, coupled friction does not bend the path sideways. Real curl in button and Subbuteo play comes from uneven pressure and from how the flick strikes.
- The current `kS` bend is a reasonable fudge. Leave it, tune it by feel, and note in the code that it is not Magnus physics.

**P3. Adjust cap mass to match real caps, and offer it as a choice.**
- Default 2.4 g (a bare flattened cap with its liner).
- An optional **"weighted caps" (4 g)** for a heavier, harder-hitting style.
- Changing `pm` changes every exchange, so re-tune the computer's shot selection (`ai.js`) after any mass change.

**P4. Offer table speed as a setting, the way pool games offer cloth speed.**
- **Fast** (lacquered wood, cap μ 0.22, button 0.15).
- **Normal** (today: 0.27 / 0.18).
- **Slow** (felt or cloth, 0.40 / 0.30). A slow table keeps play in the middle of the pitch and reduces rail bounces on a small phone screen.
- μ is part of the deterministic world, so both online players must get the same value. Put it in the match setup the host sends.

**P5. Make restitution depend on speed, a little.**
- Real impacts lose more energy at higher speed. For example, use e = e₀ − 0.0008·|v_n| with e₀ = 0.72 for cap on button, clamped to [0.5, 0.72].
- Hard shots then stop feeling like pinballs, and soft touches keep their life. It is cheap and deterministic.

**P6. Lower the full-power ceiling, or raise friction, so a full flick does not cross the whole table.**
- A full-power hit sends the button about 190 cm, more than the 120 cm pitch.
- Either top out around 180 cm/s, or rely on P4's Normal and Slow settings.
- This matters on phones, where the ball leaving the visible area is the other half of the "edge" complaint.

**P7. Measure a real cap and button once, and record the numbers in `phys.js`.**
- Friction: tilt a board until the cap starts to slide (μs = tan θ). Then film a slide in slow motion from a known launch speed for μk = v²/(2gd).
- Restitution: film a head-on cap-to-button hit and divide the speeds after by the speeds before, along the line of contact.
- Ten minutes with a phone camera beats any table of values.

**Constraints for all physics changes:**
- Only + − × ÷ and sqrt in anything both players simulate (see the header comment in `phys.js`).
- Run the game tests (determinism and rollback) and a few hundred computer-vs-computer matches to check average goals and match length did not swing.

---

## Suggested order of work

1. R1 + R2 (select, then drag anywhere; screen-space power). This fixes the edge problem by itself.
2. R3 (frame the shot) + R7 (on-screen view buttons).
3. R5 + R6 (one-finger pan, two-finger tilt, fine aim and the lift-off fix).
4. P6 + P4 (power ceiling, table speed setting).
5. P1 + P5 (coupled spin-slide, speed-dependent bounce), with P7's measurements to set the constants.
6. P3 (cap mass) last, because it needs the computer's shots re-tuned.
