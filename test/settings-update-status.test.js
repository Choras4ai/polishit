'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function renderStatus(status) {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/renderer/settings/script.js'), 'utf8');
  const start = source.indexOf('function renderUpdateStatus(status)');
  const end = source.indexOf('async function renderModelList()', start);
  assert(start >= 0 && end > start);
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      textContent: '', classList: { toggle: (_name, hidden) => { element(selector).hidden = hidden; } },
    });
    return elements.get(selector);
  };
  const context = vm.createContext({
    $: element, updateStatusCache: null,
    formatVersion: value => 'v' + (value || ''), formatDateTime: value => value,
  });
  vm.runInContext(source.slice(start, end), context);
  context.status = status;
  vm.runInContext('renderUpdateStatus(status)', context);
  return element;
}

test('installation failure stays visible while the known newer version remains retryable', () => {
  const element = renderStatus({ currentVersion: '1.6.8', latestVersion: '1.6.9', hasUpdate: true,
    lastError: 'fixture installer launch failure' });
  assert.match(element('#aboutUpdateStatus').textContent, /失败/);
  assert.match(element('#aboutUpdateMeta').textContent, /fixture installer launch failure/);
  assert.match(element('#aboutUpdateMeta').textContent, /1\.6\.9/);
  assert.equal(element('#btnInstallUpdate').hidden, false);
});

test('normal available-update status still shows release notes', () => {
  const element = renderStatus({ currentVersion: '1.6.8', latestVersion: '1.6.9', hasUpdate: true,
    releaseNotes: 'fixture release notes' });
  assert.match(element('#aboutUpdateStatus').textContent, /发现新版本/);
  assert.match(element('#aboutUpdateMeta').textContent, /fixture release notes/);
  assert.equal(element('#btnInstallUpdate').hidden, false);
});

test('failed check without a known update reports its error and hides installation', () => {
  const element = renderStatus({ currentVersion: '1.6.9', lastError: 'fixture offline' });
  assert.match(element('#aboutUpdateStatus').textContent, /失败/);
  assert.match(element('#aboutUpdateMeta').textContent, /fixture offline/);
  assert.equal(element('#btnInstallUpdate').hidden, true);
});
