import { DurableObject } from "cloudflare:workers";

/* Quick match. Players who are open to a challenger keep one hibernating WebSocket here: someone playing the
   computer with "open to challengers" on, or someone who pressed Quick match and found nobody waiting.
   A player looking for a game asks match() and gets the room code of whoever has waited longest.
   Live public matches are listed here too (live=1), so anyone can browse the tables and watch.

   Nothing is stored: who is waiting lives in the socket attachments, and a closed tab drops out by itself.
   One lobby is plenty until thousands wait at once. Then shard it by game or region (getByName("flick:eu")). */

interface Waiting { code: string; name: string; game: string; since: number; heldUntil: number; live?: boolean; free?: number; players?: number; watching?: number }

const count = (v: unknown): number | undefined => { const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= 99 ? n : undefined; };

const HOLD_MS = 12_000;          // a host offered to one seeker is not offered to another for this long
const CODE = /^[A-HJ-NP-Z2-9]{5}$/;

export class Lobby extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const url = new URL(request.url);
    const code = url.searchParams.get("code") || "";
    if (!CODE.test(code)) return new Response("Bad room code", { status: 400 });
    const game = (url.searchParams.get("game") || "flick").slice(0, 24);
    const live = url.searchParams.get("live") === "1";
    const name = (url.searchParams.get("name") || "Player").slice(0, live ? 60 : 24);
    const f = Number(url.searchParams.get("free"));
    const free = Number.isInteger(f) && f >= 0 && f <= 9 ? f : undefined;   // card tables: computer seats anyone can take
    const players = count(url.searchParams.get("players")), watching = count(url.searchParams.get("watching"));   // people at the game, shown on the landing page
    for (const ws of this.ctx.getWebSockets(code)) ws.close(4009, "replaced");   // one entry per room
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [code, live ? `live:${game}` : `game:${game}`]);
    server.serializeAttachment({ code, name, game, since: Date.now(), heldUntil: 0, live, free, players, watching } satisfies Waiting);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Room code of the longest-waiting open player for this game, or null. */
  async match(game: string, exclude: string[] = []): Promise<{ code: string; name: string } | null> {
    const now = Date.now();
    let best: { ws: WebSocket; w: Waiting } | null = null;
    for (const ws of this.ctx.getWebSockets(`game:${game}`)) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const w = ws.deserializeAttachment() as Waiting;
      if (w.heldUntil > now || exclude.includes(w.code)) continue;
      if (!best || w.since < best.w.since) best = { ws, w };
    }
    if (!best) return null;
    best.ws.serializeAttachment({ ...best.w, heldUntil: now + HOLD_MS });
    return { code: best.w.code, name: best.w.name };
  }

  /** Public matches being played right now, newest first, for the "watch a live game" list. */
  async live(game: string, limit = 20): Promise<{ code: string; title: string; since: number; free?: number; players?: number; watching?: number }[]> {
    return this.ctx.getWebSockets(`live:${game}`)
      .filter(ws => ws.readyState === WebSocket.OPEN)
      .map(ws => ws.deserializeAttachment() as Waiting)
      .sort((a, b) => b.since - a.since)
      .slice(0, limit)
      .map(w => ({ code: w.code, title: w.name, since: w.since, free: w.free, players: w.players, watching: w.watching }));
  }

  /** Players open to a challenger, longest-waiting first. Unlike match() this holds nobody: it is only for showing. */
  async waiting(game: string, limit = 10): Promise<{ code: string; name: string; since: number; watching?: number }[]> {
    return this.ctx.getWebSockets(`game:${game}`)
      .filter(ws => ws.readyState === WebSocket.OPEN)
      .map(ws => ws.deserializeAttachment() as Waiting)
      .sort((a, b) => a.since - b.since)
      .slice(0, limit)
      .map(w => ({ code: w.code, name: w.name, since: w.since, watching: w.watching }));
  }

  /** Everything the landing pages show, in one call: seats to ask for, tables and matches to watch, and players
      waiting for an opponent. Full Whot tables stay listed so people can watch them. */
  async open(): Promise<{
    whot: { tables: { code: string; title: string; free: number; since: number; players?: number; watching?: number }[]; seats: number };
    flick: { waiting: { code: string; name: string; since: number; watching?: number }[]; live: number; matches: { code: string; title: string; since: number; players?: number; watching?: number }[] };
  }> {
    const tables = (await this.live("whot", 60)).map(t => ({ code: t.code, title: t.title, free: t.free ?? 0, since: t.since, players: t.players, watching: t.watching }))
      .sort((a, b) => (b.free > 0 ? 1 : 0) - (a.free > 0 ? 1 : 0) || b.since - a.since);
    const matches = await this.live("flick", 60);
    return {
      whot: { tables: tables.slice(0, 30), seats: tables.reduce((n, t) => n + t.free, 0) },
      flick: { waiting: await this.waiting("flick", 12), live: matches.length, matches: matches.slice(0, 30) }
    };
  }

  /** How many players are open right now, for the "N waiting" hint. */
  async count(game: string): Promise<number> {
    return this.ctx.getWebSockets(`game:${game}`).filter(ws => ws.readyState === WebSocket.OPEN).length;
  }

  /* Pings are answered by the runtime. The only message is a count update, {"t":"n","p":players,"w":watching}, sent when
     someone sits down, leaves or starts watching: it lives in the attachment, so nothing is stored. */
  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    if (typeof msg !== "string" || msg.length > 100 || msg[0] !== "{") return;
    let m: { t?: string; p?: unknown; w?: unknown };
    try { m = JSON.parse(msg); } catch { return; }
    if (m.t !== "n") return;
    const w = ws.deserializeAttachment() as Waiting;
    ws.serializeAttachment({ ...w, players: count(m.p) ?? w.players, watching: count(m.w) ?? w.watching } satisfies Waiting);
  }
  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try { ws.close(code === 1005 ? 1000 : code, reason); } catch { /* already closed */ }
  }
}
