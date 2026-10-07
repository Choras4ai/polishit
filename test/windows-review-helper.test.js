'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const WindowsReviewHelper = require('../src/windows-review-helper');

const context = {
  bundleIdentifier: 'win32.word', frontmostPid: 123, windowHandle: 456,
  documentId: '123|start|document|hash', expectedText: '原文测试',
  selectionRange: { location: 30, length: 4 },
};

function mockProcess(reply, { hang = false, code = 0 } = {}) {
  let invocation;
  const spawn = (executable, args, options) => {
    const process = new EventEmitter();
    process.stdin = new PassThrough();
    process.stdout = new PassThrough();
    process.stderr = new PassThrough();
    process.kill = () => { invocation.killed = true; };
    invocation = { executable, args, options, process, input: '', killed: false };
    process.stdin.on('data', chunk => { invocation.input += chunk.toString('utf8'); });
    process.stdin.on('finish', () => {
      if (hang) return;
      process.stdout.write(typeof reply === 'string' ? reply : JSON.stringify(reply));
      process.emit('close', code);
    });
    return process;
  };
  return { spawn, invocation: () => invocation };
}

test('Windows bridge sends literal text through stdin and fixed PowerShell file arguments', async () => {
  const replacement = '中文 \'" $(Remove-Item *) `test`';
  const expectedText = replacement + '测试';
  const mock = mockProcess({ ...context, ok: true, verified: true, text: expectedText, expectedText,
    selectionRange: { location: 30, length: expectedText.length }, documentId: 'new-document-hash' });
  const helper = new WindowsReviewHelper({ platform: 'win32', spawn: mock.spawn });
  assert.equal((await helper.applyEdit(context, replacement, { targetRange: { location: 30, length: 2 } })).ok, true);
  const call = mock.invocation();
  assert.equal(call.options.shell, false);
  assert.equal(call.args.includes(replacement), false);
  assert.equal(call.args.includes('-STA'), true);
  assert.equal(JSON.parse(call.input).replacement, replacement);
  assert.deepEqual(JSON.parse(call.input).targetRange, { location: 30, length: 2 });
});

test('fails closed before launching on source identity, length and out-of-selection errors', async () => {
  let spawned = false;
  const helper = new WindowsReviewHelper({ platform: 'win32', spawn: () => { spawned = true; throw Error(); } });
  for (const bad of [{ ...context, documentId: '' }, { ...context, expectedText: '不匹配' },
    { ...context, bundleIdentifier: 'win32.other' }, { ...context, windowHandle: -1 }]) {
    assert.equal((await helper.reviewGeometry({ ...bad, ranges: [] })).reason, 'invalid-request');
  }
  assert.equal((await helper.applyEdit(context, '替换', { targetRange: { location: 29, length: 2 } })).reason, 'invalid-request');
  assert.equal((await helper.reviewGeometry({ ...context, ranges: [{ id: 'x', location: 33, length: 2 }] })).reason, 'invalid-request');
  assert.equal(spawned, false);
});

test('a dispatched write timeout is uncertain and never reported as successful', async () => {
  const mock = mockProcess(null, { hang: true });
  const helper = new WindowsReviewHelper({ platform: 'win32', spawn: mock.spawn, timeoutMs: 15 });
  const pending = helper.applyEdit(context, '新', { targetRange: { location: 30, length: 1 } });
  assert.equal((await helper.probe()).reason, 'busy');
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
  assert.equal(result.sourceMayHaveChanged, true);
  assert.equal(mock.invocation().killed, true);
});

test('malformed/crashed write replies invalidate source state; read failures do not claim mutation', async () => {
  for (const mock of [mockProcess('not json'), mockProcess({}, { code: 1 })]) {
    const helper = new WindowsReviewHelper({ platform: 'win32', spawn: mock.spawn });
    const result = await helper.applyEdit(context, '新', { targetRange: { location: 30, length: 1 } });
    assert.equal(result.ok, false);
    assert.equal(result.sourceMayHaveChanged, true);
  }
  const mock = mockProcess(null, { hang: true });
  const result = await new WindowsReviewHelper({ platform: 'win32', spawn: mock.spawn, timeoutMs: 15 }).probe();
  assert.equal(result.sourceMayHaveChanged, false);
});

test('explicit source mismatch response survives transport unchanged', async () => {
  const reply = { ok: false, reason: 'source-document-changed', sourceMayHaveChanged: false };
  const mock = mockProcess(reply);
  const helper = new WindowsReviewHelper({ platform: 'win32', spawn: mock.spawn });
  const result = await helper.reviewGeometry({ ...context, ranges: [{ id: 1, location: 30, length: 2 }] });
  assert.equal(result.reason, reply.reason); assert.equal(result.sourceMayHaveChanged, false);
});

test('other platforms never launch PowerShell', async () => {
  const helper = new WindowsReviewHelper({ platform: 'darwin', spawn: () => assert.fail('spawned') });
  assert.equal((await helper.probe()).reason, 'unsupported-platform');
});

test('a source write waits for in-flight geometry and then validates its own write reply', async () => {
  const reading = mockProcess(null, { hang: true });
  const writing = mockProcess({ ...context, ok: true, verified: true, text: '新文测试', expectedText: '新文测试', documentId: 'updated' });
  let calls = 0;
  const helper = new WindowsReviewHelper({ platform: 'win32', spawn: (...args) => (++calls === 1 ? reading : writing).spawn(...args) });
  const geometry = helper.reviewGeometry({ ...context, ranges: [{ id: 1, location: 30, length: 1 }] });
  const applied = helper.applyEdit(context, '新', { targetRange: { location: 30, length: 1 } });
  assert.equal(calls, 1, 'write must wait for the existing read');
  reading.invocation().process.stdout.write(JSON.stringify({ ok: true, coordinateSpace: 'physical', rects: [] }));
  reading.invocation().process.emit('close', 0);
  assert.equal((await geometry).ok, true);
  assert.equal((await applied).ok, true);
  assert.equal(calls, 2);
});

test('unverified success or a different replacement cannot be claimed as a completed write', async () => {
  for (const response of [{ ok: true }, { ...context, ok: true, verified: true, text: '错误文本' }]) {
    const mock = mockProcess(response);
    const helper = new WindowsReviewHelper({ platform: 'win32', spawn: mock.spawn });
    const result = await helper.applyEdit(context, '新', { targetRange: { location: 30, length: 1 } });
    assert.equal(result.reason, 'invalid-response');
    assert.equal(result.sourceMayHaveChanged, true);
  }
});

test('geometry response requires physical finite rectangles for requested IDs', async () => {
  for (const response of [
    { ok: true, coordinateSpace: 'dip', rects: [] },
    { ok: true, coordinateSpace: 'physical', rects: [{ id: 'other', x: 1, y: 2, width: 3, height: 4 }] },
    { ok: true, coordinateSpace: 'physical', rects: [{ id: 1, x: 1, y: 2, width: -3, height: 4 }] },
  ]) {
    const mock = mockProcess(response);
    const helper = new WindowsReviewHelper({ platform: 'win32', spawn: mock.spawn });
    const result = await helper.reviewGeometry({ ...context, ranges: [{ id: 1, location: 30, length: 1 }] });
    assert.equal(result.reason, 'invalid-response');
  }
});
