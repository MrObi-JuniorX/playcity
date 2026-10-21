import { fail, ipOf, json, readJson, sameOrigin } from "../http";
import { currentSession } from "../auth/session";
import { hmac } from "../auth/crypto";
import type { AuthEnv } from "../auth/env";
import { cupAccount, cupSpec, playerAccount, playerSpec, transferStatements, ensureStatements } from "../wallet/ledger";
import { openWallet } from "../wallet/wallet";
import type { CupConfig } from "./config";

/* Public cup API (docs/whot-cup-prd.md, Phase 4).
   GET  /api/cups                       cups players can see now (edge-cached 5 s)
   GET  /api/cups/:slug                 one cup: settings, seats, schedule, progress, seeds (edge-cached 5 s)
   GET  /api/cups/:slug/me              your entry, and in a running cup your table or your Second Chance offer
   POST /api/cups/:slug/enter           { ref? }  stake the entry fee; ref = the player whose invite brought you
   POST /api/cups/:slug/checkin         "I'm here", during the check-in window
   POST /api/cups/:slug/second-chance   buy back in after a first loss, while the offer is open

   Entering is one D1 transaction: the registration row, the seat counter (its CHECK refuses an entry past
   capacity) and the stake. A full cup or an empty wallet rolls the whole thing back, so nobody pays for a seat
   they didn't get and two people can't take the last seat. */

const PUBLIC_STATES = ["scheduled", "registration", "closed", "check-in", "running", "settled", "cancelled"];

interface CupRow { id: string; slug: string; name: string; state: string; config_json: string; config_hash: string | null; estimate_json: string | null; schedule_json: string | null; live_json: string | null; cancel_reason: string | null; updated_at: number }

export async function cupRoute(req: Request, env: AuthEnv, path: string, ctx: ExecutionContext): Promise<Response | null> {
  if (path === "/api/cups" && req.method === "GET") return cached(req, ctx, () => listCups(env));
  const m = path.match(/^\/api\/cups\/([a-z0-9-]{3,48})(?:\/([a-z-]+))?$/);
  if (!m) return path.startsWith("/api/cups") ? fail(404, "not-found") : null;
  const [, slug, action] = m;
  if (!action && req.method === "GET") return cached(req, ctx, () => cupDetail(env, slug));
  const cup = await env.DB.prepare("SELECT * FROM cups WHERE slug = ?").bind(slug).first<CupRow>();
  if (!cup || !PUBLIC_STATES.includes(cup.state)) return fail(404, "no-cup");
  if (action === "me" && req.method === "GET") return myEntry(env, req, cup);
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
  return json({ cups: rows.results.map(r => { const c = JSON.parse(r.config_json) as CupConfig; return { ...publicConfig(c), state: r.state, entries: r.taken ?? 0, live: r.live_json ? JSON.parse(r.live_json) : null }; }) });
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
  return json({ entry: reg, live });
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
