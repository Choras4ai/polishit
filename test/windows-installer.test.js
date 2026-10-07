'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { launchWindowsInstaller } = require('../src/updater/windows-installer');
test('installer launch failure rejects instead of claiming successful installation', async () => {
  const child = new EventEmitter(); child.unref = () => assert.fail('failed process must not unref');
  const started = launchWindowsInstaller('fixture.exe', () => child);
  child.emit('error', new Error('fixture launch failure'));
  await assert.rejects(started, /fixture launch failure/);
});
test('installer launch resolves only after successful spawn', async () => {
  const child = new EventEmitter(); let unref = false; child.unref = () => { unref = true; };
  const started = launchWindowsInstaller('fixture.exe', () => child);
  assert.equal(unref, false); child.emit('spawn'); await started; assert.equal(unref, true);
});
