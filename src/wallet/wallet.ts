import { ensureStatements, ISSUER, issuerSpec, playerAccount, playerSpec, transfer, LedgerError, type Kind } from "./ledger";

/* Coins (WL-3): a welcome grant, a daily top-up claimed when the player opens their wallet, and a balance cap.
   Coins can't be bought, sold, sent to another player or cashed out: the only ways in are these grants and cup
   winnings, and nothing here pays coins out to the world.

   The top-up needs no cron: the first wallet visit after 08:00 Lagos time claims it, keyed by that day, so it
   costs nothing for players who don't come back and can't be claimed twice. */

export interface Economy { coinWelcomeGrant: number; coinDailyTopUp: number; coinBalanceCap: number; topUpHourLagos: number }
export const DEFAULT_ECONOMY: Economy = { coinWelcomeGrant: 5000, coinDailyTopUp: 1000, coinBalanceCap: 20000, topUpHourLagos: 8 };

const LAGOS_MS = 3600_000;              // West Africa Time is UTC+1 all year
const DAY = 86_400_000;
let cache: { at: number; e: Economy } | null = null;

/** Global economy settings (PRD 5.1), edited in the admin console from Phase 3. Cached for a minute per isolate. */
export async function economy(db: D1Database): Promise<Economy> {
  if (cache && Date.now() - cache.at < 60_000) return cache.e;
  const raw = await db.prepare("SELECT value FROM settings WHERE key = 'economy'").first<string>("value");
  let e = DEFAULT_ECONOMY;
  if (raw) { try { e = { ...DEFAULT_ECONOMY, ...JSON.parse(raw) }; } catch { /* keep defaults */ } }
  cache = { at: Date.now(), e };
  return e;
}
export const forgetEconomyCache = () => { cache = null; };

/** The Lagos "top-up day": it turns over at the top-up hour, not at midnight. */
export const topUpDay = (now: number, e: Economy) => Math.floor((now + LAGOS_MS - e.topUpHourLagos * 3600_000) / DAY);
export const nextTopUpAt = (now: number, e: Economy) => (topUpDay(now, e) + 1) * DAY - LAGOS_MS + e.topUpHourLagos * 3600_000;

/** Open a player's coin wallet: creates it with the welcome grant on first use, then claims today's top-up. */
export async function openWallet(db: D1Database, playerId: string, now = Date.now()): Promise<{ balance: number; economy: Economy }> {
  const e = await economy(db), acct = playerAccount(playerId), day = topUpDay(now, e);
  let row = await db.prepare("SELECT balance, last_topup_day FROM accounts WHERE id = ?").bind(acct).first<{ balance: number; last_topup_day: number | null }>();

  if (!row) {
    // Welcome: the grant counts as today's coins, so the first daily top-up comes tomorrow.
    const amount = Math.min(e.coinWelcomeGrant, e.coinBalanceCap);
    const mark = db.prepare("UPDATE accounts SET last_topup_day = ? WHERE id = ?").bind(day, acct);
    if (amount > 0) await safe(transfer(db, { idem: `welcome:${playerId}:COIN`, from: ISSUER(), to: acct, amount, currency: "COIN", kind: "welcome", playerId, memo: "Welcome coins" }, [issuerSpec(), playerSpec(playerId)], [mark]));
    else await db.batch([...ensureStatements(db, [playerSpec(playerId)]), mark]);
    row = await db.prepare("SELECT balance, last_topup_day FROM accounts WHERE id = ?").bind(acct).first();
  } else if ((row.last_topup_day ?? -1) < day) {
    const amount = Math.max(0, Math.min(e.coinDailyTopUp, e.coinBalanceCap - row.balance));
    const mark = db.prepare("UPDATE accounts SET last_topup_day = ? WHERE id = ? AND (last_topup_day IS NULL OR last_topup_day < ?)").bind(day, acct, day);
    if (amount > 0) await safe(transfer(db, { idem: `topup:${playerId}:${day}`, from: ISSUER(), to: acct, amount, currency: "COIN", kind: "topup", playerId, memo: "Daily coins" }, [issuerSpec()], [mark]));
    else await mark.run();                               // at the cap: nothing to add, but today is claimed
    row = await db.prepare("SELECT balance, last_topup_day FROM accounts WHERE id = ?").bind(acct).first();
  }
  return { balance: row!.balance, economy: e };
}

/* Two tabs opening the wallet together race to the same idempotency key; the loser's "already done" is fine. */
async function safe(p: Promise<unknown>) {
  try { await p; } catch (err) { if (!(err instanceof LedgerError && err.code === "idem-conflict")) throw err; }
}

export interface HistoryEntry { id: number; kind: Kind; amount: number; cupId: string | null; memo: string | null; at: number }

/** A player's entries, newest first, amounts signed from their side. */
export async function history(db: D1Database, playerId: string, before: number | null, limit = 30): Promise<{ entries: HistoryEntry[]; more: boolean }> {
  const acct = playerAccount(playerId);
  const rows = await db.prepare("SELECT id, kind, amount, to_account, cup_id, memo, created_at FROM ledger WHERE player_id = ? AND id < ? ORDER BY id DESC LIMIT ?")
    .bind(playerId, before ?? Number.MAX_SAFE_INTEGER, limit + 1)
    .all<{ id: number; kind: Kind; amount: number; to_account: string; cup_id: string | null; memo: string | null; created_at: number }>();
  const list = rows.results.slice(0, limit).map(r => ({ id: r.id, kind: r.kind, amount: r.to_account === acct ? r.amount : -r.amount, cupId: r.cup_id, memo: r.memo, at: r.created_at }));
  return { entries: list, more: rows.results.length > limit };
}
