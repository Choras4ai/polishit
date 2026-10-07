'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  APP_BUNDLE_IDENTIFIER,
  isOwnBundleIdentifier,
} = require('../src/app-identity');

test('own app and Electron helper bundle identifiers are excluded', () => {
  assert.equal(APP_BUNDLE_IDENTIFIER, 'com.runshi.app');
  assert.equal(isOwnBundleIdentifier('com.runshi.app'), true);
  assert.equal(isOwnBundleIdentifier('com.runshi.app.helper'), true);
  assert.equal(isOwnBundleIdentifier('com.runshi.app.helper.Renderer'), true);
});

test('external editors are not excluded', () => {
  assert.equal(isOwnBundleIdentifier('com.microsoft.Word'), false);
  assert.equal(isOwnBundleIdentifier('com.kingsoft.wpsoffice.mac'), false);
  assert.equal(isOwnBundleIdentifier(''), false);
});
