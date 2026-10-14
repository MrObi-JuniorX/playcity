# Cloudflare Efficiency & Cost Test Protocol — playcity

Every game in this repo (realtime multiplayer games, turn-based games, and a SimCity-style city sim) must pass this protocol before it's merged and again before it ships. The aim is a known, bounded **cost per room-hour** and **cost per idle room-month**, checked automatically and not guessed.

> Prices and limits below were pulled from developers.cloudflare.com on 2026-10-09. Re-check the pricing pages each quarter. If this doc and the docs disagree, the docs are right.

---

## 0. The cost model (what we're actually paying for)

### Prices that matter (Workers Paid, $5/mo minimum)

| Meter | Included / month | Overage | Notes |
|---|---|---|---|
| Worker requests | 10M | $0.30 / M | WS upgrade = 1 request. Static assets are **free and unmetered**. |
| Worker CPU | 30M ms | $0.02 / M ms | CPU time only, not wall time. |
| DO requests | 1M | $0.15 / M | RPC calls, fetches, alarms. **Inbound WS messages billed 20:1** (100 msgs = 5 requests). |
| DO duration | 400k GB-s | $12.50 / M GB-s | Billed at 128 MB per awake object, by **wall-clock time**. Hibernated = $0. |
| DO SQLite rows read | 25B | $0.001 / M | Basically free, unless you full-scan in a hot loop. |
| DO SQLite rows written | 50M | **$1.00 / M** | **The dangerous meter.** Each index update counts as another row. |
| DO storage | 5 GB-mo | $0.20 / GB-mo | 10 GB max per SQLite DO. |

Free tier (resets daily): 100k requests, 13k GB-s, 5M rows read, 100k rows written.

### Unit economics to memorize

| Scenario | Math | Cost |
|---|---|---|
| 1 DO awake for 1 hour | 0.125 GB × 3600 s = 450 GB-s | **$0.0056** |
| 1 DO awake 24/7 for a month | 324,000 GB-s | **$4.05** (about all of the included quota, from one room) |
| 100 idle rooms that never hibernate | 32.4M GB-s | **~$400 / mo for nothing** |
| 8 players × 20 Hz inputs × 1 hr | 576k msgs ÷ 20 = 28.8k req | $0.0043 |
| Same at 60 Hz, unbatched | 1.73M msgs ÷ 20 = 86k req | $0.013 |
| SimCity 256×256, 1 row per tile, 1 Hz sim tick | 65,536 rows/s → 5.6B rows/day | **~$5,600 / day** 💀 |
| SimCity, 64 chunk BLOBs, dirty-only flush every 30 s | ≤ 184k rows/day | ~$0.18 / day while running |

**Takeaways that the tests enforce:**
1. **Idle = hibernated.** Any DO with nobody connected must be able to hibernate or be evicted. No timers, no repeating alarms, no outbound sockets.
2. **Row writes get batched and chunked**, never one row per entity per tick.
3. **Active play is cheap** (about 1¢ per room-hour). Spend effort on idle cost and writes, not on micro-tuning CPU.

### Budgets (CI fails if these are exceeded)

| Budget | Realtime game (≤16 players) | Turn-based / lobby | City sim |
|---|---|---|---|
| Cost per active room-hour | ≤ $0.02 | ≤ $0.002 | ≤ $0.02 |
| Cost per idle room-month | ≈ $0 (must hibernate) | ≈ $0 | ≤ $0.01 (storage only) |
| Rows written per sim tick | ≤ 2 | n/a | ≤ 1 per dirty chunk, flushed ≤ every 10 s |
| Rows written per player join/leave | ≤ 3 | ≤ 3 | ≤ 3 |
| Inbound client msg rate | ≤ 20 Hz/player | event-driven | ≤ 10 Hz/player |
| Server tick CPU (p99) | ≤ 2 ms @ max players | n/a | ≤ 10 ms per tick |
| Outbound bytes / player / s | ≤ 4 KB | n/a | ≤ 8 KB (viewport only) |
| WS attachment size | ≤ 2 KB (hard cap 16 KB) | same | same |
| DB size per room | ≤ 50 MB | ≤ 5 MB | ≤ 500 MB (cap 10 GB) |

---

## 1. Architecture rules (what the tests check for)

- **One DO per coordination atom**: one per match/room/city. Never one global DO (soft limit is about 1,000 req/s per object).
- **Lobby / matchmaking** goes in a sharded DO or D1, **not KV** (KV writes are slow to propagate and are rate-limited per key).
- **Client is served via Workers Static Assets** (free). The Worker only does `/api/*` and WS upgrades.
- **WebSockets use the Hibernation API**: `ctx.acceptWebSocket(ws, tags)`, `webSocketMessage`/`webSocketClose` handlers, `serializeAttachment` for per-connection state. Never `ws.accept()` in a DO.
- **Heartbeats use `setWebSocketAutoResponse`** (ping/pong without waking the DO).
- **Tick loop lifecycle**: start `setInterval` on the first player join, and **clear it on the last leave**. Realtime games tick only while someone is connected.
- **City sim uses lazy / catch-up simulation**: store `lastSimulatedAt`. On wake, deterministically fast-forward `elapsed / tickLen` ticks (capped, then summarized). Don't run alarms on cities nobody is watching. If background progress is needed (e.g. a daily tax report), use **one alarm per hours/day**, never per second.
- **Storage layout**: snapshot BLOBs per chunk/room plus a small append log. Dirty-flag in memory and flush on a timer, on last-leave, and when the dirty count passes a threshold. Write related rows with no `await` between them (keeps them atomic, coalesced into one commit).
- **Persist first, then mutate memory**, for anything you can't lose (purchases, match results). Cosmetic tick state can live in memory and be snapshotted.
- **Network**: binary or compact encoding, delta updates, and interest management (city: only the chunks in the viewport). Batch several logical messages into one frame.

---

## 2. Test tiers

| Tier | Where | When | Tooling |
|---|---|---|---|
| T1 Static gates | CI, every PR | seconds | eslint + grep script |
| T2 Cost-unit tests | CI, every PR | < 1 min | `@cloudflare/vitest-pool-workers` |
| T3 Local load / soak | dev box, pre-merge for netcode changes | 5–30 min | `wrangler dev` + bot swarm (Node `ws`) |
| T4 Staging metering | staging account, pre-release | 1–24 h | GraphQL Analytics API |
| T5 Prod guardrails | always on | continuous | Analytics Engine + alerts + budget notifications |

---

### T1 — Static gates (fail the build)

`scripts/cf-lint.sh`, run in CI:

```bash
#!/usr/bin/env bash
set -euo pipefail
fail=0
check() { if grep -rnE "$2" src --include='*.ts' | grep -v 'cf-lint-allow'; then echo "❌ $1"; fail=1; fi; }

check "Use ctx.acceptWebSocket (hibernation), not ws.accept()"   '\b(server|ws|socket)\.accept\(\)'
check "Math.random for IDs/tokens — use crypto"                   'Math\.random\(\).*(id|token|key)'
check "setInterval outside TickLoop — must be lifecycle-managed"  'setInterval\(' # allow only in src/engine/tick-loop.ts via cf-lint-allow
check "passThroughOnException is banned"                          'passThroughOnException'
check "Destructured ctx loses this binding"                       'const \{[^}]*waitUntil[^}]*\} *= *ctx'
check "KV used for hot game state"                                'env\.[A-Z_]*KV[A-Z_]*\.put\(.*(room|match|tick|player)'
check "Outbound WebSocket from DO blocks hibernation"             'new WebSocket\('
check "Per-row writes inside loops — batch/chunk instead"         'for *\(.*\)[^{]*\{[^}]*sql\.exec\(\s*["'"'"'`](INSERT|UPDATE)'
exit $fail
```

Also enforce:
- `@typescript-eslint/no-floating-promises: error`
- `wrangler.jsonc` contains `observability.enabled: true` with `head_sampling_rate` ≤ 0.1 in prod, uses `new_sqlite_classes`, and has a compatibility date less than 90 days old.
- `wrangler types` output is checked in and up to date (`git diff --exit-code worker-configuration.d.ts`).

---

### T2 — Cost-unit tests (vitest-pool-workers)

Each game's DO exposes its engine through a **metered storage wrapper**, so tests can assert on billed units directly.

**`src/engine/meter.ts`**

```ts
export interface CostMeter {
  rowsRead: number;
  rowsWritten: number;
  sqlCalls: number;
  wsIn: number;
  wsOut: number;
  bytesOut: number;
}

export const newMeter = (): CostMeter => ({ rowsRead: 0, rowsWritten: 0, sqlCalls: 0, wsIn: 0, wsOut: 0, bytesOut: 0 });

/** Wraps sql.exec so every cursor's billed rows are counted once fully consumed. */
export function meteredExec(sql: SqlStorage, meter: CostMeter) {
  return <T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]) => {
    const cursor = sql.exec<T>(query, ...bindings);
    const rows = cursor.toArray(); // consume so rowsRead/rowsWritten are final
    meter.sqlCalls++;
    meter.rowsRead += cursor.rowsRead;
    meter.rowsWritten += cursor.rowsWritten;
    return rows;
  };
}
```

In production the meter costs nothing much (a few integer adds). Keep it on, and also flush it to Analytics Engine (see T5).

**Required tests per game**. Copy `test/cost.template.test.ts`:

```ts
import { env, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { GameRoom } from "../src/rooms/game-room";
import { BUDGET } from "../src/rooms/game-room.budget";

const room = (name: string) => env.GAME_ROOM.getByName(name);

describe("cost: storage writes", () => {
  it("N ticks write ≤ budget rows", async () => {
    await runInDurableObject(room("w1"), async (inst: GameRoom) => {
      inst.debugAddBots(BUDGET.maxPlayers);
      inst.meter.rowsWritten = 0;
      for (let i = 0; i < 600; i++) inst.tick();          // 30 s at 20 Hz, called directly
      inst.flush();
      expect(inst.meter.rowsWritten / 600).toBeLessThanOrEqual(BUDGET.rowsPerTick);
    });
  });

  it("join + leave writes ≤ 3 rows each", async () => { /* ... */ });

  it("no unbounded table growth: 10k ticks keeps db under budget", async () => {
    await runInDurableObject(room("w2"), async (inst: GameRoom, state) => {
      inst.debugAddBots(BUDGET.maxPlayers);
      for (let i = 0; i < 10_000; i++) inst.tick();
      inst.flush();
      expect(state.storage.sql.databaseSize).toBeLessThan(BUDGET.maxDbBytes);
    });
  });

  it("every index is justified", async () => {
    await runInDurableObject(room("w3"), async (_i, state) => {
      const idx = state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").toArray();
      expect(idx.map(r => r.name)).toEqual(BUDGET.allowedIndexes); // each index = +1 row write per affected row
    });
  });
});

describe("cost: idle / hibernation", () => {
  it("after last player leaves: no tick timer, no repeating alarm", async () => {
    await runInDurableObject(room("h1"), async (inst: GameRoom, state) => {
      inst.debugAddBots(2);
      inst.debugRemoveAllBots();
      expect(inst.tickLoop.running).toBe(false);
      const alarm = await state.storage.getAlarm();
      // allowed: none, or a single cleanup alarm ≥ 1 h away
      if (alarm !== null) expect(alarm - Date.now()).toBeGreaterThanOrEqual(3_600_000);
    });
  });

  it("state survives hibernation: rebuild from storage + attachments only", async () => {
    // Engine must expose rehydrate(storage, sockets) as a pure path that the constructor uses.
    await runInDurableObject(room("h2"), async (inst: GameRoom, state) => {
      inst.debugAddBots(4);
      for (let i = 0; i < 100; i++) inst.tick();
      inst.flush();
      const before = inst.publicSnapshot();
      const fresh = inst.debugRehydrateFresh(state); // new engine from storage, no memory carried over
      expect(fresh.publicSnapshot()).toEqual(before);
    });
  });

  it("WS attachment stays small", async () => {
    await runInDurableObject(room("h3"), async (inst: GameRoom) => {
      const att = inst.debugAttachmentFor("player-1");
      expect(new TextEncoder().encode(JSON.stringify(att)).length).toBeLessThanOrEqual(2048);
    });
  });

  it("uses auto-response for heartbeats", async () => {
    await runInDurableObject(room("h4"), async (_i, state) => {
      expect(state.getWebSocketAutoResponse()).not.toBeNull();
    });
  });
});

describe("cost: network", () => {
  it("outbound bytes per player per second ≤ budget at max players", async () => {
    await runInDurableObject(room("n1"), async (inst: GameRoom) => {
      inst.debugAddBots(BUDGET.maxPlayers, { randomInputs: true, seed: 42 });
      inst.meter.bytesOut = 0;
      for (let i = 0; i < 20 * 10; i++) inst.tick();   // 10 simulated seconds
      expect(inst.meter.bytesOut / BUDGET.maxPlayers / 10).toBeLessThanOrEqual(BUDGET.bytesOutPerPlayerSec);
    });
  });

  it("one frame per player per tick at most (batching)", async () => { /* wsOut ≤ players × ticks */ });

  it("server rate-limits client input above budget Hz", async () => { /* flood 200 msgs/s, expect drop/kick */ });
});

describe("cost: CPU", () => {
  it("tick p99 ≤ budget at max load", async () => {
    await runInDurableObject(room("c1"), async (inst: GameRoom) => {
      inst.debugAddBots(BUDGET.maxPlayers, { randomInputs: true, seed: 7 });
      const t: number[] = [];
      for (let i = 0; i < 2000; i++) { const s = performance.now(); inst.tick(); t.push(performance.now() - s); }
      t.sort((a, b) => a - b);
      expect(t[Math.floor(t.length * 0.99)]).toBeLessThanOrEqual(BUDGET.tickP99Ms);
    });
  });
});
```

> ⚠️ Inside workerd, `performance.now()` only advances across I/O (a Spectre mitigation), so the CPU test above reads ~0 in the pool. Run the CPU assertions against the **pure engine in plain Node vitest** (`test/engine.bench.ts`), and keep the engine free of Cloudflare imports so this works. Treat workerd CPU as verified in T4 instead.

**Engine design that makes this testable.** Each game splits into:
- `engine/` — pure, deterministic TS: `tick(state, inputs) → {state, deltas}`, no I/O, seeded RNG. Benchmarked in Node.
- `rooms/<game>-room.ts` — a thin DO shell: sockets, storage flush, lifecycle.
- `<game>.budget.ts` — the numbers from §0 for that game, imported by the tests.

**City-sim extra tests:**
- `catch-up`: a city untouched for 7 simulated days rehydrates in ≤ 50 ms CPU (Node bench), with ≤ 1 row written per changed chunk.
- `determinism`: same seed + same inputs → identical snapshot hash after 10k ticks (needed for catch-up and for client prediction).
- `viewport`: a client watching 4 chunks receives deltas only for those 4 chunks.
- `chunk flush`: changing 1 tile writes exactly 1 chunk row, not the whole map.
- `no alarm storm`: an unobserved city has ≤ 1 alarm scheduled, and it's ≥ 1 h out.

---

### T3 — Local load / soak (`wrangler dev`)

`tools/bots/swarm.ts`: a Node script that opens R rooms × P players over WebSocket with scripted inputs at the configured Hz, and records:
- msgs in/out, bytes in/out per player per second
- server tick jitter (server echoes a tick timestamp)
- reconnection behavior after a forced server restart (kill `wrangler dev` → bots reconnect → state is intact)

Scenarios (all must pass):

| # | Scenario | Pass criteria |
|---|---|---|
| L1 | 50 rooms × max players, 10 min | budgets from §0 hold; no memory growth in `wrangler dev` |
| L2 | Join/leave churn: a player joins/leaves every 2 s, 10 min | rows written ≤ 3 × (joins+leaves) + tick flushes |
| L3 | Rooms empty out | the tick stops within 1 s of last leave (log line `tick.stop`) |
| L4 | Kill and restart dev server mid-match | clients reconnect, snapshot matches pre-kill (± ticks since last flush) |
| L5 | Hostile client: 500 msgs/s, 1 MB frames | rate-limited / closed; others in room unaffected |
| L6 | City: 1 player panning the full map for 5 min | outbound ≤ budget; rows written only for edited chunks |

Use `wrangler dev --local`. The bot script prints a cost estimate using the §0 formulas, so the netcode PR description can include "est. $/room-hour".

---

### T4 — Staging metering (real billing meters)

Deploy to a **separate staging Worker** (`playcity-staging`). Run the bot swarm from T3 against it for 1 h (realtime) or 24 h (city, including idle periods). Then query the GraphQL Analytics API (`https://api.cloudflare.com/client/v4/graphql`) for that script and window:

```graphql
query ($account: String!, $start: Time!, $end: Time!, $script: String!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      durableObjectsInvocationsAdaptiveGroups(
        limit: 1000
        filter: { datetime_geq: $start, datetime_leq: $end, scriptName: $script }
      ) { sum { requests responseBodySize } dimensions { namespaceId } }
      durableObjectsPeriodicGroups(
        limit: 1000
        filter: { datetime_geq: $start, datetime_leq: $end }
      ) { sum { cpuTime activeTime inboundWebsocketMsgCount outboundWebsocketMsgCount rowsRead rowsWritten } max { activeWebsocketConnections } }
      durableObjectsStorageGroups(
        limit: 100
        filter: { datetime_geq: $start, datetime_leq: $end }
      ) { max { storedBytes } }
      workersInvocationsAdaptive(
        limit: 100
        filter: { datetime_geq: $start, datetime_leq: $end, scriptName: $script }
      ) { sum { requests subrequests } quantiles { cpuTimeP50 cpuTimeP99 } }
    }
  }
}
```

> Field names in `durableObjectsPeriodicGroups` change over time, so confirm them with GraphQL introspection before relying on them. `scripts/cf-meter.ts` should introspect on first run and fail loudly if a field has gone missing.

`scripts/cf-meter.ts` turns the result into a report:

```
room-hours (bot-reported):     50.0
DO active GB-s:                22,600   → $0.28    ($0.0057 / room-hour)
DO requests (+ ws/20):         1.46M    → $0.22
rows written:                  31,200   → $0.03
Worker requests / CPU:         3,100 / 4.1k ms → ~$0
-------------------------------------------------
TOTAL est:                     $0.53    ($0.0106 / room-hour)   BUDGET $0.02 ✅
idle check: activeTime during 30 min idle window = 0 s            ✅
```

**The idle check is the most important line in it.** After the bots disconnect, wait 30 minutes and assert `activeTime ≈ 0` for the namespace. A non-zero value means something keeps objects awake (timer, alarm loop, outbound socket, pending promise).

Also check in T4:
- **Placement / latency**: bots from 2–3 regions, RTT p95 ≤ 120 ms for same-continent players (DO is created near its first caller, so the match-making Worker should create the room from the host player's request).
- **Cold start**: first-join latency to a hibernated room ≤ 300 ms p95.

---

### T5 — Production guardrails

1. **Analytics Engine** dataset `game_cost`: each DO writes one data point per flush (≤ 1 per 10 s per active room) with `blobs: [game, roomId]` and `doubles: [rowsWritten, rowsRead, wsIn, wsOut, bytesOut, players, tickP99]`. That gives a per-game, per-room $/hour dashboard and helps find the 1% of rooms causing 50% of cost.
2. **Billing notifications** in the dashboard: alerts at 50% / 80% / 100% of the monthly budget, plus a usage-based alert for Durable Objects duration.
3. **Kill switches** (env vars / Flagship flags): `MAX_ROOMS_PER_GAME`, `MAX_PLAYERS_PER_ROOM`, `CITY_BACKGROUND_SIM=false`, `TICK_HZ` override. These let us cap spend without a redeploy.
4. **Room reaper**: an orphaned room (0 sockets, and no activity for 24 h for matches / 90 days for cities) deletes its storage via `ctx.storage.deleteAll()` in a single long-interval alarm, so storage costs don't pile up.
5. **Weekly cost review**: run `cf-meter.ts` on the last 7 days of prod and compare it to budgets. Any game over budget gets a ticket.

---

## 3. Release checklist (per game)

- [ ] `<game>.budget.ts` filled in, reviewed
- [ ] T1 static gates green
- [ ] T2 cost-unit tests green (writes, idle, network, rehydrate, CPU bench)
- [ ] T3 L1–L6 passed, est. $/room-hour pasted in PR
- [ ] T4 staging report attached, **idle check passed**
- [ ] T5 Analytics Engine events, kill switches, reaper wired
- [ ] Cost per 1,000 DAU estimated (room-hours/DAU × $/room-hour + idle storage) and recorded below

| Game | Budget $/room-hr | Measured $/room-hr | Idle $/room-mo | Est. $/1k DAU/mo | Date |
|---|---|---|---|---|---|
| _example: arena_ | 0.02 | — | — | — | — |
| _city sim_ | 0.02 | — | — | — | — |
