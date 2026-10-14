/* playcity: who can see this game, and how to share it. One button used by every game:

     [ ● Public ]   (or ○ Private)

   Tapping it opens one panel: the choice between Public (listed, so anyone can see it is on and ask to join or
   watch) and Private (only people with the link), then three ways to send the link: WhatsApp, copy it, or the
   phone's own share sheet. The game owns the state; this only draws it and reports taps.

   PCVis.mount(container, {
     state()    → 'public' | 'private'
     canToggle()→ false hides the Public/Private choice (someone watching cannot change it)
     onToggle() → switch the game to the other state
     link()     → the URL to share, or null while the game is still getting one
     onShare()  → called as the panel opens, so the game can go online first if it needs a link
     text()     → the message sent with the link
     title      → used by the phone's share sheet
     status()   → null when the connection is fine, or a short word ("Offline", "Reconnecting…") to show on the button instead of Public/Private
     code()     → the table's 5-letter join code (optional; shown in the panel, tap to copy)
     watching() → how many are watching (optional; shown on the button and in the panel)
     pending()  → true while the link is on its way (optional; otherwise a missing link means no connection)
   }) → { paint(), close(), hidden } */
(function () {
  'use strict';
  const CSS = `
.pcv[hidden]{display:none}
.pcv{appearance:none;display:inline-flex;align-items:center;gap:8px;height:34px;padding:0 13px;border-radius:999px;border:1px solid rgba(255,255,255,.18);background:rgba(10,18,22,.72);font-weight:600;font-size:13px;line-height:1;font-family:inherit;color:inherit;cursor:pointer;white-space:nowrap;flex:none}
.pcv:focus-visible{outline:2px solid #ffc247;outline-offset:2px}
.pcv i{width:8px;height:8px;border-radius:50%;flex:none;background:#5ad18a;box-shadow:0 0 0 3px rgba(90,209,138,.22)}
.pcv.public{color:#8de6b0}
.pcv.down{color:#ffb86b;border-color:rgba(255,184,107,.55)}
.pcv.down i{background:#ffb86b;box-shadow:0 0 0 3px rgba(255,184,107,.25);animation:pcvblink 1.1s ease-in-out infinite}
@keyframes pcvblink{50%{opacity:.35}}
.pcv-menu .pcv-lost{margin:0 0 8px;padding:8px 10px;border-radius:10px;background:rgba(255,184,107,.12);color:#ffb86b;font-size:13px;font-weight:600}
.pcv-menu .pcv-lost[hidden]{display:none}
@media (prefers-reduced-motion:reduce){.pcv.down i{animation:none}}
.pcv.private i{background:transparent;box-shadow:none;border:1.5px solid #9bb2ad;width:7px;height:7px}
.pcv svg{width:13px;height:13px;flex:none;opacity:.8}
.pcv-menu{position:fixed;z-index:1000;width:260px;max-width:calc(100vw - 16px);padding:10px;border-radius:14px;background:#101c20;border:1px solid rgba(255,255,255,.16);box-shadow:0 18px 40px -12px rgba(0,0,0,.8);font-family:inherit;color:#eef4f0}
.pcv-menu[hidden]{display:none}
.pcv-menu h3{margin:2px 4px 8px;font-weight:700;font-size:11px;line-height:1;font-family:inherit;letter-spacing:.12em;text-transform:uppercase;color:#9bb2ad}
.pcv-seg{position:relative;display:grid;grid-template-columns:1fr 1fr;padding:3px;border-radius:10px;background:rgba(255,255,255,.06)}
.pcv-seg::before{content:"";position:absolute;top:3px;bottom:3px;left:3px;width:calc(50% - 3px);border-radius:8px;background:#1d3036;box-shadow:inset 0 0 0 1px rgba(255,255,255,.14),0 2px 8px -2px rgba(0,0,0,.5);transition:transform .26s cubic-bezier(.3,1.3,.5,1)}
.pcv-seg.is-private::before{transform:translateX(100%)}
.pcv-seg button{position:relative;appearance:none;display:flex;align-items:center;justify-content:center;gap:7px;min-height:38px;border:0;border-radius:8px;background:none;color:#9bb2ad;font-weight:600;font-size:14px;line-height:1;font-family:inherit;cursor:pointer;transition:color .2s}
.pcv-seg button[aria-checked="true"]{color:#eef4f0}
.pcv-seg button[data-v="public"][aria-checked="true"]{color:#8de6b0}
.pcv-menu h3.pcv-inv{margin-top:10px}
.pcv-code{appearance:none;width:100%;display:flex;align-items:center;gap:10px;margin:0 0 4px;padding:8px 10px;border-radius:10px;border:1px dashed rgba(255,255,255,.22);background:rgba(255,255,255,.04);color:inherit;font-family:inherit;cursor:pointer;text-align:left}
.pcv-code:hover,.pcv-code:focus-visible{border-color:#ffc247;outline:none}
.pcv-code[hidden]{display:none}
.pcv-code small{font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#9bb2ad;flex:1}
.pcv-code b{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:19px;font-weight:700;letter-spacing:.24em;color:#eef4f0}
.pcv-code svg{width:16px;height:16px;flex:none;color:#9bb2ad}
.pcv-eye{display:inline-flex;align-items:center;gap:4px;padding-left:8px;margin-left:2px;border-left:1px solid rgba(255,255,255,.18);color:#eef4f0;font-variant-numeric:tabular-nums}
.pcv-eye[hidden]{display:none}
.pcv .pcv-eye svg{width:14px;height:14px;opacity:.85}
.pcv-watch{display:flex;align-items:center;gap:8px;margin:6px 4px 2px;padding-top:8px;border-top:1px solid rgba(255,255,255,.1);font-size:13px;color:#9bb2ad}
.pcv-watch svg{width:16px;height:16px}
.pcv-watch[hidden]{display:none}
@media (prefers-reduced-motion:reduce){.pcv-seg::before,.pcv-seg button{transition:none}}
.pcv-seg i{width:7px;height:7px;border-radius:50%;background:#5ad18a}
.pcv-seg [data-v="private"] i{background:transparent;border:1.5px solid currentColor;width:6px;height:6px}
.pcv-menu p{margin:8px 4px 10px;font-size:12px;line-height:1.4;color:#9bb2ad}
.pcv-menu hr{border:0;border-top:1px solid rgba(255,255,255,.1);margin:0 0 6px}
.pcv-act{appearance:none;width:100%;display:flex;align-items:center;gap:10px;min-height:44px;padding:0 8px;border:0;border-radius:8px;background:none;color:inherit;font-weight:600;font-size:14px;line-height:1.2;font-family:inherit;text-align:left;cursor:pointer}
.pcv-act:hover,.pcv-act:focus-visible,.pcv-seg button:focus-visible{background:rgba(255,255,255,.07);outline:none}
.pcv-act:disabled{opacity:.45;cursor:default}
.pcv-act svg{width:20px;height:20px;flex:none}
@media (max-width:520px){.pcv{height:32px;padding:0 11px}}`;
  const ICON = {
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"/><path d="M12 3v12"/><path d="M7 8l5-5 5 5"/></svg>',
    wa: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#25d366" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2z"/><path fill="#fff" d="M8.6 7.3c-.2-.5-.4-.5-.6-.5h-.5c-.2 0-.5.1-.7.3-.3.3-.9.9-.9 2.2s.9 2.5 1 2.7c.1.2 1.8 2.9 4.5 4 2.2.9 2.7.7 3.1.7.5 0 1.6-.6 1.8-1.3.2-.6.2-1.2.2-1.3-.1-.1-.3-.2-.6-.3l-1.9-.9c-.3-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.6.1-.3-.1-1.1-.4-2.1-1.3-.8-.7-1.3-1.5-1.4-1.8-.2-.3 0-.4.1-.5l.4-.5.3-.5c.1-.2 0-.3 0-.5l-.8-1.9z"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  };
  let styled = false;
  function style() { if (styled) return; styled = true; const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); }

  function mount(container, o) {
    style();
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'pcv';
    btn.setAttribute('aria-haspopup', 'dialog'); btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = '<i aria-hidden="true"></i><span class="pcv-lbl"></span>' + ICON.share + '<span class="pcv-eye" hidden>' + ICON.eye + '<b></b></span>';
    container.appendChild(btn);
    const menu = document.createElement('div');
    menu.className = 'pcv-menu'; menu.hidden = true; menu.setAttribute('role', 'dialog'); menu.setAttribute('aria-label', 'Who can see this game, and sharing it');
    menu.innerHTML = '<p class="pcv-lost" hidden></p><div class="pcv-who"><h3>Who can see this game</h3>' +
      '<div class="pcv-seg" role="radiogroup" aria-label="Who can see this game">' +
        '<button type="button" role="radio" data-v="public"><i aria-hidden="true"></i>Public</button>' +
        '<button type="button" role="radio" data-v="private"><i aria-hidden="true"></i>Private</button></div></div>' +
      '<p class="pcv-note"></p><hr>' +
      '<h3 class="pcv-inv">Invite a friend</h3><p class="pcv-wait" hidden></p>' +
      '<button type="button" class="pcv-code" hidden aria-label="Copy the table code"><small>Table code</small><b></b>' + ICON.copy + '</button>' +
      '<button type="button" class="pcv-act" data-k="wa">' + ICON.wa + 'WhatsApp</button>' +
      '<button type="button" class="pcv-act" data-k="copy">' + ICON.link + '<span>Copy link</span></button>' +
      '<button type="button" class="pcv-act" data-k="more">' + ICON.more + 'Other apps</button>' +
      '<div class="pcv-watch" hidden>' + ICON.eye + '<span></span></div>';
    document.body.appendChild(menu);
    const note = menu.querySelector('.pcv-note'), copyLbl = menu.querySelector('[data-k="copy"] span');
    menu.querySelector('[data-k="more"]').hidden = !navigator.share;

    let last = '';
    function paint() {
      const pub = o.state() === 'public', st = o.status ? o.status() : null, n = o.watching ? o.watching() : 0;
      const key = [pub, st, n, o.canToggle(), o.link(), o.code ? o.code() : '', menu.hidden].join('|');
      if (key === last) return;          // games call this every frame: only touch the page when something changed
      last = key;
      btn.classList.toggle('public', pub && !st); btn.classList.toggle('private', !pub && !st); btn.classList.toggle('down', !!st);
      btn.querySelector('.pcv-lbl').textContent = st || (pub ? 'Public' : 'Private');
      const eye = btn.querySelector('.pcv-eye');
      eye.hidden = !n; eye.querySelector('b').textContent = n;
      btn.setAttribute('aria-label', (st ? st + ', ' : '') + (pub ? 'Public' : 'Private') + (n ? ', ' + n + ' watching' : '') + ': who can see this game, and sharing it');
      if (!menu.hidden) paintMenu();
    }
    function paintMenu() {
      const url = o.link(), pub = o.state() === 'public', can = o.canToggle(), n = o.watching ? o.watching() : 0, st = o.status ? o.status() : null;
      const lost = menu.querySelector('.pcv-lost'); lost.hidden = !st;
      if (st) lost.textContent = st === 'Offline' ? 'No internet connection. Your game carries on, and reconnects when you are back online.' : 'The connection dropped. Reconnecting…';
      menu.querySelector('.pcv-who').hidden = !can;
      menu.querySelector('.pcv-seg').classList.toggle('is-private', !pub);
      menu.querySelectorAll('.pcv-seg button').forEach(b => b.setAttribute('aria-checked', String((b.dataset.v === 'public') === pub)));
      menu.querySelectorAll('.pcv-act').forEach(b => { b.disabled = !url; });
      note.hidden = !can;
      note.textContent = pub ? 'Anyone can see this game is on and ask to join or watch.' : 'Only people you send the link to can join or watch.';
      const wait = menu.querySelector('.pcv-wait');
      wait.hidden = !!url;
      wait.textContent = o.pending && !o.pending() ? 'No connection right now, so there is no link to send. Try again in a moment.' : 'Making your link…';
      const cd = o.code ? o.code() : null, cb = menu.querySelector('.pcv-code');
      cb.hidden = !cd; if (cd) { cb.querySelector('b').textContent = cd; cb.dataset.code = cd; }
      const w = menu.querySelector('.pcv-watch');
      w.hidden = !n; w.querySelector('span').textContent = n === 1 ? '1 person watching' : n + ' people watching';
    }
    function place() {
      const r = btn.getBoundingClientRect(), w = menu.offsetWidth, h = menu.offsetHeight;
      menu.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.right - w)) + 'px';
      menu.style.top = (r.bottom + 6 + h > innerHeight - 8 ? Math.max(8, r.top - h - 6) : r.bottom + 6) + 'px';
    }
    function open() {
      if (o.onShare) o.onShare();
      menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); last = '';
      copyLbl.textContent = 'Copy link';
      paintMenu(); place();
      const first = menu.querySelector('[aria-checked="true"]') || menu.querySelector('.pcv-act:not([disabled])'); if (first) first.focus({ preventScroll: true });
    }
    function close() { if (menu.hidden) return; menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); last = ''; }
    btn.addEventListener('click', e => { e.stopPropagation(); if (menu.hidden) open(); else close(); });
    menu.addEventListener('click', async e => {
      e.stopPropagation();
      const cc = e.target.closest('.pcv-code');
      if (cc) {
        const c = cc.dataset.code, lab = cc.querySelector('small'); let ok = false;
        try { await navigator.clipboard.writeText(c); ok = true; } catch (err) {
          const t = document.createElement('textarea'); t.value = c; t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select();
          try { ok = document.execCommand('copy'); } catch (er) { /* nothing more to try */ } t.remove();
        }
        lab.textContent = ok ? 'Code copied' : 'Table code'; setTimeout(() => { lab.textContent = 'Table code'; }, 1400);
        return;
      }
      const seg = e.target.closest('.pcv-seg button');
      if (seg) { if (seg.dataset.v !== o.state()) { o.onToggle(); paint(); } paintMenu(); return; }
      const b = e.target.closest('.pcv-act'); if (!b || b.disabled) return;
      const url = o.link(); if (!url) return;
      const text = o.text ? o.text() : '';
      if (b.dataset.k === 'wa') { window.open('https://wa.me/?text=' + encodeURIComponent((text ? text + ' ' : '') + url), '_blank', 'noopener'); close(); }
      else if (b.dataset.k === 'copy') {
        let ok = false;
        try { await navigator.clipboard.writeText(url); ok = true; } catch (err) {
          const t = document.createElement('textarea'); t.value = url; t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select();
          try { ok = document.execCommand('copy'); } catch (er) { /* nothing more to try */ } t.remove();
        }
        copyLbl.textContent = ok ? 'Link copied' : url;
        if (ok) setTimeout(close, 900);
      } else if (b.dataset.k === 'more') { close(); navigator.share({ title: o.title || document.title, text, url }).catch(() => {}); }
    });
    document.addEventListener('click', e => { if (!menu.contains(e.target) && !btn.contains(e.target)) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !menu.hidden) { close(); btn.focus(); } });
    addEventListener('resize', close);
    addEventListener('online', () => { last = ''; paint(); }); addEventListener('offline', () => { last = ''; paint(); });
    paint();
    return { el: btn, paint, close, set hidden(v) { btn.hidden = v; if (v) close(); } };
  }
  window.PCVis = { mount };
})();
