'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function shortcutFixture({ requested = 'CommandOrControl+Alt+V', available = ['CommandOrControl+Shift+V'] } = {}) {
  const managerPath = require.resolve('../src/shortcuts');
  const localRequire = createRequire(managerPath);
  const module = { exports: {} };
  let registered = null;
  const saved = { shortcut: 'Alt+Shift+R' };
  const config = { get: key => saved[key], set: (key, value) => { saved[key] = value; } };
  vm.runInNewContext(fs.readFileSync(managerPath, 'utf8'), {
    module, exports: module.exports, console: { log() {} },
    require: id => id === 'electron' ? { globalShortcut: {
      unregisterAll() { registered = null; },
      register(accelerator) {
        if (!available.includes(accelerator)) return false;
        registered = accelerator; return true;
      },
    } } : localRequire(id),
  }, { filename: managerPath });
  const manager = new module.exports(config, () => {});
  const elements = new Map();
  const handlers = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      textContent: '', disabled: false,
      classList: { remove() {} },
      addEventListener: (type, callback) => handlers.set(`${selector}:${type}`, callback),
    });
    return elements.get(selector);
  };
  const source = fs.readFileSync(path.resolve(__dirname, '../src/renderer/settings/script.js'), 'utf8');
  const start = source.indexOf("$('#btnSaveShortcut').addEventListener");
  const end = source.indexOf("$('#floatingToolbarEnabled').addEventListener", start);
  assert(start >= 0 && end > start);
  vm.runInNewContext(source.slice(start, end), {
    $: element, pendingAccelerator: requested,
    shortcutCapture: element('#shortcutCapture'),
    formatShortcut: value => value.replace('CommandOrControl', 'Ctrl'),
    showStatus: (target, message) => { target.textContent = message; },
    window: { polishAPI: { setShortcut: async value => {
      const result = manager.register(value);
      if (result.success) config.set('shortcut', result.accelerator);
      return result;
    } } },
  }, { filename: 'settings-shortcut-handler.js' });
  return { click: button => handlers.get(`${button}:click`)(), element, saved,
    registered: () => registered };
}

test('shortcut save displays the actually registered fallback in both panels', async () => {
  const fixture = shortcutFixture();
  await fixture.click('#btnSaveShortcut');
  assert.equal(fixture.registered(), 'CommandOrControl+Shift+V');
  assert.equal(fixture.saved.shortcut, fixture.registered());
  assert.equal(fixture.element('#currentShortcut').textContent, 'Ctrl+Shift+V');
  assert.equal(fixture.element('#homeShortcut').textContent, 'Ctrl+Shift+V');
});

test('shortcut save displays a requested shortcut when it is available', async () => {
  const fixture = shortcutFixture({ requested: 'Alt+Shift+R', available: ['Alt+Shift+R'] });
  await fixture.click('#btnSaveShortcut');
  assert.equal(fixture.registered(), 'Alt+Shift+R');
  assert.equal(fixture.element('#currentShortcut').textContent, 'Alt+Shift+R');
  assert.equal(fixture.element('#homeShortcut').textContent, 'Alt+Shift+R');
});

test('shortcut reset displays the registered fallback when the recommended key is occupied', async () => {
  const fixture = shortcutFixture();
  await fixture.click('#btnResetShortcut');
  assert.equal(fixture.element('#currentShortcut').textContent, 'Ctrl+Shift+V');
  assert.equal(fixture.element('#homeShortcut').textContent, 'Ctrl+Shift+V');
});

test('failed shortcut registration keeps the current display and reports failure', async () => {
  const fixture = shortcutFixture({ available: [] });
  fixture.element('#currentShortcut').textContent = 'Alt+Shift+R';
  fixture.element('#homeShortcut').textContent = 'Alt+Shift+R';
  await fixture.click('#btnSaveShortcut');
  assert.equal(fixture.element('#currentShortcut').textContent, 'Alt+Shift+R');
  assert.equal(fixture.element('#homeShortcut').textContent, 'Alt+Shift+R');
  assert.match(fixture.element('#shortcutStatus').textContent, /已被占用/);
});
