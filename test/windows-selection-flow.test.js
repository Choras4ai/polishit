'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const util = require('node:util');
const { createRequire } = require('node:module');

const wordText = '第一段原文。\r第二段内容。';
const clipboardText = wordText.replace(/\r/g, '\r\n');
function wordContext(overrides = {}) {
  return { ok: true, text: wordText, bundleIdentifier: 'win32.word', frontmostPid: 123, windowHandle: 456,
    documentId: 'document-identity', selectionRange: { location: 7, length: wordText.length },
    supportsRangeEditing: true, ...overrides };
}
function load(file, dependencies, globals = {}) {
  const filename = path.resolve(__dirname, '..', file);
  const localRequire = createRequire(filename);
  const context = { module: { exports: {} }, __dirname: path.dirname(filename), Buffer, console,
    process: { ...process, platform: 'win32' }, setTimeout: callback => setTimeout(callback, 0),
    clearTimeout, setInterval, clearInterval,
    require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : localRequire(name), ...globals };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return context.module.exports;
}

function captureFixture(context, copied = clipboardText) {
  let text = 'original clipboard', writes = 0, probeCalls = 0;
  const clipboard = { readText: () => text, writeText: value => { text = value; writes++; }, readHTML: () => '<p>original</p>',
    readRTF: () => '', readImage: () => ({ isEmpty: () => true }), readBookmark: () => ({}),
    write: snapshot => { text = snapshot.text; } };
  const execute = () => {};
  execute[util.promisify.custom] = async (...args) => {
    if (String(args[0]).includes('SendWait')) text = copied;
    return { stdout: '456', stderr: '' };
  };
  const capture = load('src/capture.js', { electron: { clipboard }, child_process: { exec: execute, execFile: execute },
    './windows-review-helper': class { async probe() { probeCalls++; return context; } },
    './macos-selection-helper': class {}, './app-identity': { isOwnBundleIdentifier: () => false } });
  return { capture, savedText: () => text, probeCalls: () => probeCalls, clipboardWrites: () => writes };
}

test('Windows capture keeps COM text and offsets when clipboard uses CRLF', async () => {
  const context = wordContext();
  const fixture = captureFixture(context);
  const result = await fixture.capture.captureSelectedText();
  assert.equal(result.text, wordText);
  assert.equal(result.selectionContext, context);
  assert.equal(result.selectionContext.selectionRange.length, result.text.length);
  assert.equal(fixture.savedText(), 'original clipboard');
});

test('Windows Word readonly probe calls COM instead of AppleScript', async () => {
  const context = wordContext();
  const fixture = captureFixture(context);
  assert.equal(await fixture.capture.probeWordSelectionContext(), context);
  assert.equal(fixture.probeCalls(), 1);
  assert.equal(fixture.clipboardWrites(), 0);
});

test('Windows capture falls back to copied text when Word probe fails', async () => {
  const fixture = captureFixture({ ok: false, reason: 'word-unavailable' });
  const result = await fixture.capture.captureSelectedText();
  assert.equal(result.text, clipboardText);
  assert.equal(result.selectionContext, null);
  assert.equal(fixture.savedText(), 'original clipboard');
});

function watcherFixture() {
  const selections = [], calls = [];
  let probe = async () => wordContext(), probeCalls = 0, focused = false;
  const Watcher = load('src/selection-watcher.js', {
    electron: { BrowserWindow: { getFocusedWindow: () => focused ? {} : null }, clipboard: { readText: () => '' },
      screen: { getCursorScreenPoint: () => ({ x: 12, y: 34 }) } },
    child_process: { execFile: (...args) => { calls.push(args); } },
    './macos-selection-helper': class {}, './app-identity': { isOwnBundleIdentifier: () => false },
    './capture': { probeWordSelectionContext: async () => { probeCalls++; return probe(); } },
  });
  const watcher = new Watcher();
  watcher._selectionCallback = selection => selections.push(selection);
  const payload = { text: clipboardText, frontmostPid: 123, windowHandle: 456, isWord: true };
  return { watcher, selections, calls, payload, setProbe: value => { probe = typeof value === 'function' ? value : async () => value; },
    focused: value => { focused = value; }, probeCalls: () => probeCalls,
    poll: () => { watcher._lastWinPollAt = 0; watcher._checkClipboardForSelection(); },
    reply: (index = calls.length - 1, value = payload) => calls[index].at(-1)(null, JSON.stringify(value)),
  };
}

test('Windows selection watcher binds Word cached selection to exact UIA HWND and PID', async () => {
  const fixture = watcherFixture();
  fixture.poll(); await fixture.reply();
  assert.equal(fixture.selections.length, 1);
  assert.equal(fixture.selections[0].rawText, wordText);
  assert.equal(fixture.selections[0].selectionContext.windowHandle, 456);
  assert.equal(fixture.selections[0].selectionContext.documentId, 'document-identity');
  assert.equal(fixture.watcher._winPollPending, false);
});

test('same text in a different window or process never receives another Word context', async () => {
  for (const overrides of [{ windowHandle: 789 }, { frontmostPid: 999 }, { text: '不同的选区文本' }]) {
    const fixture = watcherFixture(); fixture.setProbe(wordContext(overrides));
    fixture.poll(); await fixture.reply();
    assert.equal(fixture.selections.length, 1);
    assert.equal(fixture.selections[0].selectionContext, null);
    assert.equal(fixture.selections[0].rawText, clipboardText);
  }
});

test('Word without a UIA TextPattern uses only verified COM selection from the exact same HWND and PID', async () => {
  const fixture = watcherFixture(); fixture.poll(); await fixture.reply(0, { ...fixture.payload, text: '' });
  assert.equal(fixture.selections.length, 1);
  assert.equal(fixture.selections[0].rawText, wordText);
  assert.equal(fixture.selections[0].selectionContext.documentId, 'document-identity');
  for (const overrides of [{ windowHandle: 789 }, { frontmostPid: 999 }, { supportsRangeEditing: false },
    { ok: false }, { text: '' }]) {
    const changed = watcherFixture(); changed.setProbe(wordContext(overrides));
    changed.poll(); await changed.reply(0, { ...changed.payload, text: '' });
    assert.equal(changed.selections.length, 0);
  }
});

test('general editor UIA text and unsupported Word selection retain safe copy fallback', async () => {
  const general = watcherFixture(); general.poll(); await general.reply(0, { ...general.payload, isWord: false });
  assert.equal(general.probeCalls(), 0);
  assert.equal(general.selections[0].selectionContext, null);
  const structured = watcherFixture(); structured.setProbe({ ok: false, reason: 'structured-text-unsupported' });
  structured.poll(); await structured.reply();
  assert.equal(structured.selections[0].selectionContext, null);
  assert.equal(structured.selections[0].rawText, clipboardText);
});

test('Windows async Word selection cannot reappear after pause, disable, stop or app focus', async () => {
  for (const cancel of [f => { f.watcher.pause(); f.watcher.resume(); },
    f => { f.watcher.setEnabled(false); f.watcher.setEnabled(true); }, f => f.watcher.stop(), f => f.focused(true)]) {
    const fixture = watcherFixture();
    let resolve;
    fixture.setProbe(() => new Promise(done => { resolve = done; }));
    fixture.poll(); const pending = fixture.reply();
    assert.equal(fixture.probeCalls(), 1);
    cancel(fixture); resolve(wordContext()); await pending;
    assert.equal(fixture.selections.length, 0);
    assert.equal(fixture.watcher._winPollPending, false);
  }
});

test('old stopped Windows poll cannot clear or populate a restarted poll', async () => {
  const fixture = watcherFixture();
  fixture.poll(); fixture.watcher.stop(); fixture.poll();
  assert.equal(fixture.calls.length, 2);
  await fixture.reply(0);
  assert.equal(fixture.watcher._winPollPending, true);
  assert.equal(fixture.selections.length, 0);
  await fixture.reply(1);
  assert.equal(fixture.selections.length, 1);
  assert.equal(fixture.watcher._winPollPending, false);
});

test('identical text refreshes source identity and range while unchanged snapshot is deduplicated', async () => {
  const fixture = watcherFixture();
  fixture.poll(); await fixture.reply();
  fixture.poll(); await fixture.reply();
  assert.equal(fixture.selections.length, 1);
  fixture.setProbe(wordContext({ documentId: 'second-document', selectionRange: { location: 99, length: wordText.length } }));
  fixture.poll(); await fixture.reply();
  assert.equal(fixture.selections.length, 2);
  assert.equal(fixture.selections[1].selectionContext.selectionRange.location, 99);
  assert.equal(fixture.selections[1].selectionContext.documentId, 'second-document');
});

test('malformed UIA identity never supplies a cached selection or dispatches COM', async () => {
  for (const overrides of [{ frontmostPid: -1 }, { windowHandle: '456' }, { text: null }]) {
    const fixture = watcherFixture(); fixture.poll(); await fixture.reply(0, { ...fixture.payload, ...overrides });
    assert.equal(fixture.selections.length, 0);
    assert.equal(fixture.probeCalls(), 0);
    assert.equal(fixture.watcher._winPollPending, false);
  }
});
