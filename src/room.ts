import { DurableObject } from "cloudflare:workers";

/* One Room per invite code. It introduces two players and then gets out of the way:
   - the host holds the room open (while playing the computer, or on the setup screen),
   - a guest knocks, the host accepts, and the two exchange WebRTC offers through here,
   - after that they talk peer to peer. Only if WebRTC cannot connect does game traffic relay through this room,
   - spectators join as "watch": the host sends one light feed of confirmed moves (messages starting {"t":"w"),
     and the room fans it out to every watcher. Watchers only listen, apart from reactions: a clap, a cheer or
     an ooh, at most a few a second each, which the room passes to the host and the other watchers.
   The host's connection can drop without the host leaving: a phone switching to WhatsApp to send the invite link
   loses it within seconds. So the code stays good. A guest or watcher who arrives while the host is away waits
   ({"t":"waiting"}) and is let in when the host is back; the host reconnects with the same code and its own host
   id (hid), which also replaces a stale connection the room still thinks is open. Only a deliberate leave (close
   code 1000, or 1001 when the tab closes) sends everyone away.
   A guest can carry a rejoin token (rj): a random id their tab keeps for this code. The room only passes it on with
   the knock, so a host whose opponent dropped can tell that player knocking again and let them straight back in.
   The same token on a new connection also replaces the guest's old one, as hid does for the host: a phone that lost
   signal often leaves a socket that never says it closed, and it must not keep the guest's place as "busy".
   Nothing is stored. All state lives in the WebSocket attachments, so the room hibernates between messages and an
   idle room costs nothing. Pings are answered by the runtime without waking it. */

type Role = "host" | "guest" | "watch";
interface Peer { role: Role; id: string; name: string; in: boolean; hid?: string; rj?: string; gone?: boolean }   // gone: replaced, already reported

const HID = /^[A-Za-z0-9]{6,32}$/;
const LEFT = new Set([1000, 1001]);   // close codes that mean the host meant to go

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

    const qh = url.searchParams.get("hid") || "", hid = HID.test(qh) ? qh : undefined;
    const qr = url.searchParams.get("rj") || "", rj = role === "guest" && HID.test(qr) ? qr : undefined;
    const host = this.host();
    const same = role === "host" && !!host && !!hid && this.peer(host).hid === hid;   // the host again, on a fresh connection
    // The same guest tab on a new connection: the old one goes now, and the host hears so before the new knock.
    if (rj) for (const g of this.peers("guest")) {
      const p = this.peer(g);
      if (p.rj !== rj) continue;
      g.serializeAttachment({ ...p, in: false, gone: true });
      try { g.close(4011, "replaced"); } catch { /* already gone */ }
      host?.send(JSON.stringify({ t: "peer-left", gid: p.id, wasIn: p.in }));
    }
    let reject: [number, string] | null = null;
    if (role === "host" && host && !same) reject = [4009, "taken"];
    if (role === "guest" && this.peers("guest").length >= GUEST_LIMIT) reject = [4010, "busy"];
    if (role === "guest" && this.peers("guest").some(p => this.peer(p).in)) reject = [4010, "busy"];
    if (role === "watch" && this.peers("watch").length >= WATCH_LIMIT) reject = [4010, "full"];

    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, id, name, in: role === "host", hid: role === "host" ? hid : undefined, rj } satisfies Peer);
    if (reject) {
      server.close(reject[0], reject[1]);
    } else if (role === "host") {
      if (same) host!.close(4011, "replaced");
      // A guest who was playing before the drop stays in only if the host still has them (in=gid); others waiting knock now.
      const keep = url.searchParams.get("in") || "";
      for (const g of this.peers("guest")) {
        const p = this.peer(g);
        if (p.in && p.id !== keep) g.close(4001, "host-left");
      }
      server.send(JSON.stringify({ t: "hosting", id }));
      for (const g of this.peers("guest")) {
        const p = this.peer(g);
        if (p.in) continue;
        server.send(JSON.stringify({ t: "knock", gid: p.id, name: p.name, rj: p.rj }));
        g.send(JSON.stringify({ t: "knocking", host: name }));
      }
      if (this.peers("watch").length) this.watchers(true);     // they need a keyframe from this connection
    } else if (!host) {
      server.send(JSON.stringify({ t: "waiting" }));             // nobody holds the code right now: wait for them
      if (role === "watch") this.watchers(false);
    } else if (role === "watch") {
      this.watchers(true);
    } else {
      host.send(JSON.stringify({ t: "knock", gid: id, name, rj }));
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
        let m: { t: string; gid?: string; full?: boolean };
        try { m = JSON.parse(raw); } catch { return; }
        const g = this.peers("guest").find(p => this.peer(p).id === m.gid);
        if (!g) return;
        if (m.t === "accept") {
          for (const other of this.peers("guest")) if (other !== g) other.close(4010, "busy");
          g.serializeAttachment({ ...this.peer(g), in: true });
          g.send(JSON.stringify({ t: "accepted", host: me.name }));
        } else if (m.full) g.close(4010, "full");          // no side free for them: they watch instead
        else g.close(4003, "declined");
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
      if (this.peers("host").some(w => w !== ws)) { /* replaced by the same host's new connection */ }
      else if (LEFT.has(code)) {
        for (const g of this.peers("guest")) g.close(4001, "host-left");
        for (const w of this.peers("watch")) w.close(4001, "host-left");
      } else {
        // Dropped, not left: everyone waits for the host to reconnect. A guest who was playing hears through their
        // direct link (or its silence) whether the match goes on.
        const away = JSON.stringify({ t: "waiting" });
        for (const g of this.peers("guest")) if (!this.peer(g).in) g.send(away);
        for (const w of this.peers("watch")) w.send(away);
      }
    } else if (me.role === "watch") {
      this.watchers(false);
    } else if (!me.gone) {
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
