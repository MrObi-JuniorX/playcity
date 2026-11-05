import { env, exports } from "cloudflare:workers";
import { describe, it, expect, vi, afterEach } from "vitest";
import * as W from "../../public/whot/engine.js";
import { encrypt } from "../../src/auth/crypto";
import { DB, director, makeCup, bulkPlayers, bulkEnter, sessionsFor } from "./cupkit";
import { call, signIn } from "./helpers";
import type { CupConfig } from "../../src/cup/config";

/* Phase 7 (docs/whot-cup-prd.md PX-4, section 7): the hub. Gates carry "your table is ready", results and Second
   Chance offers to players who have the hub open, in one call per gate per slot; players who don't get a Web Push
   (and, for check-in only, an SMS if they asked). */

const ORIGIN = "https://play.test";
const KEY = (env as unknown as { PHONE_ENC_KEY: string }).PHONE_ENC_KEY;

async function wsOpen(path: string, o: { cookie?: string; origin?: string | null } = {}) {
  const headers: Record<string, string> = { Upgrade: "websocket" };
  if (o.origin !== null) headers.Origin = o.origin ?? ORIGIN;
  if (o.cookie) headers.Cookie = o.cookie;
  const res = await exports.default.fetch(`${ORIGIN}${path}`, { headers });
  const ws = res.webSocket;
  const got: any[] = [];
  let closed: { code: number; reason: string } | null = null;
  const waiters: (() => void)[] = [];
  const wake = () => waiters.splice(0).forEach(f => f());
  if (ws) {
    ws.accept();
    ws.addEventListener("message", e => { got.push(JSON.parse(String(e.data))); wake(); });
    ws.addEventListener("close", e => { closed = { code: e.code, reason: e.reason }; wake(); });
  }
  const until = async (pred: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (!pred()) { if (Date.now() > end) throw new Error(`timed out on ${path}; got ${JSON.stringify(got).slice(0, 300)} closed ${JSON.stringify(closed)}`); await new Promise<void>(r => { waiters.push(r); setTimeout(r, 50); }); }
  };
  return { status: res.status, ws: ws!, got, until, closed: () => closed, send: (m: unknown) => ws!.send(JSON.stringify(m)) };
}
type Sock = Awaited<ReturnType<typeof wsOpen>>;
const hub = (slug: string, cookie?: string) => wsOpen(`/ws/cup/${slug}/hub`, { cookie });

function bot(s: Sock) {
  let sent = -1;
  const act = (m: any) => {
    if (m.you == null || !m.v || m.v.over || m.v.current !== m.you || m.v.turns === sent) return;
    sent = m.v.turns;
    const mv = W.aiMove(W.hydrate(m.v));
    s.send(mv.type === "play" ? { t: "play", ids: ([] as number[]).concat(mv.cardId), shape: mv.shape, turn: m.v.turns } : { t: "market", turn: m.v.turns });
  };
  s.ws.addEventListener("message", e => { const m = JSON.parse(String(e.data)); if (m.t === "nope") sent = -1; else if (m.v) act(m); });
  const had = s.got.findLast(m => m.v); if (had) act(had);
}

/** A cup in external mode, running, slot 1 not yet seated. */
async function runningCup(over: Partial<CupConfig> = {}, N = 16, checkedIn = true) {
  const cup = await makeCup({ capacity: N, minEntries: 4, expectedEntries: N, ...over }, "external");
  const ids = await bulkPlayers(N, 10_000);
  await bulkEnter(cup, ids, checkedIn);
  const cookies = await sessionsFor(ids);
  return { cup, ids, cookies, d: director(cup.id), c: cup.c };
}

afterEach(() => vi.restoreAllMocks());

describe("the hub", () => {
  it("tells every seated player their table (with a seat token that works), then their result and any offer, one call per gate", async () => {
    const { cup, ids, cookies, d, c } = await runningCup();
    await d.tick(c.registrationClosesAt); await d.tick(c.startsAt - 300_000);
    const hubs = new Map<string, Sock>();
    for (const p of ids) hubs.set(p, await hub(cup.slug, cookies.get(p)));
    await Promise.all([...hubs.values()].map(h => h.until(() => h.got.some(m => m.t === "hello"))));
    await d.rowsWritten();
    await d.tick(c.startsAt);                                                   // slot 1 is seated
    expect((await d.rowsWritten()).gates).toBe(32);                             // one call per gate for the whole slot
    await Promise.all([...hubs.values()].map(h => h.until(() => h.got.some(m => m.t === "table"))));
    const tables = await d.tables(1);
    for (const p of ids) {
      const m = hubs.get(p)!.got.find(x => x.t === "table");
      const t = tables.find(x => x.code === m.code)!;
      expect(t.players[m.seat]).toBe(p);
      expect(m).toMatchObject({ slot: 1, draw: "W", pay1: t.pay1, pay2: t.pay2 });
    }
    for (const h of hubs.values()) expect(h.got.some(m => m.t === "live")).toBe(true);    // and the cup's progress

    // Play one table on the tokens the hub gave out.
    const t = tables[0];
    const socks = await Promise.all(t.players.map(p => wsOpen(`/ws/cup/${cup.slug}/${t.code}?token=${encodeURIComponent(hubs.get(p)!.got.find(x => x.t === "table").token)}`, { cookie: cookies.get(p) })));
    socks.forEach(bot);
    await Promise.all(t.players.map(p => hubs.get(p)!.until(() => hubs.get(p)!.got.some(m => m.t === "result"), 30_000)));
    const places = (await d.tables(1)).find(x => x.code === t.code)!.result!;
    places.forEach((p, i) => {
      const r = hubs.get(p)!.got.find(m => m.t === "result");
      expect(r).toMatchObject({ code: t.code, place: i + 1, of: 4, pay: i === 0 ? t.pay1 : i === 1 ? t.pay2 : 0, through: i < 2 });
      if (i < 2) expect(r.offer).toBeNull();
      else expect(r.offer).toMatchObject({ fee: c.scFee, payFromWinnings: c.scPayFromWinnings });       // first-time losers, round 1
    });
    expect((await d.rowsWritten()).gates).toBeLessThanOrEqual(4);               // a table's result: only its players' gates
    // Nobody at another table heard about it.
    const others = ids.filter(p => !t.players.includes(p));
    for (const p of others) expect(hubs.get(p)!.got.some(m => m.t === "result")).toBe(false);
  }, 60_000);

  it("a second device takes over the hub; the first is told and closed", async () => {
    const { cup, ids, cookies } = await runningCup({}, 8);
    const one = await hub(cup.slug, cookies.get(ids[0]));
    await one.until(() => one.got.some(m => m.t === "hello"));
    const two = await hub(cup.slug, cookies.get(ids[0]));
    await two.until(() => two.got.some(m => m.t === "hello"));
    await one.until(() => one.closed()?.code === 4012);
    expect(one.got.some(m => m.t === "moved")).toBe(true);
    expect(two.closed()).toBeNull();
  });

  it("refuses the signed out, other sites and unknown cups", async () => {
    const { cup, ids, cookies } = await runningCup({}, 8);
    expect((await hub(cup.slug)).status).toBe(401);
    expect((await wsOpen(`/ws/cup/${cup.slug}/hub`, { cookie: cookies.get(ids[0]), origin: "https://evil.test" })).status).toBe(403);
    expect((await hub("no-such-cup", cookies.get(ids[0]))).status).toBe(404);
  });
});

describe("notifications for players without the hub open", () => {
  it("a player who closed the app gets the table as a Web Push; a dead subscription is deleted", async () => {
    const { cup, ids, d, c } = await runningCup({}, 16);
    const [a] = ids, now = Date.now();
    const sub = (end: string) => ({ id: `sub-${end}-${a}`, endpoint: `https://fcm.googleapis.com/fcm/send/${end}-${a}` });
    const keys = { p256dh: "BNQzQ87CMRpZNToIOCtwDlTwTvjmAds6ZbCxMKbLaV8sAUNCEzNBEgpVteopf02X2Dq1my0Dt843j8zD539pEJo", auth: "c2l4dGVlbi1ieXRlcy0hIQ" };
    for (const s of [sub("live"), sub("gone")]) await DB.prepare("INSERT INTO push_subs (id, player_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(s.id, a, s.endpoint, keys.p256dh, keys.auth, now).run();
    const sent: { url: string; headers: Headers; body: Uint8Array }[] = [];
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith("https://fcm.googleapis.com/")) return real(input as RequestInfo, init);
      sent.push({ url, headers: new Headers(init?.headers), body: new Uint8Array(init?.body as ArrayBuffer) });
      return new Response(null, { status: url.includes("/gone-") ? 410 : 201 });
    });
    await d.tick(c.registrationClosesAt); await d.tick(c.startsAt - 300_000); await d.tick(c.startsAt);
    const deadline = Date.now() + 5000;
    while (sent.length < 2 && Date.now() < deadline) await new Promise(r => setTimeout(r, 30));
    expect(sent.map(x => x.url).sort()).toEqual([sub("gone").endpoint, sub("live").endpoint].sort());
    for (const x of sent) {
      expect(x.headers.get("Content-Encoding")).toBe("aes128gcm");
      expect(x.headers.get("Authorization")).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=BNQzQ87C/);
      expect(x.body.length).toBeGreaterThan(86);                                // salt, record size, key, and a sealed payload
      expect(new TextDecoder().decode(x.body)).not.toContain("table");          // the push service can't read it
    }
    await expect.poll(async () => (await DB.prepare("SELECT id FROM push_subs WHERE player_id = ?").bind(a).all()).results.map(r => r.id)).toEqual([sub("live").id]);
    expect(ids.length).toBe(16);
  });

  it("check-in: a text only for opted-in players who weren't reached another way, inside the SMS cap", async () => {
    const { cup, ids, d, c } = await runningCup({}, 8, false);                  // nobody has checked in
    const [texted, pushed, quiet] = ids;
    for (const [p, n] of [[texted, "1"], [pushed, "2"], [quiet, "3"]] as const) {
      await DB.prepare("UPDATE players SET phone_enc = ?, phone_hmac = ?, sms_checkin = ? WHERE id = ?").bind(await encrypt(KEY, `+23480300000${n}0`), `hm-${p}`, p === quiet ? 0 : 1, p).run();
    }
    await DB.prepare("INSERT INTO push_subs (id, player_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, 'https://fcm.googleapis.com/fcm/send/ok', 'BNQzQ87CMRpZNToIOCtwDlTwTvjmAds6ZbCxMKbLaV8sAUNCEzNBEgpVteopf02X2Dq1my0Dt843j8zD539pEJo', 'c2l4dGVlbi1ieXRlcy0hIQ', ?)").bind(`s-${pushed}`, pushed, Date.now()).run();
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => String(input instanceof Request ? input.url : input).startsWith("https://fcm.googleapis.com/") ? new Response(null, { status: 201 }) : real(input as RequestInfo, init));
    await d.tick(c.registrationClosesAt);                                     // closes, and check-in opens
    await expect.poll(async () => (await DB.prepare("SELECT COUNT(*) AS n FROM dev_sms_outbox WHERE phone_hmac = ?").bind(`hm-${texted}`).first("n"))).toBe(1);
    const box = await DB.prepare("SELECT phone_hmac, body FROM dev_sms_outbox WHERE phone_hmac IN (?, ?, ?)").bind(`hm-${texted}`, `hm-${pushed}`, `hm-${quiet}`).all<{ phone_hmac: string; body: string }>();
    expect(box.results.map(r => r.phone_hmac)).toEqual([`hm-${texted}`]);      // the pushed and the quiet one got no text
    expect(box.results[0].body).toContain("check-in is open");
    expect(await DB.prepare("SELECT SUM(n) AS n FROM sms_spend WHERE kind = 'checkin'").first("n")).toBeGreaterThanOrEqual(1);
    expect(cup.slug).toBeTruthy();
  });
});

describe("the push and opt-in APIs", () => {
  it("subscribe, refuse other hosts, unsubscribe; the SMS opt-in is on the profile", async () => {
    const { cookie, player } = await signIn("NG", "8035550714");
    expect((await call("GET", "/api/push/key")).json.key).toMatch(/^BNQzQ87C/);
    const keys = { p256dh: "BNQzQ87CMRpZNToIOCtwDlTwTvjmAds6ZbCxMKbLaV8sAUNCEzNBEgpVteopf02X2Dq1my0Dt843j8zD539pEJo", auth: "c2l4dGVlbi1ieXRlcy0hIQ" };
    const endpoint = "https://fcm.googleapis.com/fcm/send/api-test";
    expect((await call("POST", "/api/push/subscribe", { cookie, body: { endpoint, keys } })).status).toBe(201);
    expect((await call("POST", "/api/push/subscribe", { cookie, body: { endpoint: "https://evil.test/x", keys } })).status).toBe(400);
    expect((await call("POST", "/api/push/subscribe", { body: { endpoint, keys } })).status).toBe(401);
    expect((await call("POST", "/api/push/subscribe", { cookie, origin: "https://evil.test", body: { endpoint, keys } })).status).toBe(403);
    expect((await DB.prepare("SELECT COUNT(*) AS n FROM push_subs WHERE player_id = ?").bind(player.id).first("n"))).toBe(1);
    expect((await call("DELETE", "/api/push/subscribe", { cookie, body: { endpoint } })).status).toBe(200);
    expect((await DB.prepare("SELECT COUNT(*) AS n FROM push_subs WHERE player_id = ?").bind(player.id).first("n"))).toBe(0);
    const r = await call("PATCH", "/api/me", { cookie, body: { smsCheckin: true } });
    expect(r.json.player.smsCheckin).toBe(true);
    expect((await call("PATCH", "/api/me", { cookie, body: { smsCheckin: "yes" } })).status).toBe(400);
  });
});
