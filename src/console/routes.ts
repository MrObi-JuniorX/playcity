import { fail, json, readJson, sameOrigin, type Json } from "../http";
import { coerceConfig, configHash, defaultCupConfig, isFrozen, previewCup, publishChecks, validateCupConfig, type CupConfig } from "../cup/config";
import { DEFAULT_ECONOMY, forgetEconomyCache, type Economy } from "../wallet/wallet";
import {
  auditStatement, can, clearConsoleCookie, consoleUser, loginOptions, loginVerify, passkeyCount, registerOptions, registerVerify,
  rolesOf, ROLES, staffOf, type ConsoleEnv, type ConsoleUser, type Role,
} from "./access";

/* The admin console API (docs/whot-cup-prd.md, Phase 3). Everything is under /api/console/.

   Unlocking
   GET   me                                   who you are, your roles, whether the console is unlocked
   POST  passkey/register/options|verify      add a passkey (the first needs only staff + phone session)
   POST  passkey/login/options|verify         unlock the console for 8 hours
   POST  signout                              lock it again

   Cups (cup-admin)                           Templates (cup-admin)        Settings
   GET   cups                                 GET    templates             GET|PUT economy  (owner, finance)
   POST  cups              new, from a template or another cup             GET     audit    (any staff)
   GET   cups/:id                             POST   templates             GET|PUT staff    (owner)
   PUT   cups/:id          save a draft       DELETE templates/:id         DELETE  staff/:player (owner)
   POST  cups/:id/publish | unpublish | countersign (finance) | cancel | pause | promote { on }
   DELETE cups/:id         a draft that was never published

   Every write is audited in the same transaction as the change. */

const SLUG = /^[a-z0-9][a-z0-9-]{2,47}$/;
const MAX_BODY = 32 * 1024;

interface CupRow {
  id: string; slug: string; name: string; state: string; config_json: string; config_hash: string | null; version: number;
  published_at: number | null; published_by: string | null; countersigned_by: string | null;
  created_by: string; created_at: number; updated_by: string; updated_at: number; promoted: number;
}

export async function consoleRoute(req: Request, env: ConsoleEnv, path: string): Promise<Response | null> {
  if (!path.startsWith("/api/console/")) return null;
  const p = path.slice("/api/console/".length).split("/");
  const m = req.method;
  if (m !== "GET" && !sameOrigin(req)) return fail(403, "bad-origin");

  // ---------- unlocking ----------
  if (p[0] === "me" && m === "GET") return me(env, req);
  if (p[0] === "passkey") return passkey(env, req, p[1], p[2]);
  if (p[0] === "signout" && m === "POST") {
    const u = await consoleUser(env, req);
    if (u) await env.DB.prepare("UPDATE console_sessions SET revoked_at = ? WHERE id = ?").bind(Date.now(), u.sessionId).run();
    return json({ ok: true }, 200, { "Set-Cookie": clearConsoleCookie() });
  }

  // ---------- everything else needs an unlocked console ----------
  const u = await consoleUser(env, req);
  if (!u) return fail(401, "locked");
  const body = m === "GET" || m === "DELETE" ? {} : await readJson(req, MAX_BODY);
  if (!body) return fail(400, "bad-request");

  if (p[0] === "cups") {
    if (!can(u, "cup-admin", "finance")) return fail(403, "not-allowed");
    if (p.length === 1 && m === "GET") return listCups(env);
    if (p.length === 1 && m === "POST") return can(u, "cup-admin") ? createCup(env, u, body) : fail(403, "not-allowed");
    const cup = await env.DB.prepare("SELECT * FROM cups WHERE id = ?").bind(p[1] || "").first<CupRow>();
    if (!cup) return fail(404, "no-cup");
    if (p.length === 2 && m === "GET") return json({ cup: cupView(cup, Date.now()) });
    if (p[2] === "countersign" && m === "POST") return countersign(env, u, cup, body);
    if (!can(u, "cup-admin")) return fail(403, "not-allowed");
    if (p.length === 2 && m === "PUT") return saveCup(env, u, cup, body);
    if (p.length === 2 && m === "DELETE") return deleteCup(env, u, cup);
    if (p[2] === "publish" && m === "POST") return publish(env, u, cup, body);
    if (p[2] === "unpublish" && m === "POST") return unpublish(env, u, cup, body);
    if (p[2] === "cancel" && m === "POST") return cancel(env, u, cup, body);
    if (p[2] === "pause" && m === "POST") return pause(env, u, cup, body);
    if (p[2] === "promote" && m === "POST") return promote(env, u, cup, body);
    if (p[2] === "live" && m === "GET") return json({ live: await env.CUP.getByName(cup.id).status() });
  }
  if (p[0] === "templates") {
    if (!can(u, "cup-admin")) return fail(403, "not-allowed");
    if (p.length === 1 && m === "GET") return json({ templates: (await env.DB.prepare("SELECT id, name, config_json, created_by, updated_at FROM cup_templates ORDER BY name").all()).results.map(t => ({ ...t, config: JSON.parse(String(t.config_json)), config_json: undefined })) });
    if (p.length === 1 && m === "POST") return createTemplate(env, u, body);
    if (p.length === 2 && m === "DELETE") return deleteTemplate(env, u, p[1]);
  }
  if (p[0] === "economy") {
    if (m === "GET") return json({ economy: await readEconomy(env) });
    if (m === "PUT") return can(u, "finance") ? saveEconomy(env, u, body) : fail(403, "not-allowed");
  }
  if (p[0] === "audit" && m === "GET") return auditLog(env, req);
  if (p[0] === "staff") {
    if (!can(u)) return fail(403, "not-allowed");                      // owners only
    if (p.length === 1 && m === "GET") return listStaff(env);
    if (p.length === 1 && m === "PUT") return saveStaff(env, u, body);
    if (p.length === 2 && m === "DELETE") return removeStaff(env, u, p[1]);
  }
  return fail(404, "not-found");
}

/* ---------- unlocking ---------- */

async function me(env: ConsoleEnv, req: Request): Promise<Response> {
  const staff = await staffOf(env, req);
  if (!staff) return json({ staff: null });
  const u = await consoleUser(env, req);
  return json({ staff: { playerId: staff.playerId, name: staff.name, roles: staff.roles }, passkeys: await passkeyCount(env, staff.playerId), unlocked: !!u, cashEnabled: env.CASH_ENABLED === "1" });
}

async function passkey(env: ConsoleEnv, req: Request, what: string, step: string): Promise<Response> {
  if (req.method !== "POST") return fail(404, "not-found");
  const staff = await staffOf(env, req);
  if (!staff) return fail(403, "not-staff");
  const body = await readJson(req, MAX_BODY);
  if (!body) return fail(400, "bad-request");
  if (what === "register") {
    // A second passkey needs an unlocked console: a stolen phone session can't add a key to an account that has one.
    if (await passkeyCount(env, staff.playerId) > 0 && !(await consoleUser(env, req))) return fail(401, "locked");
    if (step === "options") return json({ options: await registerOptions(env, req, staff) });
    if (step === "verify") {
      const id = await registerVerify(env, req, staff, body.response as never, String(body.name ?? ""));
      if (!id) return fail(400, "passkey-failed");
      await auditStatement(env, staff.playerId, "passkey.add", `passkey:${id}`, undefined, { name: body.name ?? null }).run();
      return json({ ok: true });
    }
  }
  if (what === "login") {
    if (step === "options") { const o = await loginOptions(env, req, staff); return o ? json({ options: o }) : fail(400, "no-passkey"); }
    if (step === "verify") {
      const r = await loginVerify(env, req, staff, body.response as never);
      if (!r) return fail(400, "passkey-failed");
      await auditStatement(env, staff.playerId, "console.unlock", `passkey:${r.passkeyId}`, undefined, undefined).run();
      return json({ ok: true }, 200, { "Set-Cookie": r.cookie });
    }
  }
  return fail(404, "not-found");
}

/* ---------- cups ---------- */

function cupView(c: CupRow, now: number) {
  const config = JSON.parse(c.config_json) as CupConfig;
  return {
    id: c.id, slug: c.slug, name: c.name, state: c.state, version: c.version, config, configHash: c.config_hash,
    publishedAt: c.published_at, publishedBy: c.published_by, countersignedBy: c.countersigned_by,
    createdBy: c.created_by, createdAt: c.created_at, updatedBy: c.updated_by, updatedAt: c.updated_at,
    frozen: isFrozen(c.state, config, now), promoted: !!c.promoted,
  };
}

async function listCups(env: ConsoleEnv): Promise<Response> {
  const rows = await env.DB.prepare("SELECT * FROM cups ORDER BY created_at DESC LIMIT 200").all<CupRow>();
  const now = Date.now();
  return json({ cups: rows.results.map(r => { const v = cupView(r, now); return { ...v, config: undefined, startsAt: v.config.startsAt, capacity: v.config.capacity, currency: v.config.currency, entryFee: v.config.entryFee }; }) });
}

async function uniqueSlug(env: ConsoleEnv, want: string): Promise<string> {
  const base = (want.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "cup").slice(0, 40).padEnd(3, "x");
  for (let i = 1; i < 100; i++) {
    const s = i === 1 ? base : `${base}-${i}`;
    if (!(await env.DB.prepare("SELECT 1 FROM cups WHERE slug = ?").bind(s).first())) return s;
  }
  return `${base}-${crypto.randomUUID().slice(0, 6)}`;
}

async function createCup(env: ConsoleEnv, u: ConsoleUser, b: Json): Promise<Response> {
  let base = defaultCupConfig();
  const from = b.from as Json | undefined;
  if (from?.template) {
    const t = await env.DB.prepare("SELECT config_json FROM cup_templates WHERE id = ?").bind(String(from.template)).first<string>("config_json");
    if (!t) return fail(404, "no-template");
    base = coerceConfig(JSON.parse(t), base);
  } else if (from?.cup) {
    const c = await env.DB.prepare("SELECT config_json FROM cups WHERE id = ?").bind(String(from.cup)).first<string>("config_json");
    if (!c) return fail(404, "no-cup");
    base = coerceConfig(JSON.parse(c), base);
  }
  // A copy keeps the settings but gets fresh dates: the next Saturday, with the same offsets.
  const fresh = defaultCupConfig();
  const shift = fresh.startsAt - base.startsAt;
  if (shift > 0) for (const k of ["registrationOpensAt", "registrationClosesAt", "checkInOpensAt", "startsAt", "mustEndBy"] as const) base[k] += shift;
  const name = typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 60) : base.name;
  const config: CupConfig = { ...base, name, slug: await uniqueSlug(env, typeof b.slug === "string" && b.slug ? b.slug : name) };
  const id = crypto.randomUUID(), now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO cups (id, slug, name, state, config_json, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)")
      .bind(id, config.slug, config.name, JSON.stringify(config), u.playerId, now, u.playerId, now),
    auditStatement(env, u.playerId, "cup.create", `cup:${id}`, undefined, { from: from ?? null, config }),
  ]);
  return json({ cup: cupView((await env.DB.prepare("SELECT * FROM cups WHERE id = ?").bind(id).first<CupRow>())!, now) }, 201);
}

/** Apply a change only if nobody else changed the cup since this admin read it. */
async function guarded(env: ConsoleEnv, cup: CupRow, b: Json, stmts: D1PreparedStatement[]): Promise<Response | null> {
  if (b.version !== cup.version) return fail(409, "stale", { version: cup.version });
  const res = await env.DB.batch(stmts);
  if (!res[0].meta.changes) return fail(409, "stale");
  return null;
}

async function saveCup(env: ConsoleEnv, u: ConsoleUser, cup: CupRow, b: Json): Promise<Response> {
  const now = Date.now(), before = JSON.parse(cup.config_json) as CupConfig;
  if (isFrozen(cup.state, before, now)) return fail(409, "frozen");
  if (cup.state !== "draft") return fail(409, "unpublish-first");
  const config = coerceConfig(b.config, before);
  const errors = validateCupConfig(config);
  if (errors.length) return fail(400, "invalid", { errors });
  if (config.slug !== cup.slug && await env.DB.prepare("SELECT 1 FROM cups WHERE slug = ? AND id <> ?").bind(config.slug, cup.id).first()) return fail(409, "slug-taken");
  const bad = await guarded(env, cup, b, [
    env.DB.prepare("UPDATE cups SET config_json = ?, slug = ?, name = ?, countersigned_by = NULL, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND version = ?")
      .bind(JSON.stringify(config), config.slug, config.name, u.playerId, now, cup.id, cup.version),
    auditStatement(env, u.playerId, "cup.edit", `cup:${cup.id}`, changed(before, config, true), changed(before, config, false), true),
  ]);
  return bad ?? reread(env, cup.id);
}

/** Only the settings that changed, for a readable audit trail. */
function changed(a: CupConfig, b: CupConfig, takeOld: boolean): Json {
  const out: Json = {};
  for (const k of Object.keys(b) as (keyof CupConfig)[]) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out[k] = takeOld ? a[k] : b[k];
  return out;
}

async function reread(env: ConsoleEnv, id: string, status = 200) {
  return json({ cup: cupView((await env.DB.prepare("SELECT * FROM cups WHERE id = ?").bind(id).first<CupRow>())!, Date.now()) }, status);
}

async function publish(env: ConsoleEnv, u: ConsoleUser, cup: CupRow, b: Json): Promise<Response> {
  const now = Date.now(), config = JSON.parse(cup.config_json) as CupConfig;
  if (cup.state !== "draft") return fail(409, "not-draft");
  const previews = previewCup(config);
  const problems = publishChecks(config, { now, cashEnabled: env.CASH_ENABLED === "1", countersigned: !!cup.countersigned_by }, previews);
  if (problems.length) return fail(400, "checks-failed", { problems });
  const hash = await configHash(config);
  const bad = await guarded(env, cup, b, [
    env.DB.prepare("UPDATE cups SET state = 'scheduled', config_hash = ?, estimate_json = ?, published_at = ?, published_by = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND version = ? AND state = 'draft'")
      .bind(hash, JSON.stringify(estimateOf(previews)), now, u.playerId, u.playerId, now, cup.id, cup.version),
    auditStatement(env, u.playerId, "cup.publish", `cup:${cup.id}`, { state: "draft" }, { state: "scheduled", configHash: hash }, true),
  ]);
  if (bad) return bad;
  await env.CUP.getByName(cup.id).arm(cup.id);                      // the director wakes when registration opens
  return reread(env, cup.id);
}

async function unpublish(env: ConsoleEnv, u: ConsoleUser, cup: CupRow, b: Json): Promise<Response> {
  const now = Date.now();
  if (cup.state !== "scheduled") return fail(409, "not-scheduled");
  if (isFrozen(cup.state, JSON.parse(cup.config_json), now)) return fail(409, "frozen");
  const bad = await guarded(env, cup, b, [
    env.DB.prepare("UPDATE cups SET state = 'draft', config_hash = NULL, published_at = NULL, published_by = NULL, countersigned_by = NULL, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND version = ? AND state = 'scheduled'")
      .bind(u.playerId, now, cup.id, cup.version),
    auditStatement(env, u.playerId, "cup.unpublish", `cup:${cup.id}`, { state: "scheduled", configHash: cup.config_hash }, { state: "draft" }, true),
  ]);
  if (bad) return bad;
  await env.CUP.getByName(cup.id).disarm();
  return reread(env, cup.id);
}

/* A naira cup needs a finance approver who did not create or last edit it (PRD, roles). */
async function countersign(env: ConsoleEnv, u: ConsoleUser, cup: CupRow, b: Json): Promise<Response> {
  if (!u.roles.includes("finance")) return fail(403, "not-allowed");
  if (u.playerId === cup.created_by || u.playerId === cup.updated_by) return fail(403, "not-your-own");
  if (cup.state !== "draft") return fail(409, "not-draft");
  if ((JSON.parse(cup.config_json) as CupConfig).currency !== "NGN") return fail(409, "not-naira");
  const now = Date.now();
  const bad = await guarded(env, cup, b, [
    env.DB.prepare("UPDATE cups SET countersigned_by = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?").bind(u.playerId, now, cup.id, cup.version),
    auditStatement(env, u.playerId, "cup.countersign", `cup:${cup.id}`, undefined, { configHash: await configHash(JSON.parse(cup.config_json)) }, true),
  ]);
  return bad ?? reread(env, cup.id);
}

/* Cancel. Before registration opens nothing has been staked. After that the director refunds every stake (CL-5):
   everyone gets back at least what they put in, and nobody hands back winnings. */
async function cancel(env: ConsoleEnv, u: ConsoleUser, cup: CupRow, b: Json): Promise<Response> {
  const now = Date.now();
  if (cup.state === "cancelled" || cup.state === "settled") return fail(409, "already-over");
  if (b.version !== cup.version) return fail(409, "stale", { version: cup.version });
  const reason = typeof b.reason === "string" && b.reason.trim() ? b.reason.trim().slice(0, 280) : "Cancelled by the organisers";
  if (cup.state === "draft") {
    const bad = await guarded(env, cup, b, [
      env.DB.prepare("UPDATE cups SET state = 'cancelled', cancel_reason = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND version = ?").bind(reason, u.playerId, now, cup.id, cup.version),
      auditStatement(env, u.playerId, "cup.cancel", `cup:${cup.id}`, { state: cup.state }, { state: "cancelled", reason }, true),
    ]);
    return bad ?? reread(env, cup.id);
  }
  await env.CUP.getByName(cup.id).cancel(reason);
  await env.DB.batch([
    env.DB.prepare("UPDATE cups SET version = version + 1, updated_by = ? WHERE id = ?").bind(u.playerId, cup.id),
    auditStatement(env, u.playerId, "cup.cancel", `cup:${cup.id}`, { state: cup.state }, { state: "cancelled", reason, refunded: true }),
  ]);
  return reread(env, cup.id);
}

/* Pause (CL-6): tables in progress finish; no new round starts until resumed. */
async function pause(env: ConsoleEnv, u: ConsoleUser, cup: CupRow, b: Json): Promise<Response> {
  if (!["registration", "closed", "check-in", "running"].includes(cup.state)) return fail(409, "not-live");
  const on = b.on !== false;
  await env.CUP.getByName(cup.id).pause(on);
  await auditStatement(env, u.playerId, on ? "cup.pause" : "cup.resume", `cup:${cup.id}`, undefined, undefined).run();
  return json({ live: await env.CUP.getByName(cup.id).status() });
}

/* The home page banner: on or off at any time while the cup is published. A display switch, so it isn't frozen with
   the settings and doesn't change the cup's version (an open editor stays current). Audited like everything else. */
async function promote(env: ConsoleEnv, u: ConsoleUser, cup: CupRow, b: Json): Promise<Response> {
  if (!["scheduled", "registration", "closed", "check-in", "running"].includes(cup.state)) return fail(409, cup.state === "draft" ? "publish-first" : "already-over");
  const on = b.on === true;
  await env.DB.batch([
    env.DB.prepare("UPDATE cups SET promoted = ? WHERE id = ? AND promoted <> ?").bind(on ? 1 : 0, cup.id, on ? 1 : 0),
    auditStatement(env, u.playerId, on ? "cup.home-banner.on" : "cup.home-banner.off", `cup:${cup.id}`, { promoted: !!cup.promoted }, { promoted: on }, true),
  ]);
  const fresh = await env.DB.prepare("SELECT * FROM cups WHERE id = ?").bind(cup.id).first<CupRow>();
  return json({ cup: cupView(fresh!, Date.now()) });
}

/** What the public cup page shows before the field is known: the expected field's main-draw pay and prizes. */
function estimateOf(previews: ReturnType<typeof previewCup>) {
  const p = previews.find(x => x.size === "expected") ?? previews[0], s = p.sim;
  return {
    field: p.N, rounds: s.rounds, minutes: p.minutes, champion: s.champion, prizes: s.prizes, winners: s.winners, breakEven: s.breakEven,
    main: s.slots.filter(x => x.W).map((x, i) => ({ round: i + 1, players: x.W!.n, rule: x.W!.mode, pay1: x.W!.pay1, pay2: x.W!.pay2 })),
    secondChance: s.slots.filter(x => x.L).map(x => ({ players: x.L!.n, rule: x.L!.mode, pay1: x.L!.pay1, pay2: x.L!.pay2 })),
  };
}

async function deleteCup(env: ConsoleEnv, u: ConsoleUser, cup: CupRow): Promise<Response> {
  if (cup.state !== "draft" || cup.published_at) return fail(409, "not-a-draft");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM cups WHERE id = ? AND state = 'draft'").bind(cup.id),
    auditStatement(env, u.playerId, "cup.delete", `cup:${cup.id}`, { name: cup.name, config: JSON.parse(cup.config_json) }, undefined),
  ]);
  return json({ ok: true });
}

/* ---------- templates ---------- */

async function createTemplate(env: ConsoleEnv, u: ConsoleUser, b: Json): Promise<Response> {
  const name = typeof b.name === "string" ? b.name.trim().slice(0, 60) : "";
  if (name.length < 3) return fail(400, "bad-name");
  let config: CupConfig;
  if (typeof b.fromCup === "string") {
    const c = await env.DB.prepare("SELECT config_json FROM cups WHERE id = ?").bind(b.fromCup).first<string>("config_json");
    if (!c) return fail(404, "no-cup");
    config = coerceConfig(JSON.parse(c));
  } else config = coerceConfig(b.config);
  config = { ...config, slug: "" };                                  // a template has no address of its own
  const errors = validateCupConfig({ ...config, slug: "template" });
  if (errors.length) return fail(400, "invalid", { errors });
  const id = crypto.randomUUID(), now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO cup_templates (id, name, config_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, name, JSON.stringify(config), u.playerId, now, now),
      auditStatement(env, u.playerId, "template.create", `template:${id}`, undefined, { name, config }),
    ]);
  } catch (e) { if (/UNIQUE/.test(String(e))) return fail(409, "name-taken"); throw e; }
  return json({ id }, 201);
}

async function deleteTemplate(env: ConsoleEnv, u: ConsoleUser, id: string): Promise<Response> {
  const t = await env.DB.prepare("SELECT name, config_json FROM cup_templates WHERE id = ?").bind(id).first<{ name: string; config_json: string }>();
  if (!t) return fail(404, "no-template");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM cup_templates WHERE id = ?").bind(id),
    auditStatement(env, u.playerId, "template.delete", `template:${id}`, { name: t.name, config: JSON.parse(t.config_json) }, undefined),
  ]);
  return json({ ok: true });
}

/* ---------- economy (AD-7) ---------- */

const ECONOMY_LIMITS: Record<keyof Economy, [number, number]> = {
  coinWelcomeGrant: [0, 100_000], coinDailyTopUp: [0, 50_000], coinBalanceCap: [1000, 1_000_000], topUpHourLagos: [0, 23],
};

async function readEconomy(env: ConsoleEnv): Promise<Economy> {
  const raw = await env.DB.prepare("SELECT value FROM settings WHERE key = 'economy'").first<string>("value");
  return raw ? { ...DEFAULT_ECONOMY, ...JSON.parse(raw) } : DEFAULT_ECONOMY;
}

async function saveEconomy(env: ConsoleEnv, u: ConsoleUser, b: Json): Promise<Response> {
  const before = await readEconomy(env), next = { ...before } as Economy, errors: string[] = [];
  for (const k of Object.keys(ECONOMY_LIMITS) as (keyof Economy)[]) {
    if (!(k in b)) continue;
    const v = b[k], [lo, hi] = ECONOMY_LIMITS[k];
    if (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi) errors.push(`${k} must be a whole number from ${lo} to ${hi}`);
    else next[k] = v as number;
  }
  if (next.coinWelcomeGrant > next.coinBalanceCap) errors.push("The welcome grant can't be more than the balance cap");
  if (errors.length) return fail(400, "invalid", { errors });
  await env.DB.batch([
    env.DB.prepare("INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('economy', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by")
      .bind(JSON.stringify(next), Date.now(), u.playerId),
    auditStatement(env, u.playerId, "economy.edit", "settings:economy", before, next),
  ]);
  forgetEconomyCache();                                             // other isolates pick it up within a minute
  return json({ economy: next });
}

/* ---------- audit (AD-6) ---------- */

async function auditLog(env: ConsoleEnv, req: Request): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const before = Number(q.get("before")) || Number.MAX_SAFE_INTEGER, target = q.get("target");
  const rows = target
    ? await env.DB.prepare("SELECT a.*, p.name AS actor_name FROM audit a LEFT JOIN players p ON p.id = a.actor WHERE a.target = ? AND a.id < ? ORDER BY a.id DESC LIMIT 51").bind(target, before).all()
    : await env.DB.prepare("SELECT a.*, p.name AS actor_name FROM audit a LEFT JOIN players p ON p.id = a.actor WHERE a.id < ? ORDER BY a.id DESC LIMIT 51").bind(before).all();
  const list = rows.results.slice(0, 50).map(r => ({
    id: r.id, actor: r.actor, actorName: r.actor_name, action: r.action, target: r.target, at: r.at,
    before: r.before_json ? JSON.parse(String(r.before_json)) : null, after: r.after_json ? JSON.parse(String(r.after_json)) : null,
  }));
  return json({ entries: list, more: rows.results.length > 50 });
}

/* ---------- staff (owners) ---------- */

async function listStaff(env: ConsoleEnv): Promise<Response> {
  const rows = await env.DB.prepare("SELECT s.player_id, s.roles, s.created_at, p.name, p.phone_last2 FROM staff s JOIN players p ON p.id = s.player_id ORDER BY p.name").all();
  const owners = (env.OWNER_PLAYER_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
  return json({ staff: rows.results.map(r => ({ playerId: r.player_id, name: r.name, phoneLast2: r.phone_last2, roles: String(r.roles).split(","), since: r.created_at })), bootstrapOwners: owners });
}

async function saveStaff(env: ConsoleEnv, u: ConsoleUser, b: Json): Promise<Response> {
  const pid = typeof b.playerId === "string" ? b.playerId : "";
  const roles = Array.isArray(b.roles) ? [...new Set(b.roles.filter((r): r is Role => ROLES.includes(r as Role)))] : [];
  if (!pid || !roles.length) return fail(400, "bad-request");
  if (!(await env.DB.prepare("SELECT 1 FROM players WHERE id = ?").bind(pid).first())) return fail(404, "no-player");
  const before = await rolesOf(env, pid);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO staff (player_id, roles, added_by, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET roles = excluded.roles")
      .bind(pid, roles.join(","), u.playerId, Date.now()),
    auditStatement(env, u.playerId, "staff.set", `player:${pid}`, { roles: before }, { roles }),
  ]);
  return listStaff(env);
}

async function removeStaff(env: ConsoleEnv, u: ConsoleUser, pid: string): Promise<Response> {
  if (pid === u.playerId) return fail(409, "not-yourself");
  const before = await rolesOf(env, pid);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM staff WHERE player_id = ?").bind(pid),
    env.DB.prepare("UPDATE console_sessions SET revoked_at = ? WHERE player_id = ? AND revoked_at IS NULL").bind(Date.now(), pid),
    auditStatement(env, u.playerId, "staff.remove", `player:${pid}`, { roles: before }, { roles: [] }),
  ]);
  return listStaff(env);
}
