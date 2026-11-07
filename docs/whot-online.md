# Check Up Whot: online tables

Whot for 2 to 4 at a table where every seat is either a person or the computer, and any computer seat can be taken over by someone joining, cards and all, at any moment. The game is at `/whot/`, and the landing page (`/`) lists it next to Flick Football.

## Review of the original (`Check Up Whot.html`)

What was already good:
- **A clean engine.** It is a pure state machine (`newGame`, `play`, `market`, `aiMove`) with no DOM in it, and every effect is recorded as an event (`draw`, `play`, `reshuffle`). That made it possible to run the engine unchanged on a server and replay its events as animation on every screen.
- **Fair shuffling.** Fisher–Yates with a crypto random source, then same-number cards spread apart (replaced since: see "Shuffling" below).
- **Careful rules.** The rules cover penalty stacking, partial blocks of pick-3, the check-up defence, playing several cards of one number at once, stalemate when the market runs dry, and refilling the market from played cards.
  - **Check up.** A player who plays their last card as a 2 or a 5 has checked up, and the next player gets one chance to defend. Only passing a pick 2 on with another 2 brings the checker back in (they pick 1 and play goes on). Blocking a pick 3 with a 5, in whole or in part, does not: the checker wins. Picking up the penalty also loses.
- **Pass-and-play privacy.** Hands stay hidden behind a "Show my cards" screen.

What stood in the way of online play:
- **Every hand lives in one browser.** That is fine on one phone, but a peer-to-peer or host-runs-the-game design would hand one player everyone's cards in devtools. Hidden information needs a referee nobody can peek at.
- **No way for a seat to change hands.** A seat was fixed as "human" or "computer" at the deal.
- **The randomness was mixed.** The AI used `Math.random` while the shuffle used crypto. Now there is one crypto-backed source.

I found no rule bugs in the engine. A 300-game soak test with 2 to 4 computer players finishes every game, and never loses or duplicates a card.

## How it works

```
browser ──ws──► Worker /ws/whot/:code ──► WhotTable Durable Object (one per table)
                                            owns the game, runs the computer turns,
                                            sends each connection only what that seat may see
```

- **Server-authoritative, unlike Flick Football.** Flick needs 60 Hz physics, so it plays peer to peer with rollback. Whot is turn based: a server round trip of 20 to 80 ms is invisible, and it buys three things.
  - Nobody's browser ever holds another hand or the market order.
  - No host can leave and take the table down.
  - Moves are checked against the real state.
- **Per-seat views.** `seatView(state, seat)` keeps your own hand and turns everyone else's into a count. The market becomes a number, and the played pile keeps its top two cards. Watchers see no hands at all until the round ends, when every hand is shown, as at a real table.
- **Draws for other people stay face down.** Someone else's draw arrives as a face-down card id (`hiddenId(seat, position)`) that matches the card's place in your next view. So the flying-card animation lands on the right seat without revealing anything. A test plays 120 games and checks this after every move, for every seat.
- **The same engine file runs in both places.** `public/whot/engine.js` is an ES module. The browser uses it for offline play and to draw online views (`hydrate` makes a view look like a full game, with face-down cards), and the Durable Object imports it as the referee.
- **The computer plays at once, and the browsers pace it.** After a person moves, the table plays every computer turn up to the next person in the same invocation, with no server timers. Each browser shows those turns one by one with a short "thinking" pause, and a backlog plays fast.

### Finding a free seat

- **Landing page (`/`).** An "Open now" list shows Whot tables with a free seat ("Ask to sit") and Flick players waiting for an opponent ("Play Sam"). The Check Up card also shows a green "1 open seat" badge.
- **Check Up's setup screen.** It has the same list, plus **Quick seat**.
- **One shared endpoint.** Both use `GET /api/open`, which asks the lobby once and is cached at the edge for 5 s (the cache key ignores the query string). Cost is one lobby lookup per location every 5 s however many people have the page open. Pages poll every 20 s, pause while the tab is hidden, and the landing page stops after 10 idle minutes.
- **Only opted-in tables appear.** A table shows up when its owner leaves "List my table" ticked (and it has a free seat), or a Flick player is open to challengers.

### Taking a seat: ask, notify, accept

Watching is free for anyone and shows no hidden cards. Sitting in a computer's seat takes its cards, so it needs the table's say-so.

| Who | What happens |
|---|---|
| Someone with the **invite link** (it carries the table's key) | Sits straight down. The link is the invitation. |
| Someone from the **open list**, or anyone with only the table code | **Asks.** They watch the table while the request waits. |
| Nobody is seated | Sits at once. There is no one to ask. |

1. **Request.** The request lives on the asker's own connection, not in storage, and the table schedules its alarm for it. One request per person, at most 4 waiting, and 30 s before someone who was declined can ask again.
2. **Notification.** Every seated player gets a bar: "**Sam asks for Computer 2's seat** · Joins in 12s unless someone says not now · [Not now] [Accept]". There is also a toast and a vibration. A background tab's title flashes "(1) Seat request". Watchers never see requests, and the asker's private reclaim id is never sent to anyone: requests are identified by a separate public id.
3. **Answer.** Any seated player can answer, and the first answer wins. **Accept** seats the asker in the requested seat, or the first open one if it has gone. **Not now** tells the asker who declined, and they keep watching.
4. **No answer.** The request is accepted after 15 s, so an idle or away player can't block a table. It is also accepted at once if every seated person leaves while it is waiting.
5. **The asker** sees "Asking for a seat · If nobody answers you are in after 14s" with Cancel, then "You are in".

Flick Football already worked this way: a challenger knocks, the host is told, and a 4 s auto-accept runs unless they decline.

### What happens to seats over time

| Situation | What happens |
|---|---|
| Open a table | Your seat is yours. The other seats are computer seats, open to ask for. |
| You leave (Leave, then Leave) or press Watch instead | You stand first, so the computer takes your cards at once. |
| You lose your connection (reload, tunnel, weak signal, phone call) | Your seat is **held for 60 s**. It keeps your name, shows "offline", and nobody else can take it. The computer covers your turns, but the first of them waits 15 s for you ("Waiting for Ada to reconnect… 12s"). Back in time: nothing happened. |
| You come back after the hold | The seat has the computer's name, but it is still yours: this browser takes it back automatically unless someone else has sat down. |
| Your phone lost signal but its socket never closed | The table reads the time of your last ping (pings never wake it). After 40 s of silence the connection counts as lost, not as you ignoring the clock, so it never costs you strikes. |
| You reconnect before the table noticed you dropped | The new connection takes over your seat at once and the old one is closed (4011). Nobody else sees a thing. |
| You go idle on your turn (still connected) | After 45 s the computer makes one move for you. After 2 timeouts in a row your seat goes back to the computer and you become a watcher. The clock only runs when 2 or more people are seated. |
| Nobody seated | The table pauses ("Take a seat to carry on"). |
| Everyone gone | The table is deleted 10 minutes after the last person leaves, so a host who switched apps to send the link (phones drop the connection within seconds) still finds it, and so does the friend. Someone arriving for any seat gets a computer seat nobody has a claim on before the absent host's own. |

### Staying connected on a poor network (the browser)

- **Dead sockets are found.**
  - The page pings every 10 s. If nothing at all comes back within 6 s of a ping, the socket is dead even if it says it is open, so the page drops it and connects again. A connection attempt that hangs for 8 s is dropped too.
  - Coming back to the tab, or the network coming back, checks at once.
- **Reconnecting keeps going.**
  - Backoff runs from 0.5 s doubling to 15 s, with jitter so a table does not retry in step. It waits for the network while the device says it is offline.
  - It keeps trying for 10 minutes, as long as the table keeps itself, before going back to the setup screen. Before, it gave up after about 22 s and dropped you on the setup screen.
- **What you see.**
  - "Reconnecting… your seat is kept for you." on your screen.
  - Others see your seat greyed out and marked "offline".
- **A tapped card is not lost.** Tapping Play or Market keeps the move until the table answers it (`net.move`, `sendMove` in `app.js`). Before, a move lost in flight left the card stuck for 6 s and the player had to tap again.
  - **No answer in 2 s:** the move is sent again, up to 3 sends over 6 s, and the connection is checked at the same time so a dead socket is replaced quickly. After the third send the screen is freed, but the move is kept.
  - **Tapped while disconnected:** the move is kept ("Your move goes through when you are back") instead of being refused.
  - **After a reconnect:** if the table's fresh state says it is still your turn on the same turn number, the move is sent once more. If the turn has moved on (the move did arrive, or the computer covered it), it is dropped. A move older than 20 s is dropped with "That move was not sent. Tap again."
  - **Why sending twice is safe:** every move names the turn it was made on, and the table refuses a turn it has already played (`stale` / `not-your-turn`). The page stays quiet about those refusals for 4 s after a resend, so a duplicate never shows as an error.
- **Another tab.** Opening the same table in another tab moves the seat there; the old tab says so and leaves.
- **Measured** in the browser, through a proxy that black-holes the player's traffic without closing the socket (a phone losing signal):
  - The player's screen says "Reconnecting…" after about 16 s.
  - When the signal is back, they are in their seat again about 0.1 s later.
  - The other player never saw them leave.

### Shuffling

The earlier shuffle was Fisher–Yates followed by a pass of random swaps that pushed same-number cards at most 3 apart. Measured over 20,000 deals, it had three problems:
- **Hands depended on the table size.** Hands are dealt round the table, so one player's cards sit 2, 3 or 4 apart in the deck.
  - A fair deal gives 0.636 same-number pairs per 5-card hand.
  - The swap pass gave 0.47 with 2 players, 0.43 with 3, and **0.75 with 4**, plus more double-Whot hands (7.0% against 6.1%).
- **No clear definition.** The swap pass stopped wherever it stopped, so there was no exact statement of which decks it made, or how often.
- **Slow.** It was 5× slower than a plain shuffle and used one crypto call per random number, thousands per deal.

Now (`engine.js`):
1. **Hands come from a uniform shuffle.** Every order of the 54 cards is equally likely. Measured: 0.631, 0.637 and 0.634 pairs per hand for 2, 3 and 4 players.
2. **The market is uniform among orders with no two same-number cards side by side** (`shuffleMarket`, rejection sampling). The rest of the deck after the deal, and every reshuffle of played cards, is shuffled again until no neighbours match. That includes the seam with the cards still in the market. Every allowed order stays exactly as likely as every other. If no such order exists (three 2s and a 7), the order with the fewest neighbours wins.
3. **The start card** is the first ordinary card from the top. Specials turned up on the way go back into the market at random, no longer all to the bottom.
4. **Random numbers come from crypto in batches** of 256. A deal is about 0.04 to 0.06 ms and takes 1 to 3 crypto calls.

### Midstream: from a game against the computer to an online table

In an offline game with one person in it, **Invite → Open table** sends the current game to a new table. Play carries on from exactly the same cards, and the computer seats become open seats. The table rebuilds the game from card ids only. It refuses any game where the 54 cards don't each appear exactly once, and card faces always come from the deck, never from the browser. If a game is refused, a fresh round is dealt.

### Invite and listing

- **Invite.** A code and a link (`/whot/?t=CODE&k=KEY`), with copy and share buttons. The key is what lets friends sit without asking. Only seated players are sent it.
- **How listing works.** The first seated person's browser keeps the table in the existing lobby (`/ws/lobby?game=whot&live=1&free=N`). The lobby stays storage-free and socket based, as for Flick. Lobby change: entries can carry `free` (open seats), which `/api/live` now returns.

## Around the table

- **The table:** a mahogany card table with a baize inlay, in a warm, dim room.
- **Seating:** you sit at the bottom (your seat, with your hand below it). The others sit around the rim in play order:
  - 2 players: your opponent sits opposite;
  - 3 players: left and right;
  - 4 players: left (plays after you), top, then right.

  Spectators see every seat, with seat 1 at the bottom.
- **Each seat shows** an avatar, the name, the card count and a few card backs. The player whose turn it is glows, and the turn clock appears on their seat.
- **Screen sizes:** on phones, the side seats stand upright so they fit beside the piles. From 900px wide the table grows, and every seat becomes a full nameplate.

## Walkie-talkie

- **How to talk:** hold the round mic button beside Play card (or hold Space on a keyboard) to talk to the others on the walkie-talkie: the seated players, and watchers too when the owner has opened it to all. A live waveform appears on the speaker's seat, and on your own button while you talk. Game sounds drop to 30% volume while someone else is speaking.
- **How audio travels:** WebRTC, browser to browser, one link per pair in the group, and the group holds at most 8 people (seated people first, then watchers in the order they arrived). The table server only passes the connection setup (`rtc`) and the "talking" flag (`talk`), and only between members of the group. Anyone outside it can neither send nor receive either. No audio touches the server.
- **When the mic is used:** each link carries a silent audio track until you hold the button, and holding just switches the microphone on, with no reconnection needed. The microphone is only requested on the first press, and released after 45 s without talking.
- **Open to everyone:** the owner (the table's creator, or the lowest seated person while the creator is away) has a switch in the Sound menu, "Open the walkie-talkie to everyone, including people watching" (`voiceall` message, stored as `voiceAll` on the table). It is off by default. Everyone else sees a note that it is on.
- **Voice ids:** each connection has its own public voice id (`vid`), so a seat changing hands or a reload always means fresh links. Messages are addressed by `vid`; the group list, with names and seats, comes in every update as `voice`.
- **Settings:** the Sound menu has a walkie-talkie on/off switch and a mute for each person in the group. Both are local to the listener.
- **Strict networks:** these need the optional Cloudflare TURN secrets to connect. Without them, those players simply won't hear each other.
- **Tested:** links connect between two browsers, a blocked microphone gives a clear message, and the waveform appears on the speaker's seat. Real audio quality and iPhone behaviour need a check by ear on real phones.

## Cost

The table hibernates between messages. Because hibernation drops memory, it keeps **one small row** (the game, about 5 KB), rewritten once per person's move, in SQLite storage, and deletes it when the table empties. The cost lint now enforces this pattern: the relay room and lobby must stay storage-free, and any file that stores state must also call `deleteAll`. One alarm covers the turn clock, the reconnect grace and the clean-up.

| Item | Per 15-minute, 4-player game (about 120 human moves) |
|---|---|
| Incoming messages (20:1 billing) | about 6 request-equivalents |
| Storage writes | about 120 rows, roughly $0.0001 |
| Duration | Worst case awake the whole game: $0.0014 (0.125 GB × 900 s). Slow players let it hibernate. |
| Idle or empty tables | $0. Deleted 10 minutes after the last person leaves (one 5 KB row until then). |

Computer turns cost nothing extra: they run inside the person's move that triggered them.

## Files

- `public/whot/engine.js`: the rules, per-seat views, and validation of a game handed over from a browser. It is shared by browser and Worker.
- `public/whot/engine.d.ts`: types for the Worker. It is never uploaded (`public/.assetsignore`).
- `public/whot/index.html`, `public/whot/app.js`: the original screens and animations, now drawing either a local game or the table's view.
- `src/whot.ts`: the `WhotTable` Durable Object (binding `WHOT`, migration `v2`).
- `test/worker/whot.test.ts`: the table tests listed below, plus the poor-network tests:
  - a dropped seat held under its name, kept from strangers and link holders, with one wait on the next turn;
  - the hold running out with the claim kept;
  - a reconnect replacing a socket that still looks open;
  - a silent connection at the turn clock (no strike, not "away");
  - a deliberate leave keeping nothing.
  - the table: dealing, computer turns, nobody ever sent a hidden card, turn and legality checks, leaving and reclaiming, the reconnect grace, standing up, watchers, seeded and tampered games, the idle clock, clean-up, code collisions, next round and tally;
  - the ask flow: request, notify, accept, decline, cooldown, auto-accept, nobody to ask, wrong key, no leaks to watchers;
  - `/api/open` and its cache.
- `test/game/whot.test.mjs`: the engine tests, including the check-up cases (a 2 brings the checker back in; a whole or partial 5 block does not; picking up loses; an ordinary block with no check up is unchanged). The first group is:
  - the 300-game soak;
  - views hold only your cards;
  - face-down draws line up with the next view;
  - handing over a game;
  - a single random source;
  - shuffling: hands as fair as a fair deck at every table size; no same-number neighbours in the market; every allowed market order equally likely, seam included; the fewest clumps when none-free is impossible; batched crypto.

## Known limits and next steps

- **A watcher trails fast play.** Their screen animates each move (about 1 s), so with very quick players it runs a few moves behind, then catches up (a backlog of more than 3 messages plays without animation).
- **A handed-over game was dealt in a browser.** When someone opens a computer game online, the hands that already exist came from that browser. Fine for friends; a fresh table, dealt by the server, is the fair choice for strangers.
- **Names are not accounts.** Your seat is tied to a random id kept in this browser's storage, which is enough to reclaim a seat after a reload. It is not an identity.
- **Possible next steps:** sounds for card plays, a chat line or quick reactions like Flick's, and a host option for the turn clock length.
