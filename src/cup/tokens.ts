import { hmac } from "../auth/crypto";

/* Signatures shared by the cup director and its tables (docs/whot-cup-prd.md SE-4, TB-5). Both run in this Worker
   and sign with PHONE_HMAC_KEY under their own purposes, so a seat token can never pass for a result or a phone hash. */

/** Seat token (SE-4): HMAC over the cup, slot, table, seat, player and expiry. The table admits only its holder. */
export async function seatToken(key: string, cupId: string, slot: number, code: string, seat: number, player: string, expires: number): Promise<string> {
  return `${expires}.${await hmac(key, "seat", `${cupId}|${slot}|${code}|${seat}|${player}|${expires}`)}`;
}

/** Check a token against the seat the signed-in player holds. "expired" only for a token that is otherwise right. */
export async function checkSeatToken(key: string, tok: string, cupId: string, slot: number, code: string, seat: number, player: string, now: number): Promise<"ok" | "expired" | "bad"> {
  const m = /^(\d{10,16})\.([0-9a-f]{64})$/.exec(tok);
  if (!m) return "bad";
  const want = await seatToken(key, cupId, slot, code, seat, player, Number(m[1]));
  if (!same(want, tok)) return "bad";
  return Number(m[1]) <= now ? "expired" : "ok";
}

/** The signature a table puts on its result: the places, and the stats when the table sends them. */
export async function resultSig(key: string, cupId: string, code: string, places: string[], stats?: string): Promise<string> {
  return hmac(key, "result", `${cupId}|${code}|${places.join(",")}${stats === undefined ? "" : `|${stats}`}`);
}

/** Compare without stopping at the first difference. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
