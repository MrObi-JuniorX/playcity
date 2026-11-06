import { describe, it, expect, vi } from "vitest";
import * as W from "../../public/whot/engine.js";

const seats = n => Array.from({ length: n }, (_, i) => ({ name: "P" + i, type: "cpu" }));
const allIds = g => [...g.market, ...g.discard, ...g.players.flatMap(p => p.hand)].map(c => c.id);

/* Play a whole game with the computer in every seat, calling check(before, after, events, actor) after each move. */
function playOut(n, check) {
  const g = W.newGame(seats(n), W.rand(n));
  let moves = 0;
  while (!g.over && moves < 2000) {
    const actor = g.current, before = JSON.parse(JSON.stringify(g));
    g.events = [];
    const r = W.applyMove(g, W.aiMove(g));
    expect(r.ok).toBe(true);
    if (check) check(before, g, g.events, actor);
    moves++;
  }
  return { g, moves };
}

describe("whot engine", () => {
  it("finishes 300 computer games of 2 to 4 seats, never losing or copying a card", () => {
    for (let k = 0; k < 300; k++) {
      const n = 2 + (k % 3);
      const { g } = playOut(n, (_b, a) => {
        const ids = allIds(a);
        expect(ids.length).toBe(W.DECK_SIZE);
        expect(new Set(ids).size).toBe(W.DECK_SIZE);
      });
      expect(g.over).toBe(true);
      expect(g.losers.length).toBeGreaterThan(0);
      expect(g.losers.includes(g.winner)).toBe(false);
    }
  });

  it("a seat's view holds only its own cards; watchers see none until the round ends", () => {
    for (let k = 0; k < 40; k++) {
      playOut(4, (_b, g) => {
        for (const seat of [null, 0, 1, 2, 3]) {
          const v = W.seatView(g, seat);
          expect(v.market).toBeUndefined();
          expect(v.mk).toBe(g.market.length);
          expect(v.discard.length).toBeLessThanOrEqual(2);
          v.players.forEach((p, i) => {
            if (g.over || i === seat) expect(p.hand.map(c => c.id)).toEqual(g.players[i].hand.map(c => c.id));
            else { expect(p.hand).toBeUndefined(); expect(p.count).toBe(g.players[i].hand.length); }
          });
        }
      });
    }
  });

  it("someone else's draw lands on a face-down card that is in the next view, at the same place", () => {
    for (let k = 0; k < 120; k++) {
      playOut(2 + (k % 3), (_b, g, events) => {
        for (let seat = 0; seat < g.players.length; seat++) {
          const view = W.hydrate(W.seatView(g, seat));
          const evs = W.seatEvents(events, seat, g.over);
          for (const e of evs.filter(e => e.type === "draw")) {
            const hand = view.players[e.player].hand.map(c => c.id);
            expect(hand).toContain(e.id);                                         // the card to animate exists
            if (e.player !== seat && !g.over) expect(e.id).toBeLessThan(0);      // and gives nothing away
          }
          const draws = evs.filter(e => e.type === "draw");
          expect(new Set(draws.map(e => e.id)).size).toBe(draws.length);        // no two draws share a card
        }
      });
    }
  });

  it("takes over a game in progress from a browser, and refuses tampered ones", () => {
    const names = [{ name: "Ada", type: "human" }, { name: "Computer", type: "cpu" }, { name: "Computer 2", type: "cpu" }];
    const g = W.newGame(names, 1);
    for (let i = 0; i < 6 && !g.over; i++) W.applyMove(g, W.aiMove(g));
    if (g.over) return;
    const sent = JSON.parse(JSON.stringify(g));
    const s = W.adoptState(sent, names);
    expect(s).not.toBe(null);
    expect(s.players.map(p => p.hand.map(c => c.id))).toEqual(g.players.map(p => p.hand.map(c => c.id)));
    expect(s.current).toBe(g.current);

    const twice = JSON.parse(JSON.stringify(g)); twice.players[0].hand.push(twice.market[0]);
    expect(W.adoptState(twice, names)).toBe(null);
    const missing = JSON.parse(JSON.stringify(g)); missing.market.pop();
    expect(W.adoptState(missing, names)).toBe(null);
    const forged = JSON.parse(JSON.stringify(g)); forged.players[0].hand[0] = { id: forged.players[0].hand[0].id, shape: "whot", n: 20 };
    expect(W.adoptState(forged, names).players[0].hand[0]).toEqual(W.buildDeck()[g.players[0].hand[0].id]);   // ids only: the face comes from the deck
    expect(W.adoptState({ ...JSON.parse(JSON.stringify(g)), over: true }, names)).toBe(null);
    expect(W.adoptState(JSON.parse(JSON.stringify(g)), names.slice(0, 2))).toBe(null);
  });

  it("uses only the crypto-backed random source", async () => {
    const src = await import("node:fs").then(fs => fs.readFileSync(new URL("../../public/whot/engine.js", import.meta.url), "utf8"));
    expect(src.match(/Math\.random\(\)/g)?.length ?? 0).toBe(1);   // only the fallback when crypto is missing
  });
});

describe("the computer plays fair", () => {
  /* Same random numbers for each comparison, so the only thing that can change a decision is information. */
  let seed = 1;
  const spy = () => vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(a => {
    for (let i = 0; i < a.length; i++) { seed = (seed * 1103515245 + 12345) >>> 0; a[i] = seed; }
    return a;
  });
  const same = (g, f) => { const s0 = 777 + g.turns; seed = s0; const a = f(); return a; };

  it("never uses anyone else's cards or the market order: hiding or swapping them never changes its move", () => {
    const sp = spy();
    try {
      let checked = 0;
      for (let k = 0; k < 120; k++) {
        const n = 2 + (k % 3);
        seed = 1000 + k;
        const g = W.newGame(seats(n), k % n);
        let moves = 0;
        while (!g.over && moves++ < 400) {
          const full = same(g, () => W.aiMove(g));
          const blind = same(g, () => W.aiMoveFair(g));
          // Secretly redeal every card the computer cannot see: other hands and the market, same counts.
          const sw = JSON.parse(JSON.stringify(g)), me = sw.current;
          const hidden = [...sw.market, ...sw.players.filter((_, i) => i !== me).flatMap(p => p.hand)].reverse();
          let at = 0;
          sw.players.forEach((p, i) => { if (i !== me) p.hand = p.hand.map(() => hidden[at++]); });
          sw.market = sw.market.map(() => hidden[at++]);
          const swapped = same(g, () => W.aiMove(sw));
          expect(blind).toEqual(full);
          expect(swapped).toEqual(full);
          checked++;
          seed = 5000 + moves; W.applyMove(g, full);
        }
      }
      expect(checked).toBeGreaterThan(3000);
    } finally { sp.mockRestore(); }
  });

  it("the server and the offline game only ever ask for a move through the blinded view", async () => {
    const fs = await import("node:fs");
    const read = f => fs.readFileSync(new URL(f, import.meta.url), "utf8");
    for (const f of ["../../src/whot.ts", "../../public/whot/app.js"]) {
      const src = read(f);
      expect(src).not.toMatch(/\baiMove\(/);          // never the full-state version
      expect(src).toMatch(/aiMoveFair\(/);
    }
  });
});

describe("whot knock-out rounds", () => {
  const over = (types, winner, losers) => {
    const g = W.newGame(types.map((type, i) => ({ name: "P" + i, type })), 0);
    g.over = true; g.winner = winner; g.losers = losers;
    return g;
  };
  it("knocks out the loser when three or more play and at least two are people", () => {
    expect(W.tourPlan(over(["human", "human", "cpu"], 0, [1]), 0)).toEqual({ mode: "round", elim: [1] });
    expect(W.tourPlan(over(["human", "cpu", "human", "cpu"], 2, [3]), 0)).toEqual({ mode: "round", elim: [3] });
  });
  it("is an ordinary rematch for two players, or one person against the computer", () => {
    expect(W.tourPlan(over(["human", "human"], 0, [1]), 0).mode).toBe("rematch");
    expect(W.tourPlan(over(["human", "cpu", "cpu"], 0, [1]), 0).mode).toBe("rematch");
  });
  it("calls the last two players' round the final, once somebody has gone out", () => {
    expect(W.tourPlan(over(["human", "human"], 0, [1]), 1).mode).toBe("final");
  });
  it("sends nobody out when that would leave fewer than two, or no person", () => {
    expect(W.tourPlan(over(["human", "human", "cpu"], 2, [0, 1]), 0).mode).toBe("tie");
    expect(W.tourPlan(over(["human", "human", "cpu", "cpu"], 2, [0, 1]), 0).mode).toBe("tie");
    expect(W.tourPlan(over(["human", "human", "cpu"], 0, [1, 2]), 0).mode).toBe("tie");
  });
  it("says nothing while a round is still being played", () => {
    expect(W.tourPlan(W.newGame(seats(3), 0), 0).mode).toBe("none");
  });
});

describe("shuffling", () => {
  const pairs = hand => { const c = {}; for (const x of hand) c[x.n] = (c[x.n] || 0) + 1; return Object.values(c).reduce((a, v) => a + v * (v - 1) / 2, 0); };
  // In a fair deal, a 5-card hand holds C(5,2) * P(two cards share a number) same-number pairs on average.
  const counts = W.buildDeck().reduce((m, c) => (m[c.n] = (m[c.n] || 0) + 1, m), {});
  const fairPairs = 10 * Object.values(counts).reduce((a, v) => a + v * (v - 1), 0) / (54 * 53);

  it("deals hands as a fair deck would, whatever the number of players", () => {
    for (const n of [2, 3, 4]) {
      let sum = 0, whots = 0, hands = 0;
      for (let k = 0; k < 6000; k++) {
        for (const p of W.newGame(seats(n), k % n).players) { sum += pairs(p.hand); whots += p.hand.filter(c => c.n === 20).length; hands++; }
      }
      expect(Math.abs(sum / hands - fairPairs)).toBeLessThan(0.04);         // about 5 standard errors
      expect(Math.abs(whots / hands - 25 / 54)).toBeLessThan(0.03);
    }
  });

  it("never leaves two cards of one number side by side in the market after the deal", () => {
    for (let k = 0; k < 2000; k++) {
      const g = W.newGame(seats(2 + (k % 3)), 0);
      expect(W.clumps(g.market)).toBe(0);
      expect([1, 2, 5, 8, 14, 20]).not.toContain(g.discard[0].n);           // the start card is an ordinary one
    }
  });

  it("picks every allowed market order equally often, and minds the seam with the cards below", () => {
    const deck = W.buildDeck();
    const two = deck.filter(c => c.n === 2).slice(0, 2), seven = deck.find(c => c.n === 7), eight = deck.find(c => c.n === 8);
    const tally = new Map();
    const N = 24000;
    for (let i = 0; i < N; i++) {
      const out = W.shuffleMarket([two[0], two[1], seven, eight], deck.find(c => c.n === 8 && c.id !== eight.id));
      expect(W.clumps(out, { n: 8 })).toBe(0);
      const key = out.map(c => c.id).join(",");
      tally.set(key, (tally.get(key) || 0) + 1);
    }
    // Of the 24 orders, 10 keep the 2s apart and the 8 off the end: the 2s at 1st and 3rd (then the 7 is last), or at
    // 1st and 4th, or 2nd and 4th (7 and 8 either way round), times the two orders of the 2s. Each should come up a tenth of the time.
    const allowed = [...tally.keys()];
    expect(allowed.length).toBe(10);
    for (const k of allowed) expect(Math.abs(tally.get(k) - N / 10)).toBeLessThan(N / 10 * 0.12);
  });

  it("settles for the fewest clumps when none-free is impossible, without hanging", () => {
    const twos = W.buildDeck().filter(c => c.n === 2).slice(0, 3);
    const out = W.shuffleMarket([...twos, W.buildDeck()[0]]);
    expect(out.length).toBe(4);
    expect(W.clumps(out)).toBe(1);
  });

  it("draws its randomness from crypto in batches", () => {
    const spy = vi.spyOn(globalThis.crypto, "getRandomValues");
    try {
      for (let k = 0; k < 200; k++) W.newGame(seats(2 + (k % 3)), 0);
      expect(spy.mock.calls.length / 200).toBeLessThan(10);                   // one number per call would be thousands
    } finally { spy.mockRestore(); }
  });
});
