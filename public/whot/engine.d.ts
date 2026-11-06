/* Types for the Worker side of engine.js. Not uploaded: public/.assetsignore skips *.d.ts. */
export interface Card { id: number; shape: string; n: number }
export interface Player { name: string; type: "human" | "cpu"; hand: Card[] }
export interface LogLine { msg: string; kind: string }
export interface WhotEvent { type: "draw" | "play" | "reshuffle"; player?: number; id?: number; at?: number; cards?: Card[]; moved?: number }
export interface Game {
  players: Player[]; market: Card[]; discard: Card[]; current: number;
  shape: string; pending: { n: number; amount: number } | null; hold: boolean; checkup: { player: number } | null;
  over: boolean; winner: number | null; losers: number[]; stalemate: boolean;
  log: LogLine[]; events: WhotEvent[]; passes: number; turns: number; starter: number;
}
export type Move = { type: "play"; cardId: number | number[]; shape?: string } | { type: "market" };
export interface Result { ok: boolean; reason?: string }

export const SHAPES: string[];
export const DECK_SIZE: number;
export const LOG_KEEP: number;
export function rand(n: number): number;
export function clumps(cards: Card[], after?: Card): number;
export function say(s: Game, msg: string, kind?: string): void;
export function newGame(seats: { name: string; type: "human" | "cpu" }[], starter: number): Game;
export function play(s: Game, ids: number | number[], shape?: string): Result;
export function market(s: Game): Result;
export function aiMove(s: Game): Move;
export function aiMoveFair(s: Game): Move;
export function applyMove(s: Game, mv: Move): Result;
export function hiddenId(seat: number, at: number): number;
export function seatView(s: Game, seat: number | null): Record<string, unknown>;
export function seatEvents(events: WhotEvent[], seat: number | null, over: boolean): WhotEvent[];
export function adoptState(x: unknown, names: { name: string; type: "human" | "cpu" }[]): Game | null;
export function tourPlan(s: Game, out: number): { mode: "none" | "round" | "tie" | "final" | "rematch"; elim: number[] };
