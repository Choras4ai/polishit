'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');

test('isolated backend HTTP lifecycle, billing, refund and daily check-in', { timeout: 30000 }, async t => {
  let failUpstream = false;
  let upstreamCalls = 0;
  const upstream = http.createServer((req, res) => {
    upstreamCalls++;
    req.resume();
    res.writeHead(failUpstream ? 401 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(failUpstream ? { error: { message: 'fixture failure' } } : { choices: [{ message: { content: '测试结果。' } }] }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runshi-http-test-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('RUNSHI_')));
  Object.assign(env, {
    RUNSHI_LOAD_DOTENV: '0', RUNSHI_SERVER_PORT: String(port), RUNSHI_SERVER_HOST: '127.0.0.1',
    RUNSHI_SERVER_DB: path.join(directory, 'test.sqlite3'), RUNSHI_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    RUNSHI_UPSTREAM_API_URL: `http://127.0.0.1:${upstream.address().port}/v1`, RUNSHI_UPSTREAM_API_KEY: 'fixture-only',
    RUNSHI_UPSTREAM_MODEL: 'fixture-model', RUNSHI_INITIAL_CREDITS: '5', NODE_ENV: 'test',
  });
  const child = spawn(process.execPath, [process.env.RUNSHI_TEST_SERVER_ENTRY || path.resolve(__dirname, '../server/index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null) throw new Error(`Backend exited: ${logs}`);
    try { ready = (await fetch(`${base}/api/health`)).ok; } catch (_) {}
    if (ready) break;
    await delay(50);
  }
  assert(ready, `Backend did not start: ${logs}`);
  let token = '';
  const request = (route, body) => fetch(base + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  await t.test('unauthenticated accounts are rejected', async () => {
    assert.equal((await request('/api/auth/me')).status, 401);
  });
  const registered = await (await request('/api/device/register', { fingerprint: 'isolated-http-fixture' })).json();
  token = registered.token; assert(token);
  const messages = [{ role: 'user', content: '测试文字。' }];
  await t.test('negative billing never reaches the upstream', async () => {
    const response = await request('/api/ai/chat', { messages, options: { billableChars: -1 } });
    assert.equal(response.status, 400); assert.equal(upstreamCalls, 0);
  });
  await t.test('a completed AI request consumes credits', async () => {
    const response = await request('/api/ai/chat', { messages, options: { billableChars: 5, temperature: 0 } });
    const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.content, '测试结果。'); assert.equal(body.quota.freeCredits, 4.5);
  });
  await t.test('underreported characters cannot underpay the default upstream', async () => {
    const before = upstreamCalls;
    const response = await request('/api/ai/chat', { messages: [{ role: 'user', content: '文'.repeat(8000) }], options: { billableChars: 1 } });
    assert.equal(response.status, 402);
    assert.equal(upstreamCalls, before);
  });
  await t.test('upstream failure refunds the reserved debit', async () => {
    failUpstream = true;
    assert((await request('/api/ai/chat', { messages, options: { billableChars: 5 } })).status >= 400);
    const account = await (await request('/api/device/me')).json();
    assert.equal(account.account.freeCredits, 4.5);
  });
  await t.test('concurrent check-ins grant one daily credit', async () => {
    const signup = await (await request('/api/auth/register', { email: 'fixture@example.test', password: 'fixture-password-123' })).json();
    token = signup.token; assert(token, JSON.stringify(signup));
    const before = await (await request('/api/auth/me')).json();
    const results = await Promise.all([request('/api/checkin', {}), request('/api/checkin', {})]);
    const bodies = await Promise.all(results.map(response => response.json()));
    assert.equal(bodies.filter(body => body.ok).length, 1, JSON.stringify(bodies));
    const account = await (await request('/api/auth/me')).json();
    assert.equal(account.user.freeCredits, before.user.freeCredits + 1);
  });
});
