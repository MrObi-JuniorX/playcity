/* Small HTTP helpers shared by the API routes. */

export type Json = Record<string, unknown>;

export const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
export const fail = (status: number, error: string, extra: Json = {}) => json({ error, ...extra }, status);

export const ipOf = (req: Request) => req.headers.get("CF-Connecting-IP") || "";

/** Writes only from our own pages: our own Origin, and a JSON body for anything that carries one (a DELETE
    carries none). With SameSite cookies this closes CSRF. */
export function sameOrigin(req: Request): boolean {
  const o = req.headers.get("Origin");
  if (!o || o !== new URL(req.url).origin) return false;
  return req.method === "DELETE" || (req.headers.get("Content-Type") || "").startsWith("application/json");
}

/** A JSON object body up to `max` bytes, or null. */
export async function readJson(req: Request, max = 4096): Promise<Json | null> {
  const t = await req.text();
  if (t.length > max) return null;
  try { const v = JSON.parse(t); return v && typeof v === "object" && !Array.isArray(v) ? v as Json : null; } catch { return null; }
}
