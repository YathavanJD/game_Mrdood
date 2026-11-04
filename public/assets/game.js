(() => {
'use strict';
const $ = s => document.querySelector(s);
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const screens = ['load', 'welcome', 'register', 'hub', 'challenge', 'win'];
let me = null, pending = null, pub = {}, pollT = null, busy = false;

/* ---------- helpers ---------- */
async function api(path, body) {
  let r;
  try { r = await fetch('/api' + path, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' }); }
  catch { throw { error: 'network', message: 'No connection. Check your internet and try again.' }; }
  let j = {}; try { j = await r.json(); } catch { /* empty */ }
  if (!r.ok) throw Object.assign({ status: r.status }, j, { message: j.message || 'Something went wrong.' });
  return j;
}
function show(name) { screens.forEach(s => { $('#s-' + s).hidden = s !== name; }); window.scrollTo(0, 0); }
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms); }
function loading(btn, on) { btn.classList.toggle('loading', on); btn.disabled = on; }
const fmtDur = ms => { const s = Math.round(ms / 1000), m = Math.floor(s / 60); return m ? `${m} min ${s % 60} s` : `${s} s`; };
const LOCK = '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';

/* ---------- background particles (paused when hidden) ---------- */
const bg = $('#bg'), bx = bg.getContext('2d'); let parts = [], bgRaf = 0;
function bgSize() { bg.width = innerWidth; bg.height = innerHeight; }
function bgInit() { bgSize(); parts = Array.from({ length: innerWidth < 600 ? 22 : 42 }, () => ({ x: Math.random() * bg.width, y: Math.random() * bg.height, r: 1 + Math.random() * 3, v: .15 + Math.random() * .4, a: Math.random() * 6.28 })); }
function bgFrame() {
  bx.clearRect(0, 0, bg.width, bg.height);
  for (const p of parts) { p.y -= p.v; p.x += Math.sin(p.a += .01) * .3; if (p.y < -10) { p.y = bg.height + 10; p.x = Math.random() * bg.width; }
    const g = bx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 5); g.addColorStop(0, 'rgba(255,140,40,.55)'); g.addColorStop(1, 'rgba(255,106,0,0)'); bx.fillStyle = g; bx.beginPath(); bx.arc(p.x, p.y, p.r * 5, 0, 6.28); bx.fill(); }
  bgRaf = requestAnimationFrame(bgFrame);
}
function bgStart() { if (RM || bgRaf) return; bgInit(); bgFrame(); }
function bgStop() { cancelAnimationFrame(bgRaf); bgRaf = 0; }
addEventListener('resize', () => { if (bgRaf) bgSize(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { bgStop(); clearInterval(pollT); pollT = null; } else { bgStart(); startPoll(); } });

/* ---------- confetti & burst (run only while active) ---------- */
function particles(canvas, opts) {
  if (RM) return;
  const c = canvas, x = c.getContext('2d'); const w = c.width = c.clientWidth || innerWidth, h = c.height = c.clientHeight || innerHeight;
  const cols = ['#ff6a00', '#ffb347', '#fff4e6', '#ff8c33', '#ffd9a8'];
  const ps = Array.from({ length: opts.n }, () => { const a = opts.burst ? Math.random() * 6.28 : Math.PI / 2 + (Math.random() - .5) * 1.2, v = opts.burst ? 3 + Math.random() * 6 : 2 + Math.random() * 4; return { x: opts.burst ? w / 2 : Math.random() * w, y: opts.burst ? h / 2 : -20, vx: opts.burst ? Math.cos(a) * v : (Math.random() - .5) * 3, vy: opts.burst ? Math.sin(a) * v : v, s: 4 + Math.random() * 6, c: cols[Math.floor(Math.random() * cols.length)], r: Math.random() * 6, vr: (Math.random() - .5) * .3, life: 1 }; });
  let f = 0;
  (function step() {
    x.clearRect(0, 0, w, h); let alive = 0;
    for (const p of ps) { p.x += p.vx; p.y += p.vy; p.vy += opts.burst ? .12 : .05; p.r += p.vr; p.life -= opts.burst ? .012 : .004; if (p.life <= 0 || p.y > h + 20) continue; alive++;
      x.save(); x.globalAlpha = Math.max(0, p.life); x.translate(p.x, p.y); x.rotate(p.r); x.fillStyle = p.c; if (opts.burst) { x.shadowColor = p.c; x.shadowBlur = 10; x.beginPath(); x.arc(0, 0, p.s / 2, 0, 6.28); x.fill(); } else x.fillRect(-p.s / 2, -p.s / 3, p.s, p.s / 1.6); x.restore(); }
    if (alive && ++f < 400) requestAnimationFrame(step); else x.clearRect(0, 0, w, h);
  })();
}
const confetti = () => { for (let i = 0; i < 3; i++) setTimeout(() => particles($('#confetti'), { n: 90 }), i * 600); };

/* ---------- render ---------- */
function renderHub() {
  const p = me; $('#h-hello').textContent = `Hi ${p.name}`;
  $('#h-count').textContent = `${p.progress} of 7 letters`;
  const pct = Math.round(p.progress / 7 * 100); $('#bar').style.width = pct + '%'; $('#ring-t').textContent = pct + '%'; $('#ring-v').style.strokeDashoffset = 113 - 113 * pct / 100;
  const got = new Map(p.collected.map(c => [c.n, c])); const box = $('#slots'); const prev = new Set([...box.querySelectorAll('.got')].map(e => +e.dataset.n));
  box.textContent = '';
  for (let n = 1; n <= 7; n++) {
    const d = document.createElement('div'); d.className = 'slot'; d.dataset.n = n;
    if (got.has(n)) { d.classList.add('got'); if (!prev.has(n) && renderHub.animate === n) d.classList.add('pop'); const i = new Image(); i.src = got.get(n).img; i.alt = `Letter ${got.get(n).letter}`; i.loading = 'lazy'; d.appendChild(i); }
    else { d.innerHTML = LOCK + `<small>Locked</small>`; }
    box.appendChild(d);
  }
  renderHub.animate = null;
  const b = $('#banner'); const st = p.game.status;
  const msg = p.status === 'disqualified' ? 'This player was disqualified by the organizers.' : st === 'paused' ? 'The game is paused. Scanning will resume soon.' : st === 'not_started' ? 'The game has not started yet.' : !p.game.scanningOpen ? 'Scanning is temporarily closed.' : '';
  b.hidden = !msg; b.textContent = msg;
}
function route() {
  if (!me) return show('welcome');
  if (me.winner) return showWin();
  if (me.complete && me.status === 'active') { buildWord(); show('challenge'); return; }
  renderHub(); show('hub');
}
function buildWord() { const r = $('#word-row'); r.textContent = ''; me.collected.forEach((c, i) => { const b = document.createElement('b'); b.textContent = c.letter; b.style.animationDelay = i * 90 + 'ms'; r.appendChild(b); }); }
function showWin() {
  const w = me.winner; $('#w-rank').textContent = '#' + w.position; $('#w-name').textContent = me.name; $('#w-time').textContent = `Completed in ${fmtDur(w.durationMs)}`; $('#w-code').textContent = w.claimCode; $('#w-noprize').hidden = w.prizeEligible;
  show('win');
}

/* ---------- overlays ---------- */
function oops(title, msg, dup) { $('#o-title').textContent = title; $('#o-msg').textContent = msg; $('#oops .reveal-box').classList.toggle('dup', !!dup); const o = $('#oops'); o.hidden = false; $('#o-ok').focus(); }
$('#o-ok').onclick = () => { $('#oops').hidden = true; };
function reveal(slot, after) {
  const o = $('#reveal'), img = $('#r-img');
  $('#r-title').textContent = `Letter “${slot.letter}” collected`; $('#r-sub').textContent = `${me.progress} of 7 found`;
  o.hidden = false; img.alt = `Letter ${slot.letter}`;
  const go = () => { particles($('#burst'), { n: 70, burst: true }); };
  img.onload = go; img.src = slot.img + '?v=' + Date.now();
  $('#r-ok').focus();
  $('#r-ok').onclick = () => { o.hidden = true; img.removeAttribute('src'); after(); };
}

/* ---------- actions ---------- */
async function doScan() {
  const token = pending; pending = null; if (!token || busy) return; busy = true;
  try {
    const r = await api('/scan', { token }); me = r.player;
    if (r.result === 'duplicate') { renderHub(); show(me.complete ? 'challenge' : 'hub'); oops('Already collected', `You already have “${r.slot.letter}”. Go find a different QR code.`, true); return; }
    renderHub.animate = r.slot.n; renderHub(); show('hub');
    reveal(r.slot, () => { if (me.complete) { buildWord(); show('challenge'); toast('All seven letters found!'); particles($('#confetti'), { n: 60 }); } });
  } catch (e) {
    const t = { invalid_qr: 'Not an official QR code', too_fast: 'Slow down', game_paused: 'Game paused', game_not_started: 'Not started yet', qr_inactive: 'QR switched off', rate_limited: 'Too many scans' }[e.error] || 'Scan failed';
    renderHub(); route(); oops(t, e.message);
  } finally { busy = false; }
}
$('#b-start').onclick = () => { show('register'); $('#i-name').focus(); };
$('#f-reg').onsubmit = async ev => {
  ev.preventDefault(); const b = $('#b-reg'), err = $('#e-reg'); err.textContent = ''; const name = $('#i-name').value.trim();
  if (name.length < 2) { err.textContent = 'Enter at least 2 characters.'; return; }
  loading(b, true);
  try { const r = await api('/register', { name }); me = r.player; if (pending) { route(); await doScan(); } else route(); }
  catch (e) { err.textContent = e.message; } finally { loading(b, false); }
};
$('#f-ans').onsubmit = async ev => {
  ev.preventDefault(); const b = $('#b-ans'), err = $('#e-ans'); err.textContent = ''; const answer = $('#i-ans').value.trim();
  if (!answer) { err.textContent = 'Type the secret word.'; return; }
  loading(b, true);
  try { const r = await api('/answer', { answer }); me = r.player; showWin(); confetti(); }
  catch (e) { err.textContent = e.message; const c = $('#f-ans'); if (!RM) c.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-10px)' }, { transform: 'translateX(10px)' }, { transform: 'translateX(0)' }], { duration: 300 }); }
  finally { loading(b, false); }
};
$('#b-board').onclick = async () => {
  const ol = $('#board'); try { const r = await api('/leaderboard'); ol.textContent = ''; r.winners.forEach(w => { const li = document.createElement('li'); li.textContent = `${w.name} – ${fmtDur(w.durationMs)}`; ol.appendChild(li); }); if (!r.winners.length) ol.textContent = 'No winners yet.'; ol.hidden = !ol.hidden; } catch (e) { toast(e.message); }
};
function startPoll() { clearInterval(pollT); pollT = setInterval(async () => { if (!me || me.winner || $('#s-hub').hidden) return; try { me = (await api('/me')).player; renderHub(); } catch { /* ignore transient */ } }, 20000); }

/* ---------- boot ---------- */
(async function boot() {
  const m = location.pathname.match(/^\/s\/([A-Za-z0-9_-]{1,80})\/?$/);
  if (m) { pending = m[1]; history.replaceState(null, '', '/'); } // token kept only in memory
  bgStart();
  try { pub = await api('/public'); document.title = pub.title; $('#w-title').textContent = pub.title; $('#w-desc').textContent = pub.description;
    if (!pub.registrationsOpen) { $('#w-closed').hidden = false; $('#w-closed').textContent = 'Registrations are closed right now.'; $('#b-start').disabled = true; } } catch { /* offline: continue */ }
  try { me = (await api('/me')).player; } catch (e) { me = null; if (e.error === 'network') { show('welcome'); toast(e.message, 5000); return; } }
  route(); startPoll();
  if (pending && me) doScan(); else if (pending && !me) toast('Register first, then your scan counts', 4000);
})();
})();
