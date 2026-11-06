import { fail, ipOf, json, readJson, sameOrigin } from "../http";
import { currentSession } from "../auth/session";
import { hmac } from "../auth/crypto";
import type { AuthEnv } from "../auth/env";
import { cupAccount, cupSpec, playerAccount, playerSpec, transferStatements, ensureStatements } from "../wallet/ledger";
import { openWallet } from "../wallet/wallet";
import type { CupConfig } from "./config";
import { gateName, shardOf } from "./gate";
import { shareCardRoute } from "./share";

/* Public cup API (docs/whot-cup-prd.md, Phase 4).
   GET  /api/cups                       cups players can see now (edge-cached 5 s)
   GET  /api/cups/:slug                 one cup: settings, seats, schedule, progress, seeds (edge-cached 5 s)
   GET  /api/cups/:slug/me              your entry, and in a running cup your table or your Second Chance offer
   POST /api/cups/:slug/enter           { ref? }  stake the entry fee; ref = the player whose invite brought you
   POST /api/cups/:slug/checkin         "I'm here", during the check-in window
   POST /api/cups/:slug/second-chance   buy back in after a first loss, while the offer is open
   GET  /api/cups/:slug/bracket         every round by draw, and the deciding tables (edge-cached 5 s)
   GET  /api/cups/:slug/tables          tables in play now, biggest stakes first, for Watch (edge-cached 5 s)
   GET  /api/cups/:slug/leaderboard     this cup's biggest winners (edge-cached 5 s)
   GET  /api/cups/:slug/friends         you and the players you're linked to by an invite, in this cup (signed in)
   GET  /api/cups/:slug/card/:player    a share card (SVG, src/cup/share.ts)
   GET  /api/cups/:slug/calendar        the cup as a calendar event, with an alarm when check-in opens (.ics)
   GET  /api/me/cups                    the signed-in player's cups still to play or in play (the home page's "your cup")

   Entering is one D1 transaction: the registration row, the seat counter (its CHECK refuses an entry past
   capacity) and the stake. A full cup or an empty wallet rolls the whole thing back, so nobody pays for a seat
   they didn't get and two people can't take the last seat. */

const PUBLIC_STATES = ["scheduled", "registration", "closed", "check-in", "running", "settled", "cancelled"];

interface CupRow { id: string; slug: string; name: string; state: string; config_json: string; config_hash: string | null; estimate_json: string | null; schedule_json: string | null; live_json: string | null; cancel_reason: string | null; updated_at: number; promoted: number }

export async function cupRoute(req: Request, env: AuthEnv, path: string, ctx: ExecutionContext): Promise<Response | null> {
  if (path === "/api/cups" && req.method === "GET") return cached(req, ctx, () => listCups(env));
  const card = path.match(/^\/api\/cups\/([a-z0-9-]{3,48})\/card\/([0-9a-f-]{36})$/);
  if (card && req.method === "GET") return shareCardRoute(env, req, card[1], card[2]);
  const m = path.match(/^\/api\/cups\/([a-z0-9-]{3,48})(?:\/([a-z-]+))?$/);
  if (!m) return path.startsWith("/api/cups") ? fail(404, "not-found") : null;
  const [, slug, action] = m;
  if (!action && req.method === "GET") return cached(req, ctx, () => cupDetail(env, slug));
  if (req.method === "GET" && action && action in PUBLIC_VIEWS) return cached(req, ctx, () => PUBLIC_VIEWS[action](env, slug));
  const cup = await env.DB.prepare("SELECT * FROM cups WHERE slug = ?").bind(slug).first<CupRow>();
  if (!cup || !PUBLIC_STATES.includes(cup.state)) return fail(404, "no-cup");
  if (action === "me" && req.method === "GET") return myEntry(env, req, cup);
  if (action === "friends" && req.method === "GET") return friends(env, req, cup);
  if (req.method !== "POST") return fail(404, "not-found");
  if (!sameOrigin(req)) return fail(403, "bad-origin");
  if (action === "enter") return enter(env, req, cup);
  if (action === "checkin") return checkIn(env, req, cup);
  if (action === "second-chance") return secondChance(env, req, cup);
  return fail(404, "not-found");
}

/* One origin read per colo every 5 seconds, whoever is watching. */
async function cached(req: Request, ctx: ExecutionContext, make: () => Promise<Response>): Promise<Response> {
  const key = new Request(new URL(new URL(req.url).pathname, req.url).toString());
  const hit = await caches.default.match(key);
  if (hit) return hit;
  const res = await make();
  if (res.ok) {
    const out = new Response(res.body, res);
    out.headers.set("Cache-Control", "public, max-age=5");
    ctx.waitUntil(caches.default.put(key, out.clone()));
    return out;
  }
  return res;
}

/* ---------- public views ---------- */

function publicConfig(c: CupConfig) {
  return {
    name: c.name, slug: c.slug, description: c.description, sponsor: c.sponsor, currency: c.currency,
    entryFee: c.entryFee, capacity: c.capacity, minEntries: c.minEntries, oversubscription: c.oversubscription, waitlist: c.waitlist,
    registrationOpensAt: c.registrationOpensAt, registrationClosesAt: c.registrationClosesAt, checkInOpensAt: c.checkInOpensAt,
    checkInClosesAt: c.startsAt - c.checkInCloseBeforeStartSec * 1000, startsAt: c.startsAt,
    tableClockSec: c.tableClockSec, breakSec: c.breakSec, advancePerTable: c.advancePerTable, top1Threshold: c.top1Threshold,
    scEnabled: c.scEnabled, scFee: c.scFee, scCutoffRound: c.scCutoffRound, scBuyWindowSec: c.scBuyWindowSec, scWinnerOnly: c.scWinnerOnly,
    gfSplit: c.gfSplit, phoneCountries: c.phoneCountries, noShowRefund: c.noShowRefund,
  };
}

async function listCups(env: AuthEnv): Promise<Response> {
  const rows = await env.DB.prepare(`SELECT c.*, s.taken FROM cups c LEFT JOIN cup_seats s ON s.cup_id = c.id
    WHERE c.state IN ('scheduled', 'registration', 'closed', 'check-in', 'running') OR (c.state IN ('settled', 'cancelled') AND c.updated_at > ?)
    ORDER BY json_extract(c.config_json, '$.startsAt') LIMIT 20`).bind(Date.now() - 7 * 86_400_000).all<CupRow & { taken: number | null }>();
  return json({ cups: rows.results.map(r => { const c = JSON.parse(r.config_json) as CupConfig; return { ...publicConfig(c), state: r.state, entries: r.taken ?? 0, live: r.live_json ? JSON.parse(r.live_json) : null, promoted: !!r.promoted }; }) });
}

async function cupDetail(env: AuthEnv, slug: string): Promise<Response> {
  const r = await env.DB.prepare("SELECT * FROM cups WHERE slug = ?").bind(slug).first<CupRow>();
  if (!r || !PUBLIC_STATES.includes(r.state)) return fail(404, "no-cup");
  const counts = await env.DB.prepare("SELECT state, COUNT(*) AS n FROM registrations WHERE cup_id = ? GROUP BY state").bind(r.id).all<{ state: string; n: number }>();
  const by = Object.fromEntries(counts.results.map(x => [x.state, x.n]));
  const seeds = await env.DB.prepare("SELECT slot, commitment, seed FROM seeds WHERE cup_id = ? ORDER BY slot").bind(r.id).all();
  return json({
    cup: { ...publicConfig(JSON.parse(r.config_json)), state: r.state, configHash: r.config_hash, cancelReason: r.cancel_reason },
    entries: (by.entered ?? 0) + (by.seated ?? 0) + (by.playing ?? 0) + (by.finished ?? 0), waitlist: by.waitlist ?? 0,
    estimate: r.estimate_json ? JSON.parse(r.estimate_json) : null, schedule: r.schedule_json ? JSON.parse(r.schedule_json) : null,
    live: r.live_json ? JSON.parse(r.live_json) : null, seeds: seeds.results,
  });
}

/* ---------- a player's own entry ---------- */

async function myEntry(env: AuthEnv, req: Request, cup: CupRow): Promise<Response> {
  const s = await currentSession(env, req);
  if (!s) return fail(401, "signed-out");
  const reg = await env.DB.prepare("SELECT state, seq, draw_rank, checked_in_at, sc_bought, won, finish FROM registrations WHERE cup_id = ? AND player_id = ?").bind(cup.id, s.playerId).first();
  const live = cup.state === "running" && reg ? await env.CUP.getByName(cup.id).whereIs(s.playerId) : null;
  // Every table this player has finished in this cup, with what it paid them (PX-3).
  const history = reg ? (await env.DB.prepare(`SELECT r.slot, r.draw, r.table_code AS code, CAST(j.key AS INTEGER) + 1 AS place, json_array_length(r.places_json) AS of,
      CASE WHEN j.key = 0 THEN r.pay1 WHEN j.key = 1 THEN r.pay2 ELSE 0 END AS pay, r.late
    FROM table_results r, json_each(r.places_json) j WHERE r.cup_id = ? AND j.value = ? ORDER BY r.slot`).bind(cup.id, s.playerId).all()).results : [];
  // What they've won so far, from the ledger (registrations.won is only written at settlement): the net is always right.
  const won = reg ? await env.DB.prepare("SELECT COALESCE(SUM(amount), 0) AS w FROM ledger WHERE cup_id = ? AND player_id = ? AND kind IN ('table_pay', 'gf_prize')").bind(cup.id, s.playerId).first<number>("w") : 0;
  return json({ entry: reg ? { ...reg, won } : null, live, history });
}

interface PlayerRow { name: string | null; avatar_shape: string | null; adult_at: number | null; cool_off_until: number | null; weekly_limit: number | null; phone_country: string; created_at: number }

async function enter(env: AuthEnv, req: Request, cup: CupRow): Promise<Response> {
  const s = await currentSession(env, req);
  if (!s) return fail(401, "signed-out");
  const c = JSON.parse(cup.config_json) as CupConfig, now = Date.now(), DB = env.DB;
  if (cup.state !== "registration" || now >= c.registrationClosesAt) return fail(409, cup.state === "scheduled" ? "not-open-yet" : "closed");
  if (c.currency !== "COIN") return fail(409, "cash-not-live");
  const p = await DB.prepare("SELECT name, avatar_shape, adult_at, cool_off_until, weekly_limit, phone_country, created_at FROM players WHERE id = ?").bind(s.playerId).first<PlayerRow>();
  if (!p) return fail(401, "signed-out");
  if (!p.name || !p.avatar_shape || p.adult_at === null) return fail(403, "profile-incomplete");
  if (p.cool_off_until && p.cool_off_until > now) return fail(403, "cooling-off", { until: p.cool_off_until });
  if (c.phoneCountries.length && !c.phoneCountries.includes(p.phone_country)) return fail(403, "country");
  if (c.minAccountAgeHours && now - p.created_at < c.minAccountAgeHours * 3600_000) return fail(403, "account-too-new");
  if (p.weekly_limit !== null) {
    const week = await DB.prepare(`SELECT COALESCE(SUM(CASE WHEN kind IN ('stake', 'sc_stake') THEN amount ELSE 0 END), 0) - COALESCE(SUM(CASE WHEN kind = 'refund' THEN amount ELSE 0 END), 0) AS spent
      FROM ledger WHERE player_id = ? AND created_at > ?`).bind(s.playerId, now - 7 * 86_400_000).first<number>("spent");
    if ((week ?? 0) + c.entryFee > p.weekly_limit) return fail(403, "weekly-limit", { spent: week ?? 0, limit: p.weekly_limit });
  }
  const b = (await readJson(req)) ?? {};
  const ref = typeof b.ref === "string" && b.ref !== s.playerId && /^[0-9a-f-]{36}$/.test(b.ref) ? b.ref : null;
  await openWallet(DB, s.playerId, now);                              // creates the wallet and claims today's coins if due
  const ipHash = await hmac(env.PHONE_HMAC_KEY || "none", "ip", ipOf(req) || "none");

  const attempt = async (state: "entered" | "waitlist") => {
    const stmts = [
      ...ensureStatements(DB, [cupSpec(cup.id, c.currency), playerSpec(s.playerId, c.currency)]),
      DB.prepare(`INSERT INTO registrations (cup_id, player_id, state, seq, entered_at, device_id, ip_hash, invited_by)
        SELECT ?1, ?2, ?3, COALESCE(MAX(seq), 0) + 1, ?4, ?5, ?6, ?7 FROM registrations WHERE cup_id = ?1`).bind(cup.id, s.playerId, state, now, s.deviceId, ipHash, ref),
      ...(state === "entered" ? [DB.prepare("UPDATE cup_seats SET taken = taken + 1 WHERE cup_id = ?").bind(cup.id)] : []),
      ...transferStatements(DB, [{ idem: `stake:${cup.id}:${s.playerId}`, from: playerAccount(s.playerId, c.currency), to: cupAccount(cup.id, c.currency), amount: c.entryFee, currency: c.currency, kind: "stake", playerId: s.playerId, cupId: cup.id, memo: c.name }]),
    ];
    await DB.batch(stmts);
  };
  const why = (e: unknown) => String((e as Error)?.message ?? e);
  try {
    try { await attempt("entered"); }
    catch (e) {
      if (!/seats_full/.test(why(e)) || c.oversubscription !== "first-come" || !c.waitlist) throw e;
      await attempt("waitlist");
    }
  } catch (e) {
    const m = why(e);
    if (/seats_full/.test(m)) return fail(409, "full");
    if (/UNIQUE constraint failed: registrations|UNIQUE constraint failed: ledger\.idem_key/.test(m)) return fail(409, "already-entered");
    if (/CHECK constraint failed/.test(m)) return fail(402, "insufficient-funds", { need: c.entryFee });
    throw e;
  }
  const reg = await DB.prepare("SELECT state, seq FROM registrations WHERE cup_id = ? AND player_id = ?").bind(cup.id, s.playerId).first();
  return json({ entry: reg }, 201);
}

async function checkIn(env: AuthEnv, req: Request, cup: CupRow): Promise<Response> {
  const s = await currentSession(env, req);
  if (!s) return fail(401, "signed-out");
  const c = JSON.parse(cup.config_json) as CupConfig, now = Date.now();
  if (now < c.checkInOpensAt || now >= c.startsAt - c.checkInCloseBeforeStartSec * 1000 || !["closed", "check-in"].includes(cup.state)) return fail(409, "check-in-closed");
  const u = await env.DB.prepare("UPDATE registrations SET checked_in_at = COALESCE(checked_in_at, ?) WHERE cup_id = ? AND player_id = ? AND state IN ('seated', 'waitlist') RETURNING state, checked_in_at")
    .bind(now, cup.id, s.playerId).first();
  if (!u) return fail(409, "no-seat");
  return json({ entry: u });
}

async function secondChance(env: AuthEnv, req: Request, cup: CupRow): Promise<Response> {
  const s = await currentSession(env, req);
  if (!s) return fail(401, "signed-out");
  if (cup.state !== "running") return fail(409, "not-running");
  const r = await env.CUP.getByName(cup.id).buySecondChance(s.playerId);
  if (!r.ok) return fail(r.error === "insufficient-funds" ? 402 : 409, r.error ?? "failed");
  return json(r);
}

/* ---------- a cup table (Phase 6) ----------
   GET /ws/cup/:slug/:code             watch: the public view, delayed (TB-7)
   GET /ws/cup/:slug/:code?token=…     play: the seat token from /me, and the signed-in player it names (SE-4)

   The table trusts only what this route tells it: which cup, which table and who is signed in. Anything a browser
   sends in those headers is dropped first. A token only works with our own Origin, so another site can't open a
   seat with a visitor's cookie. */
const TABLE_HEADERS = ["X-Cup-Id", "X-Cup-Table", "X-Cup-Player"];

export async function cupTableRoute(req: Request, env: AuthEnv, slug: string, code: string): Promise<Response> {
  if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
  const cup = await env.DB.prepare("SELECT id, state FROM cups WHERE slug = ?").bind(slug).first<{ id: string; state: string }>();
  if (!cup || !["running", "settled"].includes(cup.state)) return fail(404, "no-cup");
  const url = new URL(req.url), headers = new Headers(req.headers);
  for (const h of TABLE_HEADERS) headers.delete(h);
  headers.set("X-Cup-Id", cup.id);
  headers.set("X-Cup-Table", code);
  if (url.searchParams.has("token")) {
    if (req.headers.get("Origin") !== url.origin) return fail(403, "bad-origin");
    const s = await currentSession(env, req);
    if (s) headers.set("X-Cup-Player", s.playerId);
  }
  return env.CUP_TABLE.getByName(code).fetch(new Request(req.url, { headers }));
}

/* ---------- the hub (Phase 7) ----------
   GET /ws/cup/:slug/hub   the signed-in player's live line to their cup: tables, results, offers, the cup's state.
   Always the same gate for a player (shardOf), so the director can reach them with one call per gate. */
export async function cupHubRoute(req: Request, env: AuthEnv, slug: string): Promise<Response> {
  if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
  if (req.headers.get("Origin") !== new URL(req.url).origin) return fail(403, "bad-origin");
  const cup = await env.DB.prepare("SELECT id, state FROM cups WHERE slug = ?").bind(slug).first<{ id: string; state: string }>();
  if (!cup || !PUBLIC_STATES.includes(cup.state)) return fail(404, "no-cup");
  const s = await currentSession(env, req);
  if (!s) return fail(401, "signed-out");
  const headers = new Headers(req.headers);
  for (const h of TABLE_HEADERS) headers.delete(h);
  headers.set("X-Cup-Player", s.playerId);
  return env.CUP_GATE.getByName(gateName(cup.id, shardOf(s.playerId))).fetch(new Request(req.url, { headers }));
}

/* ---------- the hub's views (Phase 7, PX-2) ---------- */

/** Display names for player ids. Public views carry names only, never ids. */
async function namesOf(env: AuthEnv, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const r = await env.DB.prepare("SELECT id, name FROM players WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify([...new Set(ids)])).all<{ id: string; name: string | null }>();
  return new Map(r.results.map(x => [x.id, x.name || "Player"]));
}
async function liveCup(env: AuthEnv, slug: string) {
  const r = await env.DB.prepare("SELECT id, state FROM cups WHERE slug = ?").bind(slug).first<{ id: string; state: string }>();
  return r && PUBLIC_STATES.includes(r.state) ? r : null;
}

const PUBLIC_VIEWS: Record<string, (env: AuthEnv, slug: string) => Promise<Response>> = {
  async calendar(env, slug) {
    const r = await env.DB.prepare("SELECT id, name, state, config_json FROM cups WHERE slug = ?").bind(slug).first<{ id: string; name: string; state: string; config_json: string }>();
    if (!r || !["scheduled", "registration", "closed", "check-in"].includes(r.state)) return fail(404, "no-cup");
    return new Response(calendarOf(r.id, r.name, JSON.parse(r.config_json) as CupConfig), { headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": `attachment; filename="${slug}.ics"` } });
  },
  async bracket(env, slug) {
    const cup = await liveCup(env, slug);
    if (!cup) return fail(404, "no-cup");
    const b = ["running", "settled"].includes(cup.state) ? await env.CUP.getByName(cup.id).bracket() : null;
    if (!b) return json({ bracket: null });
    const names = await namesOf(env, b.finals.flatMap(f => f.players));
    const nm = (ids: string[] | null) => ids ? ids.map(p => names.get(p) ?? "Player") : null;
    return json({ bracket: { ...b, finals: b.finals.map(f => ({ slot: f.slot, draw: f.draw, code: f.code, players: nm(f.players), result: nm(f.result) })) } });
  },
  async tables(env, slug) {
    const cup = await liveCup(env, slug);
    if (!cup) return fail(404, "no-cup");
    const t = cup.state === "running" ? await env.CUP.getByName(cup.id).liveTables(60) : [];
    const names = await namesOf(env, t.flatMap(x => x.players));
    return json({ tables: t.map(x => ({ ...x, players: x.players.map(p => names.get(p) ?? "Player") })) });
  },
  async leaderboard(env, slug) {
    const cup = await liveCup(env, slug);
    if (!cup) return fail(404, "no-cup");
    const rows = await env.DB.prepare(`SELECT p.name, SUM(l.amount) AS won, r.finish, r.state FROM ledger l JOIN players p ON p.id = l.player_id
        LEFT JOIN registrations r ON r.cup_id = l.cup_id AND r.player_id = l.player_id
      WHERE l.cup_id = ? AND l.kind IN ('table_pay', 'gf_prize') GROUP BY l.player_id ORDER BY won DESC, p.name LIMIT 50`).bind(cup.id).all<{ name: string | null; won: number; finish: string | null; state: string | null }>();
    return json({ leaders: rows.results.map((r, i) => ({ rank: i + 1, name: r.name || "Player", won: r.won, finish: r.finish, out: r.state === "finished" || !!r.finish })) });
  },
};

/** You and your friends in this cup. A friend is anyone linked to you by an invite, either way, in any cup. */
async function friends(env: AuthEnv, req: Request, cup: CupRow): Promise<Response> {
  const s = await currentSession(env, req);
  if (!s) return fail(401, "signed-out");
  const rows = await env.DB.prepare(`WITH f(id) AS (
        SELECT player_id FROM registrations WHERE invited_by = ?1
        UNION SELECT invited_by FROM registrations WHERE player_id = ?1 AND invited_by IS NOT NULL
        UNION SELECT ?1)
      SELECT p.id = ?1 AS me, p.name, r.state, r.finish, r.sc_bought,
        (SELECT COALESCE(SUM(amount), 0) FROM ledger WHERE cup_id = ?2 AND player_id = p.id AND kind IN ('table_pay', 'gf_prize')) AS won
      FROM f JOIN players p ON p.id = f.id LEFT JOIN registrations r ON r.cup_id = ?2 AND r.player_id = p.id
      ORDER BY r.state IS NULL, won DESC, p.name LIMIT 100`).bind(s.playerId, cup.id).all<{ me: number; name: string | null; state: string | null; finish: string | null; sc_bought: number | null; won: number }>();
  return json({ friends: rows.results.map(r => ({ me: !!r.me, name: r.name || "Player", entered: !!r.state && !["refunded", "no-show"].includes(r.state), state: r.state, finish: r.finish, won: r.won })) });
}

/* ---------- reminders and "your cup" ---------- */

/** RFC 5545: the cup as one event, with an alarm when check-in opens. Times in UTC; calendars show local time. */
export function calendarOf(cupId: string, name: string, c: CupConfig, origin = "https://playcity.ng"): string {
  const t = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  const url = `${origin}/cup/?c=${encodeURIComponent(c.slug)}`;
  const before = Math.max(1, Math.round((c.startsAt - c.checkInOpensAt) / 60_000));
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//playcity//Whot Cup//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "BEGIN:VEVENT", `UID:${cupId}@playcity`, `DTSTAMP:${t(Date.now())}`, `DTSTART:${t(c.startsAt)}`, `DTEND:${t(c.mustEndBy)}`,
    `SUMMARY:${esc(name)}`, `DESCRIPTION:${esc(`Check in from ${before} minutes before the start, or your seat goes to the waitlist. ${url}`)}`, `URL:${url}`,
    "BEGIN:VALARM", `TRIGGER:-PT${before}M`, "ACTION:DISPLAY", `DESCRIPTION:${esc(`${name}: check-in is open`)}`, "END:VALARM",
    "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
}

/** The signed-in player's cups still to come or in play, soonest first: what the home page points them back to. */
export async function myCups(env: AuthEnv, req: Request): Promise<Response> {
  const s = await currentSession(env, req);
  if (!s) return fail(401, "signed-out");
  const rows = await env.DB.prepare(`SELECT c.slug, c.name, c.state, c.live_json, json_extract(c.config_json, '$.startsAt') AS starts_at,
      json_extract(c.config_json, '$.checkInOpensAt') AS check_in_opens_at, json_extract(c.config_json, '$.startsAt') - json_extract(c.config_json, '$.checkInCloseBeforeStartSec') * 1000 AS check_in_closes_at,
      r.state AS entry, r.checked_in_at
    FROM registrations r JOIN cups c ON c.id = r.cup_id
    WHERE r.player_id = ? AND c.state IN ('registration', 'closed', 'check-in', 'running') AND r.state IN ('entered', 'waitlist', 'seated', 'playing')
    ORDER BY starts_at LIMIT 5`).bind(s.playerId).all<{ slug: string; name: string; state: string; live_json: string | null; starts_at: number; check_in_opens_at: number; check_in_closes_at: number; entry: string; checked_in_at: number | null }>();
  return json({ cups: rows.results.map(r => ({
    slug: r.slug, name: r.name, state: r.state, startsAt: r.starts_at, checkInOpensAt: r.check_in_opens_at, checkInClosesAt: r.check_in_closes_at,
    entry: r.entry, checkedIn: !!r.checked_in_at, live: r.live_json ? JSON.parse(r.live_json) : null,
  })) });
}
