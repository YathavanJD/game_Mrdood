'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let port = 3900 + Math.floor(Math.random() * 500);
function start(dir, extra = {}) {
  const p = ++port; const proc = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: Object.assign({}, process.env, { PORT: p, DATA_DIR: dir, ADMIN_USER: 'root', ADMIN_PASSWORD: 'correct-horse-battery', PUBLIC_URL: 'http://localhost:' + p }, extra), stdio: 'ignore' });
  return { proc, base: 'http://localhost:' + p };
}
async function up(base) { for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/healthz')).ok) return; } catch { /* wait */ } await sleep(100); } throw new Error('server did not start'); }
function client(base) {
  const jar = {}; let csrf = '';
  const c = {
    csrf: () => csrf, jar,
    async req(method, p, body, headers = {}) {
      const h = Object.assign({ cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') }, body !== undefined ? { 'content-type': 'application/json' } : {}, headers);
      const r = await fetch(base + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
      for (const sc of r.headers.getSetCookie()) { const [kv] = sc.split(';'); const i = kv.indexOf('='); const v = kv.slice(i + 1); if (v) jar[kv.slice(0, i)] = v; else delete jar[kv.slice(0, i)]; }
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
      return { status: r.status, json, text, headers: r.headers };
    },
    async login(u = 'root', pw = 'correct-horse-battery') { const r = await c.req('POST', '/api/admin/login', { username: u, password: pw }); if (r.status === 200) csrf = r.json.csrf; return r; },
    adm: (m, p, b) => c.req(m, '/api/admin' + p, b === undefined && m !== 'GET' ? {} : b, { 'x-csrf-token': csrf })
  };
  return c;
}
const tokens = dir => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).slots.map(s => s.token);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dood-')); let S, base, admin, tk;
before(async () => { S = start(dir); base = S.base; await up(base); admin = client(base); await admin.login(); await admin.adm('PUT', '/game-config', { minScanIntervalMs: 0 }); await sleep(500); tk = tokens(dir); });
after(() => { S && S.proc.kill('SIGTERM'); });

test('deployment: health, static assets, private files protected', async () => {
  const c = client(base);
  assert.equal((await c.req('GET', '/healthz')).json.ok, true);
  for (const f of ['/', '/admin', '/assets/style.css', '/assets/game.js', '/assets/admin.js', '/assets/admin.css']) assert.equal((await c.req('GET', f)).status, 200, f);
  for (const f of ['/private/img/1.jpg', '/img/1.jpg', '/data/state.json', '/server.js', '/../server.js', '/assets/../../server.js', '/%2e%2e/server.js', '/package.json']) assert.notEqual((await c.req('GET', f)).status, 200, f);
  const r = await c.req('GET', '/s/' + tk[0]); assert.equal(r.status, 200); assert.ok(r.text.includes('Mr.DooD'));
  assert.ok(r.headers.get('content-security-policy')); assert.equal(r.headers.get('x-frame-options'), 'DENY');
});

test('public responses never contain QR tokens', async () => {
  const c = client(base); await c.req('POST', '/api/register', { name: 'Leaky' });
  for (const p of ['/api/public', '/api/me', '/api/leaderboard', '/', '/assets/game.js']) { const t = (await c.req('GET', p)).text; for (const k of tk) assert.ok(!t.includes(k), p); }
});

test('registration validation and duplicates', async () => {
  const c = client(base);
  for (const bad of ['', 'a', 'x'.repeat(25), '<script>alert(1)</script>', '   ']) assert.equal((await c.req('POST', '/api/register', { name: bad })).status, 422, bad);
  assert.equal((await c.req('POST', '/api/register', { name: 'Alice' })).status, 201);
  assert.equal((await c.req('POST', '/api/register', { name: 'Someone else' })).json.player.name, 'Alice'); // same session cannot re-register
  assert.equal((await client(base).req('POST', '/api/register', { name: 'alice' })).status, 409);
  assert.equal((await client(base).req('GET', '/api/me')).status, 401);
});

test('admin auth: login, CSRF, unauthenticated, logout', async () => {
  const c = client(base);
  assert.equal((await c.req('GET', '/api/admin/overview')).status, 401);
  assert.equal((await c.login('root', 'wrong')).status, 401);
  assert.equal((await c.login()).status, 200);
  assert.equal((await c.req('GET', '/api/admin/overview')).status, 200);
  assert.equal((await c.req('POST', '/api/admin/game/pause', {})).status, 403); // missing CSRF token
  assert.equal((await c.req('POST', '/api/admin/game/pause', {}, { 'x-csrf-token': 'nope' })).status, 403);
  assert.equal((await c.adm('POST', '/logout')).status, 200);
  assert.equal((await c.req('GET', '/api/admin/overview')).status, 401);
});

test('role permissions enforced on the backend', async () => {
  for (const [u, role, qrAccess] of [['gman', 'manager', false], ['gmqx', 'manager', true], ['qman', 'qr', false]]) assert.equal((await admin.adm('POST', '/admins', { username: u, password: 'long-enough-pass', role, qrAccess })).status, 200);
  const gm = client(base); await gm.login('gman', 'long-enough-pass');
  for (const p of ['/qr/slots', '/qr/1/image', '/qr/zip', '/qr/sheet', '/settings', '/admins', '/audit', '/backup']) assert.equal((await gm.adm('GET', p)).status, 403, 'gm ' + p);
  for (const [m, p] of [['POST', '/qr/1/regenerate'], ['POST', '/qr/reset-all'], ['PUT', '/qr/1'], ['POST', '/reset-game'], ['PUT', '/settings'], ['POST', '/admins']]) assert.equal((await gm.adm(m, p, { confirm: 'RESET' })).status, 403, 'gm ' + p);
  assert.equal((await gm.adm('GET', '/overview')).status, 200);
  assert.equal((await gm.adm('GET', '/players')).status, 200);
  const qm = client(base); await qm.login('qman', 'long-enough-pass');
  for (const p of ['/overview', '/players', '/winners', '/settings', '/audit', '/activity']) assert.equal((await qm.adm('GET', p)).status, 403, 'qm ' + p);
  assert.equal((await qm.adm('POST', '/game/pause')).status, 403);
  const slots = await qm.adm('GET', '/qr/slots'); assert.equal(slots.status, 200); assert.equal(slots.json.slots.length, 7);
  for (const k of tk) assert.ok(!slots.text.includes(k), 'slot listing must not contain tokens');
  const gmq = client(base); await gmq.login('gmqx', 'long-enough-pass'); assert.equal((await gmq.adm('GET', '/qr/slots')).status, 200); assert.equal((await gmq.adm('GET', '/settings')).status, 403);
  assert.equal((await qm.adm('GET', '/qr/1/image?format=png')).headers.get('content-type'), 'image/png');
  assert.equal((await qm.adm('GET', '/qr/zip')).headers.get('content-type'), 'application/zip');
});

test('settings and dashboard never expose QR tokens or links', async () => {
  for (const p of ['/settings', '/overview', '/activity', '/players', '/winners', '/audit', '/admins', '/game-config']) { const t = (await admin.adm('GET', p)).text; for (const k of tk) assert.ok(!t.includes(k), p); assert.ok(!t.includes('/s/'), p + ' has /s/ link'); }
  assert.ok(!fs.readFileSync(path.join(__dirname, '../public/assets/admin.js'), 'utf8').includes('localStorage.setItem(\'tokens'));
});

test('QR security: valid, duplicate, forged, modified, fabricated, image gating', async () => {
  const p = client(base); assert.equal((await p.req('POST', '/api/register', { name: 'Runner' })).status, 201);
  assert.equal((await p.req('GET', '/api/img/1')).status, 403); // uncollected image blocked
  for (const bad of [{ token: 'A'.repeat(32) }, { token: tk[0].slice(0, -1) + (tk[0].endsWith('A') ? 'B' : 'A') }, { token: tk[0] + 'x' }, { token: '' }, { n: 3 }, { letter: 'M', n: 1 }, { token: { $ne: 1 } }, { token: ['a'] }])
    assert.equal((await p.req('POST', '/api/scan', bad)).status, 404, JSON.stringify(bad));
  assert.equal((await p.req('GET', '/api/me')).json.player.progress, 0);
  const r1 = await p.req('POST', '/api/scan', { token: tk[0] }); assert.equal(r1.status, 200); assert.equal(r1.json.result, 'ok'); assert.equal(r1.json.player.progress, 1);
  assert.equal((await p.req('GET', '/api/img/1')).headers.get('content-type'), 'image/jpeg');
  assert.equal((await p.req('GET', '/api/img/2')).status, 403);
  const d = await p.req('POST', '/api/scan', { token: tk[0] }); assert.equal(d.json.result, 'duplicate'); assert.equal(d.json.player.progress, 1);
  assert.equal((await client(base).req('POST', '/api/scan', { token: tk[1] })).status, 401); // unregistered cannot scan
  for (let i = 1; i < 7; i++) { const r = await p.req('POST', '/api/scan', { token: tk[i] }); assert.equal(r.json.result, 'ok', 'slot ' + (i + 1)); }
  const me = (await p.req('GET', '/api/me')).json.player; assert.equal(me.progress, 7); assert.equal(me.complete, true); assert.deepEqual(me.collected.map(c => c.letter), ['M', 'r', '.', 'D', 'o', 'o', 'D']);
});

test('regenerate / revoke / deactivate invalidate tokens immediately', async () => {
  const q = client(base); await q.req('POST', '/api/register', { name: 'Tester' });
  const old = tk[2]; const r = await admin.adm('POST', '/qr/3/regenerate'); assert.equal(r.status, 200); await sleep(400);
  const nw = tokens(dir); assert.notEqual(nw[2], old);
  assert.equal((await q.req('POST', '/api/scan', { token: old })).status, 404);
  assert.equal((await q.req('POST', '/api/scan', { token: nw[2] })).json.result, 'ok');
  assert.equal((await admin.adm('POST', '/qr/4/revoke')).status, 200); await sleep(400);
  assert.equal((await q.req('POST', '/api/scan', { token: tk[3] })).status, 404);
  assert.equal((await admin.adm('GET', '/qr/4/image')).status, 409); // revoked token has no image
  assert.equal((await admin.adm('POST', '/qr/4/activate')).status, 409);
  assert.equal((await admin.adm('POST', '/qr/5/deactivate')).status, 200);
  assert.equal((await q.req('POST', '/api/scan', { token: tk[4] })).status, 423);
  await admin.adm('POST', '/qr/5/activate'); assert.equal((await q.req('POST', '/api/scan', { token: tk[4] })).json.result, 'ok');
  assert.equal((await admin.adm('POST', '/qr/4/regenerate')).status, 200); await sleep(400);
  assert.equal((await q.req('POST', '/api/scan', { token: tokens(dir)[3] })).json.result, 'ok');
  assert.equal((await q.req('POST', '/api/scan', { token: tk[3] })).status, 404);
  // label edits cannot change letter mapping; slot count stays 7
  const e = await admin.adm('PUT', '/qr/1', { label: 'Renamed', letter: 'Z', n: 9 }); assert.equal(e.json.slot.letter, 'M'); assert.equal(e.json.slot.label, 'Renamed');
  assert.equal((await admin.adm('GET', '/qr/slots')).json.slots.length, 7); assert.equal((await admin.adm('POST', '/qr/8/regenerate')).status, 404);
  tk = tokens(dir);
});

test('secret word, ranking, claim codes, answer lockout', async () => {
  const scanAll = async c => { for (const t of tk) await c.req('POST', '/api/scan', { token: t }); };
  const a = client(base), b = client(base), c = client(base);
  await a.req('POST', '/api/register', { name: 'First' }); await b.req('POST', '/api/register', { name: 'Second' }); await c.req('POST', '/api/register', { name: 'Third' });
  assert.equal((await a.req('POST', '/api/answer', { answer: 'MrDooD' })).status, 403); // not complete yet
  await scanAll(a); await scanAll(b); await scanAll(c);
  assert.equal((await a.req('POST', '/api/answer', { answer: 'nope' })).status, 422);
  const [ra, rb] = await Promise.all([a.req('POST', '/api/answer', { answer: ' mrdood ' }), b.req('POST', '/api/answer', { answer: 'MrDooD' })]);
  const pos = [ra.json.player.winner.position, rb.json.player.winner.position].sort(); assert.deepEqual(pos, [1, 2]);
  assert.notEqual(ra.json.player.winner.claimCode, rb.json.player.winner.claimCode); assert.match(ra.json.player.winner.claimCode, /^DOOD-[A-Z2-9]{8}$/);
  const again = await a.req('POST', '/api/answer', { answer: 'MrDooD' }); assert.equal(again.json.player.winner.position, ra.json.player.winner.position);
  for (let i = 0; i < 5; i++) await c.req('POST', '/api/answer', { answer: 'bad' + i });
  assert.equal((await c.req('POST', '/api/answer', { answer: 'MrDooD' })).status, 429); // locked out even with right answer
  const lb = await client(base).req('GET', '/api/leaderboard'); assert.equal(lb.json.winners.length, 2); assert.ok(!lb.text.includes('DOOD-'));
  const w = await admin.adm('GET', '/winners'); assert.equal(w.json.winners.length, 2); assert.ok(w.json.winners[0].winner.claimCode);
  assert.equal((await admin.adm('POST', `/winners/${w.json.winners[0].id}/verify`, { verified: true })).json.verified, true);
});

test('player management, game pause, overview, reset', async () => {
  const pl = (await admin.adm('GET', '/players?q=runner')).json.players; assert.equal(pl.length, 1); const id = pl[0].id;
  const det = await admin.adm('GET', '/players/' + id); assert.equal(det.json.player.scans.length, 7);
  await admin.adm('POST', `/players/${id}/disqualify`); const r = client(base); // disqualified player cannot scan: use their cookie? create fresh one instead
  const x = client(base); await x.req('POST', '/api/register', { name: 'Pausable' });
  await admin.adm('POST', '/game/pause'); assert.equal((await x.req('POST', '/api/scan', { token: tk[0] })).status, 423);
  await admin.adm('POST', '/game/resume'); assert.equal((await x.req('POST', '/api/scan', { token: tk[0] })).status, 200);
  const ov = (await admin.adm('GET', '/overview')).json; assert.ok(ov.players >= 6 && ov.scans > 10 && ov.winners === 2 && ov.disqualified === 1 && ov.perSlot.length === 7);
  await admin.adm('POST', `/players/${id}/reinstate`); await admin.adm('POST', `/players/${id}/reset`); assert.equal((await admin.adm('GET', '/players/' + id)).json.player.progress, 0);
  assert.equal((await admin.adm('DELETE', '/players/' + id)).status, 200); assert.equal((await admin.adm('GET', '/players/' + id)).status, 404);
  assert.equal((await admin.adm('POST', '/reset-game', {})).status, 400); // needs typed confirmation
  assert.equal((await admin.adm('POST', '/reset-game', { confirm: 'RESET' })).status, 200);
  assert.equal((await admin.adm('GET', '/players')).json.players.length, 0);
  assert.equal((await x.req('GET', '/api/me')).status, 401);
  const y = client(base); await y.req('POST', '/api/register', { name: 'AfterReset' }); await y.req('POST', '/api/scan', { token: tk[0] });
  for (const t of tk.slice(1)) await y.req('POST', '/api/scan', { token: t }); assert.equal((await y.req('POST', '/api/answer', { answer: 'MrDooD' })).json.player.winner.position, 1);
});

test('suspicious scan detection and audit log', async () => {
  const s = client(base); await s.req('POST', '/api/register', { name: 'Sneaky' });
  for (let i = 0; i < 6; i++) await s.req('POST', '/api/scan', { token: 'forged-token-' + i + 'x'.repeat(20) });
  const ov = (await admin.adm('GET', '/overview')).json; assert.ok(ov.suspicious >= 1);
  const au = (await admin.adm('GET', '/audit')).json.audit.map(a => a.action); for (const a of ['login', 'qr.regenerate', 'qr.revoke', 'game.reset', 'denied']) assert.ok(au.includes(a), a);
});

test('backup / restore round trip', async () => {
  const bk = (await admin.adm('GET', '/backup')).text; assert.ok(JSON.parse(bk).slots.length === 7);
  assert.equal((await admin.adm('POST', '/restore', { confirm: 'RESTORE', data: { slots: [] } })).status, 422);
  assert.equal((await admin.adm('POST', '/restore', { confirm: 'RESTORE', data: JSON.parse(bk) })).status, 200);
  assert.equal((await admin.adm('GET', '/overview')).status, 401); // sessions cleared after restore
  await admin.login();
});

test('persistence survives restart; old tokens stay invalid', async () => {
  const p = client(base); await p.req('POST', '/api/register', { name: 'Survivor' }); await p.req('POST', '/api/scan', { token: tokens(dir)[0] }); await sleep(500);
  S.proc.kill('SIGTERM'); await sleep(700); S = start(dir); base = S.base; await up(base);
  const a = client(base); await a.login(); const pl = (await a.adm('GET', '/players?q=survivor')).json.players; assert.equal(pl.length, 1); assert.equal(pl[0].progress, 1);
  assert.equal((await a.adm('GET', '/qr/slots')).json.slots[2].rotations, 1);
});

test('session expiry', async () => {
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dood2-')); const s = start(d2); await up(s.base); s.proc.kill('SIGTERM'); await sleep(600);
  const f = path.join(d2, 'state.json'); const st = JSON.parse(fs.readFileSync(f, 'utf8')); st.settings.sessionMinutes = 0.001; fs.writeFileSync(f, JSON.stringify(st));
  const s2 = start(d2); await up(s2.base); const c = client(s2.base); assert.equal((await c.login()).status, 200); assert.equal((await c.adm('GET', '/overview')).status, 200);
  await sleep(200); assert.equal((await c.adm('GET', '/overview')).status, 401); s2.proc.kill('SIGTERM');
});

test('login rate limiting', async () => {
  const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'dood3-')); const s = start(d3); await up(s.base); const c = client(s.base);
  let last; for (let i = 0; i < 10; i++) last = (await c.login('root', 'bad' + i)).status; assert.equal(last, 429);
  assert.equal((await c.login()).status, 429); s.proc.kill('SIGTERM');
});
