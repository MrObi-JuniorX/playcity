# Flick Football: review and online play

Source reviewed: `~/Downloads/Flick Football (2).html` (a single 170 KB file). It now lives in `public/flick-football/`, split into modules, with online play added.

## What the original did well

- A clean split between pure physics (`Phys`), rules (`Rules`), computer opponent (`AI`) and the two views. That split is what made networking possible without a rewrite.
- A turn-based core (one flick, then everything settles) with a live part (keepers slide and dive while the ball moves). That is an ideal shape for netcode: only small inputs need to cross the wire.
- A small world (14 bodies), so the simulation is cheap enough to rewind and replay many times per frame.

## Problems found

| # | Issue | Effect | Fixed |
|---|---|---|---|
| 1 | Physics step count was `round(frameTime / (1/480))` | Game speed depends on the monitor: at 144 Hz it runs **~10% slow** (3.33 substeps rounded to 3), at 75 Hz ~6% slow. Two players on different screens could never agree. | Fixed 60 Hz tick, exactly 8 substeps (`Phys.advance`) |
| 2 | `Math.hypot` and `Math.exp` inside the simulation | These can differ in the last bit between Chrome, Safari and Firefox. A flick game is chaotic, so one bit grows into a different goal. | Simulation uses only `+ − × ÷ √`, and a test enforces it |
| 3 | UI code called `doFlick`, `moveTaker`, `arrangeMove` and so on directly | No single place where "what happened" is recorded, so nothing can be replayed or sent | Every action is now a per-team **input** applied by `Rules.simTick` |
| 4 | Computer randomness (`Math.random`) mixed into game flow | Fine offline, impossible to sync | The computer produces inputs, like a player. Only one machine runs it. |
| 5 | Dead code: `ballDisc` / `ballCap` (loft physics), a hidden Loft slider | Confusing, unused | Left in place but flagged; safe to delete |
| 6 | Any unhandled promise rejection showed the red "Something went wrong" bar | Network hiccups would look like crashes | Rejections are logged, not shown |
| 7 | Pause menu freezes the match | Can't work with two players | Online, the menu no longer pauses; "End match" and "Rematch" are synced commands |

## How online play works

```
 Browser A ──── WebRTC data channels (peer to peer, ~RTT/2) ──── Browser B
     │                                                              │
     └──────── /ws/room/CODE (Durable Object: knock, signaling, ─────┘
                relay only if peer-to-peer fails)
```

**Connecting is one tap.**
- **Invite a friend**: the Online panel shows a 5-letter code and a link (Copy / Share). Opening the link knocks on the room. The host gets a 4-second "Sam wants to play" countdown with **Play now / Not now**.
- **Quick match**: joins whoever has waited longest. If nobody is waiting, you play the computer straight away and are listed, so the next person looking drops into your game.
- **Open to challengers**: while playing the computer, let strangers take over the computer's side.

**Midstream takeover.** When a knock is accepted during a match against the computer, the host sends the exact match state (score, clock, positions, cards, whose turn). The guest takes over the computer's team and play continues where it was. If either player leaves, closes the tab, or goes silent for 10 seconds, the computer takes their side again. No match is ever abandoned. A player who only lost their connection is let back in when it returns (see "Poor networks" below).

**Zero felt latency: rollback netcode** (`rollback.js`).
- Both browsers run the same deterministic match at 60 ticks a second.
- Your own input (keeper keys, drag, flick) applies on your screen **instantly**.
- The other player's input is predicted (they keep doing what they were doing). When their real input arrives about half a round trip later, the match rewinds to that tick and replays. A full 40-tick rewind costs a few milliseconds.
- Corrections are **smoothed**: pieces glide to their true position over ~70 ms instead of jumping.
- **Flicks**: the flick starts `min(RTT/2, 4 ticks)` after release on both screens. The flicker sees the cap go within ~66 ms (masked by the release), and the opponent sees it start on time instead of jumping forward.
- **The force pointer**: while you pull back, your aim arrow (direction and power), plus the cap you are hovering, streams at 30 Hz over the unreliable channel. The opponent's screen eases toward each sample, so the arrow moves smoothly on their side, mirrored into their camera.
- **Each player sees the game as their own**: the guest's camera is turned 180°, so both attack left to right, and keys and pad arrows rotate with it. Only your caps light up, and only your keeper pad shows.
- **Safety net**: at every turn start both sides compare a hash of the match. If they ever differ, the host's state replaces the guest's, during the pause between turns where nobody can see it.
- **Packet loss**: every packet repeats all inputs the other side hasn't acknowledged, so a lost or reordered packet costs nothing.
- **Hidden tabs**: browsers stop drawing in background tabs. Online, the match keeps ticking from a worker timer, so switching tabs never freezes your opponent.

## Measured (local, two tabs)

| Check | Result |
|---|---|
| Direct P2P link, round trip | 8–17 ms |
| Relay fallback (no WebRTC), round trip | 9–21 ms through the local Durable Object |
| Same match on both screens after flicks, both paths | identical hash at the same tick |
| Rollbacks during a flick exchange | 1, of 1 tick |
| Simulated 200 ms / 10% loss for 60 s | in sync, 0 hash mismatches (`test/game`) |

## Cost

- **Peer to peer (most players)**: the server only introduces the players: a WebSocket connect, a knock, an accept and a few dozen signaling messages per match. That is about a cent per *thousand* matches. Rooms and the lobby store nothing and hibernate between messages. Idle rooms cost $0.
- **Relay fallback**: inputs go to 30 Hz per player, so 60 messages/s per room → 3 billable requests/s → about **$0.0016/hour**, plus ~$0.0056/hour of Durable Object duration while active. That is **under 1¢ per room-hour**, inside the $0.02 budget in `docs/cloudflare-cost-protocol.md`.
- **Static files** (the game itself) are served by Workers Static Assets: free and unmetered.
- **TURN** (optional, for strict corporate NATs): set `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` with `wrangler secret put` and `/api/ice` hands out short-lived Cloudflare TURN credentials. Without them, STUN plus the relay covers everyone.

## Files

| Path | What |
|---|---|
| `public/flick-football/phys.js` | Deterministic physics, fixed tick |
| `public/flick-football/rules.js` | Rules, plus `simTick`, input commands, `snapshot` / `restore`, `hash` |
| `public/flick-football/rollback.js` | Rollback session: prediction, rewind, time sync, hash check, resync |
| `public/flick-football/net.js` | Rooms, quick match, watching, WebRTC with relay fallback |
| `public/flick-football/sound.js`, `atmosphere.js` | Mixer with per-channel settings; crowd, organ, commentary |
| `public/flick-football/intro.mp3` | 8.5 s kick-off sting |
| `public/flick-football/spectate.js` | Spectator feed (host) and buffered playback (watchers) |
| `public/flick-football/app.js` | UI. Every action is an input. Online panel, knock toast, remote aim, smoothing |
| `src/index.ts`, `src/room.ts`, `src/lobby.ts` | Worker, invite room, quick-match lobby (Durable Objects, storage-free) |
| `test/game/netplay.test.mjs` | Determinism, rollback under lag and loss, midstream seeding, CPU budget |
| `test/worker/rooms.test.ts` | Knock/accept/relay, busy rooms, quick match, hibernation checks |

## Run it

```bash
npm run dev       # http://localhost:8787/flick-football/ — open two tabs
npm test          # game + worker tests
npm run lint:cf   # cost gates
npm run deploy
```

## Sound and atmosphere

Everything except the kick-off sting is synthesised in the browser (`sound.js`, `atmosphere.js`). It all follows the match events every screen already simulates, so players and spectators hear the same crowd and commentary at the moment they see the action.

- **Commentary**: the browser's built-in speech voice (free, offline, nothing to download). Short lines with team names for goals, own goals, saves, the woodwork, fouls, penalties, cards, corners, the breaks and the result. A goal or red card talks over minor lines, small lines leave gaps, and it stays quiet in a hidden tab. You can pick the voice in the Sound menu.
- **Crowd**: no constant background murmur (removed by request). It only reacts: oohs at the post and on corners, groans for misses, boos for fouls and cards, a roar and applause for goals, and rhythmic clapping at set pieces. It gets a little louder with each real spectator.
- **Organ**: a drawbar organ with a spinning-speaker wobble, playing short original riffs only in dead time: after goals, at corners and free kicks, during long thinks, and a medley at half-time and full time.
- **Kick-off intro**: `intro.mp3` (the first 8.5 s of the provided "sports action" track, trimmed from 1.2 MB to 272 KB). It plays for 7 s from Kick off and fades over the last 2 s.
- **Reactions**: 👏 📣 😮 buttons for players and spectators whenever a match is online or watched. Each makes a real crowd sound for everyone at the table, and lots at once swell the whole crowd. Watchers send them through the room (validated, rate-limited to one per 300 ms each). Players send them over their direct link, with the host passing them on.
- **Sound menu**: master volume, Mute all, and for each of Commentary, Crowd, Organ & music, Reactions and Ball & whistle an on/off switch, a volume slider and a ▶ test button. Settings are saved per device, so everyone sets their own.
- **Cost**: reactions are the only new server traffic, at most ~3 billed requests a second for a busy room of 60 tapping watchers. The rest runs in the browser.

## Mobile

- **Full screen + landscape**: Kick off, Quick match, Watch and "Play now" go full screen and lock to landscape on phones (Android Chrome and iPad). A ⛶ button in the top bar does it anywhere, and guests who arrive by link get a "Play full screen?" prompt. iPhone Safari doesn't allow web pages to go full screen, so the page ships a web app manifest: **Share → Add to Home Screen** opens it full screen and landscape with no browser bars.
- **Screen stays awake** during a match (Wake Lock), and is taken again after switching apps.
- **Rendering**: phones render at up to 2× resolution (crisp on 3× screens at a sane cost), skip antialiasing on high-density screens, and use a 1024 shadow map. A governor steps quality down only after 5 s of settling and two slow 2 s windows in a row under 40 fps (resolution first, then shadows). The first version was too eager: the stutter of going full screen and rotating could cost a phone its resolution and shadows straight away.
- **Finding the ball**: when the 2 cm button is small on screen, a yellow ring with a dark edge appears around it, sized to stay ~8 px wide, and the button itself is drawn up to 1.7× larger. Both are only for the eye; the physics is unchanged.
- **Turning the phone**: the camera re-orients whenever the screen flips between portrait and landscape, including the flip into full-screen landscape at kick-off (which used to leave the table sideways).
- **Rotating the table**: two fingers work like a map: twist to turn, pinch to zoom, slide up or down to tilt. One finger on empty table still orbits.
- **Referee calls**: only goals, half-time and full time use the big centre banner (shorter, and smaller on phones). Restarts, fouls and cards show as a slim strip along the top edge (about 70×22 px on a phone), so the pitch stays clear.
- **Less per-frame work**: HUD nodes are cached, the keeper-pad arrows only update when the camera turns, and the computer's thinking gets 4 ms a frame on phones instead of 7.
- **Touch**: no double-tap zoom on buttons, no tap flash, no pull-to-refresh or rubber-banding mid-flick.
- **Layout**: in landscape on a phone the top bar and controls shrink to one slim row each, so the board gets ~80% of the screen (310 of 390 px on an 844×390 phone, up from 272). Narrow portrait screens hide the "?" and 2D buttons (help is on the setup screen, the flat view is in View).

## Fixes

- **Throw-ins after deflections**: a ball that grazed a cap while already moving away counted as that cap's touch. So when team A deflected the ball out and it brushed a team B cap on the way, A got the throw. Now only a real knock counts as a touch. A regression test plays whole matches and checks every out (`test/game`, "rules").
- Help, menu and break overlays now open above the setup screen.

## Spectators: the billiards room

Anyone can watch a live table, and each watcher turns, tilts and zooms the table however they like. Cameras are local to each screen, so nobody's view affects anyone else's.

- **Finding a table**: Online → **Live tables** (or **Watch** on the setup screen) lists public matches being played now, newest first. Quick-match games are public. Friend-invite games are watchable only through their link: players find it under **Let people watch** in the Online panel (`?watch=CODE`).
- **What watchers see**: the same match, about 0.4 s behind live, with both players' aim arrows timed to the playback, the referee, banners and sounds. No lit caps and no controls. The pill reads "Watching Ada v Sam · 👁 3", and players see "👁 3" too.
- **How it works** (`spectate.js`): players stay on their direct link. The host sends one feed to the room: a keyframe (the whole match, ~4 KB) when someone starts watching or the match changes outside the inputs, then confirmed per-tick inputs in batches four times a second. The room fans that out to every watcher (up to 500 a table). Watchers simulate it deterministically from a buffer, so playback never rewinds or jumps. A watcher who returns to a hidden tab catches up at 8× speed with the sound muted.
- **If a player leaves**, the computer takes their side and the watchers keep watching. If the host leaves, the table closes for everyone.
- **Cost**: the host sends 4 feed messages a second, plus at most 10 aim samples a second per player while aiming, and only while someone is watching. That's under 1 billed request a second, about $0.0006 an hour, plus ~$0.0056 an hour of Durable Object time while the feed runs. Messages out to watchers aren't billed as requests, so a room of 500 watchers costs about the same as a room of one.
- **Tested**: a watcher who joins from the start and one who joins halfway both end on the players' exact match under 80 ms lag and 2% loss (`test/game`). The room routes the feed only to watchers, never lets watchers send, and closes them when the host leaves (`test/worker`). In the browser, host, guest and spectator finished a flick with the ball at the identical position.

### Next steps for spectating
- **Take the seat**: when a player leaves, offer the seat to a watcher instead of the computer. They already hold the match state.
- Reactions or chat from watchers, rate-limited by the room.

## Known limits and next steps

- **Trust**: peers trust each other's inputs. That is fine for casual play with no saved scores. A ranked mode would need the room to verify inputs.
- **3D in the test pane**: the browser pane used for testing has no WebGL, so testing used the game's 2D fallback. The 3D view uses the same code path (the flip is applied to both).
- **Lobby** is a single Durable Object. Shard it by game or region (`getByName("flick:eu")`) once thousands wait at the same moment.
- **Signaling drop**: if the room's server restarts mid-match (a deploy), players on a direct link play on. Only a closed data channel, a goodbye, or 10 s of silence ends the match.
- Delete the dead loft physics (`ballDisc`, `ballCap`, hidden Loft slider) if loft isn't coming back.

## Finding games, spectators and the walkie-talkie (2026-10-10)

- **Open now, on Flick's start screen.** It sits right under the title and lists:
  - every player open to challengers, each with **Play**. This knocks on their room; the host sees "X wants to play" and the match starts after the usual 4-second count unless they decline;
  - every public match being played, each with **Watch**.

  It reads the same edge-cached `/api/open` as the playcity landing page, refreshes every 20 s and pauses while the tab is hidden. The landing page shows the same matches with **Watch** links (`/flick-football/?watch=CODE`).
- **Bug fixed: dead rooms stayed listed.** If a waiting player's room connection dropped (network, deploy), the lobby kept listing a room nobody hosted. The fix has two parts:
  - the room's accidental close now takes the listing down, and opens a fresh room if the player is still open (the new room lists itself);
  - `Net.listOpen` no longer resurrects a listing that was cancelled while a reconnect was pending.

  Checked with a real local server restart: one fresh listing, the dead one gone.
- **Walkie-talkie.** The two players' existing WebRTC connection now carries one audio track, silent until someone holds the round mic button (bottom left, or Space).
  - **Signals:** a `talk` message on the reliable channel shows "🎙 Name" with a live waveform at the top of the opponent's screen, and the game sound ducks while they talk.
  - **Privacy:** watchers are not on this connection, so they never hear it.
  - **Limits:** voice needs the direct connection. Over the relay fallback the button says so.

## Mobile 3D camera (2026-10-10)

Following map and 3D-viewer conventions:
- **Two fingers:** pinch zooms toward the point between the fingers, drag pans, twist turns. Each part needs a clear movement before it starts (8% pinch, 14 px drag, 0.22 rad twist) and then stays on for that gesture, so a pinch no longer tilts or spins the table.
- **Pan bounds:** panning or zooming to a point pins the view (it stops following the ball) within the table's bounds.
- **One finger on empty table:** turns and tilts. Letting go mid-swipe keeps it turning briefly (fling with decay). A double tap resets to the standard view.
- **Turning the phone:** waits for the size to settle (phones report several sizes mid-rotation), then re-applies presets. A custom view keeps its tilt, turns a quarter so the pitch stays along the long side, and refits the whole table.
- **Safari:** its page pinch and rotate gestures are blocked on the board.
- **Sharpness on small or low-density screens:** they render at 1.5× (supersampling, capped at 2, and the frame-rate governor still steps down). Printed cap tops use the GPU's maximum anisotropic filtering. Each outfield cap has a dark outline so it separates from the pitch. Caps under about 7 px are drawn up to 25% larger, for the eye only (physics unchanged), like the ball.
- **Not yet checked on a device:** the 3D path could not be run in the test browser (no WebGL). It needs a check on real phones.

## Livelier caps, and a ball marker that is not a cap (2026-10-10)

- **Physics:**
  - cap sliding friction 0.30 → 0.27;
  - cap-on-button restitution 0.60 → 0.64;
  - from mid to hard pull, flick speed gets a smooth boost of up to +8% (top speed 200 → 214). The AI's top speed follows.

  Measured, cap flicked into the ball (old → new):

  | Pull | Cap slides further | Ball speed off the hit |
  |---|---|---|
  | 50% | +13% | +7% |
  | 65% | +17% | +8% |
  | 80% | +23% | +10% |
  | full | +27% | +11% |

  A cap knocked by another at 80% pull slides 27% further. Masses are unchanged; momentum and impulse simply follow the extra speed.
- **Bug caught on the way:** an inline comment had cut off `ePost`, `eNet` and `ePP`, turning every cap-on-cap collision into NaN. A new test now requires every physics constant to be a real number.
- **Ball marker:** the yellow ring around a tiny ball read as a yellow-kit cap. It is now four short white arcs on a dark edge, a target marker no kit resembles, in both the 3D and the flat 2D views.

## Invite links that survive the host switching apps (2026-10-16)

**Bug:** a shared link said "That invite has expired or the host has gone." Sending the link from a phone (WhatsApp, the share sheet) puts the game in the background, and phones, iPhones especially, drop its connection within seconds. The room closed, so the friend was turned away. When the host came back the game opened a room under a **new** code, so the link never worked again.

**Now:**
- **The code is for keeps.** `Net.host` reconnects by itself under the same code: backoff 1 s → 15 s, straight away when the tab is shown again or the network returns, and with a ping check for a socket that claims to be open but is dead. It sends a per-host id (`hid`), so the room swaps a stale host connection for the fresh one instead of refusing it as "taken". Renaming reuses the code too.
- **Arrivals wait instead of failing.** With no host connected, the room accepts guests and watchers and sends `{"t":"waiting"}`. The host's return knocks for each waiting guest and asks for a keyframe for the watchers. The page shows "Waiting for the game to open…" and gives up after 60 s. Quick match never waits: it moves on to the next player.
- **Drop vs leave.** Only a deliberate close (1000, or 1001 when the tab closes) sends everyone away (4001). Any other close means "dropped": watchers keep watching ("The players dropped off for a moment…"), and a guest who was playing stays in if the host still has them (the host reconnects with `in=<gid>`).
- **One link, then a name.** The Share button always sends `?join=CODE`, during a match too. Opening it asks for a name first (once per game per tab), then knocks: the friend takes over the computer's side, or watches if both sides have a player (the host declines with `full`, the room closes with 4010, and the page switches to watching). "Play" in Open now asks for the name too.
- **Fixed on the way:** a guest who gave up during the host's 4-second count left the host stuck on "Connecting to…". The room's `peer-left` for a guest who never got in now clears the knock.
- **Tested:** `test/worker/rooms.test.ts` covers waiting guests and watchers, the same host replacing a stale connection, a different host still refused, a deliberate leave, `full`, a guest who gave up, and `in=`. In the browser: host dropped and kept away → friend's link waited → host back on the same code → friend took over the computer's side; a third person on the same link watched; a mid-match drop kept both the match and the watcher.
- **Not fixable from the page:** on iPhone, a link tapped in WhatsApp opens in Safari (or WhatsApp's own browser), never in a home-screen web app. Android opens it in the installed app when Chrome is the default browser.

## Set pieces, livelier ball, view tips (2026-10-16)

- **Place, then Ready.** People did not find "Move taker". Every throw-in, corner, goal kick, free kick or penalty you take now starts with the taker picked up: the yellow area shows where it may stand, and dragging the lit cap (or tapping inside the area) moves it. A small card beside the cap, on the side away from the ball, says "Drag to move the taker" and carries **Ready** (Enter on a keyboard). Only after Ready does a pull back flick. The same card carries Ready while you arrange your caps for a kick-off or a goal kick. Placing is local to your screen; the moves go out as ordinary taker commands. "Move taker" stays for kick-offs and for moving again after Ready.
- **Ball friction 0.18 → 0.16.** Measured goal kick from the 6-yard line, straight, nobody in the way (stop point; the far six-yard box starts at x = 52):

  | Pull | 0.18 | 0.16 |
  |---|---|---|
  | 60% | 11 (just past halfway) | 18 |
  | 65% | 22 | 31 |
  | 70% | 34 | 45 (the far penalty area, by the six-yard box) |
  | 75% | 48 | runs to the far goal line |

  A full pull already reached the far keeper, and still does. The computer's aim reads the same constant, so it adjusts by itself.
- **View tips at the start of a match**: rotate (twist two fingers), move (swipe two fingers), zoom (pinch), with small animated fingers; drag and wheel on a mouse. Shown for about three seconds when you kick off, join someone or start watching. It never takes a tap, and touching the table hides it at once.

## Poor networks: getting back into the match

**Before:** a guest whose connection died (a tunnel, weak signal, a phone that slept) lost their side for good. Both screens gave it to the computer, and nothing ever reconnected them; they had to open the link again and wait out the host's 4-second count. Two more problems made it worse:
- The silence limit counted frames, not seconds: each stalled frame added 1/60 s, so "15 s" was 15 s only at 60 fps. It was 30 s in a headless browser and about 45 s on a struggling phone at 20 fps, with the other player staring at a frozen match.
- A guest whose old socket was still half-open in the room (common after losing signal) was turned away as `busy` on the way back.

**Now:**
- **Silence is wall time.** `rollback.js` adds the real time a stalled frame took. The match hands the silent side to the computer after 10 s (`STALL_GIVE_UP`), lower than before because coming back is now cheap.
- **A drop is not a goodbye.** A side that detects the drop sends `{t:'bye', drop:true}`, and the screen says "lost connection" instead of "left". A real goodbye (Leave, closing the tab) and a host's deliberate close (4001) still end it for good.
- **Rejoin token.** Each guest tab keeps a random token per code (`rj`, in session storage) and sends it with every knock. The room passes it to the host with the knock, and replays it when the host reconnects.
- **The host remembers.** For 2 minutes after a dropped (not departed) guest, a knock with the same token while the computer still holds that side is accepted at once, with no countdown. The host sends the match as it stands on its screen ("You are back").
- **The guest keeps knocking.** It keeps playing the computer meanwhile, and does not open itself to challengers. It knocks again with backoff (1 s doubling to 15 s, with jitter) for up to 2 minutes, at once when the network or the tab comes back. An attempt that hangs while connecting is dropped after 8 s. If the host has left, declined, or is playing someone else, it stops and says so.
- **The room replaces the stale guest.** A new connection with the same token closes the old one (4011) and tells the host `peer-left` before forwarding the new knock, exactly as `hid` does for the host.
- **Tested:**
  - `test/worker/rooms.test.ts` covers the token on knocks (and dropping a malformed one), its replay after the host reconnects, and replacement of a half-open guest in the right order.
  - In the browser, behind a proxy that black-holes the guest's traffic without closing the socket (forcing the relay path):
    - Both screens hand the side to the computer after about 11 s.
    - When the network is back, the guest is in the match on its old side about 1.1 s later.
    - Both screens show the same score, with ticks advancing together.

