/* The ledger (docs/whot-cup-prd.md, WL-1, WL-2, WL-5).

   A transfer moves a whole amount from one account to another. Each one is three writes in one D1 transaction:
   the ledger row, the payer's balance, the payee's balance. D1 runs a batch as a single transaction, so:
   - an overdraft trips the accounts CHECK and the whole batch rolls back (no read-then-write race);
   - a repeated idempotency key trips the UNIQUE index and the whole batch rolls back, and we answer "already done"
     when every entry in it matches what is on file;
   - an unknown account trips the foreign key, so money can't be sent to an account that doesn't exist.
   transferAll applies many transfers all or nothing: a round's payouts land together or not at all. */

export type Currency = "COIN" | "NGN";
export type Kind = "welcome" | "topup" | "stake" | "sc_stake" | "platform_cut" | "table_pay" | "gf_prize" | "refund" | "cheer" | "sponsor" | "adjust";

export interface Transfer {
  idem: string; from: string; to: string; amount: number; currency: Currency; kind: Kind;
  playerId?: string | null; cupId?: string | null; memo?: string | null;
}
export interface AccountSpec { id: string; kind: "player" | "platform" | "issuer" | "cup" | "sponsor"; owner?: string | null; currency: Currency; allowNegative?: boolean }

export class LedgerError extends Error {
  constructor(public code: "insufficient-funds" | "idem-conflict" | "bad-transfer" | "unknown-account", message?: string) { super(message ?? code); }
}

/* ---------- account ids ---------- */
export const playerAccount = (playerId: string, c: Currency = "COIN") => `p:${playerId}:${c}`;
export const cupAccount = (cupId: string, c: Currency = "COIN") => `cup:${cupId}:${c}`;
export const PLATFORM = (c: Currency = "COIN") => `platform:${c}`;
export const ISSUER = (c: Currency = "COIN") => `issuer:${c}`;

export const playerSpec = (playerId: string, c: Currency = "COIN"): AccountSpec => ({ id: playerAccount(playerId, c), kind: "player", owner: playerId, currency: c });
export const cupSpec = (cupId: string, c: Currency = "COIN"): AccountSpec => ({ id: cupAccount(cupId, c), kind: "cup", owner: cupId, currency: c });
export const platformSpec = (c: Currency = "COIN"): AccountSpec => ({ id: PLATFORM(c), kind: "platform", currency: c });
export const issuerSpec = (c: Currency = "COIN"): AccountSpec => ({ id: ISSUER(c), kind: "issuer", currency: c, allowNegative: c === "COIN" });

const IDEM = /^[A-Za-z0-9:_.\-]{3,160}$/;

function check(t: Transfer) {
  if (!Number.isSafeInteger(t.amount) || t.amount <= 0) throw new LedgerError("bad-transfer", `amount must be a positive whole number: ${t.amount}`);
  if (t.from === t.to) throw new LedgerError("bad-transfer", "from and to are the same account");
  if (!IDEM.test(t.idem)) throw new LedgerError("bad-transfer", `bad idempotency key: ${t.idem}`);
  if (!t.from.endsWith(":" + t.currency) || !t.to.endsWith(":" + t.currency)) throw new LedgerError("bad-transfer", "account and currency differ");
}

/** Statements that create accounts if they don't exist yet. Put them in the same batch as the transfers. */
export function ensureStatements(db: D1Database, specs: AccountSpec[]): D1PreparedStatement[] {
  const now = Date.now();
  return specs.map(s => db.prepare("INSERT OR IGNORE INTO accounts (id, kind, owner, currency, allow_negative, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(s.id, s.kind, s.owner ?? null, s.currency, s.allowNegative ? 1 : 0, now));
}

export function transferStatements(db: D1Database, ts: Transfer[]): D1PreparedStatement[] {
  const now = Date.now(), out: D1PreparedStatement[] = [];
  for (const t of ts) {
    check(t);
    out.push(
      db.prepare("INSERT INTO ledger (idem_key, from_account, to_account, amount, currency, kind, player_id, cup_id, memo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(t.idem, t.from, t.to, t.amount, t.currency, t.kind, t.playerId ?? null, t.cupId ?? null, t.memo ?? null, now),
      db.prepare("UPDATE accounts SET balance = balance - ? WHERE id = ?").bind(t.amount, t.from),
      db.prepare("UPDATE accounts SET balance = balance + ? WHERE id = ?").bind(t.amount, t.to),
    );
  }
  return out;
}

/** Apply transfers all or nothing. `applied: false` means every one of them was already on file (a safe retry).
    `extra` statements run in the same transaction (for example, marking a top-up as claimed). */
export async function transferAll(db: D1Database, ts: Transfer[], ensure: AccountSpec[] = [], extra: D1PreparedStatement[] = []): Promise<{ applied: boolean; rowsWritten: number }> {
  if (!ts.length) return { applied: false, rowsWritten: 0 };
  const stmts = [...ensureStatements(db, ensure), ...transferStatements(db, ts), ...extra];
  try {
    const res = await db.batch(stmts);
    return { applied: true, rowsWritten: res.reduce((n, r) => n + (r.meta?.rows_written ?? 0), 0) };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/UNIQUE constraint failed: ledger\.idem_key/i.test(msg)) {
      if (await allOnFile(db, ts)) return { applied: false, rowsWritten: 0 };
      throw new LedgerError("idem-conflict", "an idempotency key was reused for a different transfer");
    }
    if (/CHECK constraint failed/i.test(msg)) throw new LedgerError("insufficient-funds");
    if (/FOREIGN KEY constraint failed/i.test(msg)) throw new LedgerError("unknown-account");
    throw e;
  }
}

export const transfer = (db: D1Database, t: Transfer, ensure: AccountSpec[] = [], extra: D1PreparedStatement[] = []) => transferAll(db, [t], ensure, extra);

async function allOnFile(db: D1Database, ts: Transfer[]): Promise<boolean> {
  for (const t of ts) {
    const r = await db.prepare("SELECT from_account, to_account, amount, currency, kind FROM ledger WHERE idem_key = ?").bind(t.idem)
      .first<{ from_account: string; to_account: string; amount: number; currency: string; kind: string }>();
    if (!r || r.from_account !== t.from || r.to_account !== t.to || r.amount !== t.amount || r.currency !== t.currency || r.kind !== t.kind) return false;
  }
  return true;
}

export async function balanceOf(db: D1Database, account: string): Promise<number | null> {
  return db.prepare("SELECT balance FROM accounts WHERE id = ?").bind(account).first<number>("balance");
}

/* ---------- reconciliation (WL-5) ---------- */

export interface Mismatch { kind: "account" | "currency" | "cup"; id: string; expected: number; found: number }

/** Every account's balance against the sum of its entries, and every currency summing to zero. */
export async function reconcileAll(db: D1Database): Promise<Mismatch[]> {
  const out: Mismatch[] = [];
  const accts = await db.prepare(`
    SELECT a.id, a.balance, COALESCE(i.s, 0) - COALESCE(o.s, 0) AS computed
    FROM accounts a
    LEFT JOIN (SELECT to_account AS id, SUM(amount) AS s FROM ledger GROUP BY to_account) i ON i.id = a.id
    LEFT JOIN (SELECT from_account AS id, SUM(amount) AS s FROM ledger GROUP BY from_account) o ON o.id = a.id
    WHERE a.balance <> COALESCE(i.s, 0) - COALESCE(o.s, 0)`).all<{ id: string; balance: number; computed: number }>();
  for (const r of accts.results) out.push({ kind: "account", id: r.id, expected: r.computed, found: r.balance });
  const cur = await db.prepare("SELECT currency, SUM(balance) AS s FROM accounts GROUP BY currency HAVING SUM(balance) <> 0").all<{ currency: string; s: number }>();
  for (const r of cur.results) out.push({ kind: "currency", id: r.currency, expected: 0, found: r.s });
  return out;
}

/** One cup: its pot's balance matches the cup's entries, and a settled cup's pot is empty. */
export async function reconcileCup(db: D1Database, cupId: string, settled: boolean, c: Currency = "COIN"): Promise<Mismatch[]> {
  const pot = cupAccount(cupId, c);
  const r = await db.prepare(`SELECT
      (SELECT COALESCE(SUM(amount), 0) FROM ledger WHERE cup_id = ?1 AND to_account = ?2) -
      (SELECT COALESCE(SUM(amount), 0) FROM ledger WHERE cup_id = ?1 AND from_account = ?2) AS computed,
      (SELECT balance FROM accounts WHERE id = ?2) AS balance`).bind(cupId, pot).first<{ computed: number; balance: number | null }>();
  const out: Mismatch[] = [];
  const balance = r?.balance ?? 0, computed = r?.computed ?? 0;
  if (balance !== computed) out.push({ kind: "cup", id: cupId, expected: computed, found: balance });
  if (settled && balance !== 0) out.push({ kind: "cup", id: cupId, expected: 0, found: balance });
  return out;
}

/** The nightly check. Logs one alert line per problem; never logs a player's data beyond account ids. */
export async function nightlyReconcile(db: D1Database): Promise<Mismatch[]> {
  const m = await reconcileAll(db);
  for (const x of m) console.error(JSON.stringify({ alert: true, msg: "ledger mismatch", ...x }));
  if (!m.length) console.log(JSON.stringify({ msg: "ledger reconciled" }));
  return m;
}
