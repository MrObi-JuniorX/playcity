/* playcity: "put it on your device". Registers the service worker, and on the landing page offers a one-tap install.
   Chrome, Edge and Android hand us an install prompt to call; iPhone, iPad and Safari have none, so they get the two
   steps instead. Once installed (or dismissed) it stays out of the way. */
(function () {
  'use strict';
  if ('serviceWorker' in navigator) addEventListener('load', function () { navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () { /* no service worker: still a normal website */ }); });

  var KEY = 'pc-install-dismissed', WEEKS = 2;
  var box = document.getElementById('install');
  if (!box) return;
  function standalone() { return matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true; }
  function dismissedRecently() { try { var t = +localStorage.getItem(KEY); return t && Date.now() - t < WEEKS * 6048e5; } catch (e) { return false; } }
  if (standalone() || dismissedRecently()) return;

  var ua = navigator.userAgent, ios = /iPad|iPhone|iPod/.test(ua) || (!/Android/.test(ua) && navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);      // iPadOS says it is a Mac
  var safariMac = !ios && /Safari\//.test(ua) && !/Chrome|Chromium|Edg|OPR|Firefox/.test(ua) && /Macintosh/.test(ua);
  var phone = ios || /Android|Mobile/.test(ua), deferred = null, shown = false;
  var text = box.querySelector('.inst-text'), go = box.querySelector('.inst-go'), steps = box.querySelector('.inst-steps'), close = box.querySelector('.inst-x');

  function show() { if (shown) return; shown = true; box.hidden = false; requestAnimationFrame(function () { box.classList.add('on'); }); }
  function hide(remember) {
    box.classList.remove('on'); setTimeout(function () { box.hidden = true; }, 250);
    if (remember) try { localStorage.setItem(KEY, String(Date.now())); } catch (e) { /* ignore */ }
  }
  close.addEventListener('click', function () { hide(true); });
  addEventListener('appinstalled', function () { deferred = null; hide(false); });

  /* Chrome, Edge, Samsung Internet, Android: the browser tells us when installing is possible. */
  addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault(); deferred = e;
    text.textContent = phone ? 'Add playcity to your home screen to start a game in one tap.' : 'Install playcity on this computer to start a game in one click.';
    go.hidden = false; steps.hidden = true; show();
  });
  go.addEventListener('click', function () {
    if (!deferred) return;
    var p = deferred; deferred = null; p.prompt();
    p.userChoice.then(function (c) { hide(c.outcome !== 'accepted'); }).catch(function () { hide(false); });
  });

  /* iPhone, iPad and Safari on a Mac: no prompt exists, so say where the button is. */
  if (ios || safariMac) {
    text.textContent = ios ? 'Keep playcity on your home screen to start a game in one tap.' : 'Keep playcity in your Dock to start a game in one click.';
    go.hidden = true; steps.hidden = false;
    steps.innerHTML = ios
      ? '<span>1. Tap <b class="ico" aria-label="Share">' + shareIcon() + '</b> in the toolbar</span><span>2. Choose <b>Add to Home Screen</b></span>'
      : '<span>1. Open the <b>File</b> menu, or click <b class="ico" aria-label="Share">' + shareIcon() + '</b></span><span>2. Choose <b>Add to Dock</b></span>';
    setTimeout(show, 1200);
  }
  function shareIcon() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"/><path d="M12 3v12"/><path d="M7 8l5-5 5 5"/></svg>'; }
})();
