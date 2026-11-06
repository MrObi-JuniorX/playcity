// playcity admin console (docs/whot-cup-prd.md, Phase 3). Plain modules, no framework.
// cup.js is src/cup/config.ts bundled by `npm run build`, so the form and preview use the server's own rules.
import { FIELDS } from "./cup.js";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => (typeof n === "number" ? n.toLocaleString("en-NG") : "–");
const when = (ms) => (ms ? new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "–");
const lagos = (ms) => new Date(ms).toLocaleString([], { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short" });
const main = $("#main");

let me = null, countries = [], editing = null;

const ERR = {
  locked: "Your console is locked. Unlock it with your passkey.", "not-staff": "This account isn't on the staff list.", "not-allowed": "Your role can't do that.",
  stale: "Someone changed this cup since you opened it. Reload to see their changes.", frozen: "Registration has opened, so the settings are frozen.",
  "unpublish-first": "Unpublish the cup before editing it.", "slug-taken": "That web address is taken.", "not-your-own": "You can't countersign a cup you created or last edited.",
  "cancel-needs-refunds": "Cancelling this cup has to refund its entries. Try again in a moment.",
  "publish-first": "Publish the cup first.", "already-over": "This cup is over.",
  "passkey-failed": "The passkey check didn't pass. Try again.", "no-passkey": "No passkey is set up yet.", "name-taken": "A template with that name exists.",
  "not-yourself": "You can't remove yourself.", "no-player": "No player has that id.", "not-a-draft": "Only drafts that were never published can be deleted.",
};
const errText = (j) => (j?.errors?.length ? j.errors.join(" · ") : j?.problems?.length ? j.problems.join(" · ") : ERR[j?.error] || "Something went wrong. Please try again.");

async function api(method, path, body) {
  const r = await fetch(path, { method, credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch {}
  if (r.status === 401 && j.error === "locked" && me?.unlocked) { me.unlocked = false; gate(); }
  return { ok: r.ok, status: r.status, j };
}

/* ---------- passkeys (WebAuthn JSON <-> browser objects) ---------- */
const b64u = {
  dec: (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)).buffer,
  enc: (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
};
async function createPasskey(o) {
  const P = window.PublicKeyCredential;
  if (P?.parseCreationOptionsFromJSON) return (await navigator.credentials.create({ publicKey: P.parseCreationOptionsFromJSON(o) })).toJSON();
  const c = await navigator.credentials.create({ publicKey: { ...o, challenge: b64u.dec(o.challenge), user: { ...o.user, id: b64u.dec(o.user.id) }, excludeCredentials: (o.excludeCredentials || []).map((x) => ({ ...x, id: b64u.dec(x.id) })) } });
  return { id: c.id, rawId: b64u.enc(c.rawId), type: c.type, authenticatorAttachment: c.authenticatorAttachment, clientExtensionResults: c.getClientExtensionResults(),
    response: { clientDataJSON: b64u.enc(c.response.clientDataJSON), attestationObject: b64u.enc(c.response.attestationObject), transports: c.response.getTransports?.() || [] } };
}
async function usePasskey(o) {
  const P = window.PublicKeyCredential;
  if (P?.parseRequestOptionsFromJSON) return (await navigator.credentials.get({ publicKey: P.parseRequestOptionsFromJSON(o) })).toJSON();
  const c = await navigator.credentials.get({ publicKey: { ...o, challenge: b64u.dec(o.challenge), allowCredentials: (o.allowCredentials || []).map((x) => ({ ...x, id: b64u.dec(x.id) })) } });
  return { id: c.id, rawId: b64u.enc(c.rawId), type: c.type, authenticatorAttachment: c.authenticatorAttachment, clientExtensionResults: c.getClientExtensionResults(),
    response: { clientDataJSON: b64u.enc(c.response.clientDataJSON), authenticatorData: b64u.enc(c.response.authenticatorData), signature: b64u.enc(c.response.signature), userHandle: c.response.userHandle ? b64u.enc(c.response.userHandle) : undefined } };
}

/* ---------- gate: phone session → staff → passkey ---------- */
async function gate() {
  const [m, p, cfg] = await Promise.all([api("GET", "/api/console/me"), api("GET", "/api/me"), countries.length ? null : api("GET", "/api/auth/config")]);
  if (cfg?.ok) countries = cfg.j.countries;
  me = m.j.staff ? { ...m.j.staff, passkeys: m.j.passkeys, unlocked: m.j.unlocked, cashEnabled: m.j.cashEnabled } : null;
  $("#nav").hidden = !me?.unlocked; $("#lockBtn").hidden = !me?.unlocked;
  $("#who").textContent = me ? `${me.name || "Staff"} · ${me.roles.join(", ")}` : "";
  document.querySelectorAll("[data-owner]").forEach((b) => (b.hidden = !me?.roles.includes("owner")));
  if (!p.ok) return gateCard("Sign in first", `<p>The console uses your playcity phone sign-in, then a passkey.</p><a class="btn primary" style="display:inline-block;text-decoration:none" href="/account/?next=/console/">Sign in with your phone</a>`);
  if (!me) return gateCard("Not on the staff list", `<p>Ask an owner to add you. They'll need your player id:</p><p class="mono" style="user-select:all">${esc(p.j.player.id)}</p>`);
  if (!me.passkeys) return gateCard("Set up your passkey", `<p>The console needs a passkey on top of your phone sign-in: your fingerprint, face or device PIN. Set one up on this device.</p><button class="btn primary" id="pkReg">Set up a passkey</button><p class="msg" id="pkMsg" role="alert"></p>`, () => ($("#pkReg").onclick = registerKey));
  if (!me.unlocked) return gateCard("Unlock the console", `<p>Confirm it's you with your passkey. The console stays unlocked for 8 hours on this device.</p><button class="btn primary" id="pkUse">Unlock with passkey</button><p class="msg" id="pkMsg" role="alert"></p>`, () => ($("#pkUse").onclick = unlockKey));
  route();
}
function gateCard(title, html, wire) {
  main.innerHTML = `<div class="gate card stack"><h1>${esc(title)}</h1>${html}</div>`;
  wire?.();
}
async function registerKey() {
  const msg = $("#pkMsg"); msg.textContent = ""; msg.className = "msg";
  try {
    const o = await api("POST", "/api/console/passkey/register/options", {});
    if (!o.ok) throw o.j;
    const response = await createPasskey(o.j.options);
    const v = await api("POST", "/api/console/passkey/register/verify", { response, name: navigator.platform || "Passkey" });
    if (!v.ok) throw v.j;
    await unlockKey();
  } catch (e) { msg.textContent = e?.error ? errText(e) : "The passkey wasn't created. Try again, or use a device with a fingerprint, face or PIN unlock."; msg.className = "msg bad"; }
}
async function unlockKey() {
  const msg = $("#pkMsg"); if (msg) { msg.textContent = ""; msg.className = "msg"; }
  try {
    const o = await api("POST", "/api/console/passkey/login/options", {});
    if (!o.ok) throw o.j;
    const v = await api("POST", "/api/console/passkey/login/verify", { response: await usePasskey(o.j.options) });
    if (!v.ok) throw v.j;
    gate();
  } catch (e) { if (msg) { msg.textContent = e?.error ? errText(e) : "The passkey check was cancelled or failed."; msg.className = "msg bad"; } }
}
$("#lockBtn").onclick = async () => { await api("POST", "/api/console/signout", {}); gate(); };

/* ---------- routing ---------- */
function route() {
  if (!me?.unlocked) return;
  const [view, id] = (location.hash.slice(1) || "cups").split("/");
  document.querySelectorAll("#nav button").forEach((b) => b.setAttribute("aria-current", b.dataset.go === (view === "cup" ? "cups" : view) ? "page" : "false"));
  if (view === "cup" && id) return cupView(id);
  ({ cups: cupsView, templates: templatesView, economy: economyView, audit: auditView, staff: staffView }[view] || cupsView)();
}
window.addEventListener("hashchange", route);
$("#nav").onclick = (e) => { const b = e.target.closest("[data-go]"); if (b) location.hash = b.dataset.go; };

/* ---------- dialog ---------- */
function ask(title, html, okLabel = "OK") {
  const d = $("#dlg");
  $("#dlgTitle").textContent = title; $("#dlgBody").innerHTML = html; $("#dlgOk").textContent = okLabel;
  d.showModal();
  return new Promise((res) => { d.onclose = () => res(d.returnValue === "ok" ? Object.fromEntries(new FormData(d.querySelector("form"))) : null); });
}

/* ---------- cups list ---------- */
async function cupsView() {
  main.innerHTML = `<div class="stack"><div class="spread"><h1>Cups</h1><button class="btn primary" id="newCup">New cup</button></div><div class="card scroll" id="list"><p class="muted">Loading…</p></div></div>`;
  const r = await api("GET", "/api/console/cups");
  if (!r.ok) { $("#list").innerHTML = `<p class="msg bad">${esc(errText(r.j))}</p>`; return; }
  const cups = r.j.cups;
  $("#list").innerHTML = cups.length ? `<table><thead><tr><th>Cup</th><th>State</th><th>Round 1</th><th class="num">Seats</th><th class="num">Entry</th><th>Updated</th></tr></thead><tbody>${cups.map((c) => `
    <tr class="link" data-id="${esc(c.id)}"><td><b>${esc(c.name)}</b><br><span class="muted mono">/${esc(c.slug)}</span></td>
    <td><span class="chip ${esc(c.state)}">${esc(c.state)}</span>${c.frozen && (c.state === "scheduled") ? ' <span class="chip frozen">frozen</span>' : ""}</td>
    <td>${esc(when(c.startsAt))}</td><td class="num">${fmt(c.capacity)}</td><td class="num">${fmt(c.entryFee)} ${esc(c.currency)}</td><td>${esc(when(c.updatedAt))}</td></tr>`).join("")}</tbody></table>`
    : `<p class="muted">No cups yet. Start one with “New cup”.</p>`;
  $("#list").onclick = (e) => { const tr = e.target.closest("tr[data-id]"); if (tr) location.hash = `cup/${tr.dataset.id}`; };
  $("#newCup").onclick = () => newCup(cups);
}
async function newCup(cups) {
  const t = await api("GET", "/api/console/templates");
  const opts = [`<option value="">Blank, with the recommended settings</option>`]
    .concat((t.j.templates || []).map((x) => `<option value="t:${esc(x.id)}">Template: ${esc(x.name)}</option>`))
    .concat((cups || []).slice(0, 20).map((c) => `<option value="c:${esc(c.id)}">Copy of: ${esc(c.name)}</option>`));
  const v = await ask("New cup", `<div class="stack"><div class="field"><label for="ncName">Name</label><input id="ncName" name="name" required maxlength="60" value="Saturday Whot Cup"></div>
    <div class="field"><label for="ncFrom">Start from</label><select id="ncFrom" name="from">${opts.join("")}</select></div><p class="muted" style="margin:0">Dates move to the next Saturday. Everything else is copied.</p></div>`, "Create draft");
  if (!v) return;
  const from = v.from?.startsWith("t:") ? { template: v.from.slice(2) } : v.from?.startsWith("c:") ? { cup: v.from.slice(2) } : undefined;
  const r = await api("POST", "/api/console/cups", { name: v.name, from });
  if (r.ok) location.hash = `cup/${r.j.cup.id}`; else alertMsg(errText(r.j));
}
function alertMsg(text) { ask("Couldn't do that", `<p>${esc(text)}</p>`); }

/* ---------- cup editor ---------- */
let worker = null, previewSeq = 0, previewTimer = 0, previewSize = "expected", lastPreview = null;

async function cupView(id) {
  main.innerHTML = `<p class="muted">Loading…</p>`;
  const r = await api("GET", `/api/console/cups/${encodeURIComponent(id)}`);
  if (!r.ok) { main.innerHTML = `<p class="msg bad">${esc(errText(r.j))}</p><p><a href="#cups">Back to cups</a></p>`; return; }
  editing = { cup: r.j.cup, config: structuredClone(r.j.cup.config), dirty: false };
  drawEditor();
}

function readOnly() { const c = editing.cup; return c.frozen || c.state !== "draft" || !me.roles.some((x) => x === "owner" || x === "cup-admin"); }

function drawEditor() {
  const c = editing.cup, ro = readOnly();
  const groups = [...new Set(FIELDS.map((f) => f.group))];
  main.innerHTML = `<div class="stack">
    <div class="spread"><div class="stack" style="gap:6px"><a href="#cups" class="muted" style="text-decoration:none">← Cups</a><h1 id="cupTitle">${esc(c.name)}</h1>
      <div class="row"><span class="chip ${esc(c.state)}">${esc(c.state)}</span>${c.frozen ? '<span class="chip frozen">frozen</span>' : ""}<span class="muted mono">v${c.version}</span>
      ${c.configHash ? `<span class="muted mono" title="SHA-256 of the published settings">#${esc(c.configHash.slice(0, 12))}</span>` : ""}${c.countersignedBy ? '<span class="chip scheduled">countersigned</span>' : ""}<span class="chip home" id="homeChip" ${c.promoted ? "" : "hidden"}>on the home page</span></div></div>
      <div class="row" id="actions"></div></div>
    ${c.frozen ? `<p class="banner">Registration has opened, so these settings are frozen. You can still pause, resume or cancel the cup, and switch its home page banner.</p>` : c.state === "scheduled" ? `<p class="banner">Published. Unpublish to edit; settings freeze when registration opens (${esc(when(c.config.registrationOpensAt))}).</p>` : ""}
    <p class="msg" id="edMsg" role="status"></p>
    <div class="card" id="shareCard"></div>
    <div class="card" id="livePanel" hidden></div>
    <div class="editor"><form id="form" class="stack" novalidate>${groups.map((g) => `<fieldset ${ro ? "disabled" : ""}><legend>${esc(g)}</legend><div class="fields">${FIELDS.filter((f) => f.group === g).map(fieldHtml).join("")}</div></fieldset>`).join("")}</form>
    <aside class="preview stack" id="preview" aria-live="polite"><div class="card"><p class="muted">Working out the payouts…</p></div></aside></div></div>`;
  drawActions(); drawShare();
  if (c.state !== "draft") loadLive();
  $("#form").addEventListener("input", onInput);
  $("#form").addEventListener("change", onInput);
  schedulePreview(0);
}

function fieldHtml(f) {
  const v = editing.config[f.key], id = `f_${f.key}`, t = f.type;
  const help = f.help ? `<div class="help">${esc(f.help)}</div>` : "";
  if (t.kind === "bool") return `<div class="field"><label class="check"><input type="checkbox" id="${id}" data-key="${f.key}" ${v ? "checked" : ""}> ${esc(f.label)}</label>${help}</div>`;
  if (t.kind === "choice") return `<div class="field"><label for="${id}">${esc(f.label)}</label><select id="${id}" data-key="${f.key}">${t.options.map((o) => `<option ${o === v ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>${help}</div>`;
  if (t.kind === "time") return `<div class="field"><label for="${id}">${esc(f.label)}</label><input type="datetime-local" id="${id}" data-key="${f.key}" value="${localInput(v)}"><div class="help" id="${id}_lagos">Lagos: ${esc(lagos(v))}</div>${help}</div>`;
  if (t.kind === "text") return `<div class="field ${f.key === "description" ? "wide" : ""}"><label for="${id}">${esc(f.label)}</label><input id="${id}" data-key="${f.key}" maxlength="${t.max}" value="${esc(v)}">${help}</div>`;
  if (t.kind === "countries") return `<div class="field wide"><label>${esc(f.label)}</label><div class="countries">${countries.map((x) => `<label><input type="checkbox" data-key="${f.key}" data-country="${esc(x.iso)}" ${v.includes(x.iso) ? "checked" : ""}> ${esc(x.iso)}</label>`).join("")}</div>${help}</div>`;
  if (t.kind === "split") return `<div class="field wide"><label>${esc(f.label)}</label><div class="split4">${[0, 1, 2, 3].map((i) => `<input type="number" min="0" max="100" step="1" aria-label="Place ${i + 1}" data-key="${f.key}" data-i="${i}" value="${v[i] ?? ""}">`).join("")}</div>${help}</div>`;
  const step = t.step ?? (t.kind === "num" ? "any" : 1);
  return `<div class="field"><label for="${id}">${esc(f.label)}</label><input type="number" id="${id}" data-key="${f.key}" min="${t.min}" max="${t.max}" step="${step}" value="${v}" inputmode="decimal">${help}</div>`;
}
const localInput = (ms) => { const d = new Date(ms); return new Date(ms - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };

function onInput(e) {
  const el = e.target.closest("[data-key]"); if (!el) return;
  const key = el.dataset.key, f = FIELDS.find((x) => x.key === key), t = f.type, cfg = editing.config;
  if (t.kind === "bool") cfg[key] = el.checked;
  else if (t.kind === "choice" || t.kind === "text") cfg[key] = el.value;
  else if (t.kind === "time") { const ms = new Date(el.value).getTime(); if (Number.isFinite(ms)) { cfg[key] = ms; const l = $(`#f_${key}_lagos`); if (l) l.textContent = `Lagos: ${lagos(ms)}`; } }
  else if (t.kind === "countries") cfg[key] = [...document.querySelectorAll(`[data-key="${key}"]:checked`)].map((x) => x.dataset.country);
  else if (t.kind === "split") {               // 1 to 4 places; empty or 0 trailing places are dropped
    const v = [...document.querySelectorAll(`[data-key="${key}"]`)].map((x) => (x.value === "" ? 0 : Number(x.value)));
    while (v.length > 1 && v.at(-1) === 0) v.pop();
    cfg[key] = v;
  }
  else cfg[key] = el.value === "" ? NaN : Number(el.value);
  if (key === "name") $("#cupTitle").textContent = el.value || "Untitled";
  editing.dirty = true; drawActions(); schedulePreview(350);
}

function drawActions() {
  const c = editing.cup, a = $("#actions"); if (!a) return;
  const admin = me.roles.some((x) => x === "owner" || x === "cup-admin"), fin = me.roles.includes("finance");
  const b = [];
  if (c.state === "draft" && !c.frozen && admin) {
    b.push(`<button class="btn primary" data-act="save" ${editing.dirty ? "" : "disabled"}>Save draft</button>`);
    b.push(`<button class="btn" data-act="publish" ${editing.dirty ? "disabled title='Save first'" : ""}>Publish</button>`);
  }
  if (c.state === "draft" && editing.config.currency === "NGN" && fin && !c.countersignedBy) b.push(`<button class="btn" data-act="countersign" ${editing.dirty ? "disabled" : ""}>Countersign</button>`);
  if (c.state === "scheduled" && !c.frozen && admin) b.push(`<button class="btn" data-act="unpublish">Unpublish</button>`);
  if (admin) b.push(`<button class="btn" data-act="duplicate">Duplicate</button><button class="btn" data-act="template">Save as template</button>`);
  const live = ["registration", "closed", "check-in", "running"].includes(c.state);
  if (live && admin) b.push(`<button class="btn" data-act="pause">${editing.live?.paused ? "Resume" : "Pause"}</button>`);
  if ((c.state === "draft" || c.state === "scheduled" || live) && admin) b.push(`<button class="btn danger" data-act="cancel">Cancel cup</button>`);
  if (c.state === "draft" && !c.publishedAt && admin) b.push(`<button class="btn danger" data-act="delete">Delete</button>`);
  a.innerHTML = b.join("");
  a.onclick = (e) => { const x = e.target.closest("[data-act]"); if (x && !x.disabled) act(x.dataset.act); };
}

async function act(what) {
  const c = editing.cup, msg = $("#edMsg");
  const done = (r, okText) => {
    if (!r.ok) { msg.textContent = errText(r.j); msg.className = "msg bad"; return false; }
    if (r.j.cup) { editing = { cup: r.j.cup, config: structuredClone(r.j.cup.config), dirty: false }; drawEditor(); }
    const m = $("#edMsg"); if (m) { m.textContent = okText; m.className = "msg good"; }
    return true;
  };
  if (what === "save") return done(await api("PUT", `/api/console/cups/${c.id}`, { version: c.version, config: editing.config }), "Saved.");
  if (what === "publish") {
    if (lastPreview?.checks?.length) { msg.textContent = "Fix the publish checks first (see the preview)."; msg.className = "msg bad"; return; }
    if (!(await ask("Publish this cup?", `<p>Players will see it. You can unpublish until registration opens on ${esc(when(c.config.registrationOpensAt))}; then the settings freeze.</p>`, "Publish"))) return;
    return done(await api("POST", `/api/console/cups/${c.id}/publish`, { version: c.version }), "Published.");
  }
  if (what === "unpublish") return done(await api("POST", `/api/console/cups/${c.id}/unpublish`, { version: c.version }), "Back to draft.");
  if (what === "countersign") {
    if (!(await ask("Countersign this naira cup?", `<p>You confirm the money settings as they stand. Any later edit removes your countersign.</p>`, "Countersign"))) return;
    return done(await api("POST", `/api/console/cups/${c.id}/countersign`, { version: c.version }), "Countersigned.");
  }
  if (what === "pause") {
    const r = await api("POST", `/api/console/cups/${c.id}/pause`, { on: !editing.live?.paused });
    if (!r.ok) { msg.textContent = errText(r.j); msg.className = "msg bad"; return; }
    editing.live = r.j.live; drawActions(); drawLive();
    msg.textContent = r.j.live.paused ? "Paused: tables in play finish, no new round starts." : "Resumed."; msg.className = "msg good";
    return;
  }
  if (what === "cancel") {
    const refunds = c.state !== "draft" && c.state !== "scheduled";
    const v = await ask("Cancel this cup?", `${refunds ? "<p>Every player gets back at least what they staked. Nobody hands back winnings already paid.</p>" : ""}<div class="field"><label for="cr">Reason (players see it)</label><input id="cr" name="reason" maxlength="280"></div>`, "Cancel cup");
    if (!v) return;
    return done(await api("POST", `/api/console/cups/${c.id}/cancel`, { version: c.version, reason: v.reason }), "Cancelled.");
  }
  if (what === "delete") {
    if (!(await ask("Delete this draft?", `<p>It has never been published. The audit log keeps a copy of its settings.</p>`, "Delete"))) return;
    const r = await api("DELETE", `/api/console/cups/${c.id}`);
    if (r.ok) location.hash = "cups"; else done(r);
    return;
  }
  if (what === "duplicate") {
    const r = await api("POST", "/api/console/cups", { name: `${c.name} (copy)`, from: { cup: c.id } });
    if (r.ok) location.hash = `cup/${r.j.cup.id}`; else done(r);
    return;
  }
  if (what === "template") {
    const v = await ask("Save as template", `<div class="field"><label for="tn">Template name</label><input id="tn" name="name" required maxlength="60" value="${esc(c.name)}"></div><p class="muted" style="margin:0">Saves the settings as last saved${editing.dirty ? " (save first to include your edits)" : ""}.</p>`, "Save template");
    if (!v) return;
    const r = await api("POST", "/api/console/templates", { name: v.name, fromCup: c.id });
    msg.textContent = r.ok ? "Template saved." : errText(r.j); msg.className = r.ok ? "msg good" : "msg bad";
  }
}

/* ---------- sharing the registration link, and the home page banner ---------- */
function drawShare() {
  const c = editing.cup, box = $("#shareCard"); if (!box) return;
  const admin = me.roles.some((x) => x === "owner" || x === "cup-admin");
  const slug = editing.config.slug || c.slug, url = `${location.origin}/cup/?c=${encodeURIComponent(slug)}`;
  const published = !["draft", "cancelled", "settled"].includes(c.state), over = ["cancelled", "settled"].includes(c.state);
  const canPromote = admin && published;
  box.innerHTML = `<h2>Share and promote</h2>
    <div class="field wide"><label for="regLink">Registration link</label>
      <div class="row"><input id="regLink" readonly value="${esc(url)}" style="flex:1;min-width:0" aria-describedby="regHelp">
        <button class="btn" type="button" id="copyLink" ${published ? "" : "disabled"}>Copy link</button>
        ${navigator.share ? `<button class="btn" type="button" id="shareLink" ${published ? "" : "disabled"}>Share</button>` : ""}
        ${published ? `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Open</a>` : ""}</div>
      <div class="help" id="regHelp">${published ? "Players who open it see the cup page with the Enter button once registration opens. Invite links from players add <span class=\"mono\">&ref=</span> so friends show up on each other's leaderboards." : over ? "This cup is over; the link shows its results." : "The link works once the cup is published. It follows the web address in Identity."}</div></div>
    <label class="check"><input type="checkbox" id="promoteOn" ${c.promoted ? "checked" : ""} ${canPromote ? "" : "disabled"}> Show this cup's banner on the home page</label>
    <div class="help">${published ? "Above the games, for every visitor: the countdown, seats taken and the Enter or Watch button. Switch it on or off any time; it doesn't change the cup. Players already in a cup always see their own." : "Publish the cup to put it on the home page."}</div>
    <p class="msg" id="shareMsg" role="status"></p>`;
  const say = (t, ok = true) => { const m = $("#shareMsg"); m.textContent = t; m.className = ok ? "msg good" : "msg bad"; };
  $("#copyLink").onclick = async () => { try { await navigator.clipboard.writeText(url); say("Link copied."); } catch { $("#regLink").select(); say("Press Ctrl+C or ⌘C to copy the selected link."); } };
  const sh = $("#shareLink"); if (sh) sh.onclick = async () => { try { await navigator.share({ title: c.name, text: `Enter ${c.name} on playcity`, url }); } catch { /* cancelled */ } };
  $("#promoteOn").onchange = async (e) => {
    const on = e.target.checked;
    const r = await api("POST", `/api/console/cups/${c.id}/promote`, { on });
    if (!r.ok) { e.target.checked = !on; say(errText(r.j), false); return; }
    editing.cup = { ...editing.cup, promoted: r.j.cup.promoted };
    say(on ? "The banner is on the home page (it can take a few seconds to show)." : "The banner is off the home page.");
    const chip = $("#homeChip"); if (chip) chip.hidden = !r.j.cup.promoted;
  };
}

/* ---------- a published cup, live ---------- */
async function loadLive() {
  const r = await api("GET", `/api/console/cups/${editing.cup.id}/live`);
  editing.live = r.ok ? r.j.live : null;
  drawActions(); drawLive();
}
function drawLive() {
  const p = $("#livePanel"), l = editing.live; if (!p) return;
  if (!l) { p.hidden = true; return; }
  p.hidden = false;
  p.innerHTML = `<div class="spread"><h2>Live</h2><button class="btn" id="liveRefresh">Refresh</button></div>
    <div class="stats" style="margin-top:10px">
      <div class="stat"><b>${esc(l.phase)}${l.paused ? " · paused" : ""}</b><span>state</span></div>
      <div class="stat"><b class="num">${l.slot || "–"}</b><span>round</span></div>
      <div class="stat"><b class="num">${fmt(l.finished)} / ${fmt(l.tables)}</b><span>tables finished</span></div>
      <div class="stat"><b class="num">${fmt(l.field)}</b><span>players in the field</span></div>
      <div class="stat"><b class="num">${fmt(l.scBuyers)}</b><span>Second Chance buyers</span></div>
      <div class="stat"><b class="num" style="color:${l.late ? "var(--warn)" : "inherit"}">${fmt(l.late)}</b><span>late tables (finished by the clock)</span></div>
    </div>
    ${l.overdue?.length ? `<p class="banner" style="margin-top:10px">Overdue now: <span class="mono">${l.overdue.map(esc).join(", ")}</span></p>` : ""}
    ${l.lateTables?.length ? `<p class="muted" style="margin:10px 0 0;font-size:.85rem">Late: ${l.lateTables.map((t) => `<span class="mono">R${t.slot} ${esc(t.draw)} ${esc(t.code)}</span>`).join(" · ")}</p>` : ""}`;
  $("#liveRefresh").onclick = loadLive;
}

/* ---------- live preview (runs in preview-worker.js) ---------- */
function schedulePreview(ms) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    worker ??= new Worker("./preview-worker.js", { type: "module" });
    worker.onmessage = (e) => { if (e.data.id === previewSeq) { lastPreview = e.data; drawPreview(); } };
    worker.postMessage({ id: ++previewSeq, config: editing.config, ctx: { now: Date.now(), cashEnabled: !!me.cashEnabled, countersigned: !!editing.cup.countersignedBy } });
  }, ms);
}

function drawPreview() {
  const p = lastPreview, box = $("#preview"); if (!box || !p) return;
  document.querySelectorAll(".field.bad").forEach((x) => x.classList.remove("bad"));
  for (const e of p.errors) { const f = FIELDS.find((x) => e.startsWith(x.label + ":")); if (f) document.querySelector(`[data-key="${f.key}"]`)?.closest(".field")?.classList.add("bad"); }
  const checks = p.checks.length
    ? `<h3>Can't publish yet</h3><ul class="problems">${p.checks.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`
    : `<p class="ok">Ready to publish: every check passes.</p>`;
  if (!p.previews.length) { box.innerHTML = `<div class="card stack">${checks}</div>`; return; }
  const cur = p.previews.find((x) => x.size === previewSize) || p.previews[1];
  const s = cur.sim, cfg = editing.config, N = cur.N;
  const pct = (a) => `${Math.round((100 * a) / N)}%`;
  const rows = s.slots.map((sl, i) => `<tr><td class="mono">R${i + 1}</td>${cell(sl.W, true)}<td class="num">${sl.W ? (sl.open ? `${fmt(sl.bought)}/${fmt(sl.lost)}` : "–") : ""}</td>${cell(sl.L, true)}</tr>`).join("");
  box.innerHTML = `<div class="card stack">${checks}</div>
    <div class="card stack">
      <div class="sizes" role="group" aria-label="Field size">${p.previews.map((x) => `<button type="button" class="size" data-size="${x.size}" aria-pressed="${x.size === cur.size}"><span>${x.size}</span><b class="num">${fmt(x.N)}</b><span>${x.sim.rounds} rounds · ~${Math.round(x.minutes / 6) / 10} h</span></button>`).join("")}</div>
      <div class="stats">
        <div class="stat"><b class="num">${fmt(s.champion)}</b><span>champion takes home</span></div>
        <div class="stat"><b class="num">${pct(s.winners)}</b><span>win something</span></div>
        <div class="stat"><b class="num">${pct(s.breakEven)}</b><span>win back their stake</span></div>
        <div class="stat"><b class="num">${fmt(s.platform)}</b><span>platform (${esc(cfg.currency)})</span></div>
      </div>
      <p style="margin:0;font-size:.9rem"><span class="muted">Grand Final:</span> <span class="num">${s.prizes.map(fmt).join(" / ")}</span><br>
        <span class="muted">Second Chance:</span> ${cfg.scEnabled ? `<span class="num">${fmt(s.bought)}</span> buyers at ${Math.round(cfg.scTakeUpEstimate * 100)}% take-up (estimate)` : "off"}</p>
      <div class="scroll"><table class="ladder"><thead>
        <tr><th></th><th class="g-main sep" colspan="4">Main draw</th><th>Buy in</th><th class="g-second sep" colspan="4">Second Chance</th></tr>
        <tr><th>Round</th><th class="sep">Players</th><th>Rule</th><th class="num">1st</th><th class="num">2nd</th><th class="num">of lost</th><th class="sep">Players</th><th>Rule</th><th class="num">1st</th><th class="num">2nd</th></tr></thead>
        <tbody>${rows}<tr><td class="mono">R${s.slots.length + 1}</td><td class="sep" colspan="9">Grand Final: ${s.prizes.map(fmt).join(" / ")}</td></tr></tbody></table></div>
      <p class="muted" style="margin:0;font-size:.82rem">Equal-skill simulation with Second Chance pay frozen the way a real cup freezes it. Real cups pay from the same engine.</p>
    </div>`;
  box.querySelectorAll("[data-size]").forEach((b) => (b.onclick = () => { previewSize = b.dataset.size; drawPreview(); }));
}
const cell = (x, sep) => x
  ? `<td class="num ${sep ? "sep" : ""}">${fmt(x.n)}→${fmt(x.advance)}</td><td>${esc(x.mode)}</td><td class="num">${fmt(x.pay1)}</td><td class="num">${fmt(x.pay2)}</td>`
  : `<td class="${sep ? "sep" : ""} muted" colspan="4">–</td>`;

/* ---------- templates ---------- */
async function templatesView() {
  main.innerHTML = `<div class="stack"><h1>Templates</h1><p class="muted" style="margin:0">Save a template from any cup's page. New cups can start from one.</p><div class="card scroll" id="list"><p class="muted">Loading…</p></div></div>`;
  const r = await api("GET", "/api/console/templates");
  if (!r.ok) { $("#list").innerHTML = `<p class="msg bad">${esc(errText(r.j))}</p>`; return; }
  const t = r.j.templates;
  $("#list").innerHTML = t.length ? `<table><thead><tr><th>Name</th><th class="num">Entry</th><th class="num">Seats</th><th class="num">Second Chance</th><th>Updated</th><th></th></tr></thead><tbody>${t.map((x) => `
    <tr><td><b>${esc(x.name)}</b></td><td class="num">${fmt(x.config.entryFee)} ${esc(x.config.currency)}</td><td class="num">${fmt(x.config.capacity)}</td><td class="num">${x.config.scEnabled ? fmt(x.config.scFee) : "off"}</td><td>${esc(when(x.updated_at))}</td>
    <td><button class="btn danger" data-del="${esc(x.id)}" data-name="${esc(x.name)}">Delete</button></td></tr>`).join("")}</tbody></table>` : `<p class="muted">No templates yet.</p>`;
  $("#list").onclick = async (e) => {
    const b = e.target.closest("[data-del]"); if (!b) return;
    if (!(await ask("Delete template?", `<p>${esc(b.dataset.name)}. Cups made from it keep their settings.</p>`, "Delete"))) return;
    const d = await api("DELETE", `/api/console/templates/${b.dataset.del}`);
    if (d.ok) templatesView(); else alertMsg(errText(d.j));
  };
}

/* ---------- economy ---------- */
async function economyView() {
  const r = await api("GET", "/api/console/economy");
  const e = r.j.economy || {}, canEdit = me.roles.some((x) => x === "owner" || x === "finance");
  const f = (k, label, help) => `<div class="field"><label for="e_${k}">${esc(label)}</label><input type="number" id="e_${k}" name="${k}" value="${e[k]}" step="1" ${canEdit ? "" : "disabled"}><div class="help">${esc(help)}</div></div>`;
  main.innerHTML = `<div class="stack" style="max-width:720px"><h1>Coin economy</h1><p class="muted" style="margin:0">Applies to every player. Changes reach all servers within a minute.</p>
    <form class="card stack" id="eco"><div class="fields">
      ${f("coinWelcomeGrant", "Welcome grant", "Coins a new wallet starts with.")}${f("coinDailyTopUp", "Daily top-up", "Free coins each day.")}
      ${f("coinBalanceCap", "Balance cap", "Grants never take a wallet above this.")}${f("topUpHourLagos", "Top-up hour (Lagos)", "0–23. The day's coins arrive from this hour.")}
    </div>${canEdit ? `<div class="row"><button class="btn primary">Save</button></div>` : `<p class="muted" style="margin:0">Owners and finance can change these.</p>`}<p class="msg" id="ecoMsg" role="status"></p></form></div>`;
  $("#eco").onsubmit = async (ev) => {
    ev.preventDefault();
    const body = Object.fromEntries([...new FormData(ev.target)].map(([k, v]) => [k, Number(v)]));
    const s = await api("PUT", "/api/console/economy", body);
    $("#ecoMsg").textContent = s.ok ? "Saved." : errText(s.j); $("#ecoMsg").className = s.ok ? "msg good" : "msg bad";
  };
}

/* ---------- audit ---------- */
async function auditView(before) {
  if (!before) main.innerHTML = `<div class="stack"><h1>Audit log</h1><div class="row"><input id="aTarget" placeholder="Filter by target, e.g. cup:…" style="max-width:360px"><button class="btn" id="aGo">Filter</button></div><div class="card scroll"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Before</th><th>After</th></tr></thead><tbody id="aRows"></tbody></table><button class="btn" id="aMore" hidden style="margin-top:10px">Show older</button></div></div>`;
  const target = $("#aTarget").value.trim();
  const q = new URLSearchParams(); if (before) q.set("before", before); if (target) q.set("target", target);
  const r = await api("GET", `/api/console/audit?${q}`);
  if (!before) $("#aRows").innerHTML = "";
  const j = (v) => (v === null ? '<span class="muted">–</span>' : `<pre class="json">${esc(JSON.stringify(v, null, 1))}</pre>`);
  $("#aRows").insertAdjacentHTML("beforeend", (r.j.entries || []).map((e) => `<tr><td>${esc(when(e.at))}</td><td>${esc(e.actorName || e.actor)}</td><td class="mono">${esc(e.action)}</td><td class="mono"><a href="#" data-target="${esc(e.target)}">${esc(e.target)}</a></td><td>${j(e.before)}</td><td>${j(e.after)}</td></tr>`).join(""));
  const more = $("#aMore"); more.hidden = !r.j.more;
  more.onclick = () => auditView(r.j.entries.at(-1).id);
  $("#aGo").onclick = () => auditView();
  $("#aRows").onclick = (ev) => { const a = ev.target.closest("[data-target]"); if (a) { ev.preventDefault(); $("#aTarget").value = a.dataset.target; auditView(); } };
}

/* ---------- staff (owners) ---------- */
const ROLE_NAMES = { owner: "Owner", "cup-admin": "Cup admin", integrity: "Integrity", finance: "Finance" };
async function staffView() {
  const r = await api("GET", "/api/console/staff");
  if (!r.ok) { main.innerHTML = `<p class="msg bad">${esc(errText(r.j))}</p>`; return; }
  main.innerHTML = `<div class="stack" style="max-width:900px"><h1>Staff</h1>
    <div class="card scroll"><table><thead><tr><th>Name</th><th>Player id</th><th>Roles</th><th></th></tr></thead><tbody>${r.j.staff.map((s) => `
      <tr><td><b>${esc(s.name || "–")}</b> <span class="muted">••${esc(s.phoneLast2)}</span></td><td class="mono" style="user-select:all">${esc(s.playerId)}</td><td>${s.roles.map((x) => esc(ROLE_NAMES[x] || x)).join(", ")}</td>
      <td>${s.playerId === me.playerId ? "" : `<button class="btn danger" data-rm="${esc(s.playerId)}">Remove</button>`}</td></tr>`).join("")}</tbody></table>
      ${r.j.bootstrapOwners.length ? `<p class="muted" style="margin:10px 0 0;font-size:.85rem">Also owners through OWNER_PLAYER_IDS: <span class="mono">${r.j.bootstrapOwners.map(esc).join(", ")}</span></p>` : ""}</div>
    <form class="card stack" id="addStaff"><h2>Add or change staff</h2>
      <div class="field"><label for="sp">Player id</label><input id="sp" name="playerId" required class="mono" placeholder="They see it on the console's sign-in page"></div>
      <div class="row">${Object.entries(ROLE_NAMES).map(([k, v]) => `<label class="row" style="gap:6px;font-weight:600"><input type="checkbox" name="role" value="${k}"> ${esc(v)}</label>`).join("")}</div>
      <div class="row"><button class="btn primary">Save</button></div><p class="msg" id="stMsg" role="status"></p></form></div>`;
  $("#addStaff").onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const s = await api("PUT", "/api/console/staff", { playerId: String(fd.get("playerId")).trim(), roles: fd.getAll("role") });
    if (s.ok) staffView(); else { $("#stMsg").textContent = errText(s.j); $("#stMsg").className = "msg bad"; }
  };
  main.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = async () => {
    if (!(await ask("Remove from staff?", "<p>Their console access ends at once.</p>", "Remove"))) return;
    const d = await api("DELETE", `/api/console/staff/${b.dataset.rm}`);
    if (d.ok) staffView(); else alertMsg(errText(d.j));
  }));
}

gate();
