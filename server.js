'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const QRCode = require('qrcode');

const PORT = +process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUB = path.join(__dirname, 'public'), IMG = path.join(__dirname, 'private', 'img');
const LETTERS = ['M', 'r', '.', 'D', 'o', 'o', 'D'];
const LETTER_NAMES = ['M', 'r', 'dot', 'D', 'o', 'o2', 'D2'];
const UP_URL = process.env.UPSTASH_REDIS_REST_URL, UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const STATE_KEY = process.env.STATE_KEY || 'dood:state:v1';
const TRUST_PROXY = process.env.TRUST_PROXY !== '0';
const log = (lvl, ...a) => console.log(new Date().toISOString(), lvl, ...a);
const rand = n => crypto.randomBytes(n).toString('base64url');
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const CLAIM_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/* ------------------------------ state & persistence ------------------------------ */
const newSlot = i => ({ n: i + 1, letter: LETTERS[i], label: `QR ${i + 1} (${LETTERS[i]})`, notes: '', token: rand(24), active: true, revoked: false, createdAt: Date.now(), rotatedAt: Date.now(), rotations: 0 });
const defaultState = () => ({
  v: 1,
  settings: {
    title: 'Mr.DooD QR Hunt', brand: 'Mr.DooD', eventInfo: '', description: 'Find the seven hidden QR codes, collect every letter and unlock the secret word.',
    secret: 'MrDooD', registrationsOpen: true, scanningOpen: true, gameStatus: 'running', duplicatePolicy: 'notify',
    minScanIntervalMs: 1500, maxWinners: 0, suspiciousInvalidPerMin: 5, suspiciousScansPerMin: 12, maxAnswerAttempts: 5,
    sessionMinutes: 480, loginMaxAttempts: 8, ntfyUrl: '', telegramToken: '', telegramChat: ''
  },
  slots: LETTERS.map((_, i) => newSlot(i)), players: {}, winnerSeq: 0, admins: {}, audit: [], events: []
});
let state = defaultState();

function normalizeState(s) {
  const d = defaultState();
  s.settings = Object.assign(d.settings, s.settings || {});
  s.slots = LETTERS.map((l, i) => {
    const o = (s.slots || []).find(x => x && x.n === i + 1) || newSlot(i);
    return Object.assign(newSlot(i), o, { n: i + 1, letter: l }); // letter mapping is immutable
  });
  s.players = s.players || {}; s.admins = s.admins || {}; s.audit = s.audit || []; s.events = s.events || []; s.winnerSeq = s.winnerSeq || 0;
  return s;
}

let saveTimer = null, saving = Promise.resolve();
const persistMode = UP_URL && UP_TOKEN ? 'upstash' : 'file';
async function writeOut() {
  const json = JSON.stringify(state);
  if (persistMode === 'upstash') {
    const r = await fetch(UP_URL, { method: 'POST', headers: { Authorization: `Bearer ${UP_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(['SET', STATE_KEY, json]), signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('upstash ' + r.status);
  } else {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = path.join(DATA_DIR, `state.${process.pid}.tmp`);
    fs.writeFileSync(tmp, json, { mode: 0o600 });
    fs.renameSync(tmp, path.join(DATA_DIR, 'state.json'));
  }
}
function save(immediate) {
  clearTimeout(saveTimer);
  const run = () => { saving = saving.then(writeOut).catch(e => log('ERROR', 'persist failed:', e.message)); return saving; };
  if (immediate) return run();
  saveTimer = setTimeout(run, 250);
  return Promise.resolve();
}
async function load() {
  try {
    if (persistMode === 'upstash') {
      const r = await fetch(UP_URL, { method: 'POST', headers: { Authorization: `Bearer ${UP_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(['GET', STATE_KEY]), signal: AbortSignal.timeout(8000) });
      const j = await r.json(); if (j.result) state = normalizeState(JSON.parse(j.result)); else state = normalizeState(state);
    } else {
      const f = path.join(DATA_DIR, 'state.json');
      state = normalizeState(fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : state);
    }
  } catch (e) { log('ERROR', 'load failed, refusing to start with empty state:', e.message); throw e; }
  if (!Object.keys(state.admins).length) {
    const username = process.env.ADMIN_USER || 'admin';
    const generated = !process.env.ADMIN_PASSWORD;
    const pw = process.env.ADMIN_PASSWORD || rand(12);
    state.admins[username] = { username, role: 'super', extra: [], pw: hashPw(pw), createdAt: Date.now() };
    if (generated) log('WARN', `FIRST RUN: created super admin "${username}" with generated password: ${pw}  (change it after login)`);
    else log('INFO', `FIRST RUN: created super admin "${username}" from ADMIN_PASSWORD`);
  }
  await save(true);
}

/* ------------------------------ helpers ------------------------------ */
function hashPw(pw) { const salt = crypto.randomBytes(16); return `scrypt$${salt.toString('base64')}$${crypto.scryptSync(pw, salt, 64).toString('base64')}`; }
function checkPw(pw, stored) {
  try { const [, s, h] = stored.split('$'); return crypto.timingSafeEqual(crypto.scryptSync(pw, Buffer.from(s, 'base64'), 64), Buffer.from(h, 'base64')); } catch { return false; }
}
const DUMMY_PW = hashPw('dummy-password-for-timing');
const buckets = new Map();
function rl(key, max, windowMs) { // fixed-window limiter; returns true when allowed
  const now = Date.now(); let b = buckets.get(key);
  if (!b || b.reset < now) { b = { c: 0, reset: now + windowMs }; buckets.set(key, b); }
  return ++b.c <= max;
}
const windows = new Map();
function hit(key, windowMs) { const now = Date.now(); const a = (windows.get(key) || []).filter(t => now - t < windowMs); a.push(now); windows.set(key, a); return a.length; }
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); for (const [k, a] of windows) if (!a.length || now - a[a.length - 1] > 120000) windows.delete(k); for (const [k, s] of sessions) if (s.exp < now) sessions.delete(k); }, 60000).unref();

const clients = new Set();
function emit(type, data = {}) {
  const ev = Object.assign({ id: crypto.randomUUID(), t: Date.now(), type }, data);
  state.events.push(ev); if (state.events.length > 5000) state.events.splice(0, state.events.length - 5000);
  for (const c of clients) { try { c.res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { clients.delete(c); } }
  save(); return ev;
}
function audit(admin, action, detail = '', ip = '') {
  state.audit.push({ t: Date.now(), admin: admin ? admin.username : '-', action, detail: String(detail).slice(0, 300), ip });
  if (state.audit.length > 3000) state.audit.splice(0, state.audit.length - 3000);
  if (admin) emit('admin', { msg: `${admin.username}: ${action}${detail ? ' – ' + String(detail).slice(0, 120) : ''}` }); else save();
}
async function notify(text) {
  const s = state.settings;
  try { if (s.ntfyUrl) await fetch(s.ntfyUrl, { method: 'POST', body: text, signal: AbortSignal.timeout(5000) }); } catch (e) { log('WARN', 'ntfy failed', e.message); }
  try { if (s.telegramToken && s.telegramChat) await fetch(`https://api.telegram.org/bot${s.telegramToken}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: s.telegramChat, text }), signal: AbortSignal.timeout(5000) }); } catch (e) { log('WARN', 'telegram failed', e.message); }
}

/* ------------------------------ http plumbing ------------------------------ */
const routes = [];
const route = (method, p, opts, fn) => routes.push({ method, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), opts: opts || {}, fn });
const send = (res, code, obj, headers = {}) => { const b = JSON.stringify(obj); res.writeHead(code, Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, headers)); res.end(b); };
class HttpError extends Error { constructor(code, error, message) { super(message || error); this.code = code; this.error = error; } }
const E = (code, error, message) => new HttpError(code, error, message);
const getIp = req => (TRUST_PROXY && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress) || '?';
const isHttps = req => req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted;
function cookies(req) { const o = {}; String(req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = p.slice(i + 1).trim(); }); return o; }
const setCookie = (req, name, val, maxAge, sameSite) => `${name}=${val}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > limit) { reject(E(413, 'too_large', 'Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolve({}); try { const j = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(j && typeof j === 'object' ? j : {}); } catch { reject(E(400, 'bad_json', 'Invalid JSON')); } });
    req.on('error', reject);
  });
}
const SEC_HEADERS = {
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};

/* ------------------------------ auth ------------------------------ */
const sessions = new Map(); // sha(token) hex -> {username, csrf, exp}
const ROLE_PERMS = { super: ['*'], manager: ['stats', 'activity', 'players', 'winners', 'game'], qr: ['qr'] };
const EXTRA_ALLOWED = ['qr'];
const can = (a, perm) => { const p = ROLE_PERMS[a.role] || []; return p.includes('*') || p.includes(perm) || (a.extra || []).includes(perm); };
const permList = a => ['stats', 'activity', 'players', 'winners', 'game', 'qr', 'settings', 'admins', 'audit', 'data', 'reset'].filter(p => can(a, p));
function adminFrom(req) {
  const tok = cookies(req).dood_a; if (!tok) return null;
  const k = sha(tok).toString('hex'), s = sessions.get(k);
  if (!s || s.exp < Date.now()) { sessions.delete(k); return null; }
  const a = state.admins[s.username]; if (!a) { sessions.delete(k); return null; }
  s.exp = Date.now() + state.settings.sessionMinutes * 60000;
  return { admin: a, session: s };
}
function playerFrom(req) {
  const c = cookies(req).dood_p; if (!c) return null;
  const i = c.indexOf('.'); if (i < 1) return null;
  const p = state.players[c.slice(0, i)]; if (!p) return null;
  return safeEq(sha(c.slice(i + 1)).toString('hex'), p.sh) ? p : null;
}

/* ------------------------------ game logic ------------------------------ */
const cleanName = s => String(s || '').normalize('NFC').replace(/\s+/g, ' ').trim();
const nameKey = s => s.toLocaleLowerCase();
const scanCount = p => Object.keys(p.scans).length;
const gameBlock = () => { const s = state.settings; if (s.gameStatus === 'not_started') return ['game_not_started', 'The game has not started yet.']; if (s.gameStatus === 'paused') return ['game_paused', 'The game is paused. Please wait for the organizers.']; return null; };
function winnerInfo(p) { return p.win ? { position: p.win.position, claimCode: p.win.claimCode, at: p.win.at, durationMs: p.win.durationMs, prizeEligible: p.win.prizeEligible } : null; }
function playerView(p) {
  const collected = Object.keys(p.scans).map(Number).sort((a, b) => a - b).map(n => ({ n, letter: LETTERS[n - 1], img: `/api/img/${n}`, at: p.scans[n] }));
  const s = state.settings;
  return { name: p.name, status: p.status, progress: collected.length, total: 7, collected, complete: collected.length === 7, winner: winnerInfo(p), game: { status: s.gameStatus, registrationsOpen: s.registrationsOpen, scanningOpen: s.scanningOpen } };
}
function flagSuspicious(p, ip, reason) {
  if (p) p.suspicious = (p.suspicious || 0) + 1;
  const ev = emit('suspicious', { pid: p && p.id, name: p && p.name, ip, msg: reason });
  notify(`Mr.DooD: suspicious activity – ${p ? p.name : ip}: ${reason}`);
  return ev;
}

/* ------------------------------ public routes ------------------------------ */
route('GET', '/healthz', {}, () => ({ ok: true, uptime: Math.round(process.uptime()), persistence: persistMode }));
route('GET', '/api/public', {}, () => { const s = state.settings; return { title: s.title, brand: s.brand, description: s.description, eventInfo: s.eventInfo, status: s.gameStatus, registrationsOpen: s.registrationsOpen, scanningOpen: s.scanningOpen }; });

route('POST', '/api/register', { ip: ['register', 60, 600000] }, ({ req, res, body, ip }) => {
  const s = state.settings; const existing = playerFrom(req);
  if (existing) return { player: playerView(existing) };
  if (!s.registrationsOpen) throw E(423, 'registrations_closed', 'Registrations are closed right now.');
  const bl = gameBlock(); if (bl && s.gameStatus === 'not_started') throw E(423, bl[0], bl[1]);
  const name = cleanName(body.name);
  if (name.length < 2 || name.length > 24 || !/^[\p{L}\p{N} ._'-]+$/u.test(name)) throw E(422, 'invalid_name', 'Use 2–24 letters, numbers or spaces.');
  const key = nameKey(name);
  if (Object.values(state.players).some(p => p.nameKey === key)) throw E(409, 'name_taken', 'That name is already playing. Pick another one.');
  const id = rand(9), secret = rand(24);
  const p = { id, name, nameKey: key, sh: sha(secret).toString('hex'), createdAt: Date.now(), scans: {}, status: 'active', suspicious: 0, attempts: [], lastScanAt: 0, win: null };
  state.players[id] = p; emit('register', { pid: id, name, msg: `${name} joined the hunt` });
  return [{ player: playerView(p) }, 201, { 'set-cookie': setCookie(req, 'dood_p', `${id}.${secret}`, 60 * 60 * 24 * 30, 'Lax') }];
});

route('GET', '/api/me', { player: true }, ({ player }) => ({ player: playerView(player) }));

route('POST', '/api/scan', { player: true }, ({ body, player: p, ip }) => {
  if (!rl('scan:' + p.id, 60, 60000)) throw E(429, 'rate_limited', 'Too many scans. Slow down.');
  const s = state.settings;
  if (p.status === 'disqualified') throw E(403, 'disqualified', 'This player has been disqualified.');
  const bl = gameBlock(); if (bl) throw E(423, bl[0], bl[1]);
  if (!s.scanningOpen) throw E(423, 'scanning_closed', 'Scanning is temporarily closed.');
  const now = Date.now();
  if (hit('fast:' + p.id, 60000) === s.suspiciousScansPerMin) flagSuspicious(p, ip, `${s.suspiciousScansPerMin}+ scan attempts in a minute`);
  if (now - p.lastScanAt < s.minScanIntervalMs) throw E(429, 'too_fast', 'You are scanning too fast. Wait a moment.');
  const token = typeof body.token === 'string' ? body.token : '';
  let found = null;
  for (const sl of state.slots) { // no early exit: constant-time-ish across all seven slots
    const ok = /^[A-Za-z0-9_-]{16,64}$/.test(token) && sl.token && safeEq(token, sl.token);
    if (ok) found = sl;
  }
  if (!found || found.revoked) {
    p.lastScanAt = now;
    emit('invalid', { pid: p.id, name: p.name, ip, msg: `${p.name} scanned an invalid QR code` });
    if (hit('inv:' + p.id, 60000) === s.suspiciousInvalidPerMin) flagSuspicious(p, ip, `${s.suspiciousInvalidPerMin}+ invalid QR scans in a minute`);
    throw E(404, 'invalid_qr', 'This QR code is not part of the official Mr.DooD hunt.');
  }
  if (!found.active) { p.lastScanAt = now; emit('invalid', { pid: p.id, name: p.name, msg: `${p.name} scanned a deactivated QR (slot ${found.n})` }); throw E(423, 'qr_inactive', 'This QR code is switched off right now.'); }
  p.lastScanAt = now;
  const slot = { n: found.n, letter: found.letter, img: `/api/img/${found.n}` };
  if (p.scans[found.n]) {
    emit('duplicate', { pid: p.id, name: p.name, n: found.n, msg: `${p.name} re-scanned QR ${found.n}` });
    return { result: 'duplicate', slot, player: playerView(p) };
  }
  p.scans[found.n] = now;
  emit('scan', { pid: p.id, name: p.name, n: found.n, msg: `${p.name} collected "${found.letter}" (${scanCount(p)}/7)` });
  if (scanCount(p) === 7) emit('complete', { pid: p.id, name: p.name, msg: `${p.name} collected all 7 letters` });
  return { result: 'ok', slot, player: playerView(p) };
});

route('GET', '/api/img/:n', { player: true, raw: true }, ({ res, params, player: p }) => {
  const n = +params.n;
  if (!Number.isInteger(n) || n < 1 || n > 7 || !p.scans[n]) throw E(403, 'not_collected', 'Letter not collected yet.');
  const f = path.join(IMG, `${n}.jpg`); if (!fs.existsSync(f)) throw E(404, 'missing_image', 'Image missing.');
  res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600' }); fs.createReadStream(f).pipe(res);
});

route('POST', '/api/answer', { player: true }, ({ body, player: p, ip }) => {
  const s = state.settings;
  if (p.win) return { result: 'ok', player: playerView(p) };
  if (p.status === 'disqualified') throw E(403, 'disqualified', 'This player has been disqualified.');
  const bl = gameBlock(); if (bl) throw E(423, bl[0], bl[1]);
  if (scanCount(p) < 7) throw E(403, 'not_complete', 'Collect all seven letters first.');
  const now = Date.now(); p.attempts = (p.attempts || []).filter(t => now - t < 600000);
  if (p.attempts.length >= s.maxAnswerAttempts) throw E(429, 'locked', `Too many wrong answers. Try again in ${Math.ceil((600000 - (now - p.attempts[0])) / 60000)} min.`);
  const a = String(body.answer || '').trim().toLowerCase().slice(0, 64);
  if (!safeEq(a, String(s.secret).trim().toLowerCase())) {
    p.attempts.push(now); emit('wrong', { pid: p.id, name: p.name, msg: `${p.name} gave a wrong answer` });
    throw E(422, 'wrong_answer', `Not quite. ${s.maxAnswerAttempts - p.attempts.length} attempts left.`);
  }
  // synchronous section: ranking is race-free in single-threaded Node
  const position = ++state.winnerSeq;
  let code; do { code = 'DOOD-' + Array.from({ length: 8 }, () => CLAIM_ALPHA[crypto.randomInt(CLAIM_ALPHA.length)]).join(''); } while (Object.values(state.players).some(x => x.win && x.win.claimCode === code));
  p.win = { position, claimCode: code, at: now, durationMs: now - p.createdAt, verified: false, prizeEligible: !s.maxWinners || position <= s.maxWinners };
  emit('winner', { pid: p.id, name: p.name, msg: `${p.name} finished in position #${position}` });
  notify(`Mr.DooD winner #${position}: ${p.name} (${code})`);
  return { result: 'ok', player: playerView(p) };
});

route('GET', '/api/leaderboard', {}, () => ({
  winners: Object.values(state.players).filter(p => p.win && p.status !== 'disqualified').sort((a, b) => a.win.position - b.win.position).slice(0, 20).map(p => ({ position: p.win.position, name: p.name, durationMs: p.win.durationMs, at: p.win.at }))
}));

/* ------------------------------ admin routes ------------------------------ */
route('POST', '/api/admin/login', { ip: ['login', 30, 900000] }, ({ req, body, ip }) => {
  const u = String(body.username || '').slice(0, 40), pw = String(body.password || '').slice(0, 200);
  if (!rl('login-ip:' + ip, state.settings.loginMaxAttempts * 2, 900000) || !rl('login-user:' + u, state.settings.loginMaxAttempts, 900000)) throw E(429, 'rate_limited', 'Too many login attempts. Try again later.');
  const a = Object.prototype.hasOwnProperty.call(state.admins, u) ? state.admins[u] : null;
  const ok = checkPw(pw, a ? a.pw : DUMMY_PW) && a;
  if (!ok) { audit(null, 'login.failed', u, ip); throw E(401, 'bad_credentials', 'Wrong username or password.'); }
  const tok = rand(32), csrf = rand(16);
  sessions.set(sha(tok).toString('hex'), { username: a.username, csrf, exp: Date.now() + state.settings.sessionMinutes * 60000 });
  audit(a, 'login', '', ip);
  return [{ admin: { username: a.username, role: a.role, perms: permList(a) }, csrf }, 200, { 'set-cookie': setCookie(req, 'dood_a', tok, 60 * 60 * 24, 'Strict') }];
});
route('POST', '/api/admin/logout', { admin: true }, ({ req, admin, ip }) => {
  sessions.delete(sha(cookies(req).dood_a).toString('hex')); audit(admin, 'logout', '', ip);
  return [{ ok: true }, 200, { 'set-cookie': setCookie(req, 'dood_a', '', 0, 'Strict') }];
});
route('GET', '/api/admin/me', { admin: true }, ({ admin, session }) => ({ admin: { username: admin.username, role: admin.role, perms: permList(admin) }, csrf: session.csrf }));

function stats() {
  const ps = Object.values(state.players), now = Date.now();
  const perSlot = [0, 0, 0, 0, 0, 0, 0]; let scans = 0;
  for (const p of ps) for (const n of Object.keys(p.scans)) { perSlot[n - 1]++; scans++; }
  const hours = []; const base = Math.floor(now / 3600000) * 3600000;
  for (let i = 23; i >= 0; i--) hours.push({ t: base - i * 3600000, scans: 0, players: 0, suspicious: 0 });
  for (const e of state.events) { const i = Math.floor((e.t - (base - 23 * 3600000)) / 3600000); if (i < 0 || i > 23) continue; if (e.type === 'scan') hours[i].scans++; else if (e.type === 'register') hours[i].players++; else if (e.type === 'suspicious') hours[i].suspicious++; }
  return {
    players: ps.length, scans, completed: ps.filter(p => scanCount(p) === 7).length, winners: ps.filter(p => p.win).length,
    active: ps.filter(p => p.status === 'active' && now - Math.max(p.lastScanAt, p.createdAt) < 15 * 60000).length,
    disqualified: ps.filter(p => p.status === 'disqualified').length, suspicious: state.events.filter(e => e.type === 'suspicious').length,
    completionPct: ps.length ? Math.round(scans / (ps.length * 7) * 1000) / 10 : 0, perSlot, slotLabels: state.slots.map(s => s.letter), hours, gameStatus: state.settings.gameStatus
  };
}
route('GET', '/api/admin/overview', { perm: 'stats' }, () => stats());
route('GET', '/api/admin/activity', { perm: 'activity' }, () => ({ events: state.events.slice(-200).reverse() }));
route('GET', '/api/admin/stream', { perm: 'activity', raw: true }, ({ req, res }) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write('retry: 3000\n\n');
  const c = { res }; clients.add(c);
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch { /* closed */ } }, 25000);
  req.on('close', () => { clearInterval(hb); clients.delete(c); });
});

const pSummary = p => ({ id: p.id, name: p.name, status: p.status, progress: scanCount(p), createdAt: p.createdAt, lastScanAt: p.lastScanAt || null, suspicious: p.suspicious || 0, winner: p.win ? { position: p.win.position, claimCode: p.win.claimCode, at: p.win.at, durationMs: p.win.durationMs, verified: p.win.verified, prizeEligible: p.win.prizeEligible } : null });
route('GET', '/api/admin/players', { perm: 'players' }, ({ query }) => {
  const q = (query.q || '').toLowerCase(), st = query.status || 'all';
  const list = Object.values(state.players).filter(p => (!q || p.nameKey.includes(q)) && (st === 'all' || (st === 'winner' ? p.win : st === 'complete' ? scanCount(p) === 7 : st === 'suspicious' ? p.suspicious > 0 : p.status === st))).sort((a, b) => b.createdAt - a.createdAt).slice(0, 1000);
  return { players: list.map(pSummary) };
});
const getPlayer = id => { if (!Object.prototype.hasOwnProperty.call(state.players, id)) throw E(404, 'not_found', 'Player not found.'); return state.players[id]; };
route('GET', '/api/admin/players/:id', { perm: 'players' }, ({ params }) => {
  const p = getPlayer(params.id);
  return { player: Object.assign(pSummary(p), { scans: Object.keys(p.scans).map(Number).sort((a, b) => a - b).map(n => ({ n, letter: LETTERS[n - 1], label: state.slots[n - 1].label, at: p.scans[n] })), wrongAnswers: (p.attempts || []).length, events: state.events.filter(e => e.pid === p.id).slice(-30).reverse() }) };
});
for (const [act, fn] of Object.entries({
  disqualify: p => { p.status = 'disqualified'; }, reinstate: p => { p.status = 'active'; },
  reset: p => { p.scans = {}; p.win = null; p.attempts = []; p.suspicious = 0; p.lastScanAt = 0; }
})) route('POST', `/api/admin/players/:id/${act}`, { perm: 'players' }, ({ params, admin, ip }) => { const p = getPlayer(params.id); fn(p); audit(admin, 'player.' + act, p.name, ip); return { ok: true }; });
route('DELETE', '/api/admin/players/:id', { perm: 'players' }, ({ params, admin, ip }) => { const p = getPlayer(params.id); delete state.players[p.id]; audit(admin, 'player.remove', p.name, ip); return { ok: true }; });

route('GET', '/api/admin/winners', { perm: 'winners' }, () => ({
  winners: Object.values(state.players).filter(p => p.win).sort((a, b) => a.win.position - b.win.position).map(p => Object.assign(pSummary(p), { disqualified: p.status === 'disqualified' }))
}));
route('POST', '/api/admin/winners/:id/verify', { perm: 'winners' }, ({ params, body, admin, ip }) => {
  const p = getPlayer(params.id); if (!p.win) throw E(409, 'not_winner', 'Player has not won.');
  p.win.verified = body.verified !== false; audit(admin, p.win.verified ? 'winner.verify' : 'winner.unverify', `${p.name} #${p.win.position}`, ip); return { ok: true, verified: p.win.verified };
});

route('POST', '/api/admin/game/:action', { perm: 'game' }, ({ params, admin, ip }) => {
  const map = { start: 'running', pause: 'paused', resume: 'running' };
  if (!map[params.action]) throw E(404, 'not_found', 'Unknown action');
  state.settings.gameStatus = map[params.action]; audit(admin, 'game.' + params.action, '', ip); emit('game', { msg: `Game ${params.action}${params.action === 'pause' ? 'd' : params.action === 'resume' ? 'd' : 'ed'}` });
  return { ok: true, status: state.settings.gameStatus };
});
route('POST', '/api/admin/reset-game', { perm: 'reset' }, ({ body, admin, ip }) => {
  if (body.confirm !== 'RESET') throw E(400, 'confirm_required', 'Type RESET to confirm.');
  state.players = {}; state.winnerSeq = 0; state.events = []; windows.clear(); audit(admin, 'game.reset', 'all players cleared', ip); emit('game', { msg: 'Game was reset' }); return { ok: true };
});
route('POST', '/api/admin/clear-events', { perm: 'data' }, ({ admin, body, ip }) => {
  if (body.confirm !== 'CLEAR') throw E(400, 'confirm_required', 'Type CLEAR to confirm.');
  state.events = []; audit(admin, 'data.clear_events', '', ip); return { ok: true };
});

const SETTING_RULES = {
  title: ['s', 80], brand: ['s', 40], eventInfo: ['s', 400], description: ['s', 400], secret: ['s', 40, 1], registrationsOpen: ['b'], scanningOpen: ['b'],
  duplicatePolicy: ['e', ['notify', 'silent']], minScanIntervalMs: ['i', 0, 60000], maxWinners: ['i', 0, 10000], suspiciousInvalidPerMin: ['i', 1, 100], suspiciousScansPerMin: ['i', 1, 200],
  maxAnswerAttempts: ['i', 1, 50], sessionMinutes: ['i', 5, 10080], loginMaxAttempts: ['i', 3, 50], ntfyUrl: ['s', 300], telegramToken: ['s', 200], telegramChat: ['s', 60]
};
const MASK = '••••••••';
const settingsView = () => Object.assign({}, state.settings, { telegramToken: state.settings.telegramToken ? MASK : '', totalQr: 7 });
route('GET', '/api/admin/settings', { perm: 'settings' }, () => ({ settings: settingsView() }));
function applySettings(body, keys) {
  const changed = [];
  for (const k of keys) {
    const rule = SETTING_RULES[k]; if (!(k in body)) continue; let v = body[k];
    if (rule[0] === 's') { v = String(v).trim(); if (v.length > rule[1] || (rule[2] && !v)) throw E(422, 'invalid_setting', `Invalid ${k}`); if (k === 'telegramToken' && v === MASK) continue; if (k === 'ntfyUrl' && v && !/^https?:\/\//.test(v)) throw E(422, 'invalid_setting', 'ntfy URL must start with http(s)://'); }
    else if (rule[0] === 'b') { if (typeof v !== 'boolean') throw E(422, 'invalid_setting', `Invalid ${k}`); }
    else if (rule[0] === 'i') { v = Number(v); if (!Number.isInteger(v) || v < rule[1] || v > rule[2]) throw E(422, 'invalid_setting', `${k} must be ${rule[1]}–${rule[2]}`); }
    else if (rule[0] === 'e') { if (!rule[1].includes(v)) throw E(422, 'invalid_setting', `Invalid ${k}`); }
    if (state.settings[k] !== v) { state.settings[k] = v; changed.push(k); }
  }
  return changed;
}
route('PUT', '/api/admin/settings', { perm: 'settings' }, ({ body, admin, ip }) => {
  const changed = applySettings(body, Object.keys(SETTING_RULES));
  audit(admin, 'settings.update', changed.filter(k => k !== 'secret' && k !== 'telegramToken').join(', ') + (changed.includes('secret') ? ' [secret changed]' : ''), ip);
  return { settings: settingsView() };
});
const GAME_KEYS = ['registrationsOpen', 'scanningOpen', 'duplicatePolicy', 'minScanIntervalMs', 'suspiciousInvalidPerMin', 'suspiciousScansPerMin'];
const gameCfg = () => Object.fromEntries(GAME_KEYS.map(k => [k, state.settings[k]]));
route('GET', '/api/admin/game-config', { perm: 'game' }, () => ({ config: gameCfg(), status: state.settings.gameStatus }));
route('PUT', '/api/admin/game-config', { perm: 'game' }, ({ body, admin, ip }) => { const c = applySettings(body, GAME_KEYS); audit(admin, 'game.config', c.join(', '), ip); return { config: gameCfg() }; });
route('POST', '/api/admin/notify-test', { perm: 'settings' }, async ({ admin, ip }) => { await notify('Mr.DooD test notification'); audit(admin, 'notify.test', '', ip); return { ok: true }; });

route('GET', '/api/admin/audit', { perm: 'audit' }, () => ({ audit: state.audit.slice(-300).reverse() }));
route('GET', '/api/admin/admins', { perm: 'admins' }, () => ({ admins: Object.values(state.admins).map(a => ({ username: a.username, role: a.role, extra: a.extra || [], createdAt: a.createdAt })) }));
const validPw = pw => typeof pw === 'string' && pw.length >= 10 && pw.length <= 200;
route('POST', '/api/admin/admins', { perm: 'admins' }, ({ body, admin, ip }) => {
  const u = String(body.username || '').trim();
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(u)) throw E(422, 'invalid_username', 'Username: 3–32 letters, numbers, . _ -');
  if (!['super', 'manager', 'qr'].includes(body.role)) throw E(422, 'invalid_role', 'Invalid role.');
  if (!validPw(body.password)) throw E(422, 'weak_password', 'Password must be at least 10 characters.');
  if (Object.prototype.hasOwnProperty.call(state.admins, u)) throw E(409, 'exists', 'Username already exists.');
  const extra = body.role === 'manager' && body.qrAccess ? ['qr'] : [];
  state.admins[u] = { username: u, role: body.role, extra, pw: hashPw(body.password), createdAt: Date.now() }; audit(admin, 'admin.create', `${u} (${body.role})`, ip); return { ok: true };
});
route('PUT', '/api/admin/admins/:u', { perm: 'admins' }, ({ params, body, admin, ip }) => {
  const a = state.admins[params.u]; if (!a || !Object.prototype.hasOwnProperty.call(state.admins, params.u)) throw E(404, 'not_found', 'Admin not found.');
  if (body.role !== undefined) {
    if (!['super', 'manager', 'qr'].includes(body.role)) throw E(422, 'invalid_role', 'Invalid role.');
    if (a.role === 'super' && body.role !== 'super' && Object.values(state.admins).filter(x => x.role === 'super').length < 2) throw E(409, 'last_super', 'Keep at least one super administrator.');
    a.role = body.role;
  }
  if (body.qrAccess !== undefined) a.extra = a.role === 'manager' && body.qrAccess ? ['qr'] : [];
  if (body.password !== undefined) { if (!validPw(body.password)) throw E(422, 'weak_password', 'Password must be at least 10 characters.'); a.pw = hashPw(body.password); }
  for (const [k, s] of sessions) if (s.username === a.username) sessions.delete(k); // force re-login after any privilege change
  audit(admin, 'admin.update', a.username, ip); return { ok: true };
});
route('DELETE', '/api/admin/admins/:u', { perm: 'admins' }, ({ params, admin, ip }) => {
  const a = Object.prototype.hasOwnProperty.call(state.admins, params.u) ? state.admins[params.u] : null; if (!a) throw E(404, 'not_found', 'Admin not found.');
  if (a.role === 'super' && Object.values(state.admins).filter(x => x.role === 'super').length < 2) throw E(409, 'last_super', 'Keep at least one super administrator.');
  delete state.admins[a.username]; for (const [k, s] of sessions) if (s.username === a.username) sessions.delete(k); audit(admin, 'admin.delete', a.username, ip); return { ok: true };
});
route('POST', '/api/admin/password', { admin: true }, ({ body, admin, ip, session }) => {
  if (!checkPw(String(body.current || ''), admin.pw)) throw E(403, 'bad_credentials', 'Current password is wrong.');
  if (!validPw(body.password)) throw E(422, 'weak_password', 'Password must be at least 10 characters.');
  admin.pw = hashPw(body.password); for (const [k, s] of sessions) if (s.username === admin.username && s !== session) sessions.delete(k);
  audit(admin, 'password.change', '', ip); return { ok: true };
});

/* ---- data management ---- */
route('GET', '/api/admin/export/players.csv', { perm: 'players', raw: true }, ({ res, admin, ip }) => {
  const q = v => `"${String(v ?? '').replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"`;
  const rows = [['name', 'status', 'letters', 'registered', 'completed_scans_at', 'position', 'claim_code', 'duration_s', 'verified', 'suspicious'].join(',')];
  for (const p of Object.values(state.players)) rows.push([q(p.name), p.status, scanCount(p), new Date(p.createdAt).toISOString(), scanCount(p) === 7 ? new Date(Math.max(...Object.values(p.scans))).toISOString() : '', p.win ? p.win.position : '', p.win ? p.win.claimCode : '', p.win ? Math.round(p.win.durationMs / 1000) : '', p.win ? p.win.verified : '', p.suspicious || 0].join(','));
  audit(admin, 'data.export_players', '', ip);
  res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="players.csv"', 'cache-control': 'no-store' }); res.end(rows.join('\n'));
});
route('GET', '/api/admin/backup', { perm: 'data', raw: true }, ({ res, admin, ip }) => {
  audit(admin, 'data.backup', 'contains QR tokens and password hashes', ip);
  res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': `attachment; filename="mrdood-backup-${new Date().toISOString().slice(0, 10)}.json"`, 'cache-control': 'no-store' }); res.end(JSON.stringify(state));
});
route('POST', '/api/admin/restore', { perm: 'data', limit: 8e6 }, ({ body, admin, ip }) => {
  if (body.confirm !== 'RESTORE') throw E(400, 'confirm_required', 'Type RESTORE to confirm.');
  const d = body.data; if (!d || typeof d !== 'object' || !d.admins || !Object.values(d.admins).some(a => a && a.role === 'super' && a.pw) || !Array.isArray(d.slots) || d.slots.length !== 7) throw E(422, 'invalid_backup', 'This is not a valid Mr.DooD backup.');
  state = normalizeState(d); sessions.clear(); audit(null, 'data.restore', `by ${admin.username}`, ip); save(true); return { ok: true, relogin: true };
});

/* ---- QR management (perm 'qr' only) ---- */
const baseUrl = req => (process.env.PUBLIC_URL || `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`).replace(/\/$/, '');
const slotMeta = s => ({ n: s.n, letter: s.letter, label: s.label, notes: s.notes, active: s.active, revoked: s.revoked, createdAt: s.createdAt, rotatedAt: s.rotatedAt, rotations: s.rotations, scans: Object.values(state.players).filter(p => p.scans[s.n]).length });
const getSlot = n => { n = +n; if (!Number.isInteger(n) || n < 1 || n > 7) throw E(404, 'not_found', 'Unknown QR slot.'); return state.slots[n - 1]; };
const qrUrl = (req, s) => `${baseUrl(req)}/s/${s.token}`;
const noStore = { 'cache-control': 'no-store, max-age=0', pragma: 'no-cache' };
route('GET', '/api/admin/qr/slots', { perm: 'qr' }, () => ({ slots: state.slots.map(slotMeta) }));
route('PUT', '/api/admin/qr/:n', { perm: 'qr' }, ({ params, body, admin, ip }) => { // label/notes only – letter mapping is immutable
  const s = getSlot(params.n);
  if (body.label !== undefined) s.label = String(body.label).trim().slice(0, 60) || s.label;
  if (body.notes !== undefined) s.notes = String(body.notes).trim().slice(0, 300);
  audit(admin, 'qr.edit', `slot ${s.n}`, ip); return { slot: slotMeta(s) };
});
function slotAction(act, s) {
  if (act === 'regenerate') { s.token = rand(24); s.revoked = false; s.active = true; s.rotatedAt = Date.now(); s.rotations++; }
  else if (act === 'revoke') { s.token = null; s.revoked = true; s.active = false; s.rotatedAt = Date.now(); }
  else if (act === 'activate') { if (s.revoked || !s.token) throw E(409, 'revoked', 'Revoked slot: regenerate it first.'); s.active = true; }
  else if (act === 'deactivate') s.active = false;
  else throw E(404, 'not_found', 'Unknown action');
}
route('POST', '/api/admin/qr/reset-all', { perm: 'qr' }, ({ body, admin, ip }) => {
  if (body.confirm !== 'RESET QR') throw E(400, 'confirm_required', 'Type RESET QR to confirm.');
  state.slots.forEach(s => slotAction('regenerate', s)); audit(admin, 'qr.reset_all', 'all 7 tokens regenerated', ip); return { slots: state.slots.map(slotMeta) };
});
route('POST', '/api/admin/qr/:n/:action', { perm: 'qr' }, ({ params, admin, ip }) => {
  const s = getSlot(params.n); slotAction(params.action, s); audit(admin, 'qr.' + params.action, `slot ${s.n}`, ip); return { slot: slotMeta(s) };
});
const pngOpts = { errorCorrectionLevel: 'M', margin: 3, width: 900, color: { dark: '#111111', light: '#ffffff' } };
function needToken(s) { if (!s.token) throw E(409, 'revoked', 'This QR is revoked. Regenerate it first.'); }
route('GET', '/api/admin/qr/zip', { perm: 'qr', raw: true }, async ({ req, res, admin, ip }) => {
  const files = [];
  for (const s of state.slots) if (s.token) files.push({ name: `QR-${s.n}-${LETTER_NAMES[s.n - 1]}.png`, data: await QRCode.toBuffer(qrUrl(req, s), pngOpts) });
  if (!files.length) throw E(409, 'none', 'No active tokens.');
  audit(admin, 'qr.download_zip', '', ip);
  res.writeHead(200, Object.assign({ 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="mrdood-qr-codes.zip"' }, noStore)); res.end(makeZip(files));
});
route('GET', '/api/admin/qr/sheet', { perm: 'qr', raw: true }, async ({ req, res, admin, ip }) => {
  let cells = '';
  for (const s of state.slots) {
    const svg = s.token ? await QRCode.toString(qrUrl(req, s), { type: 'svg', errorCorrectionLevel: 'M', margin: 2 }) : '<p class="rev">REVOKED</p>';
    cells += `<figure>${svg}<figcaption><b>${escHtml(s.label)}</b><span>Slot ${s.n}</span></figcaption></figure>`;
  }
  audit(admin, 'qr.print_sheet', '', ip);
  res.writeHead(200, Object.assign({ 'content-type': 'text/html; charset=utf-8' }, SEC_HEADERS, noStore));
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Mr.DooD QR print sheet</title><link rel="stylesheet" href="/assets/sheet.css"></head><body><header><h1>Mr.DooD QR sheet</h1><button id="p">Print</button></header><main>${cells}</main><script src="/assets/sheet.js"></script></body></html>`);
});
route('GET', '/api/admin/qr/:n/image', { perm: 'qr', raw: true }, async ({ req, res, params, query, admin, ip }) => {
  const s = getSlot(params.n); needToken(s); const url = qrUrl(req, s);
  audit(admin, query.dl ? 'qr.download' : 'qr.view', `slot ${s.n}`, ip);
  if (query.format === 'png') { const b = await QRCode.toBuffer(url, pngOpts); res.writeHead(200, Object.assign({ 'content-type': 'image/png' }, query.dl ? { 'content-disposition': `attachment; filename="QR-${s.n}-${LETTER_NAMES[s.n - 1]}.png"` } : {}, noStore)); return res.end(b); }
  const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, color: { dark: '#111111', light: '#ffffff' } });
  res.writeHead(200, Object.assign({ 'content-type': 'image/svg+xml' }, query.dl ? { 'content-disposition': `attachment; filename="QR-${s.n}-${LETTER_NAMES[s.n - 1]}.svg"` } : {}, noStore)); res.end(svg);
});
const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---- minimal store-only ZIP writer ---- */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function makeZip(files) {
  const parts = [], cd = []; let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.name), crc = crc32(f.data), h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt32LE(crc, 14); h.writeUInt32LE(f.data.length, 18); h.writeUInt32LE(f.data.length, 22); h.writeUInt16LE(name.length, 26);
    parts.push(h, name, f.data);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt32LE(crc, 16); c.writeUInt32LE(f.data.length, 20); c.writeUInt32LE(f.data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(off, 42);
    cd.push(c, name); off += 30 + name.length + f.data.length;
  }
  const cdBuf = Buffer.concat(cd), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

/* ------------------------------ static files & dispatcher ------------------------------ */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' || pathname.startsWith('/s/') ? '/index.html' : pathname === '/admin' ? '/admin.html' : pathname;
  let f; try { f = path.join(PUB, decodeURIComponent(rel)); } catch { return false; }
  if (!f.startsWith(PUB + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return false;
  const ext = path.extname(f), isHtml = ext === '.html';
  res.writeHead(200, Object.assign({ 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': isHtml ? 'no-store' : 'public, max-age=300' }, SEC_HEADERS));
  fs.createReadStream(f).pipe(res); return true;
}
const redact = p => p.startsWith('/s/') ? '/s/[token]' : p;

const server = http.createServer(async (req, res) => {
  const t0 = Date.now(); const url = new URL(req.url, 'http://x'); const pathname = url.pathname;
  for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
  if (isHttps(req)) res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  res.on('finish', () => { if (pathname.startsWith('/api') ) log('REQ', req.method, redact(pathname), res.statusCode, Date.now() - t0 + 'ms'); });
  try {
    if (req.method === 'GET' || req.method === 'HEAD') { if (!pathname.startsWith('/api/') && pathname !== '/healthz' && serveStatic(req, res, pathname)) return; }
    const ip = getIp(req);
    for (const r of routes) {
      if (r.method !== req.method) continue; const m = r.re.exec(pathname); if (!m) continue;
      const o = r.opts, ctx = { req, res, ip, params: Object.assign({}, m.groups), query: Object.fromEntries(url.searchParams) };
      if (o.ip && !rl(o.ip[0] + ':' + ip, o.ip[1], o.ip[2])) throw E(429, 'rate_limited', 'Too many requests. Please wait.');
      if (o.perm || o.admin) {
        const a = adminFrom(req); if (!a) throw E(401, 'unauthenticated', 'Please sign in.');
        if (req.method !== 'GET' && !(typeof req.headers['x-csrf-token'] === 'string' && safeEq(req.headers['x-csrf-token'], a.session.csrf))) throw E(403, 'csrf', 'Invalid CSRF token.');
        if (o.perm && !can(a.admin, o.perm)) { audit(a.admin, 'denied', `${req.method} ${pathname}`, ip); throw E(403, 'forbidden', 'You do not have permission for this action.'); }
        ctx.admin = a.admin; ctx.session = a.session;
      }
      if (o.player) { const p = playerFrom(req); if (!p) throw E(401, 'no_player', 'Please register first.'); ctx.player = p; }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const ct = String(req.headers['content-type'] || ''); if (!ct.includes('application/json') && Number(req.headers['content-length'] || 0) > 0) throw E(415, 'bad_content_type', 'JSON required.');
        ctx.body = await readBody(req, o.limit || 65536);
      } else ctx.body = {};
      const out = await r.fn(ctx);
      if (o.raw) return;
      if (Array.isArray(out)) return send(res, out[1], out[0], out[2]);
      return send(res, 200, out);
    }
    throw E(404, 'not_found', 'Not found.');
  } catch (e) {
    if (res.headersSent) { try { res.end(); } catch { /* */ } return; }
    if (e instanceof HttpError) return send(res, e.code, { error: e.error, message: e.message });
    log('ERROR', req.method, redact(pathname), e && e.stack || e);
    send(res, 500, { error: 'server_error', message: 'Something went wrong. Please try again.' });
  }
});

async function shutdown() { log('INFO', 'shutting down'); for (const c of clients) try { c.res.end(); } catch { /* */ } await save(true); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
process.on('unhandledRejection', e => log('ERROR', 'unhandledRejection', e));

if (require.main === module) load().then(() => server.listen(PORT, () => log('INFO', `Mr.DooD hunt listening on :${PORT} (persistence: ${persistMode})`))).catch(() => process.exit(1));
module.exports = { server, load };
