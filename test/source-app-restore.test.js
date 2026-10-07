'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const util = require('node:util');

function fixture(platform, stale = '') {
  const calls = [];
  const clipboardWrites = [];
  let clipboardText = 'saved clipboard';
  const clipboard = { writeText: text => { clipboardText = text; clipboardWrites.push(text); }, readText: () => clipboardText,
    readHTML: () => '', readRTF: () => '', readImage: () => ({ isEmpty: () => true }), readBookmark: () => ({ title: '' }),
    write: data => { clipboardText = data.text; clipboardWrites.push(data.text); } };
  let reply = 'true';
  const execute = () => {};
  execute[util.promisify.custom] = async (binary, args) => { calls.push({ binary, args }); return { stdout: reply, stderr: '' }; };
  const context = { module: { exports: {} }, process: { ...process, platform }, Buffer, console,
    setTimeout: fn => setTimeout(fn, 0),
    require: name => {
      if (name === 'electron') return { clipboard };
      if (name === 'child_process') return { exec: execute, execFile: execute };
      if (name === './macos-selection-helper' || name === './windows-review-helper') return class {};
      if (name === './app-identity') return { isOwnBundleIdentifier: () => false };
      return require(name);
    } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src/capture.js'), 'utf8'), context);
  vm.runInContext(`lastFrontApp=${JSON.stringify(stale)}`, context);
  return { capture: context.module.exports, calls, clipboardWrites, reply: value => { reply = value; } };
}

test('first cached Word source activates its canonical bundle/PID with no saved global target', async () => {
  const f = fixture('darwin');
  assert.equal(await f.capture.restoreFrontApp({ bundleIdentifier: 'com.microsoft.Word', frontmostPid: 123 }), true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].binary, 'osascript');
  assert.deepEqual(Array.from(f.calls[0].args.slice(2)), ['com.microsoft.Word', '123']);
  assert(!f.calls[0].args[1].includes('com.microsoft.Word'), 'Source data is argv, not AppleScript code');
});

test('canonical source overrides a stale saved app and uses refreshed geometry PID', async () => {
  const f = fixture('darwin', 'com.apple.TextEdit');
  assert.equal(await f.capture.restoreFrontApp({ bundleIdentifier: 'com.microsoft.Word', frontmostPid: 0,
    geometryContext: { frontmostPid: 456 } }), true);
  assert.deepEqual(Array.from(f.calls[0].args.slice(2)), ['com.microsoft.Word', '456']);
});

test('invalid canonical targets and vanished PID never fall back to a stale app or write', async () => {
  for (const context of [{ bundleIdentifier: 'bad"\nactivate' }, { bundleIdentifier: 'com.microsoft.Word', frontmostPid: '123' }]) {
    const f = fixture('darwin', 'com.apple.TextEdit');
    assert.equal(await f.capture.restoreFrontApp(context), false); assert.equal(f.calls.length, 0);
  }
  const f = fixture('darwin', 'com.apple.TextEdit'); f.reply('false');
  const result = await f.capture.applyTextEdit({ bundleIdentifier: 'com.microsoft.Word', frontmostPid: 123 }, 'replacement');
  assert.equal(result.ok, false); assert.equal(f.calls.length, 1);
});

test('Windows canonical handle overrides saved handle and is validated before fixed PowerShell', async () => {
  const f = fixture('win32', '999');
  assert.equal(await f.capture.restoreFrontApp({ windowHandle: '12345' }), true);
  assert(f.calls[0].args[2].includes('[long]12345'));
  assert.equal(f.calls[0].args.length, 3);
  for (const handle of ['0', '-1', '12;Stop-Process', '9223372036854775808', '']) {
    const invalid = fixture('win32', '999');
    assert.equal(await invalid.capture.restoreFrontApp({ windowHandle: handle }), false);
    assert.equal(invalid.calls.length, 0);
  }
});

test('legacy paste stops before any paste keystroke when restoring the saved app fails', async () => {
  const f = fixture('darwin', 'com.apple.TextEdit'); f.reply('false');
  await assert.rejects(f.capture.pasteText('replacement'), /无法恢复原文应用/);
  assert.equal(f.calls.length, 1);
  assert(!f.calls[0].args[1].includes('keystroke'));
  assert.deepEqual(f.clipboardWrites, ['replacement', 'saved clipboard']);
});

test('legacy restoration without canonical context retains its saved-app fallback', async () => {
  const f = fixture('darwin', 'com.apple.TextEdit');
  assert.equal(await f.capture.restoreFrontApp(), true);
  assert.equal(f.calls[0].args[2], 'com.apple.TextEdit');
});
