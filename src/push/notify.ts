import type { AuthEnv } from "../auth/env";
import { decrypt } from "../auth/crypto";
import { smsSender } from "../auth/sms";
import { limits } from "../auth/limits";
import { pushReady, sendPush, type PushEnv } from "./webpush";

/* Telling players who don't have the hub open (docs/whot-cup-prd.md PX-4). Called by the cup gates after they have
   answered the director, so the director never waits on a push service.
     Web Push   to every browser the player allowed notifications in. Dead subscriptions are deleted.
     SMS        check-in only, only for players who opted in, only when no push reached them, and inside the same
                daily SMS spend cap as sign-in codes (threat T9). */

export interface Note { title: string; body: string; url: string; tag: string; ttl?: number }
interface Offline { player: string; note?: Note; sms?: string }
const PARALLEL = 16;

export type NotifyEnv = AuthEnv & PushEnv;

export async function notifyOffline(env: NotifyEnv, events: Offline[]): Promise<{ pushed: number; texted: number }> {
  const reached = new Set<string>();
  let pushed = 0, texted = 0;
  const noted = events.filter(e => e.note);
  if (noted.length && pushReady(env)) {
    const subs = (await env.DB.prepare("SELECT id, player_id, endpoint, p256dh, auth FROM push_subs WHERE player_id IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify([...new Set(noted.map(e => e.player))])).all<{ id: string; player_id: string; endpoint: string; p256dh: string; auth: string }>()).results;
    const of = new Map<string, typeof subs>();
    for (const s of subs) (of.get(s.player_id) ?? of.set(s.player_id, []).get(s.player_id)!).push(s);
    const jobs = noted.flatMap(e => (of.get(e.player) ?? []).map(s => ({ e, s })));
    const gone: string[] = [];
    for (let i = 0; i < jobs.length; i += PARALLEL) {
      await Promise.all(jobs.slice(i, i + PARALLEL).map(async ({ e, s }) => {
        const n = e.note!;
        try {
          const status = await sendPush(env, s, { title: n.title, body: n.body, url: n.url, tag: n.tag }, n.ttl ?? 300);
          if (status >= 200 && status < 300) { reached.add(e.player); pushed++; }
          else if (status === 404 || status === 410) gone.push(s.id);
        } catch { /* a push service that doesn't answer: the player still has the cup page */ }
      }));
    }
    if (gone.length) await env.DB.prepare("DELETE FROM push_subs WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(gone)).run();
  }
  const texts = events.filter(e => e.sms && !reached.has(e.player));
  if (texts.length) texted = await textCheckIn(env, texts);
  return { pushed, texted };
}

async function textCheckIn(env: NotifyEnv, events: Offline[]): Promise<number> {
  const sender = smsSender(env);
  if (!sender || !env.PHONE_ENC_KEY) return 0;
  const rows = (await env.DB.prepare("SELECT id, phone_enc, phone_hmac FROM players WHERE sms_checkin = 1 AND id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(events.map(e => e.player))).all<{ id: string; phone_enc: string; phone_hmac: string }>()).results;
  if (!rows.length) return 0;
  // One cap for all SMS spend: sign-in codes in the last 24 hours plus today's other texts.
  const now = Date.now(), day = new Date(now + 3600_000).toISOString().slice(0, 10);     // Lagos day (UTC+1)
  const L = limits(env);
  const used = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM otp_requests WHERE created_at > ?) + COALESCE((SELECT SUM(n) FROM sms_spend WHERE day = ?), 0) AS n").bind(now - 86_400_000, day).first<number>("n") ?? 0;
  const room = Math.max(0, L.globalDay - used);
  if (room < rows.length) console.error(JSON.stringify({ alert: true, msg: "sms daily spend cap: check-in texts cut short", wanted: rows.length, room }));
  const body = new Map(events.map(e => [e.player, e.sms!]));
  let sent = 0;
  for (const r of rows.slice(0, room)) {
    try { if (await sender.send(await decrypt(env.PHONE_ENC_KEY, r.phone_enc), body.get(r.id)!, r.phone_hmac)) sent++; } catch { /* one bad number doesn't stop the rest */ }
  }
  if (sent) {
    await env.DB.prepare("INSERT INTO sms_spend (day, kind, n) VALUES (?, 'checkin', ?) ON CONFLICT(day, kind) DO UPDATE SET n = n + excluded.n").bind(day, sent).run();
    if (used + sent >= Math.ceil(L.globalDay * L.alertAt) && used < Math.ceil(L.globalDay * L.alertAt)) console.error(JSON.stringify({ alert: true, msg: "sms daily spend at alert level", sent: used + sent, cap: L.globalDay }));
  }
  return sent;
}
