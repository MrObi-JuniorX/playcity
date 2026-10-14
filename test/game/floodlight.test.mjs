import { describe, it, expect } from "vitest";
import * as D from "../../public/floodlight-fc/data.js";
import { createMatch, HX, HZ, BR, DIR } from "../../public/floodlight-fc/sim.js";
import { mulberry32 } from "../../public/floodlight-fc/vec.js";

const eko = (o) => D.buildTeam(D.defaultSetup("eko", o));
const nbk = (o) => D.buildTeam(D.defaultSetup("nbk", o));
function match(o = {}) {
  const events = [];
  const M = createMatch({ teams: [o.a || eko(), o.b || nbk({ manager: "bankole", formation: "4-3-1-2", playstyle: "longBallCounter" })], human: o.human ?? -1, seed: o.seed ?? 7, settings: { len: 180, ...(o.settings || {}) } },
    (e, ...a) => { events.push([e, ...a]); });
  M.events = events;
  return M;
}
const run = (M, seconds) => { for (let i = 0; i < seconds * 60; i++) M.step(1 / 60); };
const until = (M, test, max = 20) => { for (let i = 0; i < max * 60 && !test(); i++) M.step(1 / 60); return test(); };
const toPlay = (M) => until(M, () => M.G.phase === "play", 5);
const named = (M, name) => M.players.find((p) => p.name === name);
/* Park everyone except the named players far from the action, so a scenario plays out undisturbed. */
function park(M, keep) {
  for (const p of M.players) if (!keep.includes(p)) { p.pos.set(DIR[p.team] * -40, 0, (p.i - 5) * 5); p.vel.set(0, 0, 0); }
}

describe("floodlight data model", () => {
  it("has the full model from the design research", () => {
    expect(D.STAT_KEYS).toHaveLength(26);
    expect(D.TRAITS).toHaveLength(4);
    expect(D.POSITIONS).toHaveLength(13);
    expect(Object.keys(D.STYLES)).toHaveLength(22);
    expect(Object.keys(D.AI_STYLES)).toHaveLength(7);
    expect(Object.keys(D.SKILLS)).toHaveLength(55);
    expect(Object.keys(D.FORMATIONS)).toHaveLength(7);
    expect(D.PLAY_KEYS).toHaveLength(6);
    for (const s of Object.values(D.STYLES)) for (const p of s.pos) expect(D.POSITIONS).toContain(p);
  });
  it("every formation is eleven slots with one keeper", () => {
    for (const f of Object.values(D.FORMATIONS)) {
      expect(f.slots).toHaveLength(11);
      expect(f.slots.filter((s) => s[0] === "GK")).toHaveLength(1);
      for (const [pos, fx, fz] of f.slots) { expect(D.POSITIONS).toContain(pos); expect(fx).toBeLessThan(0); expect(Math.abs(fz)).toBeLessThan(0.7); }
    }
  });
  it("managers are proficient 50–89 in every playstyle and carry two real boosters", () => {
    for (const m of D.MANAGERS) {
      for (const k of D.PLAY_KEYS) { expect(m.prof[k]).toBeGreaterThanOrEqual(50); expect(m.prof[k]).toBeLessThanOrEqual(89); }
      expect(m.boost).toHaveLength(2);
      for (const b of m.boost) expect(D.STAT_KEYS).toContain(b);
      if (m.linkUp) expect(D.LINKUPS[m.linkUp]).toBeTruthy();
    }
  });
  it("squads are sixteen valid players, and the same every time", () => {
    for (const sq of D.SQUADS) {
      expect(sq.players).toHaveLength(16);
      for (const p of sq.players) {
        for (const k of D.STAT_KEYS) { expect(p.stats[k]).toBeGreaterThanOrEqual(40); expect(p.stats[k]).toBeLessThanOrEqual(99); }
        for (const s of p.skills) expect(D.SKILLS[s]).toBeTruthy();
        expect(D.STYLES[p.style].pos).toContain(p.pos);
      }
    }
    expect(D.squadById("eko").players[8].stats).toEqual(D.squadById("eko").players[8].stats);
  });
  it("a player out of position is rated lower, and loses technical stats but not physical ones", () => {
    const obi = D.squadById("eko").players.find((p) => p.name === "Obi");
    expect(D.posFit(obi, "CF")).toBe(1);
    expect(D.posFit(obi, "SS")).toBeLessThan(1);
    expect(D.posFit(obi, "CB")).toBeLessThan(D.posFit(obi, "SS"));
    expect(D.ovr(obi, "CB")).toBeLessThan(D.ovr(obi, "CF"));
    const out = D.effStats(obi, "CB", null, 0);
    expect(out.finish).toBeLessThan(obi.stats.finish);
    expect(out.speed).toBe(obi.stats.speed);
  });
  it("condition moves the stats a player brings to the match, never his rating", () => {
    const pl = D.squadById("eko").players[6];
    expect(D.effStats(pl, pl.pos, null, 2).lowPass).toBe(pl.stats.lowPass + 4);
    expect(D.effStats(pl, pl.pos, null, -2).lowPass).toBe(pl.stats.lowPass - 4);
    expect(D.ovr(pl)).toBe(D.rate(D.effStats(pl, pl.pos, null, 0), pl.pos));
  });
  it("high Form keeps the condition arrow steadier than low Form", () => {
    const spread = (form) => { const r = mulberry32(3); let s = 0; for (let i = 0; i < 4000; i++) { const c = D.rollCondition({ form }, r); expect(c).toBeGreaterThanOrEqual(-2); expect(c).toBeLessThanOrEqual(2); s += c * c; } return s / 4000; };
    expect(spread(8)).toBeLessThan(spread(1) * 0.6);
  });
  it("a manager's boosters add one point, and proficiency scales the playstyle", () => {
    const pl = D.squadById("eko").players[6], mgr = D.managerById("verhoeven");
    expect(D.effStats(pl, pl.pos, mgr, 0).speed).toBe(pl.stats.speed + 1);
    expect(D.tacticParams("longBallCounter", 89).line).toBeCloseTo(D.PLAYSTYLES.longBallCounter.line);
    const weak = D.tacticParams("longBallCounter", 55).line;
    expect(weak).toBeGreaterThan(D.PLAYSTYLES.longBallCounter.line);
    expect(weak).toBeLessThan(D.NEUTRAL_PLAY.line);
  });
  it("skill moves are gated by stars and by the matching skill", () => {
    const by = (n) => D.squadById("eko").players.find((p) => p.name === n);
    expect(D.canDo(by("Bello"), "stepover")).toBe(false);          // 1★
    expect(D.canDo(by("Bello"), "knockon")).toBe(true);
    expect(D.canDo(by("Uche"), "elastico")).toBe(true);            // 5★ with Flip Flap
    expect(D.canDo(by("Lawal"), "rainbow")).toBe(false);           // 4★ but no Sombrero skill
    expect(D.canDo(by("Akinola"), "elastico")).toBe(false);        // has the stars for a 4★ move, not a 5★ one
  });
  it("a saved team is always repaired into a legal one", () => {
    const d = D.defaultSetup("eko");
    expect(D.cleanSetup(null, "eko")).toEqual(d);
    const broken = D.cleanSetup({ xi: [0, 0, 1], manager: "nobody", tactics: [{ formation: "9-9-9" }], captain: 99, moves: { up: "nope" }, cbUp: 7, instr: { att: [{ p: 99, type: "attacking" }] } }, "eko");
    expect(new Set(broken.xi).size).toBe(11);
    expect(D.FORMATIONS[broken.tactics[0].formation]).toBeTruthy();
    expect(broken.xi).toContain(broken.captain);
    expect(broken.moves.up).toBe(D.DEFAULT_MOVES.up);
    expect(broken.cbUp).toBe(2);
    expect(broken.instr.att[0]).toBeNull();
    const t = D.buildTeam(broken);
    expect(t.xi).toHaveLength(11);
    for (const i of [0, 1]) expect(t.xi.filter((x) => x.tac[i].pos === "GK")).toHaveLength(1);
  });
  it("the best eleven fills every formation with a keeper in goal", () => {
    for (const f of Object.keys(D.FORMATIONS)) {
      const s = D.defaultSetup("nbk", { formation: f }), sq = D.squadById("nbk");
      expect(new Set(s.xi).size).toBe(11);
      expect(sq.players[s.xi[0]].pos).toBe("GK");
      expect(D.teamRating(s)).toBeGreaterThan(70);
    }
  });
});

describe("floodlight match engine", () => {
  it("plays whole matches to full time with sane numbers", () => {
    for (const seed of [1, 2, 3]) {
      const M = match({ seed });
      let steps = 0;
      while (M.G.phase !== "ft" && steps < 60 * 400) {
        M.step(1 / 60); steps++;
        if (steps % 300 === 0) {
          for (const p of M.players) expect(Number.isFinite(p.pos.x + p.pos.z + p.vel.x + p.vel.z + p.facing + p.fit + p.stamina)).toBe(true);
          expect(Number.isFinite(M.ball.pos.x + M.ball.pos.y + M.ball.pos.z)).toBe(true);
          expect(Math.abs(M.ball.pos.x)).toBeLessThan(HX + 6);
        }
      }
      const st = M.G.stats;
      expect(M.G.phase).toBe("ft");
      expect(M.G.score[0] + M.G.score[1]).toBeLessThan(15);
      expect(st.passA[0] + st.passA[1]).toBeGreaterThan(60);
      expect((st.passC[0] + st.passC[1]) / (st.passA[0] + st.passA[1])).toBeGreaterThan(0.5);
      expect(st.onT[0]).toBeLessThanOrEqual(st.shots[0]);
    }
  });
  it("is repeatable: the same seed plays the same match", () => {
    const a = match({ seed: 11 }), b = match({ seed: 11 });
    run(a, 60); run(b, 60);
    expect(a.G.score).toEqual(b.G.score);
    expect(a.G.stats).toEqual(b.G.stats);
    expect(a.ball.pos).toEqual(b.ball.pos);
  });
  it("a step is cheap (well under a millisecond)", () => {
    const M = match({ seed: 5 });
    run(M, 5);
    const t0 = performance.now(); run(M, 60);
    expect((performance.now() - t0) / 3600).toBeLessThan(1);
  });
  it("the team playstyle changes how the team plays: a Long Ball Counter side defends deeper than a Quick Counter side", () => {
    const lineDepth = (playstyle, manager) => {
      let sum = 0, cnt = 0;
      for (const seed of [1, 2]) {
        const M = match({ seed, b: nbk({ manager, formation: "4-4-2", playstyle }) });
        for (let i = 0; i < 60 * 90; i++) {
          M.step(1 / 60);
          if (i % 30 === 0 && M.G.phase === "play" && M.ball.owner && M.ball.owner.team === 0 && Math.abs(M.ball.pos.x) < 15)
            for (const p of M.players) if (p.team === 1 && p.line === "DF") { sum += p.pos.x * DIR[1]; cnt++; }
        }
      }
      return sum / cnt;
    };
    expect(lineDepth("longBallCounter", "bankole")).toBeLessThan(lineDepth("quickCounter", "ridl") - 2);
  });
  it("switching sub-tactic moves players to new slots, with the out-of-position penalty", () => {
    const M = match({ human: 0, a: eko({ formationB: "4-3-1-2", playstyleB: "longBallCounter" }) });
    toPlay(M);
    const uche = named(M, "Uche"), before = { pos: uche.posCode, drib: uche.s.drib, T: M.teams[0].T };
    M.lever("tactic");
    expect(M.teams[0].tac).toBe(1);
    expect(uche.posCode).not.toBe(before.pos);
    expect(uche.s.drib).toBeLessThan(before.drib);
    expect(M.teams[0].T.line).toBeLessThan(before.T.line);
    M.lever("tactic");
    expect(uche.posCode).toBe(before.pos);
  });
  it("the attack and defence dial stays within five levels and moves the team up the pitch", () => {
    const M = match({ human: 0 });
    toPlay(M);
    const cb = named(M, "Bello"), at = () => M.dbg.formationTarget(cb, { set(x, y, z) { this.x = x; this.z = z; return this; }, lerp() { return this; } }).x;
    const mid = at();
    for (let i = 0; i < 5; i++) M.lever("level", 1);
    expect(M.teams[0].level).toBe(2);
    expect(at()).toBeGreaterThan(mid);
    for (let i = 0; i < 9; i++) M.lever("level", -1);
    expect(M.teams[0].level).toBe(-2);
  });
  it("a move needs the stars and the skill: a 1★ centre-back cannot step over, a 5★ winger can", () => {
    const M = match({ human: 0 });
    toPlay(M);
    const bello = named(M, "Bello"), uche = named(M, "Uche");
    park(M, [bello, uche]);
    M.ball.owner = null; M.dbg.setOwner(bello);
    expect(M.ctrl).toBe(bello);
    M.skillInput("up");
    expect(bello.skill).toBeNull();
    expect(M.events.some((e) => e[0] === "tag" && /NEEDS 2★/.test(e[1]))).toBe(true);
    M.ball.owner = null; M.dbg.setOwner(uche);
    M.skillInput("elastico");
    expect(uche.skill && uche.skill.type).toBe("elastico");
  });
  it("offside: a pass to a player beyond the second-last defender is flagged when he plays it", () => {
    const play = (receiverX) => {
      const M = match({ seed: 3 });
      toPlay(M);
      const a = named(M, "Akinola"), r = named(M, "Obi");
      park(M, [a, r]);
      M.players.filter((p) => p.team === 1 && !p.isGK).forEach((p, i) => p.pos.set(20, 0, (i % 2 ? 1 : -1) * (22 + i)));
      M.players.find((p) => p.team === 1 && p.isGK).pos.set(51, 0, 0);
      a.pos.set(5, 0, 0); r.pos.set(receiverX, 0, 3); r.vel.set(0, 0, 0);
      M.ball.owner = null; M.dbg.setOwner(a);
      M.dbg.doPass(a, "pass", null, { target: r });
      until(M, () => M.G.phase !== "play" || M.ball.owner === r, 4);
      return M;
    };
    const off = play(30);
    expect(off.G.stats.offsides[0]).toBe(1);
    expect(off.G.phase).toBe("restart");
    expect(off.G.restart.kind).toBe("freekick");
    expect(off.G.restart.team).toBe(1);
    const on = play(17);
    expect(on.G.stats.offsides[0]).toBe(0);
    expect(on.ball.owner && on.ball.owner.name).toBe("Obi");
  });
  it("offside can be switched off", () => {
    const M = match({ seed: 3, settings: { offside: 0 } });
    toPlay(M);
    const a = named(M, "Akinola"), r = named(M, "Obi");
    park(M, [a, r]);
    M.players.filter((p) => p.team === 1 && !p.isGK).forEach((p, i) => p.pos.set(20, 0, (i % 2 ? 1 : -1) * (22 + i)));
    a.pos.set(5, 0, 0); r.pos.set(30, 0, 3);
    M.ball.owner = null; M.dbg.setOwner(a); M.dbg.doPass(a, "pass", null, { target: r });
    until(M, () => M.G.phase !== "play" || M.ball.owner === r, 4);
    expect(M.G.stats.offsides[0]).toBe(0);
  });
  it("a foul outside the box is a free kick with a wall; inside it is a penalty", () => {
    const M = match({ seed: 4 });
    toPlay(M);
    const victim = named(M, "Obi"), by = M.players.find((p) => p.team === 1 && p.posCode === "CB");
    victim.pos.set(28, 0, 2);
    M.dbg.setOwner(victim); M.dbg.foul(by, victim);
    expect(M.G.restart.kind).toBe("freekick");
    expect(M.G.stats.fouls[1]).toBe(1);
    until(M, () => M.G.phase === "setpiece", 4);
    const sp = M.G.sp;
    run(M, 1.2);                                                          // the wall shuffles the last step or two into place
    expect(M.G.phase).toBe("setpiece");
    expect(sp.direct).toBe(true);
    expect(sp.wall.length).toBeGreaterThanOrEqual(3);
    for (const w of sp.wall) expect(Math.hypot(w.pos.x - sp.pos.x, w.pos.z - sp.pos.z)).toBeGreaterThan(8.5);
    expect(M.ball.owner).toBe(sp.taker);
    expect(until(M, () => M.G.phase !== "setpiece", 6)).toBe(true);      // the computer takes it

    const P = match({ seed: 4 });
    toPlay(P);
    const v2 = named(P, "Obi"), b2 = P.players.find((p) => p.team === 1 && p.posCode === "CB");
    v2.pos.set(44, 0, 3);
    P.dbg.setOwner(v2); P.dbg.foul(b2, v2);
    expect(P.G.restart.kind).toBe("penalty");
    until(P, () => P.G.phase === "setpiece", 4);
    expect(P.G.sp.taker.i).toBe(P.teams[0].cfg.takers.pk);
    expect(P.ball.pos.x).toBeCloseTo(HX - 11, 0);
    for (const p of P.players) if (p !== P.G.sp.taker && !p.isGK) expect(Math.abs(p.pos.x) < HX - 16.4 || Math.abs(p.pos.z) > 20).toBe(true);
    const shots = P.G.stats.shots[0];
    until(P, () => P.G.phase !== "setpiece", 6);
    expect(P.G.stats.shots[0]).toBe(shots + 1);
    expect(P.ball.vel.x).toBeGreaterThan(10);
  });
  it("a ball dribbled over the touchline is a throw-in, and one walked into the net is a goal", () => {
    const M = match({ seed: 2 });
    toPlay(M);
    const p = named(M, "Uche");
    p.pos.set(10, 0, HZ + 2); p.facing = Math.PI / 2; M.ball.owner = null; M.dbg.setOwner(p); M.ball.pos.set(10, BR, HZ + 2.5);
    M.step(1 / 60);
    expect(M.G.phase).toBe("restart");
    expect(M.G.restart.kind).toBe("throw");
    expect(M.G.restart.team).toBe(1);

    const N = match({ seed: 2 });
    toPlay(N);
    const q = named(N, "Obi");
    park(N, [q]);
    q.pos.set(HX + 1, 0, 0); q.facing = 0; N.ball.owner = null; N.dbg.setOwner(q); N.ball.pos.set(HX + 1.5, BR, 0);
    N.step(1 / 60);
    expect(N.G.score).toEqual([1, 0]);
    expect(N.G.phase).toBe("goal");
  });
  it("a Stunning shot winds up before it is struck, then flies faster than a normal one", () => {
    const strike = (mod) => {
      const M = match({ human: 0, seed: 9 });
      toPlay(M);
      const p = named(M, "Obi");
      park(M, [p]);
      p.pos.set(30, 0, 0); p.facing = 0; p.vel.set(0, 0, 0); M.ball.owner = null; M.dbg.setOwner(p); p.protect = 3;
      M.press("shoot"); run(M, 0.75); M.release("shoot", mod);
      const woundUp = !!p.wind && M.ball.owner === p;
      until(M, () => M.ball.owner !== p, 1);
      return { woundUp, speed: M.ball.power, stun: M.ball.stun, type: M.ball.kickType };
    };
    const normal = strike(""), stunning = strike("right");
    expect(normal.woundUp).toBe(false);
    expect(stunning.woundUp).toBe(true);
    expect(stunning.type).toBe("shot");
    expect(stunning.stun).toBe(true);
    expect(stunning.speed).toBeGreaterThan(normal.speed * 1.08);
  });
  it("shielding makes a tackle less likely to win the ball", () => {
    const wins = (shield) => {
      let won = 0;
      for (let seed = 1; seed <= 60; seed++) {
        const M = match({ human: 0, seed });
        toPlay(M);
        const c = named(M, "Emenike") || named(M, "Obi"), t = M.players.find((p) => p.team === 1 && p.posCode === "CB");
        park(M, [c, t]);
        c.pos.set(0, 0, 0); c.facing = Math.PI; c.vel.set(0, 0, 0); c.protect = 0; M.ball.owner = null; M.dbg.setOwner(c); c.protect = 0;
        t.pos.set(1.1, 0, 0); t.facing = Math.PI; t.vel.set(0, 0, 0); t.tackleCd = 0;
        M.inp.shield = shield;
        M.step(1 / 60);
        M.dbg.tryTackle(t, false);
        run(M, 0.3);
        if (M.G.stats.tackles[1] > 0) won++;
      }
      return won;
    };
    expect(wins(true)).toBeLessThan(wins(false));
  });
  it("legs tire: after a match the outfield players have lost fitness and the keepers have not", () => {
    const M = match({ seed: 6 });
    until(M, () => M.G.phase === "ft", 400);
    const out = M.players.filter((p) => !p.isGK), gk = M.players.filter((p) => p.isGK);
    expect(Math.min(...out.map((p) => p.fit))).toBeLessThan(0.85);
    expect(Math.min(...gk.map((p) => p.fit))).toBeGreaterThan(0.95);
  });
});
