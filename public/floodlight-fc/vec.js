/* A small 3D vector, just the operations the match engine uses, so the engine runs without three.js (and so in Node tests). */
export class V3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new V3(this.x, this.y, this.z); }
  setY(y) { this.y = y; return this; }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  subVectors(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  divideScalar(s) { return this.multiplyScalar(1 / s); }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  length() { return Math.sqrt(this.lengthSq()); }
  normalize() { const l = this.length(); return l > 0 ? this.multiplyScalar(1 / l) : this; }
  setLength(l) { return this.normalize().multiplyScalar(l); }
  distanceTo(v) { const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z; return Math.sqrt(dx * dx + dy * dy + dz * dz); }
  lerp(v, t) { this.x += (v.x - this.x) * t; this.y += (v.y - this.y) * t; this.z += (v.z - this.z) * t; return this; }
  lerpVectors(a, b, t) { this.x = a.x + (b.x - a.x) * t; this.y = a.y + (b.y - a.y) * t; this.z = a.z + (b.z - a.z) * t; return this; }
}
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const angDiff = (a, b) => { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d; };
/* Seeded random numbers, so a match (or a squad) can be replayed exactly. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
