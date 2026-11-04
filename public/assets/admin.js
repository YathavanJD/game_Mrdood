(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const IC = {
  overview: '<path d="M4 13h6V4H4zM14 20h6V4h-6zM4 20h6v-3H4z"/>', live: '<path d="M3 12h4l3-8 4 16 3-8h4"/>', players: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.5 3-6 6.5-6s6.5 2.5 6.5 6M17 11a3 3 0 1 0 0-6M21.5 20c0-2.6-1.8-4.6-4.5-5.3"/>',
  winners: '<path d="M7 4h10v5a5 5 0 0 1-10 0zM7 6H3c0 3 1.5 5 4 5.5M17 6h4c0 3-1.5 5-4 5.5M12 14v4M8 20h8"/>', qr: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v6h-4M14 18h2"/>',
  game: '<circle cx="12" cy="12" r="9"/><path d="M10 8.5l5 3.5-5 3.5z"/>', settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>'
};
const icon = n => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${IC[n]}</svg>`;
let ME = null, CSRF = '', cleanups = [], eventHook = null, es = null, feed = [], status = '';

/* ---------- api ---------- */
async function api(path, { method = 'GET', body, raw } = {}) {
  let r;
  try { r = await fetch('/api/admin' + path, { method, credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': CSRF }, body: body ? JSON.stringify(body) : undefined }); }
  catch { throw new Error('Network error. Check your connection.'); }
  let j = {}; try { j = await r.json(); } catch { /* */ }
  if (r.status === 401 && path !== '/login') { showLogin(); throw new Error('Session expired. Please sign in again.'); }
  if (!r.ok) throw new Error(j.message || 'Request failed');
  return j;
}
const fmtT = t => t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–';
const ago = t => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? s + 's ago' : s < 3600 ? Math.round(s / 60) + 'm ago' : fmtT(t); };
const dur = ms => { const s = Math.round(ms / 1000), m = Math.floor(s / 60); return m ? `${m}m ${s % 60}s` : s + 's'; };
const can = p => ME && ME.perms.includes(p);

/* ---------- ui helpers ---------- */
function toast(msg, kind = '') { const t = document.createElement('div'); t.className = 'toast ' + kind; t.textContent = msg; $('#toasts').appendChild(t); setTimeout(() => t.remove(), 4200); }
function modal(html, setup) {
  const m = $('#modal'); m.innerHTML = `<div class="dlg" role="dialog" aria-modal="true">${html}</div>`; m.hidden = false;
  const close = () => { if (RM) { m.hidden = true; m.innerHTML = ''; return; } const d = m.firstChild; d && d.animate([{ opacity: 1 }, { opacity: 0, transform: 'scale(.96)' }], { duration: 150 }).finished.then(() => { m.hidden = true; m.innerHTML = ''; }).catch(() => { m.hidden = true; }); };
  m.onclick = e => { if (e.target === m) close(); }; document.onkeydown = e => { if (e.key === 'Escape' && !m.hidden) close(); };
  setup && setup($('.dlg', m), close); const f = $('input,select,textarea,button', m); f && f.focus(); return close;
}
function confirmBox({ title, body, phrase, ok = 'Confirm', danger = true }) {
  return new Promise(res => {
    const close = modal(`<h2>${esc(title)}</h2><div class="mut">${body}</div>${phrase ? `<label>Type <b>${esc(phrase)}</b> to continue</label><input id="cf" autocomplete="off">` : ''}<div class="acts"><button class="btn" data-x>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok ${phrase ? 'disabled' : ''}>${esc(ok)}</button></div>`, d => {
      const b = $('[data-ok]', d); if (phrase) $('#cf', d).oninput = e => { b.disabled = e.target.value !== phrase; };
      $('[data-x]', d).onclick = () => { close(); res(false); }; b.onclick = () => { close(); res(phrase ? $('#cf', d).value : true); };
    });
    $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') res(false); }, { once: true });
  });
}
async function act(fn, okMsg) { try { const r = await fn(); okMsg && toast(okMsg, 'ok'); return r; } catch (e) { toast(e.message, 'bad'); return null; } }
function countUp(el, to) { if (RM) { el.textContent = to; return; } const t0 = performance.now(); const dec = String(to).includes('.'); (function f(t) { const k = Math.min(1, (t - t0) / 700), v = to * (1 - Math.pow(1 - k, 3)); el.textContent = dec ? v.toFixed(1) : Math.round(v); if (k < 1) requestAnimationFrame(f); })(t0); }
const skeleton = n => Array.from({ length: n }, () => '<div class="skel"></div>').join('');
const empty = (t, s) => `<div class="empty"><b>${esc(t)}</b>${esc(s || '')}</div>`;
let audioCtx; function beep(f = 880) { if (localStorage.getItem('snd') !== '1') return; try { audioCtx = audioCtx || new AudioContext(); const o = audioCtx.createOscillator(), g = audioCtx.createGain(); o.frequency.value = f; g.gain.setValueAtTime(.12, audioCtx.currentTime); g.gain.exponentialRampToValueAtTime(.001, audioCtx.currentTime + .35); o.connect(g); g.connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + .36); } catch { /* */ } }

/* ---------- shell ---------- */
const VIEWS = [['overview', 'Overview', 'stats'], ['live', 'Live Activity', 'activity'], ['players', 'Players', 'players'], ['winners', 'Winners', 'winners'], ['qr', 'QR Management', 'qr'], ['game', 'Game Controls', 'game'], ['settings', 'Settings', 'settings']];
function showLogin() { closeStream(); ME = null; $('#shell').hidden = true; $('#login').hidden = false; $('#l-user').focus(); }
function closeStream() { if (es) { es.close(); es = null; } $('#live-dot').classList.remove('on'); }
function initShell() {
  $('#login').hidden = true; $('#shell').hidden = false; $('#who').textContent = `${ME.username} · ${ME.role === 'super' ? 'Super admin' : ME.role === 'qr' ? 'QR manager' : 'Game manager'}`;
  $('#nav').innerHTML = VIEWS.filter(v => can(v[2])).map(v => `<a href="#/${v[0]}" data-v="${v[0]}">${icon(v[0])}<span>${v[1]}</span></a>`).join('');
  if (can('activity')) openStream();
  if (!location.hash) location.hash = '#/' + (VIEWS.find(v => can(v[2])) || [''])[0]; else render();
}
function openStream() {
  closeStream(); es = new EventSource('/api/admin/stream');
  es.onopen = () => $('#live-dot').classList.add('on'); es.onerror = () => $('#live-dot').classList.remove('on');
  es.onmessage = m => { let ev; try { ev = JSON.parse(m.data); } catch { return; } feed.unshift(ev); feed.length = Math.min(feed.length, 200); alertFor(ev); eventHook && eventHook(ev); if (ev.type === 'game') refreshPill(); };
}
function alertFor(ev) {
  const loud = ['winner', 'suspicious'].includes(ev.type);
  if (['winner', 'suspicious', 'invalid', 'register'].includes(ev.type)) { toast(ev.msg, loud ? 'bad' : 'ok'); if (loud) beep(ev.type === 'winner' ? 1040 : 440); else if (ev.type === 'invalid') beep(520); }
  if (loud && localStorage.getItem('bn') === '1' && 'Notification' in window && Notification.permission === 'granted') new Notification('Mr.DooD', { body: ev.msg });
}
async function refreshPill() { if (!can('stats')) return; try { const s = await api('/overview'); status = s.gameStatus; $('#game-pill').textContent = { running: 'Live', paused: 'Paused', not_started: 'Not started' }[status]; $('#game-pill').className = 'pill ' + status; } catch { /* */ } }
function render() {
  cleanups.forEach(f => f()); cleanups = []; eventHook = null;
  const name = (location.hash.match(/^#\/(\w+)/) || [])[1]; const v = VIEWS.find(x => x[0] === name && can(x[2])) || VIEWS.find(x => can(x[2]));
  if (!v) { $('#view').innerHTML = empty('No access', 'Your role has no workspaces.'); return; }
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.v === v[0])); $('#v-title').textContent = v[1]; document.body.classList.remove('open');
  const el = $('#view'); el.innerHTML = skeleton(3); el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
  refreshPill(); Promise.resolve(R[v[0]](el)).catch(e => { el.innerHTML = empty('Could not load', e.message); });
}
addEventListener('hashchange', () => ME && render());
$('#b-menu').onclick = () => { if (innerWidth <= 860) document.body.classList.toggle('open'); else document.body.classList.toggle('collapsed'); };
$('#scrim').onclick = () => document.body.classList.remove('open');
$('#b-logout').onclick = async () => { try { await api('/logout', { method: 'POST' }); } catch { /* */ } location.hash = ''; showLogin(); };
$('#f-login').onsubmit = async e => {
  e.preventDefault(); $('#l-err').textContent = '';
  try { const r = await api('/login', { method: 'POST', body: { username: $('#l-user').value, password: $('#l-pass').value } }); ME = r.admin; CSRF = r.csrf; $('#l-pass').value = ''; initShell(); } catch (er) { $('#l-err').textContent = er.message; }
};

/* ---------- charts ---------- */
function chart(hours) {
  const W = 720, H = 220, P = 28, max = Math.max(4, ...hours.map(h => Math.max(h.scans, h.players))), bw = (W - P * 2) / 24;
  const y = v => H - P - (v / max) * (H - P * 2);
  const bars = hours.map((h, i) => `<rect class="bar" style="animation-delay:${i * 25}ms" x="${P + i * bw + 3}" y="${y(h.scans)}" width="${bw - 6}" height="${H - P - y(h.scans)}" rx="3"><title>${h.scans} scans</title></rect>`).join('');
  const pts = hours.map((h, i) => `${P + i * bw + bw / 2},${y(h.players)}`).join(' ');
  const lbl = hours.map((h, i) => i % 4 === 0 ? `<text x="${P + i * bw + bw / 2}" y="${H - 8}" text-anchor="middle">${new Date(h.t).getHours()}:00</text>` : '').join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Scans per hour (bars) and new players per hour (line)"><line x1="${P}" x2="${W - P}" y1="${H - P}" y2="${H - P}" stroke="#322a23"/>${bars}<polyline class="ln" points="${pts}"/>${lbl}<text x="${P}" y="12">${max}</text></svg>`;
}

/* ---------- views ---------- */
const R = {};
R.overview = async el => {
  const draw = async () => {
    const s = await api('/overview'); const cards = [['Players', s.players], ['QR scans', s.scans], ['Completed', s.completed], ['Winners', s.winners], ['Active now', s.active], ['Disqualified', s.disqualified], ['Suspicious scans', s.suspicious], ['Completion %', s.completionPct]];
    el.innerHTML = `<div class="grid g4">${cards.map((c, i) => `<div class="card stat ${i === 1 ? 'hl' : ''}"><small>${c[0]}</small><b data-n="${c[1]}">0</b></div>`).join('')}</div>
    <div class="grid g2" style="margin-top:16px"><div class="card"><h2>Scans per QR</h2><div class="bars">${s.perSlot.map((n, i) => `<div class="bar-row"><span class="letter">${esc(s.slotLabels[i])}</span><div class="track"><i data-w="${s.players ? Math.round(n / s.players * 100) : 0}"></i></div><span class="mut">${n}</span></div>`).join('')}</div><p class="hint">Share of players who found each QR. Tokens and links are never shown here.</p></div>
    <div class="card"><h2>Last 24 hours</h2>${chart(s.hours)}<p class="hint">Orange bars: scans. White line: new players.</p></div></div>`;
    el.querySelectorAll('[data-n]').forEach(b => countUp(b, +b.dataset.n)); requestAnimationFrame(() => el.querySelectorAll('[data-w]').forEach(i => { i.style.width = i.dataset.w + '%'; }));
  };
  await draw(); let t; eventHook = ev => { if (['scan', 'register', 'winner', 'suspicious'].includes(ev.type)) { clearTimeout(t); t = setTimeout(() => draw().catch(() => {}), 1200); } }; cleanups.push(() => clearTimeout(t));
};
const LBL = { register: 'Registration', scan: 'Scan', duplicate: 'Duplicate scan', invalid: 'Invalid scan', suspicious: 'Suspicious', winner: 'Winner', admin: 'Admin', game: 'Game', complete: 'Completed', wrong: 'Wrong answer' };
R.live = async el => {
  const r = await api('/activity'); feed = r.events;
  const row = ev => `<div class="fe ${esc(ev.type)}"><span class="dot"></span><div><b>${esc(LBL[ev.type] || ev.type)}</b> <span class="mut">${esc(ev.msg || '')}</span></div><time>${ago(ev.t)}</time></div>`;
  el.innerHTML = `<div class="row" style="margin-bottom:14px"><span class="mut sp">Updates appear instantly while this page is open.</span><label class="row" style="margin:0"><input type="checkbox" id="snd" ${localStorage.getItem('snd') === '1' ? 'checked' : ''}> Sound alerts</label></div><div class="feed" id="feed">${feed.length ? feed.map(row).join('') : empty('Nothing yet', 'Events show up as players register and scan.')}</div>`;
  $('#snd').onchange = e => { localStorage.setItem('snd', e.target.checked ? '1' : '0'); if (e.target.checked) beep(); };
  eventHook = ev => { const f = $('#feed'); if (!f) return; const e0 = f.querySelector('.empty'); e0 && e0.remove(); f.insertAdjacentHTML('afterbegin', row(ev)); while (f.children.length > 200) f.lastChild.remove(); };
};
R.players = async el => {
  el.innerHTML = `<div class="row" style="margin-bottom:14px"><input id="q" placeholder="Search by name" style="max-width:280px"><select id="st" style="max-width:190px"><option value="all">All players</option><option value="active">Active</option><option value="disqualified">Disqualified</option><option value="complete">Collected all 7</option><option value="winner">Winners</option><option value="suspicious">Suspicious</option></select><span class="sp"></span>${can('players') ? '<a class="btn" href="/api/admin/export/players.csv">Export CSV</a>' : ''}</div><div id="pl">${skeleton(3)}</div>`;
  const load = async () => {
    const r = await api(`/players?q=${encodeURIComponent($('#q').value)}&status=${$('#st').value}`);
    $('#pl').innerHTML = r.players.length ? `<div class="tw"><table><thead><tr><th>Name</th><th>Progress</th><th>Status</th><th>Joined</th><th>Last scan</th><th>Flags</th></tr></thead><tbody>${r.players.map(p => `<tr class="click" data-id="${esc(p.id)}"><td><b>${esc(p.name)}</b></td><td><div class="track" style="width:90px;display:inline-block;vertical-align:middle"><i style="width:${p.progress / 7 * 100}%"></i></div> ${p.progress}/7</td><td>${p.winner ? `<span class="tag or">Winner #${p.winner.position}</span>` : `<span class="tag ${p.status === 'active' ? 'ok' : 'bad'}">${esc(p.status)}</span>`}</td><td>${fmtT(p.createdAt)}</td><td>${fmtT(p.lastScanAt)}</td><td>${p.suspicious ? `<span class="tag warn">${p.suspicious}</span>` : ''}</td></tr>`).join('')}</tbody></table></div>` : empty('No players found', 'Try a different search or filter.');
    el.querySelectorAll('tr.click').forEach(tr => { tr.onclick = () => playerDialog(tr.dataset.id, load); });
  };
  let t; $('#q').oninput = () => { clearTimeout(t); t = setTimeout(() => load().catch(e => toast(e.message, 'bad')), 250); }; $('#st').onchange = () => load(); cleanups.push(() => clearTimeout(t));
  await load(); eventHook = ev => { if (['register', 'scan', 'winner'].includes(ev.type)) load().catch(() => {}); };
};
async function playerDialog(id, reload) {
  const { player: p } = await api('/players/' + id);
  modal(`<h2>${esc(p.name)}</h2><div class="row"><span class="tag ${p.status === 'active' ? 'ok' : 'bad'}">${esc(p.status)}</span>${p.winner ? `<span class="tag or">Winner #${p.winner.position}</span>` : ''}${p.suspicious ? `<span class="tag warn">${p.suspicious} suspicious</span>` : ''}</div>
  <p class="mut">Progress ${p.progress}/7 · joined ${fmtT(p.createdAt)} · wrong answers ${p.wrongAnswers}${p.winner ? ` · finished in ${dur(p.winner.durationMs)} · code <b>${esc(p.winner.claimCode)}</b>` : ''}</p>
  <h3>Collected letters</h3>${p.scans.length ? `<div class="tw" style="margin:8px 0"><table style="min-width:0"><tbody>${p.scans.map(s => `<tr><td><span class="letter">${esc(s.letter)}</span></td><td>${esc(s.label)}</td><td>${fmtT(s.at)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="mut">No scans yet.</p>'}
  <div class="acts"><button class="btn" data-a="close">Close</button><button class="btn danger" data-a="reset">Reset progress</button>${p.status === 'active' ? '<button class="btn danger" data-a="disqualify">Disqualify</button>' : '<button class="btn" data-a="reinstate">Reinstate</button>'}<button class="btn danger" data-a="remove">Remove</button></div>`, (d, close) => {
    d.querySelectorAll('[data-a]').forEach(b => b.onclick = async () => {
      const a = b.dataset.a; if (a === 'close') return close();
      const text = { reset: ['Reset progress?', 'All letters, any win and the claim code for this player will be erased.'], disqualify: ['Disqualify player?', 'They can no longer scan or win until reinstated.'], remove: ['Remove player?', 'The player record is deleted permanently.'], reinstate: null }[a];
      if (text && !await confirmBox({ title: text[0], body: text[1], ok: a[0].toUpperCase() + a.slice(1) })) return;
      close(); const r = await act(() => api(a === 'remove' ? '/players/' + id : `/players/${id}/${a}`, { method: a === 'remove' ? 'DELETE' : 'POST', body: {} }), 'Done'); r && reload();
    });
  });
}
R.winners = async el => {
  const draw = async () => {
    const r = await api('/winners');
    el.innerHTML = `<div class="card" style="margin-bottom:16px"><h2>Verify a claim code</h2><div class="row"><input id="vc" placeholder="DOOD-XXXXXXXX" style="max-width:280px;text-transform:uppercase"><span id="vr" class="mut"></span></div></div>` + (r.winners.length ? `<div class="tw"><table><thead><tr><th>#</th><th>Player</th><th>Time taken</th><th>Finished</th><th>Claim code</th><th>Verified</th></tr></thead><tbody>${r.winners.map(w => `<tr><td><b>${w.winner.position}</b></td><td>${esc(w.name)} ${w.status === 'disqualified' ? '<span class="tag bad">disqualified</span>' : ''}${w.winner.prizeEligible ? '' : ' <span class="tag warn">no prize</span>'}</td><td>${dur(w.winner.durationMs)}</td><td>${fmtT(w.winner.at)}</td><td><code>${esc(w.winner.claimCode)}</code></td><td><button class="btn sm ${w.winner.verified ? 'primary' : ''}" data-v="${esc(w.id)}" data-on="${w.winner.verified ? 0 : 1}">${w.winner.verified ? 'Verified' : 'Mark verified'}</button></td></tr>`).join('')}</tbody></table></div>` : empty('No winners yet', 'Winners appear here the moment they enter the secret word.'));
    $('#vc').oninput = e => { const c = e.target.value.trim().toUpperCase(), w = r.winners.find(x => x.winner.claimCode === c); $('#vr').innerHTML = !c ? '' : w ? `✔ ${esc(w.name)} – position #${w.winner.position}${w.status === 'disqualified' ? ' (DISQUALIFIED)' : ''}${w.winner.verified ? ' – already verified' : ''}` : '✘ No winner with this code'; };
    el.querySelectorAll('[data-v]').forEach(b => b.onclick = async () => { await act(() => api(`/winners/${b.dataset.v}/verify`, { method: 'POST', body: { verified: b.dataset.on === '1' } })); draw(); });
  };
  await draw(); eventHook = ev => { if (ev.type === 'winner') draw().catch(() => {}); };
};

/* ---- QR management ---- */
R.qr = async el => {
  const draw = async () => {
    const { slots } = await api('/qr/slots');
    el.innerHTML = `<div class="warn-box" style="margin-bottom:16px">QR codes contain secret links. Only reveal them when you need to print or check them. Regenerating or revoking a code makes every printed copy stop working immediately.</div>
    <div class="row" style="margin-bottom:16px"><button class="btn" id="pv-all">Preview all</button><a class="btn" href="/api/admin/qr/zip">Download all (ZIP)</a><a class="btn" href="/api/admin/qr/sheet" target="_blank" rel="noopener">Print sheet</a><span class="sp"></span><button class="btn danger" id="rst">Reset all QR codes</button></div>
    <div class="grid g3">${slots.map(s => `<div class="card qrc" data-n="${s.n}"><div class="row"><span class="letter">${esc(s.letter)}</span><div class="sp"><b>${esc(s.label)}</b><div class="hint">Slot ${s.n} · ${s.scans} scans · rotated ${s.rotations}×</div></div><span class="tag ${s.revoked ? 'bad' : s.active ? 'ok' : 'warn'}">${s.revoked ? 'Revoked' : s.active ? 'Active' : 'Off'}</span></div>
      <div class="pv" data-pv>${s.revoked ? 'Revoked' : 'Hidden'}</div>${s.notes ? `<div class="hint">${esc(s.notes)}</div>` : ''}
      <div class="acts"><button class="btn sm" data-a="preview" ${s.revoked ? 'disabled' : ''}>Preview</button><a class="btn sm ${s.revoked ? 'disabled' : ''}" href="/api/admin/qr/${s.n}/image?format=png&dl=1">PNG</a><a class="btn sm" href="/api/admin/qr/${s.n}/image?format=svg&dl=1">SVG</a><button class="btn sm" data-a="edit">Edit</button>
      <button class="btn sm" data-a="${s.active ? 'deactivate' : 'activate'}" ${s.revoked ? 'disabled' : ''}>${s.active ? 'Turn off' : 'Turn on'}</button><button class="btn sm danger" data-a="regenerate">Regenerate</button><button class="btn sm danger" data-a="revoke" ${s.revoked ? 'disabled' : ''}>Revoke</button></div></div>`).join('')}</div>`;
    const preview = (card, on) => { const pv = $('[data-pv]', card); if (on) { pv.innerHTML = `<img alt="QR for slot ${card.dataset.n}" src="/api/admin/qr/${card.dataset.n}/image?format=svg&t=${Date.now()}">`; } else pv.textContent = 'Hidden'; };
    cleanups.push(() => { el.querySelectorAll('[data-pv] img').forEach(i => i.removeAttribute('src')); });
    $('#pv-all').onclick = () => el.querySelectorAll('.qrc').forEach(c => { if (!c.querySelector('[data-a=preview]').disabled) preview(c, true); });
    $('#rst').onclick = async () => { if (await confirmBox({ title: 'Reset all QR codes?', body: '<b>All 7 tokens are replaced.</b> Every printed QR stops working and you must print new ones. Player progress is kept.', phrase: 'RESET QR', ok: 'Reset all' }) && await act(() => api('/qr/reset-all', { method: 'POST', body: { confirm: 'RESET QR' } }), 'All QR codes regenerated')) draw(); };
    el.querySelectorAll('.qrc').forEach(card => card.querySelectorAll('[data-a]').forEach(b => b.onclick = async () => {
      const n = card.dataset.n, a = b.dataset.a, s = slots[n - 1];
      if (a === 'preview') { const open = !!$('[data-pv] img', card); preview(card, !open); b.textContent = open ? 'Preview' : 'Hide'; return; }
      if (a === 'edit') return modal(`<h2>Edit slot ${n}</h2><p class="hint">The letter (${esc(s.letter)}) is fixed and can’t be changed. Only the label and notes are editable.</p><label>Label</label><input id="el" maxlength="60" value="${esc(s.label)}"><label>Notes</label><textarea id="en" rows="3" maxlength="300">${esc(s.notes)}</textarea><div class="acts"><button class="btn" data-x>Cancel</button><button class="btn primary" data-s>Save</button></div>`, (d, close) => { $('[data-x]', d).onclick = close; $('[data-s]', d).onclick = async () => { const r = await act(() => api('/qr/' + n, { method: 'PUT', body: { label: $('#el', d).value, notes: $('#en', d).value } }), 'Saved'); if (r) { close(); draw(); } }; });
      if (a === 'regenerate' && !await confirmBox({ title: `Regenerate QR ${n}?`, body: 'The old QR stops working <b>immediately</b>. Any printed copies of this code must be replaced.', ok: 'Regenerate' })) return;
      if (a === 'revoke' && !await confirmBox({ title: `Revoke QR ${n}?`, body: 'This QR code is disabled and its token destroyed. Players can’t scan it until you regenerate it.', ok: 'Revoke' })) return;
      const r = await act(() => api(`/qr/${n}/${a}`, { method: 'POST', body: {} }), 'Updated'); r && draw();
    }));
  };
  await draw();
};

/* ---- game controls ---- */
R.game = async el => {
  const draw = async () => {
    const g = await api('/game-config'); const c = g.config;
    el.innerHTML = `<div class="grid g2"><div class="card"><h2>Game status</h2><p><span class="pill ${g.status}">${{ running: 'Live', paused: 'Paused', not_started: 'Not started' }[g.status]}</span></p><div class="row"><button class="btn primary" data-g="${g.status === 'paused' ? 'resume' : 'start'}" ${g.status === 'running' ? 'disabled' : ''}>${g.status === 'paused' ? 'Resume game' : 'Start game'}</button><button class="btn" data-g="pause" ${g.status !== 'running' ? 'disabled' : ''}>Pause game</button></div><p class="hint">Pausing blocks scans, registrations and answers for everyone.</p></div>
    <div class="card"><h2>Scan restrictions</h2><div class="form"><div class="sw"><input type="checkbox" id="g-reg" ${c.registrationsOpen ? 'checked' : ''}><label for="g-reg">Allow new registrations</label></div><div class="sw"><input type="checkbox" id="g-scan" ${c.scanningOpen ? 'checked' : ''}><label for="g-scan">Allow scanning</label></div>
    <label>Minimum seconds between scans</label><input id="g-int" type="number" min="0" max="60" step="0.5" value="${c.minScanIntervalMs / 1000}"><label>Duplicate scan policy</label><select id="g-dup"><option value="notify" ${c.duplicatePolicy === 'notify' ? 'selected' : ''}>Tell the player</option><option value="silent" ${c.duplicatePolicy === 'silent' ? 'selected' : ''}>Log only</option></select>
    <h3 style="margin-top:18px">Suspicious scan detection</h3><label>Invalid scans per minute before flagging</label><input id="g-inv" type="number" min="1" max="100" value="${c.suspiciousInvalidPerMin}"><label>Scan attempts per minute before flagging</label><input id="g-spm" type="number" min="1" max="200" value="${c.suspiciousScansPerMin}"><button class="btn primary" id="g-save" style="margin-top:14px">Save changes</button></div></div></div>
    ${can('reset') ? `<div class="card" style="margin-top:16px"><h2>Danger zone</h2><p class="mut">Resetting removes every player, scan and winner. QR codes, settings and admins stay.</p><button class="btn danger" id="g-reset">Reset entire game</button></div>` : ''}`;
    el.querySelectorAll('[data-g]').forEach(b => b.onclick = async () => { await act(() => api('/game/' + b.dataset.g, { method: 'POST', body: {} }), 'Game updated'); refreshPill(); draw(); });
    $('#g-save').onclick = async () => { const r = await act(() => api('/game-config', { method: 'PUT', body: { registrationsOpen: $('#g-reg').checked, scanningOpen: $('#g-scan').checked, minScanIntervalMs: Math.round(+$('#g-int').value * 1000), duplicatePolicy: $('#g-dup').value, suspiciousInvalidPerMin: +$('#g-inv').value, suspiciousScansPerMin: +$('#g-spm').value } }), 'Saved'); r && draw(); };
    const rs = $('#g-reset'); if (rs) rs.onclick = resetGame;
  };
  await draw();
};
async function resetGame() { if (await confirmBox({ title: 'Reset the entire game?', body: 'All players, scans and winners are deleted permanently. Consider downloading a backup first.', phrase: 'RESET', ok: 'Reset game' }) && await act(() => api('/reset-game', { method: 'POST', body: { confirm: 'RESET' } }), 'Game reset')) render(); }

/* ---- settings ---- */
const FIELDS = {
  general: [['title', 'Game title'], ['brand', 'Brand name'], ['eventInfo', 'Event information', 'area'], ['description', 'Game description', 'area'], ['secret', 'Secret answer', 'text', 'Players type this after finding all letters. Not case sensitive.']],
  game: [['registrationsOpen', 'Allow registrations', 'bool'], ['scanningOpen', 'Allow scanning', 'bool'], ['duplicatePolicy', 'Duplicate scan policy', 'sel:notify|silent'], ['minScanIntervalMs', 'Minimum scan interval (ms)', 'num'], ['maxWinners', 'Prize positions (0 = unlimited)', 'num'], ['maxAnswerAttempts', 'Wrong answers allowed per 10 min', 'num']],
  notify: [['ntfyUrl', 'ntfy topic URL', 'text', 'e.g. https://ntfy.sh/your-topic'], ['telegramToken', 'Telegram bot token', 'text'], ['telegramChat', 'Telegram chat ID']]
};
const fieldHtml = (f, v) => { const [k, l, t = 'text', h] = f; const id = 'f-' + k; if (t === 'bool') return `<div class="sw"><input type="checkbox" id="${id}" ${v ? 'checked' : ''}><label for="${id}">${l}</label></div>`; if (t.startsWith('sel:')) return `<label for="${id}">${l}</label><select id="${id}">${t.slice(4).split('|').map(o => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select>`; if (t === 'area') return `<label for="${id}">${l}</label><textarea id="${id}" rows="3">${esc(v)}</textarea>`; return `<label for="${id}">${l}</label><input id="${id}" ${t === 'num' ? 'type="number"' : ''} value="${esc(v)}">${h ? `<div class="hint">${h}</div>` : ''}`; };
const readFields = list => Object.fromEntries(list.map(([k, , t = 'text']) => { const e = $('#f-' + k); return [k, t === 'bool' ? e.checked : t === 'num' ? +e.value : e.value]; }));
R.settings = async el => {
  const { settings: S } = await api('/settings'); let tab = 'general';
  const tabs = [['general', 'General'], ['game', 'Game configuration'], ['security', 'Security'], ['notify', 'Notifications'], ['data', 'Data management']];
  const draw = async () => {
    el.innerHTML = `<div class="tabs" role="tablist">${tabs.map(t => `<button role="tab" data-t="${t[0]}" class="${t[0] === tab ? 'on' : ''}">${t[1]}</button>`).join('')}</div><div id="tp"></div>`;
    el.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { tab = b.dataset.t; draw(); }); const tp = $('#tp');
    if (FIELDS[tab]) {
      tp.innerHTML = `<div class="form card">${FIELDS[tab].map(f => fieldHtml(f, S[f[0]])).join('')}${tab === 'general' ? '<label>Total QR codes</label><input value="7 (fixed)" disabled><div class="hint">The hunt always has exactly seven QR slots. Manage them in QR Management.</div>' : ''}${tab === 'game' ? `<label>Game availability</label><select id="f-gs"><option value="running" ${S.gameStatus === 'running' ? 'selected' : ''}>Live</option><option value="paused" ${S.gameStatus === 'paused' ? 'selected' : ''}>Paused</option></select>` : ''}${tab === 'notify' ? `<h3 style="margin-top:18px">This browser</h3><div class="sw"><input type="checkbox" id="f-bn" ${localStorage.getItem('bn') === '1' ? 'checked' : ''}><label for="f-bn">Browser notifications for winners and suspicious activity</label></div><div class="sw"><input type="checkbox" id="f-sn" ${localStorage.getItem('snd') === '1' ? 'checked' : ''}><label for="f-sn">Sound alerts</label></div>` : ''}<div class="row" style="margin-top:16px"><button class="btn primary" id="sv">Save changes</button>${tab === 'notify' ? '<button class="btn" id="nt">Send test message</button>' : ''}</div></div>`;
      $('#sv').onclick = async () => { const r = await act(async () => { const gs = $('#f-gs'); if (gs && gs.value !== S.gameStatus) { await api('/game/' + (gs.value === 'paused' ? 'pause' : 'start'), { method: 'POST', body: {} }); S.gameStatus = gs.value; } if (tab === 'notify') { localStorage.setItem('snd', $('#f-sn').checked ? '1' : '0'); const bn = $('#f-bn').checked; if (bn && 'Notification' in window && Notification.permission !== 'granted') await Notification.requestPermission(); localStorage.setItem('bn', bn ? '1' : '0'); } return api('/settings', { method: 'PUT', body: readFields(FIELDS[tab]) }); }, 'Settings saved'); if (r) { Object.assign(S, r.settings); refreshPill(); draw(); } };
      const nt = $('#nt'); if (nt) nt.onclick = () => act(() => api('/notify-test', { method: 'POST', body: {} }), 'Test sent (check ntfy/Telegram)');
    } else if (tab === 'security') await securityTab(tp, S); else dataTab(tp);
  };
  await draw();
};
async function securityTab(tp, S) {
  const [a, au] = await Promise.all([api('/admins'), api('/audit')]);
  tp.innerHTML = `<div class="grid g2"><div class="card form"><h2>Your password</h2><label>Current password</label><input id="pw0" type="password" autocomplete="current-password"><label>New password (10+ characters)</label><input id="pw1" type="password" autocomplete="new-password"><button class="btn primary" id="pwb" style="margin-top:12px">Change password</button></div>
  <div class="card form"><h2>Sessions and login limits</h2><label>Session length (minutes)</label><input id="ss" type="number" value="${S.sessionMinutes}"><label>Login attempts per 15 min</label><input id="la" type="number" value="${S.loginMaxAttempts}"><button class="btn primary" id="ssb" style="margin-top:12px">Save</button><h3 style="margin-top:18px">QR token security</h3><p class="hint">Each QR holds a random 192-bit token that only the server knows. Tokens are never sent to the game pages or this dashboard, only to people with QR permission in QR Management.</p></div></div>
  <div class="card" style="margin-top:16px"><div class="row"><h2 class="sp">Administrators</h2><button class="btn primary sm" id="ad">Add administrator</button></div><div class="tw"><table><thead><tr><th>Username</th><th>Role</th><th>QR access</th><th></th></tr></thead><tbody>${a.admins.map(x => `<tr><td>${esc(x.username)}</td><td>${esc(x.role)}</td><td>${x.role === 'super' || x.role === 'qr' || x.extra.includes('qr') ? 'Yes' : 'No'}</td><td><button class="btn sm" data-e="${esc(x.username)}">Edit</button> <button class="btn sm danger" data-d="${esc(x.username)}">Remove</button></td></tr>`).join('')}</tbody></table></div></div>
  <div class="card" style="margin-top:16px"><h2>Audit log</h2>${au.audit.length ? `<div class="tw"><table><thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Detail</th></tr></thead><tbody>${au.audit.map(x => `<tr><td>${fmtT(x.t)}</td><td>${esc(x.admin)}</td><td>${esc(x.action)}</td><td style="white-space:normal">${esc(x.detail)}</td></tr>`).join('')}</tbody></table></div>` : empty('No entries')}</div>`;
  $('#pwb').onclick = () => act(() => api('/password', { method: 'POST', body: { current: $('#pw0').value, password: $('#pw1').value } }), 'Password changed').then(r => { if (r) { $('#pw0').value = $('#pw1').value = ''; } });
  $('#ssb').onclick = () => act(() => api('/settings', { method: 'PUT', body: { sessionMinutes: +$('#ss').value, loginMaxAttempts: +$('#la').value } }), 'Saved');
  const adminForm = (u) => modal(`<h2>${u ? 'Edit ' + esc(u.username) : 'Add administrator'}</h2>${u ? '' : '<label>Username</label><input id="au">'}<label>Role</label><select id="ar"><option value="manager">Game Manager</option><option value="qr">QR Manager</option><option value="super">Super Administrator</option></select><div class="sw"><input type="checkbox" id="aq"><label for="aq">Allow Game Manager to open QR Management</label></div><label>${u ? 'New password (leave empty to keep)' : 'Password (10+ characters)'}</label><input id="ap" type="password" autocomplete="new-password"><div class="acts"><button class="btn" data-x>Cancel</button><button class="btn primary" data-s>Save</button></div>`, (d, close) => {
    if (u) { $('#ar', d).value = u.role; $('#aq', d).checked = u.extra.includes('qr'); } $('[data-x]', d).onclick = close;
    $('[data-s]', d).onclick = async () => { const body = { role: $('#ar', d).value, qrAccess: $('#aq', d).checked }; const pw = $('#ap', d).value; if (u) { if (pw) body.password = pw; } else { body.username = $('#au', d).value; body.password = pw; }
      const r = await act(() => api(u ? '/admins/' + encodeURIComponent(u.username) : '/admins', { method: u ? 'PUT' : 'POST', body }), 'Saved'); if (r) { close(); render(); } };
  });
  $('#ad').onclick = () => adminForm(); tp.querySelectorAll('[data-e]').forEach(b => b.onclick = () => adminForm(a.admins.find(x => x.username === b.dataset.e)));
  tp.querySelectorAll('[data-d]').forEach(b => b.onclick = async () => { if (await confirmBox({ title: 'Remove administrator?', body: `${esc(b.dataset.d)} loses access immediately.`, ok: 'Remove' }) && await act(() => api('/admins/' + encodeURIComponent(b.dataset.d), { method: 'DELETE' }), 'Removed')) render(); });
}
function dataTab(tp) {
  tp.innerHTML = `<div class="grid g2"><div class="card"><h2>Backup and restore</h2><p class="mut">A backup contains everything, including QR tokens and password hashes. Store it safely.</p><div class="row"><a class="btn" href="/api/admin/backup">Download backup</a><button class="btn" id="rs">Restore from file</button><input type="file" id="rf" accept="application/json" hidden></div></div>
  <div class="card"><h2>Export</h2><p class="mut">Player records with progress and winner details.</p><a class="btn" href="/api/admin/export/players.csv">Export players (CSV)</a></div>
  <div class="card"><h2>Clear event data</h2><p class="mut">Clears the activity history and charts. Players and winners stay.</p><button class="btn danger" id="ce">Clear event data</button></div>
  <div class="card"><h2>Reset game</h2><p class="mut">Deletes all players, scans and winners.</p><button class="btn danger" id="rg">Reset game</button></div></div>`;
  $('#rs').onclick = () => $('#rf').click();
  $('#rf').onchange = async e => { const f = e.target.files[0]; if (!f) return; let data; try { data = JSON.parse(await f.text()); } catch { return toast('That file is not valid JSON.', 'bad'); }
    if (await confirmBox({ title: 'Restore this backup?', body: 'Current data, QR tokens and administrators are replaced. You will be signed out.', phrase: 'RESTORE', ok: 'Restore' }) && await act(() => api('/restore', { method: 'POST', body: { confirm: 'RESTORE', data } }), 'Restored')) showLogin(); };
  $('#ce').onclick = async () => { if (await confirmBox({ title: 'Clear event data?', body: 'The activity history is deleted.', phrase: 'CLEAR', ok: 'Clear' }) && await act(() => api('/clear-events', { method: 'POST', body: { confirm: 'CLEAR' } }), 'Cleared')) { feed = []; } };
  $('#rg').onclick = resetGame;
}

/* ---------- boot ---------- */
(async () => { try { const r = await api('/me'); ME = r.admin; CSRF = r.csrf; initShell(); } catch { showLogin(); } })();
})();
