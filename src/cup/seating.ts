/* Seating (docs/whot-cup-prd.md, SE-1 to SE-3). Pure and deterministic: given the revealed seed and the published
   player list, anyone can recompute every table. The director commits to sha256(seed) before it knows who will be
   seated, so it can't pick a seed that suits anyone.

   1. Sort the players by id (the published list's order doesn't matter).
   2. Shuffle with sfc32 seeded from the seed's first 128 bits.
   3. Cut into tables of the engine's sizes (tableSizes: 3-4 seats).
   4. Constraint pass: where two players at a table must not sit together (a shared device, a shared network, an
      inviter and invitee), swap the later one with the first player at a later table (then an earlier one) for whom
      the swap breaks no rule at either table. Same input, same swaps. */

import { tableSizes } from "./engine";

export function sfc32(hex: string): () => number {
  if (!/^[0-9a-f]{32,}$/.test(hex)) throw new Error("seed must be at least 32 hex characters");
  let a = parseInt(hex.slice(0, 8), 16) | 0, b = parseInt(hex.slice(8, 16), 16) | 0, c = parseInt(hex.slice(16, 24), 16) | 0, d = parseInt(hex.slice(24, 32), 16) | 0;
  const next = () => {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0; a = b ^ (b >>> 9); b = (c + (c << 3)) | 0; c = (c << 21) | (c >>> 11); c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) next();                     // stir
  return next;
}

export function newSeed(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, "0")).join("");
}
export async function commitment(seed: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)))].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** A seeded order of ids: the random draw at registration close uses this too. */
export function seededOrder(ids: string[], seed: string): string[] {
  const r = sfc32(seed), out = [...ids].sort();
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

/** Tables for a round. `apart(a, b)` says two players must not share a table. */
export function seatTables(ids: string[], seed: string, apart: (a: string, b: string) => boolean = () => false, sizes = tableSizes(ids.length)): { tables: string[][]; unresolved: number } {
  const order = seededOrder(ids, seed), tables: string[][] = [];
  let at = 0;
  for (const z of sizes) { tables.push(order.slice(at, at + z)); at += z; }
  const fine = (t: string[], who: string, skip: number) => t.every((x, i) => i === skip || !apart(x, who));
  let unresolved = 0;
  for (let ti = 0; ti < tables.length; ti++) {
    const t = tables[ti];
    for (let i = 1; i < t.length; i++) {
      if (t.slice(0, i).every(x => !apart(x, t[i]))) continue;
      let done = false;
      const tryAt = (tj: number) => {
        const u = tables[tj];
        for (let k = 0; k < u.length && !done; k++) {
          if (fine(t, u[k], i) && fine(u, t[i], k)) { [t[i], u[k]] = [u[k], t[i]]; done = true; }
        }
      };
      for (let tj = ti + 1; tj < tables.length && !done; tj++) tryAt(tj);
      for (let tj = 0; tj < ti && !done; tj++) tryAt(tj);
      if (!done) unresolved++;
    }
  }
  return { tables, unresolved };
}
