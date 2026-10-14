export { Room } from "./room";
export { Lobby } from "./lobby";
export { WhotTable } from "./whot";

/* playcity edge Worker. Static game files are served by Workers Static Assets before this code runs.
   GET /api/ice            STUN (and TURN, when configured) servers for WebRTC
   GET /api/match?game=    longest-waiting open player: { code, name } or { code: null, waiting: n }
   GET /api/live?game=     public matches being played now: [{ code, title, since, free? }]
   GET /api/open           open Whot seats and Flick players waiting, for the landing page. Cached at the edge for 5 s.
   GET /ws/lobby?code=     hold a spot in quick match while playing, or list a live match with live=1 (WebSocket)
   GET /ws/room/:code      invite room: host holds it, a guest knocks, then signaling or relay; role=watch to spectate
   GET /ws/whot/:code      a Whot card table: the table runs the game; people sit, watch, or take a computer's seat */

const CODE = /^[A-HJ-NP-Z2-9]{5}$/;
const STUN = [{ urls: "stun:stun.cloudflare.com:3478" }];

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/api/ice") return await ice(env);

      if (path === "/api/match") {
        const game = (url.searchParams.get("game") || "flick").slice(0, 24);
        const exclude = (url.searchParams.get("exclude") || "").split(",").filter(c => CODE.test(c)).slice(0, 20);
        const lobby = env.LOBBY.getByName("lobby");
        const m = await lobby.match(game, exclude);
        return Response.json(m ?? { code: null, waiting: await lobby.count(game) }, { headers: { "Cache-Control": "no-store" } });
      }

      if (path === "/api/open") return await openNow(request, env, ctx);

      if (path === "/api/live") {
        const game = (url.searchParams.get("game") || "flick").slice(0, 24);
        return Response.json(await env.LOBBY.getByName("lobby").live(game), { headers: { "Cache-Control": "no-store" } });
      }

      if (path === "/ws/lobby") return await env.LOBBY.getByName("lobby").fetch(request);

      const room = path.match(/^\/ws\/room\/([A-Za-z0-9]{5})$/);
      if (room) {
        const code = room[1].toUpperCase();
        if (!CODE.test(code)) return new Response("Bad room code", { status: 400 });
        return await env.ROOM.getByName(code).fetch(request);
      }
      const table = path.match(/^\/ws\/whot\/([A-Za-z0-9]{5})$/);
      if (table) {
        const code = table[1].toUpperCase();
        if (!CODE.test(code)) return new Response("Bad table code", { status: 400 });
        return await env.WHOT.getByName(code).fetch(request);
      }
      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error(JSON.stringify({ msg: "request failed", path, error: String(err) }));
      return new Response("Server error", { status: 500 });
    }
  }
} satisfies ExportedHandler<Env>;

/* One lobby lookup per colo every few seconds, however many people have the landing page open. The cache key
   ignores the query string so nobody can bypass it, and a stale answer costs nothing: it is a hint, and the
   table decides when someone sits down. */
async function openNow(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const key = new Request(new URL("/api/open", request.url).toString());
  const hit = await caches.default.match(key);
  if (hit) return hit;
  const res = Response.json(await env.LOBBY.getByName("lobby").open(), { headers: { "Cache-Control": "public, max-age=5" } });
  ctx.waitUntil(caches.default.put(key, res.clone()));
  return res;
}

/* Short-lived TURN credentials from Cloudflare Realtime when the secrets are set, otherwise free STUN only.
   Most home and mobile networks connect peer to peer with STUN; TURN covers strict corporate or carrier NATs,
   and the room relay covers everything else. */
async function ice(env: Env): Promise<Response> {
  const keyId = (env as { TURN_KEY_ID?: string }).TURN_KEY_ID, token = (env as { TURN_KEY_API_TOKEN?: string }).TURN_KEY_API_TOKEN;
  let iceServers: unknown[] = STUN;
  if (keyId && token) {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: 3600 })
    });
    if (r.ok) iceServers = ((await r.json()) as { iceServers: unknown[] }).iceServers;
    else console.warn(JSON.stringify({ msg: "turn credentials failed", status: r.status }));
  }
  return Response.json({ iceServers }, { headers: { "Cache-Control": "private, max-age=300" } });
}
