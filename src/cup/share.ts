import { fail } from "../http";
import type { AuthEnv } from "../auth/env";

/* Share cards (docs/whot-cup-prd.md PX-5): "I'm in", "reached round N", "champion". Rendered on demand at the edge
   as SVG from the player's own record in that cup. The browser turns it into a PNG and shares it as an image (WhatsApp
   and X don't preview SVG links), and the link it carries opens the cup with the player as the inviter, which is
   what makes them friends on the leaderboard.
     GET /api/cups/:slug/card/:player    the card (SVG, edge-cached a minute)
     GET /s/:slug/:player                the link people tap: a page with a link preview that opens the cup */

const ID = /^[0-9a-f-]{36}$/;
// The avatar colours, as the account page draws them (public/account/index.html).
const COLORS: Record<string, string> = { maroon: "#b0303f", gold: "#ffc247", green: "#3fa054", blue: "#3b7dd8", purple: "#8a5cd6", orange: "#f08a2c", teal: "#2aa6a0", pink: "#e2649a" };
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const PLACE = ["", "1st", "2nd", "3rd", "4th"];

interface Card { cup: string; name: string; color: string; shape: string; headline: string; detail: string; won: number }

async function cardOf(env: AuthEnv, slug: string, player: string): Promise<Card | null> {
  if (!ID.test(player)) return null;
  const r = await env.DB.prepare(`SELECT c.id, c.name AS cup, c.state AS cup_state, json_extract(c.config_json, '$.startsAt') AS starts, p.name, p.avatar_shape, p.avatar_color, g.state, g.finish,
      (SELECT COALESCE(SUM(amount), 0) FROM ledger WHERE cup_id = c.id AND player_id = p.id AND kind IN ('table_pay', 'gf_prize')) AS won,
      (SELECT MAX(t.slot) FROM table_results t, json_each(t.places_json) j WHERE t.cup_id = c.id AND j.value = p.id AND t.draw <> 'GF') AS reached
    FROM cups c JOIN registrations g ON g.cup_id = c.id JOIN players p ON p.id = g.player_id WHERE c.slug = ? AND p.id = ?`).bind(slug, player)
    .first<{ cup: string; cup_state: string; starts: number; name: string | null; avatar_shape: string | null; avatar_color: string | null; state: string; finish: string | null; won: number; reached: number | null }>();
  if (!r || ["refunded", "no-show"].includes(r.state) || ["draft", "cancelled"].includes(r.cup_state)) return null;
  const f = r.finish ?? "";
  let headline = "I'm in", detail = `The cup starts ${new Date(r.starts).toUTCString().slice(0, 22)} GMT`;
  if (f === "champion") { headline = "Champion!"; detail = "Won the Grand Final"; }
  else if (/^grand-final-\d$/.test(f)) { headline = `${PLACE[Number(f.slice(-1))]} in the Grand Final`; detail = "One of the last four"; }
  else if (/^main-r\d+$/.test(f)) { headline = `Reached round ${f.slice(6)}`; detail = "In the main draw"; }
  else if (/^sc-slot\d+$/.test(f)) { headline = `Reached round ${r.reached ?? f.slice(7)}`; detail = "Fought on in Second Chance"; }
  else if (r.reached) { headline = `Through round ${r.reached}`; detail = "Still in the cup"; }
  return { cup: r.cup, name: r.name || "A player", color: COLORS[r.avatar_color ?? ""] ?? COLORS.gold, shape: r.avatar_shape ?? "star", headline, detail, won: r.won };
}

const SHAPES: Record<string, string> = {
  circle: '<circle cx="0" cy="0" r="46"/>',
  triangle: '<path d="M0 -50 L48 36 L-48 36 Z"/>',
  cross: '<path d="M-16 -50h32v34h34v32h-34v34h-32v-34h-34v-32h34z"/>',
  square: '<rect x="-42" y="-42" width="84" height="84" rx="6"/>',
  star: '<path d="M0 -52 L14 -16 L52 -16 L21 7 L33 45 L0 22 L-33 45 L-21 7 L-52 -16 L-14 -16 Z"/>',
};

export function cardSvg(c: Card, host: string): string {
  const font = "'Bricolage Grotesque','Trebuchet MS',system-ui,sans-serif";
  const coins = c.won > 0 ? `<text x="96" y="470" font-family="${font}" font-size="34" font-weight="700" fill="#7fd69a">+${c.won.toLocaleString("en-NG")} coins won</text>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${esc(`${c.name}: ${c.headline}, ${c.cup}`)}">
<defs><radialGradient id="g" cx="50%" cy="0%" r="80%"><stop offset="0" stop-color="#b0303f" stop-opacity=".45"/><stop offset="1" stop-color="#0b1316" stop-opacity="0"/></radialGradient></defs>
<rect width="1200" height="630" fill="#0b1316"/><rect width="1200" height="630" fill="url(#g)"/>
<g transform="translate(1010 170)" fill="${c.color}">${SHAPES[c.shape] ?? SHAPES.star}</g>
<text x="96" y="132" font-family="${font}" font-size="30" font-weight="600" fill="#9bb2ad" letter-spacing="2">${esc(c.cup.toUpperCase().slice(0, 40))}</text>
<text x="96" y="250" font-family="${font}" font-size="96" font-weight="800" fill="#eef4f0">${esc(c.headline)}</text>
<text x="96" y="330" font-family="${font}" font-size="44" font-weight="700" fill="#ffc247">${esc(c.name)}</text>
<text x="96" y="398" font-family="${font}" font-size="34" fill="#9bb2ad">${esc(c.detail)}</text>
${coins}
<text x="96" y="566" font-family="${font}" font-size="30" font-weight="700" fill="#eef4f0">Play Whot with me on playcity · ${esc(host)}</text>
</svg>`;
}

export async function shareCardRoute(env: AuthEnv, req: Request, slug: string, player: string): Promise<Response> {
  const c = await cardOf(env, slug, player);
  if (!c) return fail(404, "no-card");
  return new Response(cardSvg(c, new URL(req.url).host), { headers: { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "public, max-age=60", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" } });
}

/** The link in a share: a small page whose preview says what happened, and that opens the cup with this player as
    the inviter. */
export async function sharePage(env: AuthEnv, req: Request, slug: string, player: string): Promise<Response> {
  const c = await cardOf(env, slug, player);
  const origin = new URL(req.url).origin;
  const to = c ? `/cup/?c=${encodeURIComponent(slug)}&ref=${encodeURIComponent(player)}` : "/";
  const title = c ? `${c.name}: ${c.headline}` : "playcity";
  const desc = c ? `${c.cup} on playcity. ${c.detail}. Come and play Whot.` : "Quick games for friends.";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(origin + new URL(req.url).pathname)}"><meta property="og:image" content="${esc(origin)}/icons/icon-512.png">
<meta name="twitter:card" content="summary"><meta http-equiv="refresh" content="0; url=${esc(to)}">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1316;color:#eef4f0;font:16px system-ui,sans-serif}a{color:#ffc247}</style></head>
<body><p><a href="${esc(to)}">${esc(c ? `Open ${c.cup}` : "Open playcity")}</a></p></body></html>`;
  return new Response(html, { status: c ? 200 : 404, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60" } });
}
