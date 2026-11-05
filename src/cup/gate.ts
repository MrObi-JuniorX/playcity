import { DurableObject } from "cloudflare:workers";
import type { AuthEnv } from "../auth/env";
import { notifyOffline, type Note } from "../push/notify";

/* CupGate: the hub connection players keep open during a cup (docs/whot-cup-prd.md, section 7, Phase 7). There are
   GATE_SHARDS gates per cup, and a player always lands on the same one (shardOf). The director tells each gate, in one
   call per slot, what its players need to hear: "your table is ready", how their table went and any Second Chance
   offer, the cup's state. A player with the hub open gets it at once over the socket. A player without one gets
   it as a Web Push (and, for check-in only, an SMS if they asked for one).

   Gates stay storage-free: everything a gate knows lives in socket attachments, so an idle gate hibernates for free
   (enforced by scripts/cf-lint.sh). One hub connection per player (ID-5): a second device takes over, and the first
   is told and closed. */

export const GATE_SHARDS = 32;
const MAX_SOCKETS = 2000;          // ≈ 625 per shard at 20,000 players; this is the hard stop

/** Which gate a player's hub connection lives on. FNV-1a, so it is the same everywhere and needs no lookup. */
export function shardOf(player: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < player.length; i++) { h ^= player.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0) % GATE_SHARDS;
}
export const gateName = (cupId: string, shard: number) => `${cupId}:${shard}`;

/** One thing to tell one player. `note` is what a notification says when they have no hub open; `sms` (check-in
    only, opted-in players only) is texted instead when they have neither the hub nor push. */
export interface GateEvent { player: string; msg: Record<string, unknown>; note?: Note; sms?: string }

interface Conn { player: string; at: number }

export class CupGate extends DurableObject<AuthEnv> {
  constructor(ctx: DurableObjectState, env: AuthEnv) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** A hub connection. The Worker route has checked the session; the player comes from it, never the browser. */
  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const player = req.headers.get("X-Cup-Player");
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    if (!player) { server.close(4001, "signed-out"); return new Response(null, { status: 101, webSocket: client }); }
    if (this.ctx.getWebSockets().length > MAX_SOCKETS) { server.close(4010, "full"); return new Response(null, { status: 101, webSocket: client }); }
    for (const w of this.ctx.getWebSockets()) {
      if (w === server || (w.deserializeAttachment() as Conn | null)?.player !== player) continue;
      this.send(w, { t: "moved" });
      try { w.close(4012, "moved"); } catch { /* gone */ }
    }
    server.serializeAttachment({ player, at: Date.now() } satisfies Conn);
    this.send(server, { t: "hello" });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(): Promise<void> { /* the hub only listens; "ping" is answered without waking the gate */ }
  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try { ws.close(code === 1005 ? 1000 : code, reason); } catch { /* already closed */ }
  }

  /** From the director: personal events, and optionally one message for everyone on this gate. Players with the hub
      open get theirs now; the rest are notified after this returns, so the director never waits on push services. */
  async deliver(events: GateEvent[], all?: Record<string, unknown>): Promise<{ live: number; offline: number }> {
    const by = new Map<string, WebSocket[]>();
    for (const w of this.ctx.getWebSockets()) {
      const c = w.deserializeAttachment() as Conn | null;
      if (!c || w.readyState !== WebSocket.OPEN) continue;
      (by.get(c.player) ?? by.set(c.player, []).get(c.player)!).push(w);
    }
    if (all) { const s = JSON.stringify(all); for (const ws of by.values()) for (const w of ws) this.sendRaw(w, s); }
    const offline: GateEvent[] = [];
    let live = 0;
    for (const e of events) {
      const ws = by.get(e.player);
      if (ws?.length) { live++; const s = JSON.stringify(e.msg); for (const w of ws) this.sendRaw(w, s); }
      else if (e.note || e.sms) offline.push(e);
    }
    if (offline.length) this.ctx.waitUntil(notifyOffline(this.env, offline).catch(err => console.warn(JSON.stringify({ msg: "gate notify failed", error: String(err) }))));
    return { live, offline: offline.length };
  }

  /** Who is connected here (tests and the console's connection counts). */
  async connected(): Promise<string[]> { return this.ctx.getWebSockets().map(w => (w.deserializeAttachment() as Conn | null)?.player).filter((p): p is string => !!p); }

  private send(ws: WebSocket, o: unknown) { this.sendRaw(ws, JSON.stringify(o)); }
  private sendRaw(ws: WebSocket, s: string) { try { ws.send(s); } catch { /* closing */ } }
}
