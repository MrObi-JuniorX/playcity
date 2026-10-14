import { DurableObject } from "cloudflare:workers";

/* One Room per invite code. It introduces two players and then gets out of the way:
   - the host holds the room open (while playing the computer, or on the setup screen),
   - a guest knocks, the host accepts, and the two exchange WebRTC offers through here,
   - after that they talk peer to peer. Only if WebRTC cannot connect does game traffic relay through this room,
   - spectators join as "watch": the host sends one light feed of confirmed moves (messages starting {"t":"w"),
     and the room fans it out to every watcher. Watchers only listen, apart from reactions: a clap, a cheer or
     an ooh, at most a few a second each, which the room passes to the host and the other watchers.
   Nothing is stored. All state lives in the WebSocket attachments, so the room hibernates between messages and an
   idle room costs nothing. Pings are answered by the runtime without waking it. */

type Role = "host" | "guest" | "watch";
interface Peer { role: Role; id: string; name: string; in: boolean }

const MAX_MSG = 64 * 1024;
const GUEST_LIMIT = 4;            // knocks waiting at once
const WATCH_LIMIT = 500;          // spectators per table
const REACTIONS = new Set(["clap", "cheer", "ooh"]);
const REACT_GAP_MS = 300;         // per watcher; extra taps are dropped

export class Room extends DurableObject<Env> {
  private lastReact = new WeakMap<WebSocket, number>();   // in memory only: losing it on hibernation is harmless

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const url = new URL(request.url);
    const r = url.searchParams.get("role");
    const role: Role = r === "host" ? "host" : r === "watch" ? "watch" : "guest";
    const name = (url.searchParams.get("name") || "Player").slice(0, 24);
    const id = crypto.randomUUID().slice(0, 8);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const host = this.host();
    let reject: [number, string] | null = null;
    if (role === "host" && host) reject = [4009, "taken"];
    if (role === "guest" && !host) reject = [4004, "no-host"];
    if (role === "guest" && host && this.peers("guest").length >= GUEST_LIMIT) reject = [4010, "busy"];
    if (role === "guest" && host && this.peers("guest").some(p => this.peer(p).in)) reject = [4010, "busy"];
    if (role === "watch" && !host) reject = [4004, "no-host"];
    if (role === "watch" && host && this.peers("watch").length >= WATCH_LIMIT) reject = [4010, "full"];

    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, id, name, in: role === "host" } satisfies Peer);
    if (reject) {
      server.close(reject[0], reject[1]);
    } else if (role === "host") {
      server.send(JSON.stringify({ t: "hosting", id }));
    } else if (role === "watch") {
      this.watchers(true);
    } else if (host) {
      host.send(JSON.stringify({ t: "knock", gid: id, name }));
      server.send(JSON.stringify({ t: "knocking", host: this.peer(host).name }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || raw.length > MAX_MSG) return;
    const me = this.peer(ws);
    if (me.role === "host") {
      // Control messages from the host are about one guest; everything else goes to the guest who is in.
      const head = raw.slice(0, 40);
      if (head.includes('"t":"accept"') || head.includes('"t":"decline"')) {
        let m: { t: string; gid?: string };
        try { m = JSON.parse(raw); } catch { return; }
        const g = this.peers("guest").find(p => this.peer(p).id === m.gid);
        if (!g) return;
        if (m.t === "accept") {
          for (const other of this.peers("guest")) if (other !== g) other.close(4010, "busy");
          g.serializeAttachment({ ...this.peer(g), in: true });
          g.send(JSON.stringify({ t: "accepted", host: me.name }));
        } else g.close(4003, "declined");
        return;
      }
      if (raw.startsWith('{"t":"w')) { for (const w of this.peers("watch")) w.send(raw); return; }
      for (const g of this.peers("guest")) if (this.peer(g).in) g.send(raw);
    } else if (me.role === "watch") {
      if (!raw.startsWith('{"t":"wr"') || raw.length > 64) return;
      let r: unknown;
      try { r = (JSON.parse(raw) as { r?: unknown }).r; } catch { return; }
      if (typeof r !== "string" || !REACTIONS.has(r)) return;
      const now = Date.now();
      if (now - (this.lastReact.get(ws) ?? 0) < REACT_GAP_MS) return;
      this.lastReact.set(ws, now);
      const msg = JSON.stringify({ t: "wr", r });          // re-built, so nothing else rides along
      this.host()?.send(msg);
      for (const w of this.peers("watch")) if (w !== ws) w.send(msg);
    } else if (me.role === "guest" && me.in) {
      this.host()?.send(raw);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const me = this.peer(ws);
    if (me.role === "host") {
      for (const g of this.peers("guest")) g.close(4001, "host-left");
      for (const w of this.peers("watch")) w.close(4001, "host-left");
    } else if (me.role === "watch") {
      this.watchers(false);
    } else {
      this.host()?.send(JSON.stringify({ t: "peer-left", gid: me.id, wasIn: me.in }));
    }
    try { ws.close(code === 1005 ? 1000 : code, reason); } catch { /* already closed */ }
  }

  async webSocketError(ws: WebSocket): Promise<void> { await this.webSocketClose(ws, 1011, "error"); }

  /** Tell the host and every watcher how many are watching. join: a new watcher needs a keyframe. */
  private watchers(join: boolean): void {
    const n = this.peers("watch").length, msg = JSON.stringify({ t: "watchers", n, join });
    this.host()?.send(msg);
    for (const w of this.peers("watch")) w.send(msg);
  }

  private peers(role: Role): WebSocket[] {
    return this.ctx.getWebSockets(role).filter(w => w.readyState === WebSocket.OPEN);
  }
  private host(): WebSocket | undefined { return this.peers("host")[0]; }
  private peer(ws: WebSocket): Peer { return ws.deserializeAttachment() as Peer; }
}
