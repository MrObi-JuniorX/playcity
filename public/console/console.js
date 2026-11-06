// playcity admin console (docs/whot-cup-prd.md, Phase 3). Plain modules, no framework.
// cup.js is src/cup/config.ts bundled by `npm run build`, so the form and preview use the server's own rules.
import { defaultCupConfig, FIELDS, SECTIONS } from "./cup.js";

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
  if (me?.unlocked) return route();
  if (m.j.codeEnabled) return gateCard("Enter the console code", `<form class="stack" id="codeForm"><input id="codeIn" type="password" inputmode="numeric" autocomplete="off" aria-label="Console code" required><button class="btn primary">Unlock</button><p class="msg" id="codeMsg" role="alert"></p></form>`, wireCode);
  if (!p.ok) return gateCard("Sign in first", `<p>The console uses your playcity phone sign-in, then a passkey.</p><a class="btn primary" style="display:inline-block;text-decoration:none" href="/account/?next=/console/">Sign in with your phone</a>`);
  if (!me) return gateCard("Not on the staff list", `<p>Ask an owner to add you. They'll need your player id:</p><p class="mono" style="user-select:all">${esc(p.j.player.id)}</p>`);
  if (!me.passkeys) return gateCard("Set up your passkey", `<p>The console needs a passkey on top of your phone sign-in: your fingerprint, face or device PIN. Set one up on this device.</p><button class="btn primary" id="pkReg">Set up a passkey</button><p class="msg" id="pkMsg" role="alert"></p>`, () => ($("#pkReg").onclick = registerKey));
  if (!me.unlocked) return gateCard("Unlock the console", `<p>Confirm it's you with your passkey. The console stays unlocked for 8 hours on this device.</p><button class="btn primary" id="pkUse">Unlock with passkey</button><p class="msg" id="pkMsg" role="alert"></p>`, () => ($("#pkUse").onclick = unlockKey));
  route();
}
function wireCode() {
  $("#codeIn").focus();
  $("#codeForm").onsubmit = async (e) => {
    e.preventDefault();
    const r = await api("POST", "/api/console/code", { code: $("#codeIn").value });
    if (r.ok) return gate();
    $("#codeIn").value = ""; $("#codeIn").focus();
    $("#codeMsg").className = "msg bad";
    $("#codeMsg").textContent = r.j.error === "code-locked" ? "Too many wrong tries. Try again later." : r.j.error === "code-wrong" ? "That code isn't right." : "Something went wrong. Please try again.";
  };
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
  closeTip();
  document.querySelectorAll("#nav button").forEach((b) => b.setAttribute("aria-current", b.dataset.go === (view === "cup" ? "cups" : view) ? "page" : "false"));
  if (view === "cup" && id) return cupView(id);
  if (view === "model") return modelView(id);
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
const CUP_GROUPS = [
  ["Live now", ["registration", "closed", "check-in", "running", "finals", "settling", "paused"]],
  ["Published", ["scheduled"]],
  ["Drafts", ["draft"]],
  ["Finished", ["settled", "cancelled"]],
];
async function cupsView() {
  main.innerHTML = `<div class="stack"><div class="spread"><div class="pagehead"><h1>Cups</h1><p>A cup starts as a draft. Once published, players can see it. Its settings freeze when registration opens.</p></div><button class="btn primary" id="newCup">New cup</button></div><div class="card scroll" id="list"><p class="muted">Loading…</p></div></div>`;
  const r = await api("GET", "/api/console/cups");
  if (!r.ok) { $("#list").innerHTML = `<p class="msg bad">${esc(errText(r.j))}</p>`; return; }
  const cups = r.j.cups;
  const known = new Set(CUP_GROUPS.flatMap(([, states]) => states));
  const row = (c) => `<tr class="link" data-id="${esc(c.id)}"><td><b>${esc(c.name)}</b><br><span class="muted mono">/${esc(c.slug)}</span></td>
    <td><span class="chip ${esc(c.state)}">${esc(c.state)}</span>${c.frozen && (c.state === "scheduled") ? ' <span class="chip frozen">frozen</span>' : ""}</td>
    <td>${esc(when(c.startsAt))}</td><td class="num">${fmt(c.capacity)}</td><td class="num">${fmt(c.entryFee)} ${esc(c.currency)}</td><td>${esc(when(c.updatedAt))}</td></tr>`;
  const bodies = CUP_GROUPS.map(([title, states], i) => {
    const here = cups.filter((c) => states.includes(c.state) || (i === 0 && !known.has(c.state)));
    return here.length ? `<tbody><tr class="grp"><th colspan="6">${esc(title)} <span class="muted">${here.length}</span></th></tr>${here.map(row).join("")}</tbody>` : "";
  }).join("");
  $("#list").innerHTML = cups.length ? `<table><thead><tr><th>Cup</th><th>State</th><th>Round 1</th><th class="num">Seats</th><th class="num">Entry</th><th>Updated</th></tr></thead>${bodies}</table>`
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

/* ---------- i tags: one shared popover. Hover shows it, a click or tap pins it, Esc closes it. ---------- */
const tip = $("#tip");
let tipFor = null, tipPinned = false;
function infoBtn(label, body, meta = []) {
  return `<button type="button" class="i" aria-label="What does ${esc(label)} do?" aria-expanded="false" aria-controls="tip" data-i="${esc(JSON.stringify({ label, body, meta }))}">i</button>`;
}
function showTip(btn, pin) {
  const { label, body, meta } = JSON.parse(btn.dataset.i);
  if (tipFor && tipFor !== btn) tipFor.setAttribute("aria-expanded", "false");
  tipFor = btn; tipPinned = pin;
  btn.setAttribute("aria-expanded", "true");
  tip.innerHTML = `<b>${esc(label)}</b><p>${esc(body)}</p>${meta.map((m) => `<p class="tipmeta">${esc(m)}</p>`).join("")}`;
  tip.hidden = false;
  const a = btn.getBoundingClientRect(), t = tip.getBoundingClientRect(), gap = 8, pad = 12;
  const left = Math.max(pad, Math.min(a.left + a.width / 2 - t.width / 2, innerWidth - t.width - pad));
  const below = a.bottom + gap + t.height <= innerHeight - pad;
  tip.style.left = `${left}px`;
  tip.style.top = `${below ? a.bottom + gap : Math.max(pad, a.top - gap - t.height)}px`;
}
function closeTip() {
  if (tipFor) tipFor.setAttribute("aria-expanded", "false");
  tipFor = null; tipPinned = false; tip.hidden = true;
}
document.addEventListener("click", (e) => {
  const b = e.target.closest?.(".i");
  if (b) { if (tipFor === b && tipPinned) closeTip(); else showTip(b, true); return; }
  if (!e.target.closest?.("#tip")) closeTip();
  const menu = document.querySelector("details.menu[open]");
  if (menu && !e.target.closest?.("details.menu")) menu.open = false;
});
document.addEventListener("pointerover", (e) => {
  if (e.pointerType !== "mouse" || tipPinned) return;
  const b = e.target.closest?.(".i");
  if (b) showTip(b, false); else if (tipFor) closeTip();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && tipFor) { const b = tipFor; closeTip(); b.focus(); } });
addEventListener("scroll", () => { if (tipFor) closeTip(); }, { passive: true, capture: true });
addEventListener("resize", () => { if (tipFor) closeTip(); });

/* ---------- drawing one setting: shared by the cup page and the Model page ---------- */
const RECOMMENDED = defaultCupConfig();
const fieldBy = (key) => FIELDS.find((x) => x.key === key);
const unitOf = (f, cfg) => (f.unit === "currency" ? (cfg.currency === "NGN" ? "₦" : "coins") : f.unit || "");
const trim2 = (v) => (Number.isFinite(v) ? +(+v).toFixed(2) : "");
const choiceName = (f, v) => f.labels?.[v] ?? f.pick?.find(([x]) => x === v)?.[1] ?? String(v);

function plainValue(f, v, cfg) {
  const t = f.type, u = unitOf(f, cfg);
  if (t.kind === "bool") return v ? "On" : "Off";
  if (t.kind === "choice" || f.pick) return choiceName(f, v);
  if (t.kind === "split") return `${v.join(" / ")}%`;
  if (f.asPct) return `${Math.round(v * 100)}%`;
  if (["int", "pct", "num"].includes(t.kind)) return `${fmt(trim2(v))}${u === "%" || u.startsWith("% ") ? "%" : u ? ` ${u}` : ""}`;
  return "";
}
function fieldInfo(f, cfg) {
  const t = f.type, meta = [];
  if (["int", "pct", "num"].includes(t.kind) && !f.pick) {
    const k = f.asPct ? 100 : 1, u = unitOf(f, cfg), tail = u === "%" || u.startsWith("% ") ? "%" : u ? ` ${u}` : "";
    meta.push(`Allowed: ${fmt(t.min * k)} to ${fmt(t.max * k)}${tail}`);
  }
  const rec = RECOMMENDED[f.key];
  if (!["time", "text", "countries"].includes(t.kind) && rec !== undefined) meta.push(`Recommended: ${plainValue(f, rec, cfg)}`);
  return infoBtn(f.label, f.info, meta);
}
function fieldHtml(f, cfg, o = {}) {
  const v = cfg[f.key], id = `f_${f.key}`, t = f.type, tag = fieldInfo(f, cfg);
  const lab = (html = esc(f.label), forId = id) => `<div class="lab"><label ${forId ? `for="${forId}"` : ""}>${html}</label>${tag}</div>`;
  const u = unitOf(f, cfg);
  const unit = (html) => (u ? `<div class="unit">${html}<span>${esc(u)}</span></div>` : html);
  if (t.kind === "bool") return `<div class="field toggle"><div class="lab"><label class="check"><input type="checkbox" id="${id}" data-key="${f.key}" ${v ? "checked" : ""}> ${esc(f.label)}</label>${tag}</div></div>`;
  if (f.pick) return `<div class="field">${lab()}<select id="${id}" data-key="${f.key}">${f.pick.map(([x, n]) => `<option value="${x}" ${x === v ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></div>`;
  if (t.kind === "choice") return `<div class="field">${lab()}<select id="${id}" data-key="${f.key}">${t.options.map((x) => `<option value="${esc(x)}" ${x === v ? "selected" : ""}>${esc(f.labels?.[x] ?? x)}</option>`).join("")}</select></div>`;
  if (t.kind === "time") return `<div class="field">${lab()}<input type="datetime-local" id="${id}" data-key="${f.key}" value="${localInput(v)}"><div class="help" id="${id}_lagos">Lagos: ${esc(lagos(v))}</div></div>`;
  if (t.kind === "text") return `<div class="field ${f.key === "description" ? "wide" : ""}">${lab()}<input id="${id}" data-key="${f.key}" maxlength="${t.max}" value="${esc(v)}"></div>`;
  if (t.kind === "countries") return `<div class="field wide">${lab(esc(f.label), "")}<div class="countries">${countries.length ? countries.map((x) => `<label><input type="checkbox" data-key="${f.key}" data-country="${esc(x.iso)}" ${v.includes(x.iso) ? "checked" : ""}> ${esc(x.iso)}</label>`).join("") : `<span class="muted">No countries are set up yet.</span>`}</div></div>`;
  if (t.kind === "split") return `<div class="field wide">${lab(esc(f.label), "")}<div class="split4">${[0, 1, 2, 3].map((i) => `<input type="number" min="0" max="100" step="1" aria-label="Place ${i + 1}, percent" data-key="${f.key}" data-i="${i}" value="${v[i] ?? ""}">`).join("")}</div></div>`;
  const k = f.asPct ? 100 : 1, shown = t.kind === "num" ? trim2(v * k) : v;
  if (o.slider && (t.kind === "pct" || f.asPct)) return `<div class="field wide">${lab()}<div class="slide"><input type="range" id="${id}" data-key="${f.key}" min="${t.min * k}" max="${t.max * k}" step="${f.asPct ? 5 : 1}" value="${shown}"><output id="${id}_out" for="${id}">${shown}%</output></div></div>`;
  const step = f.asPct ? 5 : t.step ?? (t.kind === "num" ? "any" : 1);
  return `<div class="field">${lab()}${unit(`<input type="number" id="${id}" data-key="${f.key}" min="${t.min * k}" max="${t.max * k}" step="${step}" value="${shown}" inputmode="decimal">`)}</div>`;
}
const localInput = (ms) => { const d = new Date(ms); return new Date(ms - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };
const isShown = (f, cfg) => !f.inactive && (!f.showIf || cfg[f.showIf.key] === f.showIf.is);
const hasDependents = (key) => FIELDS.some((f) => f.showIf?.key === key);

/** Put one input's value into a config. */
function readField(el, f, cfg, root) {
  const key = f.key, t = f.type;
  if (t.kind === "bool") cfg[key] = el.checked;
  else if (t.kind === "choice" || t.kind === "text") cfg[key] = el.value;
  else if (t.kind === "time") { const ms = new Date(el.value).getTime(); if (Number.isFinite(ms)) { cfg[key] = ms; const l = $(`#f_${key}_lagos`); if (l) l.textContent = `Lagos: ${lagos(ms)}`; } }
  else if (t.kind === "countries") cfg[key] = [...root.querySelectorAll(`[data-key="${key}"]:checked`)].map((x) => x.dataset.country);
  else if (t.kind === "split") {               // 1 to 4 places; empty or 0 trailing places are dropped
    const v = [...root.querySelectorAll(`[data-key="${key}"]`)].map((x) => (x.value === "" ? 0 : Number(x.value)));
    while (v.length > 1 && v.at(-1) === 0) v.pop();
    cfg[key] = v;
  }
  else cfg[key] = el.value === "" ? NaN : Number(el.value) / (f.asPct ? 100 : 1);
  const out = $(`#f_${key}_out`); if (out) out.textContent = `${el.value}%`;
}

/* ---------- cup page ---------- */
let worker = null, previewSeq = 0, previewTimer = 0, previewSize = "expected", lastPreview = null, ladderOpen = false;

function getWorker() {
  if (!worker) {
    worker = new Worker("./preview-worker.js", { type: "module" });
    worker.onmessage = (e) => {
      if (e.data.id !== previewSeq) return;
      if (e.data.kind === "model") { lastModel = e.data; drawModel(); } else { lastPreview = e.data; drawPreview(); drawSecNav(); markBadFields(); }
    };
  }
  return worker;
}

async function cupView(id) {
  if (editing?.dirty && editing.cup.id === id) return drawEditor();     // back from the Model page: keep unsaved edits
  main.innerHTML = `<p class="muted">Loading…</p>`;
  const r = await api("GET", `/api/console/cups/${encodeURIComponent(id)}`);
  if (!r.ok) { main.innerHTML = `<p class="msg bad">${esc(errText(r.j))}</p><p><a href="#cups">Back to cups</a></p>`; return; }
  editing = { cup: r.j.cup, config: structuredClone(r.j.cup.config), dirty: false };
  drawEditor();
}
addEventListener("beforeunload", (e) => { if (editing?.dirty) e.preventDefault(); });

function readOnly() { const c = editing.cup; return c.frozen || c.state !== "draft" || !me.roles.some((x) => x === "owner" || x === "cup-admin"); }

const LIVE_STATES = ["registration", "closed", "check-in", "running", "finals", "settling", "paused"];
const hasLive = () => editing.cup.state !== "draft";
function defaultSection() {
  const st = editing.cup.state;
  return LIVE_STATES.includes(st) ? "live" : st === "scheduled" ? "share" : "basics";
}

function drawEditor() {
  const c = editing.cup;
  editing.section ??= defaultSection();
  main.innerHTML = `<div class="stack">
    <div class="spread"><div class="stack" style="gap:6px"><a href="#cups" class="muted" style="text-decoration:none">← Cups</a><h1 id="cupTitle">${esc(editing.config.name || c.name)}</h1>
      <div class="row"><span class="chip ${esc(c.state)}">${esc(c.state)}</span>${c.frozen ? '<span class="chip frozen">frozen</span>' : ""}<span class="muted mono">v${c.version}</span>
      ${c.configHash ? `<span class="muted mono" title="SHA-256 of the published settings">#${esc(c.configHash.slice(0, 12))}</span>` : ""}${c.countersignedBy ? '<span class="chip scheduled">countersigned</span>' : ""}<span class="chip home" id="homeChip" ${c.promoted ? "" : "hidden"}>on the home page</span></div></div>
      <div class="row" id="actions"></div></div>
    ${c.frozen ? `<p class="banner">Registration has opened, so these settings are frozen. You can still pause, resume or cancel the cup, and switch its home page banner.</p>` : c.state === "scheduled" ? `<p class="banner">Published. Unpublish to edit. Settings freeze when registration opens (${esc(when(c.config.registrationOpensAt))}).</p>` : ""}
    <p class="msg" id="edMsg" role="status"></p>
    <div class="editor">
      <nav class="secnav" id="secnav" aria-label="Cup sections"></nav>
      <div class="panel"><div id="panel"></div>
        <div class="savebar" id="saveBar" hidden><span>You have unsaved changes.</span><button class="btn primary" type="button" id="saveBtn">Save draft</button></div></div>
      <aside class="preview stack" id="preview" aria-live="polite"><div class="card"><p class="muted">Working out the payouts…</p></div></aside>
    </div></div>`;
  $("#saveBtn").onclick = () => act("save");
  drawActions(); drawSecNav(); drawSection();
  if (hasLive()) loadLive();
  schedulePreview(0);
}

/* The left-hand index: every part of the cup, with what it's set to now and a dot where something needs fixing. */
const shortDate = (ms) => new Date(ms).toLocaleString([], { timeZone: "Africa/Lagos", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
function sectionSummary(id) {
  const x = editing.config, u = x.currency === "NGN" ? "₦" : "coins";
  const money = (n) => (x.currency === "NGN" ? `₦${fmt(n)}` : `${fmt(n)} ${u}`);
  switch (id) {
    case "basics": return x.slug ? `/${x.slug}` : "No web address yet";
    case "dates": return Number.isFinite(x.startsAt) ? `${shortDate(x.startsAt)} Lagos` : "";
    case "entry": return `${money(x.entryFee)} · ${fmt(x.capacity)} seats`;
    case "format": return `${x.advancePerTable === 1 ? "Winner only" : "Top 2"} · ${trim2(x.tableClockSec / 60)} min tables`;
    case "prizes": return `${x.platformCut}% cut · ${x.gfShare}% to the final`;
    case "second": return x.scEnabled ? `${money(x.scFee)} · up to round ${x.scCutoffRound}` : "Off";
    case "table": return `Voice ${x.voice === "off" ? "off" : "on"} · ${x.spectators === "off" ? "no watchers" : "watchers delayed"}`;
    default: return "";
  }
}
function problemsBySection() {
  const out = {};
  for (const e of [...(lastPreview?.errors || []), ...(lastPreview?.checks || [])]) { const id = problemSection(e); if (id) out[id] = (out[id] || 0) + 1; }
  return out;
}
function drawSecNav() {
  const n = $("#secnav"); if (!n) return;
  const bad = problemsBySection(), cur = editing.section;
  const item = (id, title, sub, count = 0) => `<button type="button" data-sec="${id}" ${cur === id ? 'aria-current="true"' : ""}><span class="t">${esc(title)}${count ? `<i class="dot" title="${count} to fix" aria-label="${count} to fix"></i>` : ""}</span>${sub ? `<span class="s">${esc(sub)}</span>` : ""}</button>`;
  n.innerHTML = `<p class="navlabel">Settings</p>${SECTIONS.map((s) => item(s.id, s.title, sectionSummary(s.id), bad[s.id])).join("")}
    <p class="navlabel">After publishing</p>${item("share", "Share and promote", "Link and home page banner")}${hasLive() ? item("live", "Live", "Round, tables and late tables") : ""}`;
  n.onclick = (e) => { const b = e.target.closest("[data-sec]"); if (b) goSection(b.dataset.sec); };
}
function goSection(id) {
  editing.section = id; closeTip();
  drawSecNav(); drawSection();
  $("#secnav").querySelector("[aria-current]")?.scrollIntoView({ block: "nearest", inline: "center" });
  const top = $(".editor").getBoundingClientRect().top;
  if (top < 0) scrollBy({ top: top - 12 });
}
function drawSection() {
  const box = $("#panel"), id = editing.section; if (!box) return;
  if (id === "share") { box.innerHTML = `<div class="card" id="shareCard"></div>`; return drawShare(); }
  if (id === "live") { box.innerHTML = `<div class="card" id="livePanel"><p class="muted">Loading…</p></div>`; if (editing.live !== undefined) drawLive(); return; }
  const sec = SECTIONS.find((s) => s.id === id), cfg = editing.config, ro = readOnly();
  const fields = FIELDS.filter((f) => f.section === id && isShown(f, cfg));
  const groups = [...new Set(fields.map((f) => f.group))];
  const parked = FIELDS.filter((f) => f.section === id && f.inactive);
  const i = SECTIONS.indexOf(sec), next = SECTIONS[i + 1], prev = SECTIONS[i - 1];
  box.innerHTML = `<form id="form" class="stack" novalidate>
    <div class="pagehead"><h2>${esc(sec.title)}</h2><p>${esc(sec.blurb)}</p></div>
    ${groups.map((g) => `<fieldset><legend>${esc(g)}</legend><div class="fields">${fields.filter((f) => f.group === g).map((f) => fieldHtml(f, cfg)).join("")}</div></fieldset>`).join("")}
    ${parked.length ? `<details class="parked"><summary>Not in use (${parked.length})</summary><ul>${parked.map((f) => `<li><b>${esc(f.label)}.</b> ${esc(f.info)}</li>`).join("")}</ul></details>` : ""}
    <div class="spread secfoot">${prev ? `<button type="button" class="btn" data-sec="${prev.id}">← ${esc(prev.title)}</button>` : "<span></span>"}${next ? `<button type="button" class="btn" data-sec="${next.id}">${esc(next.title)} →</button>` : "<span></span>"}</div>
  </form>`;
  if (ro) box.querySelectorAll("[data-key]").forEach((x) => (x.disabled = true));   // inputs only: the i tags still work on a frozen cup
  const form = $("#form");
  form.addEventListener("input", onInput); form.addEventListener("change", onInput);
  form.addEventListener("submit", (e) => e.preventDefault());
  form.querySelector(".secfoot").onclick = (e) => { const b = e.target.closest("[data-sec]"); if (b) goSection(b.dataset.sec); };
  markBadFields();
}

function onInput(e) {
  const el = e.target.closest("[data-key]"); if (!el) return;
  const key = el.dataset.key, f = fieldBy(key), before = editing.config[key];
  readField(el, f, editing.config, $("#form"));
  if (key === "name") $("#cupTitle").textContent = el.value || "Untitled";
  if (before === editing.config[key] && !["split", "countries"].includes(f.type.kind)) return;
  editing.dirty = true; drawActions(); drawSecNav(); schedulePreview(350);
  if (hasDependents(key) || key === "currency") {       // show or hide what depends on it, and keep the focus where it was
    drawSection(); $(`#f_${key}`)?.focus();
  }
}

/* Which setting, and so which section, a problem from the server's rules belongs to. */
function problemField(e) {
  return FIELDS.find((f) => e.startsWith(f.label) || e.startsWith(`${f.key} `)) || null;
}
function problemSection(e) {
  const f = problemField(e);
  if (f) return f.section;
  if (/^Schedule|must end by|^Registration must/i.test(e)) return "dates";
  if (/Naira|naira/.test(e)) return "entry";
  if (/Second Chance|^scFee/.test(e)) return "second";
  if (/pays .*1st and 2nd|gfSplit/.test(e)) return "prizes";
  if (/money does not balance/.test(e)) return "prizes";
  return null;
}
const prettyProblem = (e) => { const f = FIELDS.find((x) => e.startsWith(`${x.key} `)); return f ? f.label + e.slice(f.key.length) : e; };
function markBadFields() {
  document.querySelectorAll(".field.bad").forEach((x) => x.classList.remove("bad"));
  for (const e of lastPreview?.errors || []) { const f = problemField(e); if (f) document.querySelector(`[data-key="${f.key}"]`)?.closest(".field")?.classList.add("bad"); }
}

function drawActions() {
  const c = editing.cup, a = $("#actions"); if (!a) return;
  const admin = me.roles.some((x) => x === "owner" || x === "cup-admin"), fin = me.roles.includes("finance");
  const b = [], more = [];
  const live = LIVE_STATES.includes(c.state);
  if (c.state === "draft" && !c.frozen && admin) b.push(`<button class="btn primary" data-act="publish" ${editing.dirty ? "disabled title='Save first'" : ""}>Publish</button>`);
  if (c.state === "draft" && editing.config.currency === "NGN" && fin && !c.countersignedBy) b.push(`<button class="btn" data-act="countersign" ${editing.dirty ? "disabled" : ""}>Countersign</button>`);
  if (c.state === "scheduled" && !c.frozen && admin) b.push(`<button class="btn" data-act="unpublish">Unpublish</button>`);
  if (live && admin) b.push(`<button class="btn" data-act="pause">${editing.live?.paused ? "Resume" : "Pause"}</button>`);
  if (admin) more.push(`<button class="btn" data-act="duplicate">Duplicate</button><button class="btn" data-act="template">Save as template</button>`);
  if ((c.state === "draft" || c.state === "scheduled" || live) && admin) more.push(`<button class="btn danger" data-act="cancel">Cancel cup</button>`);
  if (c.state === "draft" && !c.publishedAt && admin) more.push(`<button class="btn danger" data-act="delete">Delete</button>`);
  a.innerHTML = b.join("") + (more.length ? `<details class="menu"><summary class="btn">More</summary><div class="menubox">${more.join("")}</div></details>` : "");
  a.onclick = (e) => { const x = e.target.closest("[data-act]"); if (x && !x.disabled) { const m = a.querySelector("details.menu"); if (m) m.open = false; act(x.dataset.act); } };
  const bar = $("#saveBar"); if (bar) bar.hidden = !(editing.dirty && !readOnly());
}

async function act(what) {
  const c = editing.cup, msg = $("#edMsg");
  const done = (r, okText) => {
    if (!r.ok) { msg.textContent = errText(r.j); msg.className = "msg bad"; return false; }
    if (r.j.cup) { editing = { cup: r.j.cup, config: structuredClone(r.j.cup.config), dirty: false, section: editing.section }; drawEditor(); }
    const m = $("#edMsg"); if (m) { m.textContent = okText; m.className = "msg good"; }
    return true;
  };
  if (what === "save") return done(await api("PUT", `/api/console/cups/${c.id}`, { version: c.version, config: editing.config }), "Saved.");
  if (what === "publish") {
    if (lastPreview?.checks?.length) { msg.textContent = "Fix the publish checks first. They're listed beside the settings."; msg.className = "msg bad"; return; }
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
  if (!l) { p.innerHTML = `<h2>Live</h2><p class="muted" style="margin:8px 0 0">Nothing to show for this cup yet.</p>`; return; }
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
    getWorker().postMessage({ id: ++previewSeq, config: editing.config, ctx: { now: Date.now(), cashEnabled: !!me.cashEnabled, countersigned: !!editing.cup.countersignedBy } });
  }, ms);
}

function drawPreview() {
  const p = lastPreview, box = $("#preview"); if (!box || !p) return;
  const problem = (x) => { const id = problemSection(x), text = esc(prettyProblem(x)); return `<li>${id ? `<button type="button" class="linkish" data-sec="${id}">${text}</button>` : text}</li>`; };
  const checks = p.checks.length
    ? `<h3>Can't publish yet</h3><ul class="problems">${p.checks.map(problem).join("")}</ul>`
    : `<p class="ok">Ready to publish: every check passes.</p>`;
  const wireProblems = () => box.querySelectorAll(".problems [data-sec]").forEach((b) => (b.onclick = () => goSection(b.dataset.sec)));
  if (!p.previews.length) { box.innerHTML = `<div class="card stack">${checks}</div>`; wireProblems(); return; }
  const cur = p.previews.find((x) => x.size === previewSize) || p.previews[1];
  const s = cur.sim, cfg = editing.config, N = cur.N;
  const pct = (a) => `${Math.round((100 * a) / N)}%`;
  const rows = s.slots.map((sl, i) => `<tr><td class="mono">R${i + 1}</td>${cell(sl.W, true)}<td class="num">${sl.W ? (sl.open ? `${fmt(sl.bought)}/${fmt(sl.lost)}` : "–") : ""}</td>${cell(sl.L, true)}</tr>`).join("");
  box.innerHTML = `<div class="card stack">${checks}</div>
    <div class="card stack">
      <div class="spread"><h3>What this cup pays</h3><a class="btn small" href="#model/${esc(editing.cup.id)}">Open in the model</a></div>
      <div class="sizes" role="group" aria-label="Field size">${p.previews.map((x) => `<button type="button" class="size" data-size="${x.size}" aria-pressed="${x.size === cur.size}"><span>${x.size}</span><b class="num">${fmt(x.N)}</b><span>${x.sim.rounds} rounds · ~${Math.round(x.minutes / 6) / 10} h</span></button>`).join("")}</div>
      <div class="stats">
        <div class="stat"><b class="num">${fmt(s.champion)}</b><span>champion takes home</span></div>
        <div class="stat"><b class="num">${pct(s.winners)}</b><span>win something</span></div>
        <div class="stat"><b class="num">${pct(s.breakEven)}</b><span>win back their stake</span></div>
        <div class="stat"><b class="num">${fmt(s.platform)}</b><span>platform (${esc(cfg.currency)})</span></div>
      </div>
      <p style="margin:0;font-size:.9rem"><span class="muted">Grand Final:</span> <span class="num">${s.prizes.map(fmt).join(" / ")}</span><br>
        <span class="muted">Second Chance:</span> ${cfg.scEnabled ? `<span class="num">${fmt(s.bought)}</span> buyers at ${Math.round(cfg.scTakeUpEstimate * 100)}% take-up (estimate)` : "off"}</p>
      <details id="ladderBox" ${ladderOpen ? "open" : ""}><summary>Round by round</summary><div class="scroll"><table class="ladder"><thead>
        <tr><th></th><th class="g-main sep" colspan="4">Main draw</th><th>Buy in</th><th class="g-second sep" colspan="4">Second Chance</th></tr>
        <tr><th>Round</th><th class="sep">Players</th><th>Rule</th><th class="num">1st</th><th class="num">2nd</th><th class="num">of lost</th><th class="sep">Players</th><th>Rule</th><th class="num">1st</th><th class="num">2nd</th></tr></thead>
        <tbody>${rows}<tr><td class="mono">R${s.slots.length + 1}</td><td class="sep" colspan="9">Grand Final: ${s.prizes.map(fmt).join(" / ")}</td></tr></tbody></table></div></details>
      <p class="muted" style="margin:0;font-size:.82rem">Equal-skill simulation with Second Chance pay frozen the way a real cup freezes it. Real cups pay from the same engine.</p>
    </div>`;
  wireProblems();
  $("#ladderBox").ontoggle = (e) => { ladderOpen = e.target.open; };
  box.querySelectorAll("[data-size]").forEach((b) => (b.onclick = () => { previewSize = b.dataset.size; drawPreview(); }));
}
const cell = (x, sep) => x
  ? `<td class="num ${sep ? "sep" : ""}">${fmt(x.n)}→${fmt(x.advance)}</td><td>${esc(x.mode)}</td><td class="num">${fmt(x.pay1)}</td><td class="num">${fmt(x.pay2)}</td>`
  : `<td class="${sep ? "sep" : ""} muted" colspan="4">–</td>`;

/* ---------- the stake model: the Whot Cup Model, run on the real engine ---------- */
let modelState = null, lastModel = null, modelTimer = 0;

const MODEL_N = { key: "N", label: "Players who check in", unit: "players", info: "The size of the field to model. Payouts depend on the field that actually checks in, so try the smallest and largest cups you expect.", type: { kind: "int", min: 4, max: 20000 } };
const MODEL_BASE = { key: "scBase", label: "Second Chance pay", labels: { frozen: "As a real cup pays", exact: "Exact take-up (original model)" }, info: "A real cup has to fix Second Chance pay before anyone buys in, so it plans for any take-up from 10% to 100%, and what its tables don't use goes to the Grand Final. Exact assumes take-up is known in advance, which is how the original model worked.", type: { kind: "choice", options: ["frozen", "exact"] } };
const MODEL_CURRENCY = { key: "currency", label: "Show amounts in", labels: { COIN: "Coins", NGN: "Naira" }, info: "Only changes how amounts are labelled here. The sums are the same.", type: { kind: "choice", options: ["COIN", "NGN"] } };
const MODEL_GROUPS = [
  ["The field", [MODEL_N, "top1Threshold", "advancePerTable"]],
  ["Money in", ["entryFee", "platformCut", "guaranteedPool", MODEL_CURRENCY]],
  ["Prize shape", ["gfShare", "secondShare", "growthPerHalving", "gfSplit", "roundTo"]],
  ["Second Chance", ["scEnabled", "scFee", "scTakeUpEstimate", "scCutoffRound", "scWinnerOnly", MODEL_BASE]],
];
const modelField = (k) => (typeof k === "string" ? fieldBy(k) : k);
const MODEL_RECOMMENDED = () => ({ ...structuredClone(RECOMMENDED), slug: "model", N: 1024, scBase: "frozen" });

async function modelView(cupId) {
  main.innerHTML = `<p class="muted">Loading…</p>`;
  let name = null, base = null;
  if (cupId) {
    let src = editing?.cup.id === cupId ? editing : null;
    if (!src) { const r = await api("GET", `/api/console/cups/${encodeURIComponent(cupId)}`); if (r.ok) src = { cup: r.j.cup, config: r.j.cup.config }; }
    if (src) { name = src.config.name || src.cup.name; base = { ...structuredClone(src.config), N: src.config.expectedEntries, scBase: "frozen" }; }
  }
  modelState = { cupId: base ? cupId : null, name, base, config: structuredClone(base || MODEL_RECOMMENDED()) };
  drawModelPage();
}
function drawModelPage() {
  const st = modelState;
  main.innerHTML = `<div class="stack">
    <div class="spread"><div class="pagehead"><h1>Whot Cup Model</h1>
      <p>Change the settings to see where the money goes, how many players leave with something, and how long the cup runs. It uses the same engine as real cups. Nothing here is saved or changes a cup.</p></div>
      ${st.cupId ? `<a class="btn" href="#cup/${esc(st.cupId)}">← Back to ${esc(st.name)}</a>` : ""}</div>
    ${st.cupId ? `<p class="banner">Started from <b>${esc(st.name)}</b>${editing?.cup.id === st.cupId && editing.dirty ? ", including your unsaved changes" : ""}. To keep a change, make it on the cup's own page.</p>` : ""}
    <div class="modelgrid">
      <form class="card stack modelform" id="mForm" novalidate autocomplete="off">
        <div class="spread"><h2>Settings</h2><div class="row" style="gap:6px"><button type="button" class="btn small" id="mReset">${st.cupId ? "Back to this cup" : "Recommended"}</button></div></div>
        <div id="mFields" class="stack"></div>
      </form>
      <div class="stack" id="mResults" aria-live="polite"><div class="card"><p class="muted">Working out the payouts…</p></div></div>
    </div>
    <div class="card stack" id="mNotes"></div></div>`;
  drawModelFields();
  drawModelNotes();
  const form = $("#mForm");
  form.addEventListener("input", onModelInput); form.addEventListener("change", onModelInput);
  form.addEventListener("submit", (e) => e.preventDefault());
  form.addEventListener("click", (e) => { const b = e.target.closest("[data-n]"); if (!b) return; st.config.N = Number(b.dataset.n); drawModelFields(); runModel(0); });
  $("#mReset").onclick = () => { st.config = structuredClone(st.base || MODEL_RECOMMENDED()); drawModelFields(); drawModelNotes(); runModel(0); };
  runModel(0);
}
function drawModelFields() {
  const cfg = modelState.config, box = $("#mFields"); if (!box) return;
  box.innerHTML = MODEL_GROUPS.map(([title, keys]) => `<fieldset><legend>${esc(title)}</legend><div class="fields one">${keys.map(modelField).filter((f) => isShown(f, cfg)).map((f) => fieldHtml(f, cfg, { slider: true })
    + (f.key === "N" ? `<div class="presets" role="group" aria-label="Field size presets">${[128, 1024, 10000, 20000].map((n) => `<button type="button" class="btn small" data-n="${n}" aria-pressed="${cfg.N === n}">${fmt(n)}</button>`).join("")}</div>` : "")).join("")}</div></fieldset>`).join("");
}
function onModelInput(e) {
  const el = e.target.closest("[data-key]"); if (!el) return;
  const key = el.dataset.key, cfg = modelState.config;
  const f = MODEL_GROUPS.flatMap(([, k]) => k).map(modelField).find((x) => x.key === key);
  const before = cfg[key];
  readField(el, f, cfg, $("#mForm"));
  if (before === cfg[key] && f.type.kind !== "split") return;
  if (key === "N") $("#mForm").querySelectorAll("[data-n]").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.n) === cfg.N)));
  if (key === "scEnabled" || key === "currency") { drawModelFields(); $(`#f_${key}`)?.focus(); }
  drawModelNotes();
  runModel(120);
}
function runModel(ms) {
  clearTimeout(modelTimer);
  modelTimer = setTimeout(() => {
    const cfg = modelState.config;
    if (!Number.isInteger(cfg.N) || cfg.N < 4 || cfg.N > 20000) { previewSeq++; lastModel = { errors: ["Players who check in: must be a whole number from 4 to 20,000"] }; drawModel(); return; }
    getWorker().postMessage({ id: ++previewSeq, kind: "model", config: structuredClone(cfg) });
  }, ms);
}
function drawModel() {
  const box = $("#mResults"), r = lastModel; if (!box || !r || !modelState) return;
  if (r.errors?.length) { box.innerHTML = `<div class="card stack"><h3>Fix these to see the model</h3><ul class="problems">${r.errors.map((e) => `<li>${esc(prettyProblem(e))}</li>`).join("")}</ul></div>`; return; }
  const m = r.sim, cfg = modelState.config, N = m.N;
  const money = (n) => (cfg.currency === "NGN" ? `₦${fmt(Math.round(n))}` : `${fmt(Math.round(n))} coins`);
  const pc = (a, b) => (b ? `${((100 * a) / b).toFixed(a / b < 0.1 && a > 0 ? 1 : 0)}%` : "0%");
  const mins = Math.ceil((m.rounds * (cfg.tableClockSec + cfg.breakSec)) / 60), dur = `${Math.floor(mins / 60) ? `${Math.floor(mins / 60)}h ` : ""}${mins % 60 ? `${mins % 60}m` : ""}`.trim();
  const first = m.slots[0].W;
  const stats = [
    ["key", pc(m.winners, N), "win something"],
    ["", pc(m.breakEven, N), "win back what they staked or more"],
    ["key", money(m.champion), "champion takes home"],
    ["", money(m.medianWin), "typical win, among those who win"],
    ["", `${money(first.pay1)} / ${money(first.pay2)}`, "round 1 pay, 1st / 2nd"],
    ["", `${m.rounds} rounds`, `about ${dur}. Main draw ${m.wRounds}${cfg.scEnabled ? `, Second Chance ${m.lRounds}` : ""}`],
    ...(cfg.scEnabled ? [["", pc(m.scAny, m.bought), `of Second Chance buyers win something (${pc(m.scStakeBack, m.bought)} get their stake back)`], ["", `${fmt(m.maxLGames)} tables`, "most Second Chance tables any buyer plays"]] : []),
    ["", money(m.platform), `platform revenue (${cfg.platformCut}% of every stake)`],
  ];
  const parts = [
    [`Platform (${cfg.platformCut}%)`, m.platform, "--s-platform"],
    ["Main draw tables", m.wPay, "--main"],
    ["Second Chance tables", m.lPay, "--second"],
    ["Grand Final", m.gfPot, "--s-final"],
  ].filter(([, v]) => v > 0);
  const maxB = Math.max(...m.buckets.map((b) => b.n), 1);
  const places = ["Champion", "Runner-up", "3rd place", "4th place"];
  const chip = (x) => `<span class="chip ${x.mode === "top 1" ? "t1" : x.mode === "final" ? "fin" : ""}">${x.mode === "final" ? "final table" : x.mode}</span>`;
  const cells = (x) => (x ? `<td class="num sep">${fmt(x.n)} → ${fmt(x.advance)}</td><td>${chip(x)}</td><td class="num">${fmt(x.pay1)}</td><td class="num">${fmt(x.pay2)}</td>` : `<td class="muted sep" colspan="4">–</td>`);
  const buyin = (sl) => (!sl.W ? `<td class="muted">–</td>` : sl.open ? `<td class="num">${fmt(sl.bought)} of ${fmt(sl.lost)}</td>` : `<td class="muted">closed</td>`);
  box.innerHTML = `
    ${r.problems.length ? `<div class="card stack warnbox"><h3>A real cup like this couldn't be published</h3><ul class="problems">${r.problems.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
    <section class="stack tight" aria-labelledby="mGlance"><div class="pagehead"><h2 id="mGlance">The cup at a glance</h2>
      <p>${fmt(N)} players at ${money(cfg.entryFee)} each. ${pc(m.winners, N)} win something, ${pc(m.breakEven, N)} win back everything they staked or more, and the champion takes home about ${money(m.champion)}.${cfg.scEnabled ? ` ${fmt(m.bought)} first-time losers buy a Second Chance for ${money(cfg.scFee)}.` : ""}</p></div>
      <div class="stats big">${stats.map(([c, b, t]) => `<div class="stat ${c}"><b class="num">${esc(b)}</b><span>${esc(t)}</span></div>`).join("")}</div></section>
    <section class="card stack tight" aria-labelledby="mSplit"><div class="pagehead"><h2 id="mSplit">Where the money goes</h2><p>All the money in: entry fees, Second Chance stakes${cfg.guaranteedPool ? " and the sponsor top-up" : ""}. Total ${money(m.entries)}.</p></div>
      <div class="splitbar" role="img" aria-label="${esc(parts.map(([l, v]) => `${l} ${pc(v, m.entries)}`).join(", "))}">${parts.map(([, v, c]) => `<div style="flex:${v} 1 0;background:var(${c})"></div>`).join("")}</div>
      <div class="legend">${parts.map(([l, v, c]) => `<div><i style="background:var(${c})"></i><span>${esc(l)}</span><b class="num">${money(v)} · ${pc(v, m.entries)}</b></div>`).join("")}</div></section>
    <div class="twoup">
      <section class="card stack tight" aria-labelledby="mOut"><div class="pagehead"><h2 id="mOut">What players take home</h2><p>Each player's total winnings across the cup, compared with everything they staked.</p></div>
        <div class="bars">${m.buckets.map((b, i) => `<div class="bar ${i === 0 ? "zero" : ""}"><span class="lbl">${esc(b.label.replace("-", "–"))}</span><div class="track"><div class="fill" style="width:${(70 * b.n) / maxB}%"></div><span class="val num">${pc(b.n, N)} · ${fmt(b.n)}</span></div></div>`).join("")}</div></section>
      <section class="card stack tight" aria-labelledby="mGf"><div class="pagehead"><h2 id="mGf">Grand Final prizes</h2><p>Paid on top of what the finalists won at earlier tables. Pot: ${money(m.gfPot)}.</p></div>
        <ol class="prizes">${m.prizes.map((p, i) => `<li><span>${places[i]}</span><b class="num">${money(p)}</b></li>`).join("")}</ol></section>
    </div>
    <section class="stack tight" aria-labelledby="mRounds"><div class="pagehead"><h2 id="mRounds">Round by round</h2><p>Both draws play at the same time. Each line shows players at the start → players who advance, and what 1st and 2nd get at every table that round.</p></div>
      <div class="card scroll"><table class="ladder"><thead><tr><th></th><th class="g-main sep" colspan="5">Main draw</th><th class="g-second sep" colspan="4">Second Chance</th></tr>
        <tr><th>Round</th><th class="sep">Players</th><th>Rule</th><th class="num">1st gets</th><th class="num">2nd gets</th><th>Losers who buy in</th><th class="sep">Players</th><th>Rule</th><th class="num">1st gets</th><th class="num">2nd gets</th></tr></thead>
        <tbody>${m.slots.map((sl, i) => `<tr><td class="mono">R${i + 1}</td>${cells(sl.W)}${buyin(sl)}${cells(sl.L)}</tr>`).join("")}
        <tr><td class="mono">R${m.slots.length + 1}</td><td class="sep" colspan="9">Grand Final: ${m.prizes.map(fmt).join(" / ")}</td></tr></tbody></table></div></section>`;
}
function drawModelNotes() {
  const box = $("#mNotes"); if (!box) return;
  const c = modelState.config;
  const money = (n) => (c.currency === "NGN" ? `₦${fmt(n)}` : `${fmt(n)} coins`);
  box.innerHTML = `<h2>How the model works</h2><ul class="notes">
    <li><b>Every table pays 1st and 2nd.</b> Pay depends on how deep into the field a round takes you. A round that halves the field raises pay one step, and a winner-only round, which quarters it, raises pay two steps.</li>
    <li><b>Two pots.</b> Entry fees pay main-draw tables and Second Chance stakes pay Second Chance tables. Each pot gives the platform ${c.platformCut}% and sends ${c.gfShare}% of the rest to the Grand Final, so neither group pays for the other.</li>
    <li><b>The money always balances.</b> Each pot's pay is worked out so its tables stay within their share. Payouts round down to ${fmt(c.roundTo)}, and the leftovers go to the Grand Final.</li>
    <li><b>Two losses and you're out.</b> ${c.scEnabled ? `A first loss in rounds 1 to ${c.scCutoffRound} can be bought back for ${money(c.scFee)}. After that, a first loss ends your cup.` : "With Second Chance off, a first loss ends your cup."}</li>
    <li><b>Random seating every round</b> from a published seed. Fields that don't divide by four get up to three tables of three. Final tables send their top 2 to the Grand Final.</li>
    <li><b>All players are assumed equally skilled,</b> so this shows the shape of the payouts rather than a forecast for any one player. Stronger players will do better.</li>
    <li><b>Duration</b> is rounds × (table clock + break): ${trim2((c.tableClockSec + c.breakSec) / 60)} minutes a round with these clocks.</li></ul>`;
}

/* ---------- templates ---------- */
async function templatesView() {
  main.innerHTML = `<div class="stack"><div class="pagehead"><h1>Templates</h1><p>Save a template from any cup's page, under More. New cups can start from one.</p></div><div class="card scroll" id="list"><p class="muted">Loading…</p></div></div>`;
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
  const f = (k, label, info) => `<div class="field"><div class="lab"><label for="e_${k}">${esc(label)}</label>${infoBtn(label, info)}</div><input type="number" id="e_${k}" name="${k}" value="${e[k]}" step="1" ${canEdit ? "" : "disabled"}></div>`;
  main.innerHTML = `<div class="stack" style="max-width:720px"><div class="pagehead"><h1>Coin economy</h1><p>Applies to every player. Changes reach all servers within a minute.</p></div>
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
  if (!before) main.innerHTML = `<div class="stack"><div class="pagehead"><h1>Audit log</h1><p>Every change made in the console, who made it, and what it changed.</p></div><div class="row"><input id="aTarget" placeholder="Filter by target, e.g. cup:…" style="max-width:360px"><button class="btn" id="aGo">Filter</button></div><div class="card scroll"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Before</th><th>After</th></tr></thead><tbody id="aRows"></tbody></table><button class="btn" id="aMore" hidden style="margin-top:10px">Show older</button></div></div>`;
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
  main.innerHTML = `<div class="stack" style="max-width:900px"><div class="pagehead"><h1>Staff</h1><p>Who can open this console, and what each person can do.</p></div>
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
