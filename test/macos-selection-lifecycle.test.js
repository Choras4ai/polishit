'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function fixture() {
  const callbacks = [];
  const events = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/selection-watcher.js'), 'utf8'), {
    module, process: { platform: 'darwin', pid: 1 }, console, setInterval, clearInterval, setTimeout,
    require: name => ({
      electron: { BrowserWindow: { getFocusedWindow: () => null }, clipboard: { readText: () => '' }, screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) } },
      child_process: { execFile: () => { throw Error('no external calls'); } },
      './macos-selection-helper': class { run(cb) { callbacks.push(cb); return true; } },
      './app-identity': { isOwnBundleIdentifier: () => false },
      './capture': { probeWordSelectionContext: async () => null },
    })[name],
  });
  const watcher = new module.exports();
  watcher._selectionCallback = value => events.push(value);
  return { watcher, events, finish: (index = callbacks.length - 1) => callbacks[index](null, { text: '这是一段测试内容', frontmostPid: 2, bundleIdentifier: 'test.app' }) };
}
for (const operation of ['pause', 'disable', 'stop']) test(`macOS stale probe ignored after ${operation} even after resume`, () => {
  const { watcher, events, finish } = fixture();
  watcher._check();
  if (operation === 'disable') { watcher.setEnabled(false); watcher.setEnabled(true); }
  else { watcher[operation](); watcher.resume(); }
  finish();
  assert.equal(events.length, 0);
  watcher._check(); finish();
  assert.equal(events.length, 1);
  watcher.stop();
});

 test('old macOS completion cannot release a newer pending probe after restart', () => {
  const { watcher, events, finish } = fixture();
  watcher._check();
  watcher.stop();
  watcher.resume();
  watcher._check();
  const pending = watcher._pending;
  finish(0);
  assert.equal(watcher._pending, pending);
  assert.equal(events.length, 0);
  finish(1);
  assert.equal(watcher._pending, false);
  assert.equal(events.length, 1);
  watcher.stop();
});
