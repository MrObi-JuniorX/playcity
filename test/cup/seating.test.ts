import { describe, it, expect } from "vitest";
import { seatTables, seededOrder, sfc32, commitment } from "../../src/cup/seating";

const seed = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const ids = Array.from({ length: 103 }, (_, i) => `p${String(i).padStart(4, "0")}`);

describe("seating", () => {
  it("is reproducible from the seed and ignores the list's order", () => {
    const a = seatTables(ids, seed).tables, b = seatTables([...ids].reverse(), seed).tables;
    expect(b).toEqual(a);
    expect(seatTables(ids, seed.replace(/^9/, "8")).tables).not.toEqual(a);
  });
  it("seats everyone once, in tables of 3 or 4", () => {
    const t = seatTables(ids, seed).tables;
    expect(t.flat().sort()).toEqual([...ids].sort());
    expect(t.every(x => x.length === 3 || x.length === 4)).toBe(true);
  });
  it("keeps apart players who must not share a table", () => {
    const device = (id: string) => Number(id.slice(1)) % 20;           // 20 shared devices, ~5 players each
    const r = seatTables(ids, seed, (a, b) => device(a) === device(b));
    expect(r.unresolved).toBe(0);
    for (const t of r.tables) expect(new Set(t.map(device)).size).toBe(t.length);
  });
  it("counts what it can't separate instead of looping", () => {
    const r = seatTables(ids.slice(0, 8), seed, () => true);
    expect(r.unresolved).toBeGreaterThan(0);
  });
  it("the PRNG is uniform enough for seating", () => {
    const r = sfc32(seed), n = 100_000, buckets = new Array(10).fill(0);
    for (let i = 0; i < n; i++) buckets[Math.floor(r() * 10)]++;
    for (const b of buckets) expect(Math.abs(b - n / 10)).toBeLessThan(n / 100);
  });
  it("the draw order and the commitment are what a verifier recomputes", async () => {
    expect(seededOrder(["b", "a", "c"], seed)).toEqual(seededOrder(["c", "b", "a"], seed));
    expect(await commitment("test")).toBe("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08");
  });
});
