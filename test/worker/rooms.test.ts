import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";

/* Open a WebSocket through the Worker and collect what arrives. */
async function open(path: string) {
  const res = await exports.default.fetch(`https://play.test${path}`, { headers: { Upgrade: "websocket" } });
  const ws = res.webSocket;
  if (!ws) throw new Error(`no websocket: ${res.status}`);
  ws.accept();
  const got: any[] = [];
  let closed: { code: number; reason: string } | null = null;
  const waiters: (() => void)[] = [];
  const wake = () => waiters.splice(0).forEach(f => f());
  ws.addEventListener("message", e => { got.push(typeof e.data === "string" && e.data[0] === "{" ? JSON.parse(e.data) : e.data); wake(); });
  ws.addEventListener("close", e => { closed = { code: e.code, reason: e.reason }; wake(); });
  const until = async (pred: () => boolean, ms = 2000) => {
    const end = Date.now() + ms;
    while (!pred()) { if (Date.now() > end) throw new Error("timed out; got " + JSON.stringify(got) + " closed " + JSON.stringify(closed)); await new Promise<void>(r => { waiters.push(r); setTimeout(r, 50); }); }
  };
  return {
    ws, got, until,
    closed: () => closed,
    next: async (t: string) => { await until(() => got.some(m => m && m.t === t)); return got.find(m => m && m.t === t); },
    send: (m: unknown) => ws.send(typeof m === "string" ? m : JSON.stringify(m))
  };
}

describe("invite room", () => {
  it("host opens, guest knocks, host accepts, then messages relay both ways", async () => {
    const host = await open("/ws/room/ABCDE?role=host&name=Ada");
    await host.next("hosting");
    const guest = await open("/ws/room/abcde?role=guest&name=Sam");   // codes are case-insensitive
    const knock = await host.next("knock");
    expect(knock.name).toBe("Sam");
    expect((await guest.next("knocking")).host).toBe("Ada");
    host.send({ t: "accept", gid: knock.gid });
    expect((await guest.next("accepted")).host).toBe("Ada");
    host.send({ t: "offer", sdp: "x" });
    expect((await guest.next("offer")).sdp).toBe("x");
    guest.send({ t: "in", n: [0, 1] });
    expect((await host.next("in")).n).toEqual([0, 1]);
  });

  it("a guest cannot talk to the host before being accepted", async () => {
    const host = await open("/ws/room/FGHJK?role=host");
    await host.next("hosting");
    const guest = await open("/ws/room/FGHJK?role=guest");
    await host.next("knock");
    guest.send({ t: "offer", sdp: "sneaky" });
    await new Promise(r => setTimeout(r, 150));
    expect(host.got.some(m => m.t === "offer")).toBe(false);
  });

  it("knocking on a code nobody holds waits, and knocks as soon as the host opens it", async () => {
    const guest = await open("/ws/room/ZZZZZ?role=guest&name=Sam");
    await guest.next("waiting");
    expect(guest.closed()).toBe(null);
    const host = await open("/ws/room/ZZZZZ?role=host&name=Ada");
    await host.next("hosting");
    expect((await host.next("knock")).name).toBe("Sam");
    expect((await guest.next("knocking")).host).toBe("Ada");
  });

  it("a host whose connection drops keeps the code: a link sent meanwhile waits, then gets in", async () => {
    const h1 = await open("/ws/room/DRPAA?role=host&name=Ada&hid=hostid0001");
    await h1.next("hosting");
    const watcher = await open("/ws/room/DRPAA?role=watch");
    await watcher.next("watchers");
    h1.ws.close(4000, "dropped");                       // not 1000/1001: the phone went to another app
    await watcher.next("waiting");
    const guest = await open("/ws/room/DRPAA?role=guest&name=Sam");
    await guest.next("waiting");
    const h2 = await open("/ws/room/DRPAA?role=host&name=Ada&hid=hostid0001");
    await h2.next("hosting");
    expect((await h2.next("knock")).name).toBe("Sam");
    expect((await h2.next("watchers")).join).toBe(true);   // the watcher asks the new connection for a keyframe
    expect(watcher.closed()).toBe(null);
  });

  it("the same host on a fresh connection replaces a stale one; a different host is still refused", async () => {
    const h1 = await open("/ws/room/RPLAA?role=host&hid=hostid0002");
    await h1.next("hosting");
    const watcher = await open("/ws/room/RPLAA?role=watch");
    await watcher.next("watchers");
    const other = await open("/ws/room/RPLAA?role=host&hid=someoneels");
    await other.until(() => other.closed() !== null);
    expect(other.closed()!.code).toBe(4009);
    const h2 = await open("/ws/room/RPLAA?role=host&hid=hostid0002");
    await h2.next("hosting");
    await h1.until(() => h1.closed() !== null);
    expect(h1.closed()!.code).toBe(4011);
    await new Promise(r => setTimeout(r, 100));
    expect(watcher.closed()).toBe(null);                // a replacement is not the host leaving
    h2.send({ t: "wk", n: 1 });
    expect((await watcher.next("wk")).n).toBe(1);
  });

  it("a host leaving on purpose sends everyone away", async () => {
    const host = await open("/ws/room/LVEAA?role=host");
    await host.next("hosting");
    const watcher = await open("/ws/room/LVEAA?role=watch");
    await watcher.next("watchers");
    const guest = await open("/ws/room/LVEAA?role=guest");
    await host.next("knock");
    host.ws.close(1000, "bye");
    await watcher.until(() => watcher.closed() !== null);
    await guest.until(() => guest.closed() !== null);
    expect(watcher.closed()!.code).toBe(4001);
    expect(guest.closed()!.code).toBe(4001);
  });

  it("a host with no side free turns a knock into watching (full), and the host hears a guest who gave up", async () => {
    const host = await open("/ws/room/FULAA?role=host");
    await host.next("hosting");
    const g1 = await open("/ws/room/FULAA?role=guest");
    const k1 = await host.next("knock");
    host.send({ t: "decline", gid: k1.gid, full: true });
    await g1.until(() => g1.closed() !== null);
    expect(g1.closed()!.code).toBe(4010);
    const g2 = await open("/ws/room/FULAA?role=guest");
    const k2 = (await host.until(() => host.got.filter(m => m.t === "knock").length === 2), host.got.filter(m => m.t === "knock")[1]);
    g2.ws.close(1000);
    await host.until(() => host.got.some(m => m.t === "peer-left" && m.gid === k2.gid && m.wasIn === false));
  });

  it("after a drop, the guest who was playing stays in only if the host still has them", async () => {
    const h1 = await open("/ws/room/KEPAA?role=host&hid=hostid0003");
    await h1.next("hosting");
    const guest = await open("/ws/room/KEPAA?role=guest&name=Sam");
    const k = await h1.next("knock");
    h1.send({ t: "accept", gid: k.gid });
    await guest.next("accepted");
    h1.ws.close(4000, "dropped");
    const h2 = await open(`/ws/room/KEPAA?role=host&hid=hostid0003&in=${k.gid}`);
    await h2.next("hosting");
    await new Promise(r => setTimeout(r, 100));
    expect(guest.closed()).toBe(null);
    guest.send({ t: "in", n: [1] });
    expect((await h2.next("in")).n).toEqual([1]);
    h2.ws.close(4000, "dropped");
    const h3 = await open("/ws/room/KEPAA?role=host&hid=hostid0003");   // the direct link died meanwhile: no in=
    await h3.next("hosting");
    await guest.until(() => guest.closed() !== null);
    expect(guest.closed()!.code).toBe(4001);
  });

  it("a second host for a held code is refused", async () => {
    const a = await open("/ws/room/MNPQR?role=host"); await a.next("hosting");
    const b = await open("/ws/room/MNPQR?role=host");
    await b.until(() => b.closed() !== null);
    expect(b.closed()!.code).toBe(4009);
  });

  it("a room that is already playing turns away a third player", async () => {
    const host = await open("/ws/room/STUVW?role=host"); await host.next("hosting");
    const g1 = await open("/ws/room/STUVW?role=guest");
    host.send({ t: "accept", gid: (await host.next("knock")).gid });
    await g1.next("accepted");
    const g2 = await open("/ws/room/STUVW?role=guest");
    await g2.until(() => g2.closed() !== null);
    expect(g2.closed()!.code).toBe(4010);
  });

  it("the host hears when the guest leaves (so the computer can take over)", async () => {
    const host = await open("/ws/room/XYZ23?role=host"); await host.next("hosting");
    const g = await open("/ws/room/XYZ23?role=guest");
    host.send({ t: "accept", gid: (await host.next("knock")).gid });
    await g.next("accepted");
    g.ws.close(1000, "bye");
    expect((await host.next("peer-left")).wasIn).toBe(true);
  });

  it("stays hibernation-friendly: auto ping/pong, no alarms, nothing stored", async () => {
    const host = await open("/ws/room/H2345?role=host"); await host.next("hosting");
    await runInDurableObject(env.ROOM.getByName("H2345"), async (_inst, state) => {
      expect(state.getWebSocketAutoResponse()?.request).toBe("ping");
      expect(await state.storage.getAlarm()).toBeNull();
      expect(state.storage.sql.databaseSize).toBeLessThan(16 * 1024);   // empty database
      for (const ws of state.getWebSockets()) expect(JSON.stringify(ws.deserializeAttachment()).length).toBeLessThan(256);
    });
  });
});

describe("spectators", () => {
  it("watchers get the host's feed, and only the feed; counts reach the host", async () => {
    const host = await open("/ws/room/WATCH?role=host&name=Ada"); await host.next("hosting");
    const guest = await open("/ws/room/WATCH?role=guest&name=Sam");
    host.send({ t: "accept", gid: (await host.next("knock")).gid }); await guest.next("accepted");

    const w1 = await open("/ws/room/WATCH?role=watch");
    const joined = await host.next("watchers");
    expect(joined).toMatchObject({ n: 1, join: true });
    const w2 = await open("/ws/room/WATCH?role=watch");
    await host.until(() => host.got.some(m => m.t === "watchers" && m.n === 2));

    host.send({ t: "wk", ft: 0, state: { x: 1 } });
    host.send({ t: "in", n: [1] });                       // game traffic for the guest, not for watchers
    expect((await w1.next("wk")).ft).toBe(0);
    expect((await w2.next("wk")).ft).toBe(0);
    await guest.next("in");
    expect(w1.got.some(m => m.t === "in")).toBe(false);
    expect(guest.got.some(m => m.t === "wk")).toBe(false);

    w1.send({ t: "in", n: [9] });                         // watchers cannot talk to anyone
    await new Promise(r => setTimeout(r, 100));
    expect(host.got.filter(m => m.t === "in").length).toBe(0);
    expect(guest.got.filter(m => m.t === "in").length).toBe(1);

    w2.ws.close(1000);
    await host.until(() => host.got.some(m => m.t === "watchers" && m.n === 1 && !m.join));
    host.ws.close(1000);
    await w1.until(() => w1.closed() !== null);
    expect(w1.closed()!.code).toBe(4001);
  });

  it("watchers can send reactions, only real ones, rate-limited, to the host and the other watchers", async () => {
    const host = await open("/ws/room/RCTRC?role=host"); await host.next("hosting");
    const w1 = await open("/ws/room/RCTRC?role=watch"), w2 = await open("/ws/room/RCTRC?role=watch");
    await host.until(() => host.got.some(m => m.t === "watchers" && m.n === 2));
    w1.send({ t: "wr", r: "clap" });
    w1.send({ t: "wr", r: "cheer" });                      // too soon: dropped
    w1.send({ t: "wr", r: "<script>" });
    expect((await host.next("wr")).r).toBe("clap");
    expect((await w2.next("wr")).r).toBe("clap");
    await new Promise(r => setTimeout(r, 350));
    w1.send({ t: "wr", r: "evil", x: 1 });
    w1.send({ t: "wr", r: "ooh", extra: "x".repeat(10) });
    await host.until(() => host.got.filter(m => m.t === "wr").length >= 2);
    const got = host.got.filter(m => m.t === "wr");
    expect(got.map(m => m.r)).toEqual(["clap", "ooh"]);
    expect(Object.keys(got[1])).toEqual(["t", "r"]);
    expect(w1.got.some(m => m.t === "wr")).toBe(false);    // the sender plays its own reaction locally
  });

  it("watching a table nobody holds waits for it", async () => {
    const w = await open("/ws/room/NQNQN?role=watch");
    await w.next("waiting");
    expect(w.closed()).toBe(null);
  });

  it("public live matches are listed, newest first, and are never offered as opponents", async () => {
    const a = await open("/ws/lobby?code=LVAAA&name=Ada%20v%20Sam&game=flick2&live=1");
    await new Promise(r => setTimeout(r, 20));
    const b = await open("/ws/lobby?code=LVBBB&name=Kim%20v%20Lee&game=flick2&live=1");
    const list = await (await exports.default.fetch("https://play.test/api/live?game=flick2")).json<any[]>();
    expect(list.map(t => t.code)).toEqual(["LVBBB", "LVAAA"]);
    expect(list[1].title).toBe("Ada v Sam");
    const m = await (await exports.default.fetch("https://play.test/api/match?game=flick2")).json<any>();
    expect(m.code).toBeNull();
    a.ws.close(); b.ws.close();
  });
});

describe("quick match", () => {
  it("gives a seeker the longest-waiting open player, and does not offer them twice at once", async () => {
    const r0 = await (await exports.default.fetch("https://play.test/api/match?game=flick")).json<any>();
    expect(r0.code).toBeNull();
    const first = await open("/ws/lobby?code=AAAAA&name=First&game=flick");
    await new Promise(r => setTimeout(r, 20));
    const second = await open("/ws/lobby?code=BBBBB&name=Second&game=flick");
    const m1 = await (await exports.default.fetch("https://play.test/api/match?game=flick")).json<any>();
    expect(m1).toEqual({ code: "AAAAA", name: "First" });
    const m2 = await (await exports.default.fetch("https://play.test/api/match?game=flick")).json<any>();
    expect(m2.code).toBe("BBBBB");                       // First is held for the first seeker
    const m3 = await (await exports.default.fetch("https://play.test/api/match?game=flick&exclude=AAAAA,BBBBB")).json<any>();
    expect(m3.code).toBeNull();
    first.ws.close(); second.ws.close();
  });

  it("a closed tab drops out of the queue on its own", async () => {
    const w = await open("/ws/lobby?code=CCCCC&game=other");
    w.ws.close(1000);
    await new Promise(r => setTimeout(r, 100));
    const m = await (await exports.default.fetch("https://play.test/api/match?game=other")).json<any>();
    expect(m.code).toBeNull();
  });
});

describe("ice servers", () => {
  it("always offers free STUN", async () => {
    const r = await (await exports.default.fetch("https://play.test/api/ice")).json<any>();
    expect(JSON.stringify(r.iceServers)).toContain("stun:stun.cloudflare.com");
  });
});
