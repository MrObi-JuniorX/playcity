import { env } from "cloudflare:workers";
import { defaultCupConfig, type CupConfig } from "../../src/cup/config";
import type { CupDirector } from "../../src/cup/director";

/* Test kit for cups: create a published cup straight in D1 and arm its director, and create many players with
   coins and entries in bulk (one SQL statement per step, still through ledger rows so reconciliation holds). */

export const DB = (env as unknown as { DB: D1Database }).DB;
export const director = (cupId: string) => (env as unknown as { CUP: DurableObjectNamespace<CupDirector> }).CUP.getByName(cupId) as unknown as DurableObjectStub<CupDirector> & CupDirector;

let n = 0;
/** Times relative to now: registration open, closing in 5 min, check-in already open (tick drives the order). */
export function liveTimes(now = Date.now()) {
  return { registrationOpensAt: now - 600_000, checkInOpensAt: now - 60_000, registrationClosesAt: now + 300_000, startsAt: now + 3_600_000, checkInCloseBeforeStartSec: 300, mustEndBy: now + 12 * 3_600_000 };
}

export async function makeCup(over: Partial<CupConfig> = {}, mode: "simulate" | "external" = "simulate"): Promise<{ id: string; slug: string; c: CupConfig }> {
  const id = crypto.randomUUID(), slug = `t-cup-${Date.now().toString(36)}-${n++}`;
  const c: CupConfig = { ...defaultCupConfig(), ...liveTimes(), name: "Test Cup", slug, ...over };
  const now = Date.now();
  await DB.prepare("INSERT INTO cups (id, slug, name, state, config_json, config_hash, created_by, created_at, updated_by, updated_at, published_at) VALUES (?, ?, ?, 'scheduled', ?, 'test', 'test', ?, 'test', ?, ?)")
    .bind(id, slug, c.name, JSON.stringify(c), now, now, now).run();
  await director(id).arm(id, mode);
  return { id, slug, c };
}

/** Players with names, avatars and the 18+ declaration, each holding `coins` from the issuer. Distinct devices and IPs. */
export async function bulkPlayers(count: number, coins: number): Promise<string[]> {
  const ids = Array.from({ length: count }, () => crypto.randomUUID()), j = JSON.stringify(ids), now = Date.now();
  await DB.batch([
    DB.prepare(`INSERT INTO players (id, phone_hmac, phone_enc, phone_country, phone_last2, name, avatar_shape, avatar_color, adult_at, created_at, updated_at)
      SELECT value, 'h-' || value, 'v1:x', 'NG', '00', 'P' || substr(value, 1, 6), 'star', 'gold', ?1, ?1, ?1 FROM json_each(?2)`).bind(now, j),
    DB.prepare("INSERT OR IGNORE INTO accounts (id, kind, currency, allow_negative, created_at) VALUES ('issuer:COIN', 'issuer', 'COIN', 1, ?)").bind(now),
    DB.prepare("INSERT INTO accounts (id, kind, owner, currency, balance, created_at) SELECT 'p:' || value || ':COIN', 'player', value, 'COIN', ?1, ?2 FROM json_each(?3)").bind(coins, now, j),
    DB.prepare(`INSERT INTO ledger (idem_key, from_account, to_account, amount, currency, kind, player_id, created_at)
      SELECT 'fund:' || value, 'issuer:COIN', 'p:' || value || ':COIN', ?1, 'COIN', 'adjust', value, ?2 FROM json_each(?3)`).bind(coins, now, j),
    DB.prepare("UPDATE accounts SET balance = balance - ? WHERE id = 'issuer:COIN'").bind(coins * count),
  ]);
  return ids;
}

/** Enter players straight into a cup (stake through the ledger), checked in, each on their own device and network. */
export async function bulkEnter(cup: { id: string; c: CupConfig }, ids: string[], checkedIn = true) {
  const j = JSON.stringify(ids), now = Date.now(), fee = cup.c.entryFee;
  await DB.batch([
    DB.prepare("INSERT OR IGNORE INTO accounts (id, kind, owner, currency, created_at) VALUES (?, 'cup', ?, 'COIN', ?)").bind(`cup:${cup.id}:COIN`, cup.id, now),
    DB.prepare(`INSERT INTO registrations (cup_id, player_id, state, seq, entered_at, checked_in_at, device_id, ip_hash)
      SELECT ?1, value, 'entered', key + 1, ?2, ?3, 'dev-' || value, 'ip-' || value FROM json_each(?4)`).bind(cup.id, now, checkedIn ? now : null, j),
    DB.prepare(`INSERT INTO ledger (idem_key, from_account, to_account, amount, currency, kind, player_id, cup_id, created_at)
      SELECT 'stake:' || ?1 || ':' || value, 'p:' || value || ':COIN', ?2, ?3, 'COIN', 'stake', value, ?1, ?4 FROM json_each(?5)`).bind(cup.id, `cup:${cup.id}:COIN`, fee, now, j),
    DB.prepare("UPDATE accounts SET balance = balance - ?1 WHERE id IN (SELECT 'p:' || value || ':COIN' FROM json_each(?2))").bind(fee, j),
    DB.prepare("UPDATE accounts SET balance = balance + ? WHERE id = ?").bind(fee * ids.length, `cup:${cup.id}:COIN`),
    DB.prepare("UPDATE cup_seats SET taken = taken + ? WHERE cup_id = ?").bind(ids.length, cup.id),
  ]);
}

export const balance = async (account: string) => (await DB.prepare("SELECT balance FROM accounts WHERE id = ?").bind(account).first<number>("balance")) ?? 0;

/** Signed-in sessions for bulk players: the Cookie header each one sends. */
export async function sessionsFor(ids: string[]): Promise<Map<string, string>> {
  const { sha256 } = await import("../../src/auth/crypto");
  const now = Date.now(), out = new Map<string, string>(), stmts: D1PreparedStatement[] = [];
  for (const id of ids) {
    const tok = Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, "0")).join("");
    stmts.push(DB.prepare("INSERT INTO sessions (id, player_id, device_id, ip_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, 'ip', ?, ?, ?)").bind(await sha256(tok), id, `dev-${id}`, now, now, now + 86_400_000));
    out.set(id, `__Host-pc_s=${tok}`);
  }
  await DB.batch(stmts);
  return out;
}
