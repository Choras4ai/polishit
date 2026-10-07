'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Script } = require('node:vm');
const express = require('../server/node_modules/express');
const { mountAdmin } = require('../server/admin');
const { hashAdminPassword } = require('../server/services/admin-auth-service');

async function start(t, options = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  const db = { get: async () => ({ cnt: 0 }), all: async () => [], run: async () => ({ changes: 1 }) };
  mountAdmin(app, db, { publicBaseUrl: 'https://admin.example.test', adminUsername: 'operator', ...options });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return (url, init = {}) => fetch(base + url, { redirect: 'manual', ...init });
}

test('admin hash-only configuration authenticates username and password', async t => {
  const request = await start(t, { adminPasswordHash: hashAdminPassword('admin-test-password') });
  const response = await request('/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://admin.example.test' },
    body: JSON.stringify({ username: 'operator', password: 'admin-test-password' }),
  });
  assert.equal(response.status, 302);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie || '', /^__Host-runshi_admin=/);
  assert.match(cookie, /Path=\/;/);
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  assert.match(cookie, /Secure/);
});

test('admin mutation requires session-bound CSRF and dashboard has nonce CSP', async t => {
  const request = await start(t, { adminPassword: 'admin-test-password' });
  const login = await request('/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'operator', password: 'admin-test-password' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
  const rejected = await request('/admin/api/users/1/status', { method: 'POST', headers, body: '{"status":"disabled"}' });
  assert.equal(rejected.status, 403);
  const dashboard = await request('/admin', { headers });
  const html = await dashboard.text();
  assert.match(dashboard.headers.get('content-security-policy') || '', /script-src 'nonce-/);
  assert.match(dashboard.headers.get('x-robots-tag') || '', /noindex/);
  assert.doesNotMatch(html, /onclick=/);
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length);
  for (const [, source] of scripts) assert.doesNotThrow(() => new Script(source));
  const token = html.match(/name="csrf-token" content="([a-f0-9]+)"/)?.[1];
  assert.ok(token, 'dashboard exposes its CSRF token to its own script');
  const accepted = await request('/admin/api/users/1/status', {
    method: 'POST', headers: { ...headers, 'X-CSRF-Token': token }, body: '{"status":"disabled"}',
  });
  assert.equal(accepted.status, 200);
  assert.equal((await request('/admin/logout', { headers })).status, 404);
  const logout = await request('/admin/logout', { method: 'POST', headers: { ...headers, 'X-CSRF-Token': token } });
  assert.equal(logout.status, 302);
  assert.equal((await request('/admin/api/status', { headers })).status, 401);
});

test('admin rejects cross-site login and handles malformed cookies', async t => {
  const request = await start(t, { adminPassword: 'admin-test-password' });
  const rejected = await request('/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.test' },
    body: JSON.stringify({ username: 'operator', password: 'admin-test-password' }),
  });
  assert.equal(rejected.status, 403);
  assert.equal((await request('/admin', { headers: { Cookie: 'admin_session=%E0%A4%A' } })).status, 302);
});
