import { fail, json, readJson, sameOrigin } from "../http";
import { currentSession } from "../auth/session";
import { sha256 } from "../auth/crypto";
import type { NotifyEnv } from "./notify";
import { pushReady, validSubscription } from "./webpush";

/* Notifications (docs/whot-cup-prd.md PX-4).
   GET    /api/push/key          { key }  the VAPID public key a browser subscribes with (null: push is off)
   POST   /api/push/subscribe    a PushSubscription (toJSON()), for the signed-in player
   DELETE /api/push/subscribe    { endpoint }  this browser stops getting notifications */
const MAX_PER_PLAYER = 5;

export async function pushRoute(req: Request, env: NotifyEnv, path: string): Promise<Response | null> {
  if (path === "/api/push/key" && req.method === "GET") return json({ key: pushReady(env) ? env.VAPID_PUBLIC_KEY : null }, 200, { "Cache-Control": "public, max-age=300" });
  if (path !== "/api/push/subscribe") return path.startsWith("/api/push/") ? fail(404, "not-found") : null;
  if (!sameOrigin(req)) return fail(403, "bad-origin");
  const s = await currentSession(env, req);
  if (!s) return fail(401, "signed-out");
  const b = await readJson(req, 2048);
  if (req.method === "POST") {
    if (!pushReady(env)) return fail(503, "push-off");
    const sub = validSubscription(b);
    if (!sub) return fail(400, "bad-subscription");
    const id = await sha256(sub.endpoint), now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO push_subs (id, player_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET player_id = excluded.player_id, p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at")
        .bind(id, s.playerId, sub.endpoint, sub.p256dh, sub.auth, now),
      // keep the newest few browsers per player
      env.DB.prepare("DELETE FROM push_subs WHERE player_id = ? AND id NOT IN (SELECT id FROM push_subs WHERE player_id = ? ORDER BY created_at DESC LIMIT ?)").bind(s.playerId, s.playerId, MAX_PER_PLAYER),
    ]);
    return json({ ok: true }, 201);
  }
  if (req.method === "DELETE") {
    if (typeof b?.endpoint !== "string") return fail(400, "bad-request");
    await env.DB.prepare("DELETE FROM push_subs WHERE id = ? AND player_id = ?").bind(await sha256(b.endpoint), s.playerId).run();
    return json({ ok: true });
  }
  return fail(404, "not-found");
}
