import { describe, it, expect } from "vitest";
import { coerceConfig, configHash, defaultCupConfig, FIELDS, isFrozen, previewCup, publishChecks, SECTIONS, validateCupConfig } from "../../src/cup/config";

/* The cup settings and publish checks (docs/whot-cup-prd.md, 5.1 and 5.2). */

const now = Date.parse("2026-10-20T12:00:00Z");
const ctx = { now, cashEnabled: false, countersigned: false };

describe("cup settings", () => {
  it("the admin form covers every setting, and nothing else", () => {
    expect(new Set(FIELDS.map(f => f.key))).toEqual(new Set(Object.keys(defaultCupConfig(now))));
  });

  it("every setting has a section, an i tag and a working condition", () => {
    const ids = new Set<string>(SECTIONS.map(s => s.id));
    for (const f of FIELDS) {
      expect(ids.has(f.section), f.key).toBe(true);
      expect(f.info.length, f.key).toBeGreaterThan(20);
      if (f.showIf) expect(FIELDS.some(x => x.key === f.showIf!.key), f.key).toBe(true);
      if (f.labels && f.type.kind === "choice") expect(Object.keys(f.labels).sort(), f.key).toEqual([...f.type.options].sort());
    }
    for (const s of SECTIONS) expect(FIELDS.some(f => f.section === s.id && !f.inactive), s.id).toBe(true);
  });

  it("settings that do nothing today aren't offered in the form", () => {
    expect(FIELDS.filter(f => f.inactive).map(f => f.key).sort()).toEqual(["cheerPlayerShare", "cheers", "maxEntriesPerPlayer", "payoutHoldHours"]);
  });

  it("the defaults are valid and publishable, with registration still days away", () => {
    const c = { ...defaultCupConfig(now), slug: "saturday-cup" };
    expect(validateCupConfig(c)).toEqual([]);
    expect(publishChecks(c, ctx)).toEqual([]);
    expect(c.registrationOpensAt - now).toBeGreaterThanOrEqual(2 * 86_400_000);
    expect(new Date(c.startsAt).getUTCDay()).toBe(6);                     // Saturday
    expect(new Date(c.startsAt).getUTCHours()).toBe(15);                  // 16:00 in Lagos
  });

  it("previews the minimum, expected and full field", () => {
    const p = previewCup({ ...defaultCupConfig(now), slug: "x-cup" });
    expect(p.map(x => [x.size, x.N])).toEqual([["minimum", 16], ["expected", 1024], ["seats", 1024]]);
    expect(p.every(x => x.sim.balanced && x.problems.length === 0)).toBe(true);
    expect(p[2].minutes).toBe(Math.ceil(p[2].sim.rounds * (600 + 240) / 60));
  });

  it("names schedule, duration, timing and currency problems", () => {
    const c = { ...defaultCupConfig(now), slug: "x-cup" };
    expect(validateCupConfig({ ...c, checkInOpensAt: c.startsAt + 1 }).join(" ")).toContain("Schedule must run in order");
    expect(publishChecks({ ...c, capacity: 20000, expectedEntries: 20000, mustEndBy: c.startsAt + 3600_000 }, ctx).join(" ")).toContain("must end by");
    expect(publishChecks(c, { ...ctx, now: c.registrationOpensAt }).join(" ")).toContain("open in the future");
    const ngn = publishChecks({ ...c, currency: "NGN" }, ctx).join(" ");
    expect(ngn).toContain("cash phase"); expect(ngn).toContain("countersign");
    expect(publishChecks({ ...c, currency: "NGN" }, { ...ctx, cashEnabled: true, countersigned: true })).toEqual([]);
  });

  it("a tiny stake with coarse rounding is caught before publishing", () => {
    const c = { ...defaultCupConfig(now), slug: "x-cup", entryFee: 100, scFee: 20, roundTo: 50 };
    expect(publishChecks(c, ctx).join(" ")).toMatch(/must each get at least 50/);
  });

  it("freezes when registration opens or the cup moves past scheduled", () => {
    const c = defaultCupConfig(now);
    expect(isFrozen("draft", c, now)).toBe(false);
    expect(isFrozen("scheduled", c, c.registrationOpensAt)).toBe(true);
    expect(isFrozen("registration", c, now)).toBe(true);
    expect(isFrozen("cancelled", c, now)).toBe(true);
  });

  it("the fingerprint ignores key order and changes with any value", async () => {
    const c = defaultCupConfig(now);
    const reordered = Object.fromEntries(Object.entries(c).reverse()) as typeof c;
    expect(await configHash(reordered)).toBe(await configHash(c));
    expect(await configHash({ ...c, entryFee: c.entryFee + 1 })).not.toBe(await configHash(c));
  });

  it("untrusted input keeps known keys only", () => {
    const c = coerceConfig({ entryFee: 2000, __proto__: { x: 1 }, isAdmin: true }, defaultCupConfig(now));
    expect(c.entryFee).toBe(2000);
    expect("isAdmin" in c).toBe(false);
  });
});
