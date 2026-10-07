'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { downloadVerifiedFile } = require('../src/updater/download');
const bytes = Buffer.from('fixture-installer');
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
function destination(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runshi-download-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return path.join(dir, 'installer'); }
test('verified download writes exact bytes', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(bytes));
  const file = destination(t); await downloadVerifiedFile('https://example.test/app.dmg', file, { sha256, size: bytes.length });
  assert.deepEqual(fs.readFileSync(file), bytes);
});
test('retry resumes an existing partial installer and verifies the complete file', async t => {
  let range;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    range = options.headers.Range;
    return new Response(bytes.subarray(7), { status: 206, headers: { 'content-length': String(bytes.length - 7), 'content-range': `bytes 7-${bytes.length - 1}/${bytes.length}` } });
  });
  const file = destination(t);
  fs.writeFileSync(file, bytes.subarray(0, 7));
  await downloadVerifiedFile('https://example.test/app.dmg', file, { sha256, size: bytes.length, resume: true });
  assert.equal(range, 'bytes=7-');
  assert.deepEqual(fs.readFileSync(file), bytes);
});
test('mismatched checksum deletes the partial installer', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(bytes));
  const file = destination(t);
  await assert.rejects(downloadVerifiedFile('https://example.test/app.dmg', file, { sha256: '0'.repeat(64) }), /完整性/);
  assert.equal(fs.existsSync(file), false);
});
test('HTTPS redirect cannot downgrade to HTTP', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return new Response(null, { status: 302, headers: { location: 'http://example.test/app.dmg' } }); });
  await assert.rejects(downloadVerifiedFile('https://example.test/app.dmg', destination(t), { sha256 }), /HTTPS/);
  assert.equal(requests, 1);
});
test('destination write errors reject without an unhandled stream error', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(bytes));
  await assert.rejects(downloadVerifiedFile('https://example.test/app.dmg', path.join(destination(t), 'missing', 'file'), { sha256 }), { code: 'ENOENT' });
});
test('missing digest is rejected before network activity', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not fetch'); });
  await assert.rejects(downloadVerifiedFile('https://example.test/app.dmg', destination(t)), /SHA-256/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('complete verified installer is reused without another network request', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw Error('must not download again'); });
  const file = destination(t); fs.writeFileSync(file, bytes);
  assert.equal((await downloadVerifiedFile('https://example.test/app.dmg', file, { sha256, size: bytes.length, resume: true })).cached, true);
  assert.equal(fetch.mock.callCount(), 0);
});
test('empty or complete corrupt cached files restart cleanly', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.headers.Range, undefined); return new Response(bytes);
  });
  const file = destination(t);
  for (const cached of [Buffer.alloc(0), Buffer.alloc(bytes.length)]) {
    fs.writeFileSync(file, cached);
    await downloadVerifiedFile('https://example.test/app.dmg', file, { sha256, size: bytes.length, resume: true });
    assert.deepEqual(fs.readFileSync(file), bytes);
  }
});
test('checksum failure removes a resumed corrupt download', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(Buffer.alloc(bytes.length)));
  const file = destination(t);
  await assert.rejects(downloadVerifiedFile('https://example.test/app.dmg', file, { sha256, size: bytes.length, resume: true }), /完整性/);
  assert.equal(fs.existsSync(file), false);
});
test('range not satisfiable resets once and retries a full download', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async (_url, options) => options.headers.Range
    ? new Response(null, { status: 416 }) : new Response(bytes));
  const file = destination(t); fs.writeFileSync(file, bytes.subarray(0, 7));
  await downloadVerifiedFile('https://example.test/app.dmg', file, { sha256, size: bytes.length, resume: true });
  assert.equal(fetch.mock.callCount(), 2); assert.deepEqual(fs.readFileSync(file), bytes);
});
test('wrong content range is rejected before appending bytes', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(bytes.subarray(7), { status: 206,
    headers: { 'content-range': `bytes 6-${bytes.length - 2}/${bytes.length}` } }));
  const file = destination(t); fs.writeFileSync(file, bytes.subarray(0, 7));
  await assert.rejects(downloadVerifiedFile('https://example.test/app.dmg', file, { sha256, size: bytes.length, resume: true }), /续传范围/);
  assert.equal(fs.existsSync(file), false);
});
