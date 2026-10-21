import { currentSession } from "../auth/session";
import type { AuthEnv } from "../auth/env";
import { history, nextTopUpAt, openWallet } from "./wallet";

/* GET /api/wallet?before=<entry id>   The signed-in player's coins (WL-4): balance, the next top-up, and history.
   Opening the wallet claims the welcome grant or today's top-up. */
export async function walletRoute(req: Request, env: AuthEnv, path: string): Promise<Response | null> {
  if (path !== "/api/wallet") return null;
  const headers = { "Cache-Control": "no-store" };
  if (req.method !== "GET") return Response.json({ error: "not-found" }, { status: 404, headers });
  const s = await currentSession(env, req);
  if (!s) return Response.json({ error: "signed-out" }, { status: 401, headers });
  const before = Number(new URL(req.url).searchParams.get("before")) || null;
  const now = Date.now();
  const w = await openWallet(env.DB, s.playerId, now);
  const h = await history(env.DB, s.playerId, before);
  return Response.json({
    currency: "COIN", balance: w.balance, cap: w.economy.coinBalanceCap, dailyTopUp: w.economy.coinDailyTopUp,
    nextTopUpAt: nextTopUpAt(now, w.economy), entries: h.entries, more: h.more,
  }, { headers });
}
