# Whot Cup: product requirements and build plan

Status: draft for review · Owner: Obi · Last updated 2026-11-05

The Whot Cup is a scheduled, staked Whot tournament for up to 20,000 players. It launches on free coins and moves to naira only after legal sign-off. Every rule that is still a product choice is a per-cup setting the site admin controls, so the same code runs a 64-player coin pilot and a 16,384-player sponsored cup.

Related:
- Payout model (interactive): https://claude.ai/artifact/1xiiFLHP7xcebEbBAENoTa
- Player journey (every screen, with copy): https://claude.ai/code/artifact/c41ff3f0-3f39-4516-a05c-385d446afcf8
- Table architecture: [whot-online.md](whot-online.md)
- Cost rules and test tiers: [cloudflare-cost-protocol.md](cloudflare-cost-protocol.md)

---

## 1. Goals, non-goals and success measures

**Goals**
1. Run a weekend Whot cup that is fair, fast to join (under 2 minutes from landing to staked) and fun to follow.
2. Make the cup the main reason Nigerians and the diaspora return on weekends, and the main source of revenue (platform cut and sponsorship).
3. Make cheating, especially seeing other players' cards, technically impossible, and make collusion detectable.
4. Stay within the cost budgets in section 9 at every size from 16 to 20,000 players.

**Non-goals for this release**
- Real money. The cash phase (Phase 13) is designed for but is not built until counsel signs off.
- Other games. The cup engine is game-neutral where it is cheap to be. Ludo and Flick Football cups come later.
- Native apps. The PWA covers install and push notifications.

**Success measures (coin pilot, first four cups)**

| Measure | Target |
|---|---|
| Landing → staked, median time | ≤ 2 min |
| Checked-in share of entrants | ≥ 85% |
| Players who finish every table they were seated at (no forfeits) | ≥ 95% |
| Second Chance take-up (measured, feeds the cash model) | recorded per round |
| Entrants who enter the next cup | ≥ 40% |
| Hidden-card leaks found by tests, review or bounty | 0 |
| Infra cost per player per cup, excluding SMS | ≤ $0.002 |

---

## 2. Roles

| Role | Who | Can |
|---|---|---|
| Visitor | Anyone | Play free tables, watch cups (delayed, no hands), see cup pages |
| Player | Verified phone number, 18+ declared | Enter cups, stake, play, buy Second Chance, appear on leaderboards |
| Spectator | Anyone with the link, signed in or not | Watch cup tables with a delay and no hidden cards |
| Cup admin | Staff, allow-listed | Create, configure, publish, pause and cancel cups; see live operations |
| Integrity reviewer | Staff, allow-listed | Work the collusion and fraud queue; hold, release or void results |
| Finance approver (cash phase) | Staff, allow-listed | Approve payouts above thresholds. Never the same person who configured the cup. |

---

## 3. Glossary

| Term | Meaning |
|---|---|
| Main draw | The first draw everyone plays. Not advancing is the first loss. |
| Second Chance (SC) | An optional paid re-entry after a first loss in the early rounds. A loss here is the second loss. |
| Grand Final (GF) | One table: the top 2 from the main-draw final table and the top 2 from the Second Chance final table. |
| Rung | The pay for 1st and 2nd at a table in a given round. |
| Pot | Money staked into one draw. Each draw's pot pays its own tables plus its share of the Grand Final. |
| Slot | One 15-minute window in which both draws play a round. |
| Cup config | The frozen set of settings a cup runs with (section 5). |

---

## 4. Cup rules (default settings)

These are the defaults. Every bold term is a setting in section 5.

1. Tables of 4, seated at random every round. Fields that don't divide by 4 get up to three tables of 3.
2. Main draw: the top 2 at each table of 4 advance (**advancePerTable**). At a table of 3, only the winner advances. While more than **top1Threshold** players are left, only the winner advances.
3. 1st and 2nd at every table are paid. 2nd earns **secondShare** of 1st. Pay rises by **growthPerHalving** each time the field halves.
4. A first loss in main-draw rounds 1 to **scCutoffRound** can be bought back for **scFee** within **scBuyWindowSec**. Players who don't buy back go home.
5. In Second Chance, only the winner advances when **scWinnerOnly** is on. 2nd is still paid. A second loss ends the cup.
6. Each draw ends with a final table whose top 2 go to the Grand Final. The GF pays **gfSplit** of the GF pot, which is **gfShare** of each pot after the platform cut.
7. The platform keeps **platformCut** of every stake.
8. When the table clock runs out, the remaining players rank by fewest card points, then fewer cards, then seat order. When someone checks up, the others rank the same way behind them. A player who forfeited ranks below everyone who stayed. (Seat order is the seat at this table, which comes from the round's published seed.)

---

## 5. Cup configuration (admin)

Every open product decision is a setting. A cup is created from a template, edited as a draft, checked against the payout model, then published. **Settings freeze when registration opens.** Only the safety switches (pause, cancel, extend check-in) change after that, and every change is audited.

### 5.1 Settings

| Group | Setting | Type | Default | Allowed | Notes |
|---|---|---|---|---|---|
| Identity | `name`, `slug`, `description`, `sponsor` | text | | | Sponsor shows a logo and a line on the cup page |
| Currency | `currency` | enum | `COIN` | `COIN`, `NGN` | `NGN` is blocked until the cash phase flag is on |
| | `entryFee` | int | 1,000 | 100–100,000 | In the cup's currency |
| | `platformCut` | % | 20 | 0–30 | Applied to entry fees and SC stakes |
| | `guaranteedPool` | int | 0 | ≥ 0 | Sponsor top-up added to the main pot |
| Field | `capacity` | int | 1,024 | 16–20,000 | |
| | `minEntries` | int | 16 | 8–capacity | Below this at close: cancel and refund |
| | `oversubscription` | enum | `random-draw` | `random-draw`, `first-come` | How seats are chosen when entries exceed capacity |
| | `waitlist` | bool | on | | No-show seats go to the waitlist |
| Schedule | `registrationOpensAt`, `registrationClosesAt`, `checkInOpensAt`, `startsAt` | time | Sat 16:00 WAT, check-in 15 min before | | Shown in each player's local time |
| | `checkInCloseBeforeStartSec` | int | 300 | 60–900 | |
| | `noShowRefund` | enum | `full` | `full`, `none` | |
| Rounds | `tableClockSec` | int | 600 | 300–1,200 | Per table |
| | `turnClockSec` | int | 30 | 15–60 | Per move at cup tables |
| | `breakSec` | int | 240 | 60–600 | Gap between rounds |
| | `disconnectGraceSec` | int | 60 | 15–120 | Computer holds the seat, then forfeit |
| | `maxRounds` | int | derived | | Publish is refused if the model needs more |
| Advancing | `advancePerTable` | int | 2 | 1–2 | |
| | `top1Threshold` | int | 2,048 | 0–∞ | 0 = always top 1 |
| | `tableOfThreeAdvance` | int | 1 | 1–2 | |
| Pay | `secondShare` | % | 50 | 25–90 | |
| | `growthPerHalving` | % | 41 | 25–60 | |
| | `roundTo` | int | 10 | 1–100 | Floor each payout; leftovers go to the GF |
| Second Chance | `scEnabled` | bool | on | | |
| | `scFee` | int | 500 | 0–entryFee | |
| | `scCutoffRound` | int | 3 | 1–∞ | |
| | `scBuyWindowSec` | int | 60 | 30–180 | Decides *buy-in window* |
| | `scPayFromWinnings` | enum | `default-on` | `off`, `allowed`, `default-on` | Decides *paying for Second Chance from winnings* |
| | `scWinnerOnly` | bool | on | | |
| Grand Final | `gfShare` | % | 30 | 10–60 | Decides *Grand Final share* |
| | `gfSplit` | list | 50/25/15/10 | sums to 100 | |
| | `gfEdge` | enum | `none` | `none`, `lead-first`, `seat-choice` | Decides *an edge for unbeaten finalists* |
| Table | `voice` | enum | `off` | `off`, `seated` | Off by default at cup tables (section 8) |
| | `chat` | enum | `presets` | `off`, `presets` | Free text is never allowed at cup tables |
| | `spectators` | enum | `delayed` | `off`, `delayed` | |
| | `spectatorDelayMoves` | int | 3 | 2–10 | |
| | `revealHands` | enum | `after-table` | `never`, `after-table` | |
| | `cheers` | bool | on | | |
| | `cheerPlayerShare` | % | 50 | 0–100 | |
| Integrity | `separateDevices` | bool | on | | Never seat two accounts that share a device |
| | `separateNetworks` | enum | `rounds-1-3` | `off`, `rounds-1-3`, `always` | Never seat shared-IP accounts together |
| | `separateInviteLinks` | bool | on | | Inviter and invitee are never seated together in the early rounds |
| | `payoutHoldHours` | int | 0 (coins) / 24 (cash) | 0–168 | |
| Eligibility | `phoneCountries` | list | all | ISO list | Limits SMS cost and fraud exposure |
| | `minAccountAgeHours` | int | 0 | 0–720 | For cash cups |
| | `maxEntriesPerPlayer` | int | 1 | 1 | Fixed at 1. A setting so the rule is visible. |

Global economy settings (not per cup, in the admin console): `coinWelcomeGrant` (default 5,000), `coinDailyTopUp` (default 1,000, at 08:00 WAT), `coinBalanceCap` (default 20,000).

### 5.2 Publish checks (the admin cannot publish a cup that fails these)

- [ ] The payout model runs at `minEntries`, the expected entries and `capacity`, and every rung pays ≥ `roundTo` to 1st and 2nd.
- [ ] In every round both draws play, a Second Chance table win minus `scFee` pays less than a main-draw table win, so losing on purpose never pays.
- [ ] The model's total rounds × (table clock + break) fits before the admin's `mustEndBy`.
- [ ] Every stake balances: the platform cut, plus all table pay, plus the GF pot, equals all stakes, to the unit.
- [ ] `currency = NGN` only when the cash flag is on and a finance approver has countersigned the config.
- [ ] Every schedule time is in the future and in order.

The admin console shows the model's output (pay per round, GF prizes, the share of players who win something, duration) beside the form, using the same engine the server uses.

---

## 6. Functional requirements

Each requirement has an id used by the build plan.

### 6.1 Identity (ID)
- **ID-1** Phone sign-in with a 6-digit SMS code, only when the player enters a cup or opens their wallet. Free play stays account-free.
- **ID-2** One player per phone number. Numbers are stored as an HMAC for lookup, and encrypted for display.
- **ID-3** Name (2–14 characters, filtered) and avatar (Whot shape + colour). Names are unique per cup at display time ("Tunde", "Tunde 2").
- **ID-4** An 18+ declaration. The cash phase adds checks in Phase 13.
- **ID-5** Sessions are an HttpOnly, Secure, SameSite=Lax cookie holding an opaque id that maps to a session row. 30-day expiry, revocable. One active cup connection per player: a second device takes over and the first becomes a spectator.
- **ID-6** Turnstile on the OTP request. Per-number, per-IP and per-country rate limits stop SMS pumping.

### 6.2 Wallet and ledger (WL)
- **WL-1** Every balance is the sum of append-only ledger entries. Entries are double-entry: every credit has a matching debit to another account (player, cup pot, platform, sponsor, refund).
- **WL-2** Each entry carries an idempotency key (`cup:round:table:seat:kind`), so a retried write never pays twice.
- **WL-3** Coins: welcome grant, daily top-up, balance cap. Coins can't be bought, sold, transferred or cashed out.
- **WL-4** A player sees a wallet with a history of entries, plus the cup strip (staked, won, net) on every cup screen.
- **WL-5** Reconciliation: after every cup, each pot sums to zero. A nightly job checks every balance against its entries and pages on any mismatch.

### 6.3 Cup lifecycle (CL)
- **CL-1** States: `draft → scheduled → registration → closed → check-in → running → finals → settling → settled`, plus `paused` and `cancelled` from any live state.
- **CL-2** Registration: stake on entry. Above capacity, the cup either waitlists (first-come) or holds all entries until close, then draws seats at random and refunds the rest (random draw).
- **CL-3** Check-in: an "I'm here" tap during the window. Unclaimed seats go to the waitlist at `checkInCloseBeforeStartSec`. No-shows are refunded according to `noShowRefund`.
- **CL-4** Payout schedule: when check-in closes, the director runs the payout engine on the actual field and freezes every rung. The cup page switches from "about" to exact amounts. Main-draw pay is exact, because its shape depends only on the field. Second Chance pay must be frozen before anyone buys in, so it uses the smallest base across take-ups of 10% to 100% (`planSecondChanceBase`). Inside that range Second Chance tables stay within their own pot. Outside it, the Grand Final absorbs the difference. Measured worst case: the Grand Final keeps 99.2% of its main-draw share (4,096 players, 1% take-up). The tests hold it to at least 95%.
- **CL-5** Cancel: any stage before settling refunds every stake, including Second Chance stakes. Partial results are voided. Players are told why.
- **CL-6** Pause: tables in progress finish, and no new round starts until the admin resumes. The clock shown to players is held.

### 6.4 Seating (SE)
- **SE-1** Before each round, the director commits to a seed by publishing `sha256(seed)` on the cup page. After the round it publishes the seed. Anyone can recompute the seating from the seed and the published player list.
- **SE-2** Seating = a seeded shuffle, then a constraint pass: no shared device ever, no shared IP while `separateNetworks` applies, no inviter–invitee in rounds 1–3. The pass is deterministic, so the published seed still reproduces the seating.
- **SE-3** Table sizes as balanced as possible (3–4), exactly as the engine cuts them. The only exception is a field of exactly 5, which the engine seats as 3 + 2 (the 2-seat table sends its winner through).
- **SE-4** Each seat is issued as a signed seat token (HMAC over cup, round, table code, seat, player, expiry). The table accepts a sit only with a valid token for that seat. Nobody can ask for, take or swap a cup seat.

### 6.5 Cup tables (TB)
Cup tables are their own Durable Object, `CupTable` (`src/cup/table.ts`), built on the same rules engine and the same message shapes as the free `WhotTable`, so one browser client draws both. The rules engine is unchanged. The table's rules live in a pure core with an injected clock (`src/cup/tablecore.ts`), which is what the leak fuzz plays.

*Changed from the first draft*, which had `WhotTable` grow a cup mode. In a separate class, the free table's seat requests, invite keys, computer-seat takeovers, rematches and `adoptState` don't exist at all, so no setting or bug can switch them on at a cup table. The cost was one binding and one migration (`v4`).
- **TB-1** The server deals every cup game. `adoptState` (handing over a browser game) is refused in cup mode.
- **TB-2** Seats are bound by token (SE-4). Seat requests, the invite key and computer-seat takeovers are off.
- **TB-3** Turn clock `turnClockSec`. On timeout the computer makes one fair move (`aiMoveFair`: it sees only that seat's view). Table clock `tableClockSec`, then the clock ranking rule (section 4). The deal happens when everyone is there, or a minute after seating, whichever comes first. The table clock always ends at least 15 s before the director's backstop.
- **TB-4** Disconnects: a dropped player's own turn waits 10 s for them, then the computer plays their cards. After `disconnectGraceSec` away, they forfeit that table and rank last. A turn's deadline belongs to the turn, so dropping and reconnecting never buys a fresh clock. With nobody left at the table to play against, the table waits rather than letting the computer play the game out.
- **TB-5** Result: when the places are decided, the table sends one signed result to the director (places, card points, moves, duration). It then keeps its row only until the reveal window ends, and deletes it.
- **TB-6** Voice per `voice`. Chat per `chat` (preset phrases only).
- **TB-7** Spectators get the public view only (counts, discard pile, whose turn), `spectatorDelayMoves` behind. Hands are revealed only after the table ends, and only when `revealHands = after-table`. This changes the player journey doc, which showed a followed player's hand live.

### 6.6 Rounds and draws (RD)
- **RD-1** The director starts a slot when every table of the previous slot has reported or hit its clock, plus `breakSec`. Main draw and Second Chance tables in one slot start together.
- **RD-2** Advancing follows section 4, computed by the same engine as the model (`src/cup/engine.ts`, shared with the admin preview).
- **RD-3** The Second Chance offer goes to eligible losers the moment their table reports. It closes after `scBuyWindowSec` or when the next slot seats, whichever comes first. With `scPayFromWinnings`, the stake comes from this cup's winnings first.
- **RD-4** Second Chance waits for main-draw inflow while its pool is 4 or fewer, and runs its final once inflow has stopped.
- **RD-5** The Grand Final seats once both finals have reported. `gfEdge` applies here.
- **RD-6** Settlement: every table pay is credited when its table reports. GF prizes are credited at the end. The cup becomes `settled` after reconciliation (WL-5) passes, or after a payout hold when `payoutHoldHours > 0`.

### 6.7 Player experience (PX)
Screens and copy follow the player journey doc. Requirements that shape the build:
- **PX-1** Cup page: countdown, seat counter, entry, prize ladder (estimated, then exact), schedule in local time, friends who entered, verifiable seeds once published.
- **PX-2** Hub between rounds: My cup, Bracket, Leaderboards (this cup, friends), Watch. *Cities and season boards were dropped for now (2026-11-05): players have no city, and no season is defined.*
- **PX-3** Result cards for every outcome, always showing this table's pay and the cup net. A net loss is never called a win.
- **PX-4** Notifications: Web Push (PWA) for "starts in 2 hours", "check-in open", "your table is ready" (at seating, and again 30 s later), "Second Chance offer" and "Grand Final live". SMS only for check-in, and only when the player opted in. A notification isn't shown when the page it points to is already on screen.
- **PX-5** Share cards rendered on demand: entered, round reached, champion. Each carries a link to the cup or the next cup.
- **PX-6** Accessibility: every result announced to screen readers, every timer readable as text, reduced motion respected.

### 6.8 Spectating and cheers (SP)
*SP-2 and SP-3 were dropped with Phase 8 (2026-11-06). The `cheers` and `cheerPlayerShare` settings remain in the config but do nothing.*
- **SP-1** Watch any cup table, delayed and with no hidden cards (TB-7). Signed-out viewers are welcome.
- **SP-2** Cheers (signed-in players only): a fixed set of coin amounts, `cheerPlayerShare` to the player and the rest to the platform. Rate-limited, and never to yourself or to a player at your own table.
- **SP-3** Grand Final mode: a single live table promoted on the home page, with a cheer meter and a commentary strip generated from public events only.

### 6.9 Admin console (AD)
- **AD-1** Allow-listed staff sign in with phone plus a second factor (a passkey).
- **AD-2** Cups: create from a template, edit, run the model, see publish checks, publish, duplicate. Copy or share each cup's registration link, and switch its home page banner on or off.
- **AD-3** Live view: state, slot, tables running and late, connection counts, SC take-up, error rate, cost meter.
- **AD-4** Safety switches: pause, resume, extend check-in, cancel with refunds, void a table, re-seat a round.
- **AD-5** Integrity queue (section 8.3): flags, evidence, decision (clear, hold, void, ban), notes.
- **AD-6** Audit log: every admin action with who, when, before and after. Read-only, kept for 2 years.
- **AD-7** Economy settings (5.1, global).

### 6.10 Responsible play (RP)
- **RP-1** The net figure is always visible on cup screens.
- **RP-2** A player-set weekly entry limit, and a cool-off (24 hours, 7 days, 30 days) that blocks entry. Built in coins so it is ready for cash.
- **RP-3** Plain-language rules and odds: "About 1 in 6 players finish ahead", computed from the frozen schedule.

---

## 7. Architecture

```
Browser (PWA) ──HTTP──► Worker /api/*  ──► D1 (players, wallets, ledger, cups, registrations, audit)
     │                     │
     │                     └─RPC─► CupDirector DO (one per cup: lifecycle, seating, results, settlement)
     │                                    │  RPC fan-out once per slot
     ├──ws──► CupGate DO (sharded by player, 32 shards: "your table is ready", SC offers, live wallet)
     └──ws──► CupTable DO (one per cup table: seat tokens, clocks, delayed spectators)
                     └─RPC result─► CupDirector
```

| Component | Holds | Why this shape |
|---|---|---|
| D1 `playcity` | System of record for money and identity | Queryable, transactional per statement batch, cheap at this volume |
| `CupDirector` DO (per cup) | Live cup state: the field per draw, slot, table map, frozen schedule | One coordination atom per cup. A round barrier needs one place that knows every table. |
| `CupGate` DO (per shard) | Players' hub sockets, no storage | Spreads up to 20,000 sockets across 32 objects. Hibernates between pushes. The director sends one RPC per shard per slot, not one per player. |
| `CupTable` DO (per table) | One game row while the table runs | Same engine and messages as the free `WhotTable`, without its seat requests, invites or adoptState. Created by its first connection from the director's own record (`tableSpec`). Reports a signed result, then deletes itself after the reveal window. |
| Edge cache | Cup page, bracket and leaderboard JSON (5 s) | Thousands of viewers cost one origin read per colo every 5 s |

**Director storage.** One row per registration (player, draw, state, table), written in batches of up to 500 per transaction. One blob per slot (seating and results). No per-move writes ever reach the director.

**Shared engine.** `src/cup/engine.ts` is a TypeScript port of the payout model (`simulate`, the schedule and the advancing rules). It runs in the Worker (the director), in the admin preview (browser bundle) and in tests. One engine means the preview cannot drift from what the cup pays.

---

## 8. Security and anti-cheat

### 8.1 Threat model

| # | Threat | How someone would try it | Mitigation | Proven by |
|---|---|---|---|---|
| T1 | **Seeing other players' cards** | Read messages, devtools, the WebSocket stream, the bundle or the API | Server-authoritative table. Every connection gets only `seatView(seat)`. The market order and other hands never leave the table DO: not in messages, attachments, logs, results or director RPC. | Leak fuzz test (S-1) on every message to every role, every move, 1,000 games |
| T2 | Seeing cards through a spectator friend | Friend watches the table and relays by phone | Spectators get public info only, `spectatorDelayMoves` behind. Hands are revealed only after the table ends. | S-2 |
| T3 | Predicting the deck | Guess the shuffle or seed | Crypto RNG for the deck (already `rand()`). Seating seeds are committed before and revealed after, and are never used for the deck. | S-3: deck order is independent of any published value |
| T4 | Tampered or forged moves | Send another seat's move, replay old moves, malformed JSON | Seat comes from the bound connection, never the message. The `turn` counter is checked (existing). Schema validation and size caps. | Existing table tests + S-4 fuzz |
| T5 | Taking someone else's seat | Guess a table code, reuse a link | Signed seat tokens bound to player, seat, round and expiry. Table codes for cups are 10 random characters. | S-5 |
| T6 | Collusion (soft-play, card feeding) | Two friends at one table help each other | Seating constraints (SE-2). Voice off and preset chat only. Detection (8.3). Holds in cash cups. | S-6 detection replay on seeded collusion bots |
| T7 | Multiple accounts | Several numbers, one person | One number per player, Turnstile, device id, IP signals, payout name match (cash), velocity limits | S-7 |
| T8 | Bot assistance | A computer advises the human | Not preventable outright. Detect timing and move-quality signatures (8.3). Ban on confirmation. | Detection job metrics |
| T9 | SMS pumping fraud | Bots request OTPs to premium numbers | Turnstile, per-number/IP/country limits, `phoneCountries`, daily SMS spend cap with an alert | S-8 rate-limit tests |
| T10 | Account takeover | SIM swap, stolen session | Session revocation, re-verify on new device for wallet actions, payout-change cool-down (cash) | S-9 |
| T11 | Stalling and disconnect abuse | Disconnect to freeze a table | Turn clock, table clock, grace then forfeit | Existing idle tests + S-10 |
| T12 | Insider abuse | Admin edits a live cup or pays a friend | Config freezes at registration. Audit log. Finance approver ≠ configurer. Seeds committed in public. | S-11 |
| T13 | Ledger manipulation or double pay | Retry storms, races | Idempotency keys, double-entry, per-cup zero-sum check, nightly reconciliation | S-12 |
| T14 | Cost and denial attacks | Open thousands of sockets, hammer endpoints | Connection caps per DO, per-IP limits on upgrades, Turnstile on entry, edge-cached public JSON | T3 load tests |
| T15 | Personal data exposure | Leak phone numbers | Numbers are HMAC'd for lookup and encrypted at rest. Only the last 2 digits are ever displayed. Nigeria Data Protection Act 2023 and UK GDPR notices. | S-13 |

### 8.2 Hidden information rules (enforced in code and tests)
1. Only the table DO ever holds a full game. Its storage row is deleted when the reveal window ends.
2. Every outbound message is built from `seatView` or the public view. No message type serialises the game directly.
3. The result sent to the director has places, points and counts, never cards.
4. Logs never include a card id. A lint rule bans logging `g`, `hand` or `market` in `src/`.
5. Spectator and replay views come from a delayed public log, never from the live game.
6. The client bundle contains no seed, key or server secret. `scripts/cf-lint.sh` greps the built assets for secret patterns.

### 8.3 Collusion and assistance detection (v1, rules-based)
Run after every cup, from table results and the public move logs:
- **Pair rate:** two accounts seated together more often than chance (should be about never, given SE-2) → flag.
- **Joint advance:** a pair whose shared tables end 1st and 2nd far more often than chance → flag.
- **Feeding:** a player who repeatedly plays penalty cards into one opponent when another option was legal → flag.
- **Timing:** move times that are too even, or too fast for the position across many tables → flag (possible bot help).
- **Shared signals:** same device id, same IP block, or the same payout account across accounts → flag.

Each flag opens a queue item with the evidence. Coin cups: review, then warn or ban. Cash cups: winnings over a threshold are held until review.

---

## 9. Efficiency and cost (continuing the cost protocol)

The cost protocol's tiers T1–T5 apply to every cup component. New budgets:

| Budget | Target |
|---|---|
| Infra cost per player per cup (excluding SMS) | ≤ $0.002 |
| Rows written per player per cup, D1 + all DOs | ≤ 40 (6 per ledger entry: stake, Second Chance and 2–4 table pays; about $0.00004) |
| Director's own rows written per player, whole cup | ≤ 5 (measured 4.21 at 16,384) |
| D1 rows written per player for payouts and table records | ≤ 10 (measured 7.53 at 16,384) |
| Gate RPCs per slot | ≤ 32 (one per shard); a table's result reaches only its players' gates (≤ 4) |
| Cup table: rows written per move | ≤ 1 (measured: 80 moves, 81 rows, the extra one is the report; an unchanged table writes nothing) |
| Cup table: idle once the result is sent | hibernated, row and alarm deleted 90 s after the table ends |
| Public cup JSON origin reads | ≤ 1 per colo per 5 s |
| Director CPU per slot transition, 16,384 players | ≤ 200 ms (unverified: local wall time, D1 included, was 16.4 s for the round-1 slot in simulate mode; measure on staging, T4) |
| Sockets per gate shard at 20,000 players | ≤ 700 |

Rough cost at 1,024 players: about 1,000 tables × worst case $0.0014 = $1.40 of table time, plus under $0.10 for the director, gates and D1. That's about $0.0015 per player. Every load test re-measures it.

---

## 10. Data model (D1)

| Table | Key columns |
|---|---|
| `players` | id, phone_hmac (unique), phone_enc, name, avatar, created_at, flags, cool_off_until, weekly_limit |
| `sessions` | id, player_id, device_id, created_at, expires_at, revoked_at |
| `otp_requests` | phone_hmac, ip_hash, country, created_at, attempts (TTL 24 h) |
| `accounts` | id, kind (player, platform, issuer, cup, sponsor), owner, currency, balance (CHECK ≥ 0 except the issuer), last_topup_day |
| `ledger` | id, idem_key (unique), from_account, to_account, amount, currency, kind, player_id, cup_id, memo, created_at |
| `cups` | id, slug, state, config_json (frozen), config_hash, schedule_json (frozen at check-in close), created_by, promoted (home page banner, a console switch) |
| `registrations` | cup_id, player_id, state, seat_draw_rank, checked_in_at, sc_bought_at, invited_by (indexed both ways for the friends board: one extra index row per entry, two when invited) |
| `table_results` | cup_id, slot, draw, table_code, places_json, pay1, pay2, late, reported_at, stats_json (how it ended, moves, duration, points, cards and timeouts per place, forfeits; signed by the table, never a card) |
| `seeds` | cup_id, slot, commitment, seed (null until revealed) |
| `push_subs` | id (SHA-256 of the endpoint), player_id, endpoint, p256dh, auth, created_at |
| `sms_spend` | day, kind, n: texts that aren't sign-in codes, so one daily SMS cap covers all spend |
| `flags` | id, cup_id, kind, players, evidence_json, state, reviewer, decision, notes |
| `audit` | id, actor, action, target, before_json, after_json, at |

Balances are the sum of `ledger` entries. `accounts.balance` is a running total written in the same transaction as each entry, and the nightly reconciliation proves the two agree. `settings` holds the global economy values.

---

## 11. Rollout gates

| Stage | Field | Currency | Gate to move on |
|---|---|---|---|
| Internal | 16–64 staff and friends | Coins | No P0 bugs, every security test green, cost budgets met |
| Closed beta | 256 invited | Coins | Check-in ≥ 85%, forfeits ≤ 5%, no leaks, reconciliation clean |
| Open coin cups | 1,024 weekly | Coins | Four clean cups, return rate ≥ 40% |
| Large coin cup | 4,096 then 16,384 | Coins | T3 and T4 at that size passed beforehand |
| Sponsor cup | Any | Coins + sponsor prizes | Sponsor terms reviewed by counsel |
| Cash | Small first | NGN | Phase 13 complete, licence or legal opinion in hand |

---

## 12. Phased build plan

Tick each box as it ships with its tests green. Every phase ends with the cost protocol's T1 and T2 green and the security tests listed in that phase.

### Phase 0: Foundations and decisions
- [x] Engage Nigerian counsel on the cash phase (licence path, prize competition vs gaming). Engaged 2026-10-19. Outcome: pending, record it here.
- [ ] Agree this PRD. Copy any changed defaults into section 5.
- [x] Port the payout model to `src/cup/engine.ts` (simulate, schedule, advancing, Second Chance, GF) with types. Also holds `validateConfig`, `publishProblems` (5.2) and `planSecondChanceBase`.
- [x] Golden tests (`test/cup/engine.test.ts`): 1,024 players matches the published model to the unit (every rung, Second Chance field, GF prizes, platform cut, outcomes). 16, 128, 10,000 and 20,000 are pinned to the port's own output, because the model's final version was only recorded at 1,024.
- [x] Property tests over 2,000 random configs: balances to the unit, nobody has more than 2 losses, rounds bounded. Every advancing seat is paid in every cup that passes the publish checks, and the checks catch the ones that don't (a tiny stake with coarse rounding floors a rung to 0).
- [x] Add D1 binding `DB` (no id: the first deploy creates the database) and `migrations/`. Add `CupDirector` and `CupGate` (`src/cup/`, answering 501 until Phases 5 and 7) to `wrangler.jsonc` as `CUP` and `CUP_GATE`, migration `v3`, SQLite classes.
- [x] Extend `scripts/cf-lint.sh`: gates stay storage-free; no `console.*` that mentions a hand, the market, the deck or a game. `Math.random` was already banned across `src/`.

### Phase 1: Identity
- [x] `POST /api/auth/otp/start` (Turnstile, rate limits, allowed countries from `AUTH_COUNTRIES`) and `POST /api/auth/otp/verify` (`src/auth/routes.ts`). Per-cup `phoneCountries` is applied at entry in Phase 4. Live mode fails closed: no keys, no sender or no Turnstile secret means "Sign-in isn't open yet".
- [x] SMS sender interface (`src/auth/sms.ts`), a fake sender for dev and tests, and a daily cap on all codes with an alert at 80% and at the cap. **Still open:** the real provider (section 13, question 1). Until one is added, live mode can't send codes.
- [x] `players`, `sessions`, `otp_requests` tables (`migrations/0001_identity.sql`). Numbers are stored as an HMAC (`PHONE_HMAC_KEY`) and AES-256-GCM (`PHONE_ENC_KEY`, versioned `v1:`). Only the last 2 digits are ever shown. Session ids are SHA-256 of the cookie token.
- [x] Session cookie (`__Host-pc_s`, HttpOnly, Secure, SameSite=Lax, 30 days), sign-out, sign-out everywhere, device id (`__Host-pc_d`). Writes need our Origin and a JSON body. A daily cron deletes code rows after 24 hours.
- [x] Profile: name, avatar (5 Whot shapes × 8 colours), 18+ declaration, cool-off (24 h / 7 d / 30 d, only ever longer) and weekly limit (lower at once, raise or remove after 24 h). Page: `/account/` (sign in, code, setup, account; `?next=` returns to the page that sent them).
- [x] Tests (`test/worker/auth.test.ts`, 22): code expiry, lockout after 5 wrong guesses, single use, newer code replaces older, Turnstile, per-number/IP/country/global limits (S-8), one number one player however typed (S-7), sign-out and revoke-all (S-9), origin checks, profile rules, encrypted storage, cleanup.

**Before Phase 1 can go live:** choose the SMS provider and add its sender; create the Turnstile widget; set the secrets `PHONE_HMAC_KEY`, `PHONE_ENC_KEY` (32 random bytes each, base64), `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET` with `wrangler secret put`; deploy (creates the D1 database); run `wrangler d1 migrations apply playcity --remote`.

### Phase 2: Wallet and ledger
- [x] `accounts` and `ledger` tables (`migrations/0002_wallet.sql`), double-entry writer with idempotency keys (`src/wallet/ledger.ts`). Each transfer is one D1 transaction: an overdraft trips a CHECK, a reused key trips a UNIQUE index, an unknown account trips a foreign key, and the whole batch rolls back. `transferAll` applies many transfers all or nothing.
- [x] Coin welcome grant (5,000), daily top-up (1,000, claimed on the first wallet visit after 08:00 Lagos time, no cron), balance cap (20,000), read from the `settings` table with defaults (`src/wallet/wallet.ts`). The admin screen for them is Phase 3.
- [x] `GET /api/wallet` with signed history and paging. A Coins card on `/account/`.
- [x] Reconciliation: `reconcileAll` (every balance against its entries, every currency sums to zero) runs nightly on the existing cron and logs an alert line per mismatch. `reconcileCup` checks a pot against its entries and that a settled pot is empty; Phase 5 calls it at settlement.
- [x] Tests (`test/worker/wallet.test.ts`, 18): retries apply once and a reused key is refused (S-12); 10 parallel stakes against room for 5 lets exactly 5 through; batches are all or nothing; bad amounts and unknown accounts are refused; a whole cup ends with an empty pot and zero-sum books; reconciliation catches a tampered balance; grants, top-up, cap, the 08:00 turnover, settings, and the endpoint.
- [x] T2: measured **6 rows written per stake** (the entry, its three index entries, two balances), about $0.000006. The earlier "≤ 2" ignored index writes; the budget is now ≤ 6 and the test enforces it. Dropping `AUTOINCREMENT` saved one row per entry.

### Phase 3: Cup configuration and admin console
- [x] Admin sign-in (AD-1) at `/console/`: phone session + `staff` allow-list (roles owner, cup-admin, integrity, finance; first owner from `OWNER_PLAYER_IDS`) + a passkey (WebAuthn via `@simplewebauthn/server` 14.0.3, user verification required). Console sessions last 8 hours, cookie `__Host-pc_c` (SameSite=Strict), and only work with the same player's session. A second passkey needs an unlocked console. Challenges are single use.
- [x] Cup create, edit, duplicate, delete (drafts never published) and cancel (before registration opens), with every 5.1 setting (`src/cup/config.ts`, `FIELDS`). Edits name the version they read (409 when stale). Templates save from any cup; new cups start blank, from a template, or as a copy, with dates moved to the next Saturday.
- [x] Live preview: `npm run build` bundles `src/cup/config.ts` (engine included, 17 KB) to `public/console/cup.js`, and a web worker runs it at the minimum, expected and full field. Wrangler runs the build before `dev` and `deploy`.
- [x] Publish checks (5.2) run on the server (the authority) and live in the preview: settings valid, every rung pays, losing on purpose never pays, the cup fits before "must end by", registration in the future, naira only with the cash flag and a finance countersign from someone who didn't create or last edit the cup (any edit clears it). Publishing stores the SHA-256 of the canonical settings. Settings freeze when registration opens or the cup leaves `scheduled`.
- [x] Audit log (AD-6): every console write adds a row in the same transaction (who, action, target, before, after; edits store only the changed settings). A guarded change that loses a race writes no audit row. Kept 2 years. Tests (`test/worker/console.test.ts`, 19, real WebAuthn through a software passkey; `test/cup/config.test.ts`, 8): S-11 frozen edits, unpublish and cancel refused; forged, replayed and foreign passkey answers refused; roles enforced.
- [x] Economy settings screen (AD-7), owners and finance: welcome grant, daily top-up, cap, top-up hour, with range checks. Checked end to end in headless Chrome with a virtual passkey: set up, unlock, create a cup, live preview.

**Before the console goes live:** set `OWNER_PLAYER_IDS` (a `vars` entry or secret) to the first owner's player id, deploy, and apply migration `0003_console.sql` remotely. Staff need a device with a passkey (fingerprint, face or PIN).

### Phase 4: Cup page, registration and check-in
- [x] Public `GET /api/cups` and `GET /api/cups/:slug`, edge-cached for 5 s (`src/cup/routes.ts`). Internal settings (integrity, holds) are never sent. Drafts are invisible.
- [x] Cup page `/cup/?c=<slug>` (PX-1): countdown, seats, estimate then exact pay ladder, how it works, schedule in local and Lagos time, the published seeds, and one action card per state (sign in, enter, ticket, waitlist, check-in, live table, Second Chance offer, result, cancelled). Home banner for the next cup. Friends who entered waits for Phase 7 (friends need the invite graph).
- [x] `POST /api/cups/:slug/enter`: profile complete, cool-off, weekly limit, countries, account age, balance. One D1 transaction holds the registration, the seat counter (a `seats_full` CHECK) and the stake, so a full cup or an empty wallet rolls back everything. One entry per player (primary key). `ref` records who invited them (seating separation).
- [x] Oversubscription: first-come fills seats then the waitlist (or refuses when the waitlist is off). Random draw takes every entry (up to 5× seats) and draws at close from a seed committed when registration opened; the rest wait or are refunded.
- [x] Check-in (`POST .../checkin`) for seated and waitlisted players. At check-in close: no-shows refunded per `noShowRefund`, checked-in waitlisters promoted in line order, the rest refunded. Fewer than `minEntries` at close or at check-in close cancels with full refunds.
- [x] Payout bases frozen at check-in close on the real field (CL-4), platform cut taken, sponsor top-up added; the exact main-draw ladder is published (`cups.schedule_json`) and the cup page switches to it.
- [x] Tests (`test/worker/cup.test.ts`, 8, real sign-in): 8 players racing for 5 seats (exactly 5 pay), waitlist order, every refusal before money moves, the draw recomputed from the revealed seed, check-in with no-show and waitlist refunds to the coin, minimum-entry cancellation, public pages.

### Phase 5: Cup director and rounds
- [x] `CupDirector` (`src/cup/director.ts`): armed on publish, disarmed on unpublish, woken by alarms (`tick(now)` lets tests drive time). States follow CL-1. Pause holds the next round; tables in play finish. Cancel at any stage refunds everyone at least their stake, nobody hands back winnings, the issuer covers any shortfall (the platform, for naira), sponsor money goes back, the pot ends at zero.
- [x] Seeds: each slot's seed is committed (SHA-256 published) a slot ahead, before its players are known, and revealed when used (SE-1). Seating (`src/cup/seating.ts`): sfc32 shuffle of the sorted ids, engine table sizes, then a deterministic swap pass keeping apart shared devices, shared networks (per `separateNetworks`) and inviter–invitee in rounds 1–3. Second Chance seats from `sha256(seed + ":L")`.
- [x] Seat tokens (SE-4: HMAC over cup, slot, table, seat, player, expiry), served only to the seated player by `GET /api/cups/:slug/me`. 10-character table codes. The game tables that check the tokens are Phase 6; until then tables run in **simulate** mode (finish at random from the table's seed). **External** mode takes signed results (`report`).
- [x] Round barrier: the next slot seats `breakSec` after the last table finishes. Backstop: a table not finished by table clock + grace + 60 s is finished at random from its seed and marked late; the console's live panel lists late and overdue tables.
- [x] Advancing and both draws use the engine's own functions, step for step with `simulate()`. One documented difference: the engine knows a round's buyers before deciding whether Second Chance waits; the director decides at seating time from whether that round can still produce buyers. They agree whenever any loser buys in.
- [x] Second Chance: offers open as each main-draw table reports (rounds 1 to `scCutoffRound`), close after `scBuyWindowSec` or at the next seating; the stake moves at once (retry-safe); with `scPayFromWinnings: off`, this cup's winnings can't cover it. Buyers join the next slot; Second Chance waits while it is 4 or fewer and more may come.
- [x] Grand Final: seated once both finals are in, from its own seed. `gfEdge: lead-first` seats the main-draw finalists first so one leads; `seat-choice` needs the table screen (Phase 6).
- [x] Settlement: table pay credited as each table finishes; at the end the platform's Second Chance cut, then GF prizes from what is left (exactly the engine's GF pot); `reconcileCup` proves the pot is empty; every registration gets its finish and winnings.
- [x] Tests (`test/worker/director.test.ts`, 12): whole cups of 64 and 103 match `simulate()` exactly (every slot's tables, advancers and pay, Second Chance buyers, GF prizes, platform cut) with an empty pot and clean books; seating recomputed from the revealed seed; shared devices kept apart; cancel mid-cup (everyone ≥ their stake, pot zero); pause and resume; Second Chance rules; signed results, forgeries refused, overdue tables finished late; seat tokens.
- [x] T2 for the director (`npm run test:t2` for the full size; 4,096 runs in every suite). Measured at 16,384 players, whole cup: **4.21 rows per player** in the director's own storage (down from 8.22 after moving its tables to `WITHOUT ROWID` and dropping an index and mid-cup deletes) and **7.53 rows per player** in D1 for payouts and table records: about $0.19 for the whole cup. **Not yet met:** the slowest slot (round 1: 4,096 tables seated and all paid at once in simulate mode) took 16.4 s of wall time locally, against a 200 ms CPU budget. That figure includes local D1 writes and can't separate CPU; in external mode payouts arrive table by table instead. T4 on staging must measure real CPU before a cup above 4,096.

**Before Phases 4–5 go live:** apply migration `0004_cups_live.sql` remotely. Cups run in simulate mode (`CUP_TABLE_MODE` unset) until Phase 6 tables exist; set `CUP_TABLE_MODE=external` then.

### Phase 6: Cup tables and table security
- [x] `CupTable` (`src/cup/table.ts`, rules in `src/cup/tablecore.ts`), a separate class rather than a `WhotTable` mode (6.5). The server deals; nothing a browser sends can set up a game, so there is no `adoptState` to refuse (TB-1). Seats need a seat token plus the signed-in player it names (TB-2). The free table's seat requests, invite keys and computer-seat takeovers don't exist here. A table is created only by its first connection, from the director's record (`tableSpec`), which has no seed in it. Route: `/ws/cup/:slug/:code`. A token only works from our own Origin, and identity headers sent by a browser are dropped. A second device takes the seat over and the first one watches (ID-5).
- [x] Turn clock with one fair computer move on timeout, table clock with the ranking rule, a 10 s hold on a dropped player's turn, then forfeit after the grace (TB-3, TB-4).
- [x] Signed result with stats to the director (`report(code, places, sig, stats)`, stored in `table_results.stats_json`, migration `0005`). Retried with backoff until it lands or can never land, then the reveal window (90 s) and deletion of the row and the alarm (TB-5).
- [x] Voice for seated people only when `voice = seated`. Preset phrases only (8 of them, one per player every 2.5 s) when `chat = presets` (TB-6). Watchers can do neither.
- [x] Watchers: a public view built as each move happens and sent `spectatorDelayMoves` moves later. Nothing is shown until that many moves have been made. Hands appear only at the end, and only with `revealHands = after-table` (TB-7). `spectators = off` refuses watchers. Up to 200 watchers per table, the Grand Final included (Phase 8, which would have widened that, was removed).
- [x] **S-1 leak fuzz** (`test/cup/table.test.ts`): 1,000 random cup games with 2 to 4 seats, random settings, late arrivals, drops, idle turns and junk moves. Every view of every move, for every seat and the watchers, is checked against the live game it was built from: no card id outside that seat's own hand, the played pile and the cards just played, and no market. Results for the director carry no card. Latest run: 33,718 moves, 88 timeouts, 712 forfeits, every way a table can end, no leaks. The wire is checked too (`test/worker/cuptable.test.ts`).
- [x] **S-2:** watchers never get a hand or the market while the table runs, are never fewer than `spectatorDelayMoves` moves behind, and never go backwards (in the fuzz, and on the wire).
- [x] **S-3:** a table is never told a seed. 200 identical tables deal 200 different decks, and 10,000 deals show no dependence between the round's seed and four card positions (chi-squared, p < 0.0001).
- [x] **S-4:** malformed, oversized, out-of-turn, replayed, other-seat and free-table messages (`create`, `sit`, `again`, `answer`…) are refused. The stored row is byte-for-byte the same and nothing is written. In the fuzz, 33,555 junk moves changed nothing.
- [x] **S-5:** wrong, expired, other-seat, other-player, other-table and other-round tokens are refused. So are no session, a forged identity header, a missing or foreign Origin, an unknown cup and a code the cup never seated (nothing is stored for it).
- [x] **S-10:** across the fuzz, the longest wait for a move or the end never passed grace plus one turn (the worst case was 24 s inside the bound). Reconnecting never buys a fresh turn clock (T11). With nobody at the table, the computer doesn't play the game out.
- [x] T2: one row per move (measured 80 moves, 81 rows; the extra one is the report). An unchanged table writes nothing, so a watcher arriving costs no row. The table's memory was wiped before every one of the 80 moves and the game carried on from its row each time. The row and the alarm are gone after the reveal window, and a closed table can't be reopened.
- [x] A whole 16-player cup in external mode played on real tables by bots over WebSockets: every table's own ranking is what the director paid on, no table late, the pot empty and the books clean.
- [x] Browser client: `/whot/?cup=<slug>` opens your table (the token comes from `/me`, never the URL), and `&watch=<code>` watches one. It has a waiting sheet with who's here and the deal countdown, the table clock on your own seat, away and forfeited labels, a Say button for the presets and a result sheet with this table's pay. The cup page's "your table is ready" card links to the table. Checked in headless Chrome against `wrangler dev`, phone and desktop.
- [ ] Still open from Phase 5: `gfEdge: seat-choice` (finalists pick their seat). Publishing a cup with it set should be refused until it is built.

**Before Phase 6 goes live:** apply migration `0005_table_stats.sql` remotely. Deploy (adds `CupTable`, migration `v4`). Set `CUP_TABLE_MODE=external` (a `vars` entry), so newly published cups play on real tables. Simulate mode stays for rehearsals and the cost tests.

### Phase 7: Player experience
- [x] `CupGate` (`src/cup/gate.ts`): 32 storage-free, hibernating shards per cup at `/ws/cup/:slug/hub` (signed in, own Origin). A player always lands on the same shard (FNV-1a of the id). A second device takes over; the first is told and closed (ID-5). The director gathers what players need to hear during a tick and sends it once, one call per gate: "your table is ready" with the seat token, each table's result and any Second Chance offer, the cup's state and progress, check-in opening, the Grand Final going live. T2 holds it to ≤ 32 gate calls per tick at 4,096 players; a table's result in external mode reaches only its players' gates.
- [x] Hub screens on the cup page (PX-2): My cup (your tables with place and pay, the net, notifications, share), Bracket (every round by draw, then the finals with names), Leaderboard (this cup by coins won, and friends: anyone linked to you by an invite, either way), Watch (tables in play, biggest stakes first). "Friends who entered" now shows under the seat counter (PX-1). With the hub open the page updates when the gate says so, and polls only once a minute as a fallback. Public views carry names, never ids, and are edge-cached for 5 s.
- [x] Result cards for every outcome, with the cup's net always shown (PX-3): at the table (after the places and this table's pay) and on the cup page. "You won your table" never claims a cup win: the net sits right under it. `/me` now reports winnings live from the ledger (`registrations.won` is only written at settlement).
- [x] Second Chance offer at the table, the moment it ends: the countdown, the stake, where it's paid from (`scPayFromWinnings`), and the buy button.
- [x] Web Push (`src/push/`): VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291) in Web Crypto, checked against the RFC's test vector and decrypted by an independent implementation (`http_ece`). Players without the hub open get pushes from their gate, after it has answered the director. Subscriptions are accepted only for the browsers' own push services, and dead ones (404/410) are deleted. SMS for check-in only, only for players who opted in, and only when no push reached them. Those texts count against the same daily SMS spend cap as sign-in codes (`sms_spend`).
- [x] Share cards (PX-5): rendered at the edge as SVG (`/api/cups/:slug/card/:player`), from the player's own record: "I'm in", "Reached round N", "Nth in the Grand Final", "Champion!". The phone turns the card into a PNG and shares it as an image. The link (`/s/:slug/:player`) opens the cup with the player as the inviter, which is what builds the friends board. *Link previews show text and the app icon, not the card: WhatsApp and X don't preview SVG, and rendering PNGs in the Worker would need a 2.5 MB library.*
- [x] Accessibility (PX-6): axe-core (WCAG 2 A and AA) finds no violations on the cup page or on a cup table's result. Results, Second Chance offers and the last minute of the table clock are announced to screen readers. The tabs work with arrow keys. Every timer is text. The existing reduced-motion handling covers the new screens.
- [x] Tests (`test/worker/hub.test.ts`, `test/game/push.test.mjs`): every seated player hears their table with a token that works, then their result and offer, in one call per gate. A player who closed the app gets the table as a Web Push, sealed so the push service can't read it, and a dead subscription is deleted. A second device takes the hub over. Check-in texts reach only opted-in players no push reached. The bracket matches the director's tables, and the leaderboard, friends and your tables match the ledger to the coin. Share cards say how the player did and escape what they typed. Checked in headless Chrome against `wrangler dev`.

### Keeping players informed (added 2026-11-06)
From the notification-flow review ("Whot Cup Notification Flow"), built and tested:
- [x] **The ticket asks.** Right after entering, and until the cup starts, the cup page's "You're in" card offers notifications, the check-in text and **Add to calendar**. The calendar file (`/api/cups/:slug/calendar`) has one event, with an alarm when check-in opens. On an iPhone not yet installed, the card gives the three Add to Home Screen steps instead, since a Safari tab can't get notifications. Inside an app's built-in browser it says to open the page in Chrome or Safari.
- [x] **Back to your cup.** The home page shows a signed-in player's own cup above the games: "You're in: … · starts …", "Check in for …", or "Your cup is live · Next round in 3:12" (`/api/me/cups`). The installed app opens on the home page, so this is how returning players find their cup.
- [x] **The home page banner is a console switch.** Off by default. Owners and cup admins switch it on or off for any published cup, at any time; it isn't one of the frozen settings, doesn't change the cup's version, and is audited (`cup.home-banner.on/off`; `cups.promoted`, migration `0007`). Players with a cup of their own see their line instead of the banner for that cup.
- [x] **The registration link in the console.** Every cup shows its link (`/cup/?c=<slug>`) with Copy, Share and Open. It works once the cup is published.
- [x] **A second "your table is ready"** 30 s after seating, for tables that haven't finished. It replaces the first notification, and the service worker doesn't show it to a player who already has the table on screen. At most 32 gate calls, like every other message.
- [x] **The 2-hour reminder,** once per cup, to everyone with an entry, worded for their state (seat saved, seats still to be drawn, waitlist). Push only.
- [x] **Next round countdown.** The cup's live state carries `nextAt` (when the break ends) and `wRound`. Between rounds, the cup page counts down "Next table in 3:12 · 1st gets 950" (main draw), and the home page line does the same.
- Tests: `test/worker/reminders.test.ts` (banner switch, roles and audit; your cups; the calendar file; the reminder once; the nudge once; the next round's time). Checked in headless Chrome against `wrangler dev`: home page anonymous and entrant, the ticket on an iPhone and on Android, the countdown, and the console's link and switch with a virtual passkey. Not checked on real phones: notification permission prompts don't run in headless Chrome.

**Before Phase 7 goes live:** apply migrations `0006_notifications.sql` and `0007_home_banner.sql` remotely. Run `npm run vapid` once and store the three values with `wrangler secret put` (keep the pair for good: a new pair makes every subscription stale). Check-in texts also need the SMS provider (section 13, question 1).

### Phase 8: removed
*Removed from this release (2026-11-06): cheers (SP-2) and the Grand Final show (SP-3) aren't needed for the coin launch. Watching (SP-1) shipped in Phases 6 and 7: delayed, card-free watchers, and the Watch tab with the biggest stakes first. Phase numbers below are unchanged.*

### Phase 9: Integrity
- [ ] Post-cup detection job (8.3) and the flags table.
- [ ] Integrity queue in the admin console (AD-5) with evidence and decisions.
- [ ] Holds and voids that move ledger entries correctly.
- [ ] **S-6:** seeded collusion bots (a feeding pair, a timing bot) are flagged; ordinary bot fields produce few false flags (≤ 1 per 1,000 players).
- [ ] **S-13:** phone numbers never appear in logs, responses or analytics.

### Phase 10: Efficiency and load (cost protocol T3–T4)
- [ ] Bot swarm (Node `ws`) that registers, checks in, plays fair random moves, buys Second Chance at a set rate and disconnects at a set rate.
- [ ] T3 local: full cups at 256 and 1,024 players. Record rows written, DO wall time, CPU and the slot transition time.
- [ ] T4 staging (`playcity-staging`): 1,024, 4,096 and 16,384 players. Pull real meters from the GraphQL Analytics API. Paste $/player into this doc.
- [ ] Check every section 9 budget. Fix and re-run until all pass.
- [ ] T5 production guardrails: alerts on cost per hour, SMS spend, error rate, late tables.

### Phase 11: Security hardening
- [ ] Threat model review against section 8.1 with a second engineer.
- [ ] External penetration test of the auth, wallet, director and table endpoints. Fix all high and critical findings.
- [ ] Secrets rotation runbook. HMAC and encryption keys versioned.
- [ ] Privacy notice, data retention (registrations 2 years, OTP rows 24 h, move logs 90 days), deletion on request.
- [ ] Bug bounty (coins and swag) open from the closed beta, scoped to hidden cards, money and accounts.

### Phase 12: Coin launch
- [ ] Internal cup (16–64). Fix P0s.
- [ ] Closed beta (256). Measure check-in, forfeits, Second Chance take-up, return rate.
- [ ] Open weekly coin cups (1,024). Four clean cups.
- [ ] Large cup (4,096, then 16,384) after T3 and T4 at that size.
- [ ] Analytics funnel live: landing → cup page → OTP → staked → checked in → finished → next cup.

### Phase 13: Cash readiness (blocked on counsel)
- [ ] Licence or legal opinion in hand. Terms, prize rules and complaint process published.
- [ ] Payments in (card, transfer) and payouts out through a Nigerian provider, behind the ledger.
- [ ] KYC tiering by amount, with the payout name matched to the player.
- [ ] Payout holds, chargeback handling, finance approver flow (two people).
- [ ] Responsible play for cash: deposit limits, reality checks, self-exclusion with a cool-down before lifting.
- [ ] A small cash pilot cup, then review.

---

## 13. Open questions

1. Which SMS provider gives the best delivery and price for Nigerian numbers, and should WhatsApp codes be the default with SMS as the fallback?
2. Should coin balances carry over between seasons or reset?
3. Who owns integrity review on cup weekends, and what is the response time?
4. Cup cadence: Saturday only, or a Sunday evening cup timed for the diaspora? (Set per cup, but it affects staffing.)
5. A Second Chance final can end up with only 2 players (seen at 16 and 20,000 players). Both go to the Grand Final and both are paid without a contest. Phase 5 should decide: hold them for one more Second Chance round, or merge them into the main-draw final table.
