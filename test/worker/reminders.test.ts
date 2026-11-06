import { env, exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { call, signIn, E } from "./helpers";
import { SoftPasskey } from "./passkey";
import { DB, director, makeCup, bulkPlayers, bulkEnter, sessionsFor } from "./cupkit";

/* Keeping players informed (the notification-flow proposal, 2026-11-06): the console's home-banner switch, "your
   cup" for the home page, the calendar file, the 2-hour reminder, the 30-second "your table is waiting" nudge and
   the next round's start time. */

const ORIGIN = "https://play.test";
let seq = 0;
async function unlocked(roles = "cup-admin") {
  const p = await signIn("NG", `0806 ${String(200 + seq++).padStart(3, "0")} 0000`, `198.51.100.${20 + seq}`);
  await E.DB.prepare("INSERT INTO staff (player_id, roles, added_by, created_at) VALUES (?, ?, 'test', ?) ON CONFLICT(player_id) DO UPDATE SET roles = excluded.roles").bind(p.player.id, roles, Date.now()).run();
  const key = await SoftPasskey.create();
  const ro = await call("POST", "/api/console/passkey/register/options", { cookie: p.cookie, body: {} });
  await call("POST", "/api/console/passkey/register/verify", { cookie: p.cookie, body: { response: await key.register(ro.json.options), name: "Laptop" } });
  const lo = await call("POST", "/api/console/passkey/login/options", { cookie: p.cookie, body: {} });
  const lv = await call("POST", "/api/console/passkey/login/verify", { cookie: p.cookie, body: { response: await key.login(lo.json.options) } });
  return { ...p, cookie: `${p.cookie}; ${lv.setCookies.find(c => c.startsWith("__Host-pc_c="))!.split(";")[0]}` };
}

async function hub(slug: string, cookie: string) {
  const res = await exports.default.fetch(`${ORIGIN}/ws/cup/${slug}/hub`, { headers: { Upgrade: "websocket", Origin: ORIGIN, Cookie: cookie } });
  const ws = res.webSocket!; ws.accept();
  const got: any[] = [];
  ws.addEventListener("message", e => got.push(JSON.parse(String(e.data))));
  const until = async (pred: () => boolean, ms = 4000) => { const end = Date.now() + ms; while (!pred()) { if (Date.now() > end) throw new Error("timed out: " + JSON.stringify(got)); await new Promise(r => setTimeout(r, 25)); } };
  await until(() => got.some(m => m.t === "hello"));
  return { got, until };
}
const publicCups = async () => { await caches.default.delete(new Request(`${ORIGIN}/api/cups`)); return (await call("GET", "/api/cups")).json.cups as any[]; };

describe("the console's home-banner switch", () => {
  it("turns a published cup's banner on and off at any time, audited, without touching its settings", async () => {
    const admin = await unlocked();
    const cup = await makeCup({ capacity: 64 });                         // published, and already in registration
    await director(cup.id).tick(Date.now());
    const before = await DB.prepare("SELECT version, config_hash FROM cups WHERE id = ?").bind(cup.id).first<{ version: number; config_hash: string }>();
    const on = await call("POST", `/api/console/cups/${cup.id}/promote`, { cookie: admin.cookie, body: { on: true } });
    expect(on.status).toBe(200);
    expect(on.json.cup.promoted).toBe(true);
    expect((await publicCups()).find(c => c.slug === cup.slug).promoted).toBe(true);
    const after = await DB.prepare("SELECT version, config_hash FROM cups WHERE id = ?").bind(cup.id).first();
    expect(after).toEqual(before);                                       // a display switch: the cup itself is unchanged
    expect((await call("POST", `/api/console/cups/${cup.id}/promote`, { cookie: admin.cookie, body: { on: false } })).json.cup.promoted).toBe(false);
    expect((await publicCups()).find(c => c.slug === cup.slug).promoted).toBe(false);
    const audit = await DB.prepare("SELECT action FROM audit WHERE target = ? AND action LIKE 'cup.home-banner%' ORDER BY id").bind(`cup:${cup.id}`).all<{ action: string }>();
    expect(audit.results.map(r => r.action)).toEqual(["cup.home-banner.on", "cup.home-banner.off"]);
  });

  it("only for published cups, and only for cup admins", async () => {
    const admin = await unlocked(), fin = await unlocked("finance");
    const later = Date.now() + 86_400_000;                               // registration a day away: the director stays asleep
    const cup = await makeCup({ capacity: 64, registrationOpensAt: later, registrationClosesAt: later + 3_600_000, checkInOpensAt: later + 3_000_000, startsAt: later + 4_000_000, mustEndBy: later + 9_000_000 });
    expect((await call("POST", `/api/console/cups/${cup.id}/promote`, { cookie: fin.cookie, body: { on: true } })).status).toBe(403);
    await DB.prepare("UPDATE cups SET state = 'draft' WHERE id = ?").bind(cup.id).run();
    expect((await call("POST", `/api/console/cups/${cup.id}/promote`, { cookie: admin.cookie, body: { on: true } })).json.error).toBe("publish-first");
    await DB.prepare("UPDATE cups SET state = 'cancelled' WHERE id = ?").bind(cup.id).run();
    expect((await call("POST", `/api/console/cups/${cup.id}/promote`, { cookie: admin.cookie, body: { on: true } })).json.error).toBe("already-over");
  });
});

describe("your cup, and the calendar", () => {
  it("/api/me/cups lists the player's cups still to play, and forgets them once refunded", async () => {
    const cup = await makeCup({ capacity: 32, minEntries: 4 });
    const ids = await bulkPlayers(8, 10_000);
    await bulkEnter(cup, ids);
    const cookies = await sessionsFor(ids);
    await director(cup.id).tick(Date.now());
    const r = await call("GET", "/api/me/cups", { cookie: cookies.get(ids[0]) });
    expect(r.json.cups).toEqual([expect.objectContaining({ slug: cup.slug, state: "registration", entry: "entered", checkedIn: true, startsAt: cup.c.startsAt })]);
    expect((await call("GET", "/api/me/cups")).status).toBe(401);
    await director(cup.id).cancel("test");
    expect((await call("GET", "/api/me/cups", { cookie: cookies.get(ids[0]) })).json.cups).toEqual([]);
  });

  it("the calendar file is one event at the start, with an alarm when check-in opens", async () => {
    const cup = await makeCup({ capacity: 32, name: "Saturday Whot Cup, Lagos; live" });
    const res = await exports.default.fetch(`${ORIGIN}/api/cups/${cup.slug}/calendar`);
    const ics = await res.text();
    expect(res.headers.get("Content-Type")).toMatch(/^text\/calendar/);
    expect(res.headers.get("Content-Disposition")).toContain(`${cup.slug}.ics`);
    const at = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    expect(ics).toContain(`DTSTART:${at(cup.c.startsAt)}\r\n`);
    expect(ics).toContain(`TRIGGER:-PT${Math.round((cup.c.startsAt - cup.c.checkInOpensAt) / 60_000)}M\r\n`);
    expect(ics).toContain("SUMMARY:Saturday Whot Cup\\, Lagos\\; live\r\n");                      // RFC 5545 escaping
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n") && ics.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
  });
});

describe("reminders and the next round", () => {
  it("2 hours before the start, every entrant hears it once, with what to do", async () => {
    const now = Date.now(), startsAt = now + 3 * 3_600_000;
    const cup = await makeCup({ capacity: 32, minEntries: 4, registrationOpensAt: now - 60_000, registrationClosesAt: startsAt - 3_600_000, checkInOpensAt: startsAt - 15 * 60_000, startsAt, mustEndBy: startsAt + 6 * 3_600_000 });
    const ids = await bulkPlayers(6, 10_000);
    await bulkEnter(cup, ids, false);
    const cookies = await sessionsFor(ids);
    const d = director(cup.id);
    await d.tick(now);                                                    // registration open
    const h = await hub(cup.slug, cookies.get(ids[0])!);
    await d.tick(startsAt - 2 * 3_600_000 - 1000);
    expect(h.got.some(m => m.t === "reminder")).toBe(false);              // not yet
    await d.tick(startsAt - 2 * 3_600_000);
    await h.until(() => h.got.some(m => m.t === "reminder"));
    await d.tick(startsAt - 2 * 3_600_000 + 60_000);
    await new Promise(r => setTimeout(r, 100));
    expect(h.got.filter(m => m.t === "reminder").length).toBe(1);         // once
  });

  it("30 seconds after seating, the players of tables still waiting get a second nudge, once", async () => {
    const cup = await makeCup({ capacity: 16, minEntries: 4, expectedEntries: 16, scEnabled: false }, "external");
    const ids = await bulkPlayers(16, 10_000);
    await bulkEnter(cup, ids);
    const cookies = await sessionsFor(ids);
    const d = director(cup.id), c = cup.c;
    await d.tick(c.registrationClosesAt); await d.tick(c.startsAt - 300_000);
    const hubs = await Promise.all(ids.slice(0, 4).map(p => hub(cup.slug, cookies.get(p)!)));
    await d.tick(c.startsAt);
    await Promise.all(hubs.map(h => h.until(() => h.got.some(m => m.t === "table"))));
    await d.tick(c.startsAt + 29_000);
    expect(hubs.some(h => h.got.some(m => m.t === "nudge"))).toBe(false);
    await d.tick(c.startsAt + 30_000);
    await Promise.all(hubs.map(h => h.until(() => h.got.some(m => m.t === "nudge"))));
    for (const h of hubs) expect(h.got.find(m => m.t === "nudge").code).toBe(h.got.find(m => m.t === "table").code);
    await d.tick(c.startsAt + 45_000);
    await new Promise(r => setTimeout(r, 100));
    for (const h of hubs) expect(h.got.filter(m => m.t === "nudge").length).toBe(1);
  });

  it("between rounds, the cup's live state says when the next round seats and which main-draw round is next", async () => {
    const cup = await makeCup({ capacity: 32, minEntries: 4, expectedEntries: 32 });   // simulate: a slot finishes at once
    await bulkEnter(cup, await bulkPlayers(32, 10_000));
    const d = director(cup.id), c = cup.c;
    await d.tick(c.registrationClosesAt); await d.tick(c.startsAt - 300_000); await d.tick(c.startsAt);
    const live = JSON.parse((await DB.prepare("SELECT live_json FROM cups WHERE id = ?").bind(cup.id).first<string>("live_json"))!);
    expect(live).toMatchObject({ slot: 1, wRound: 1, nextAt: c.startsAt + c.breakSec * 1000 });
    expect(env).toBeTruthy();
  });
});
