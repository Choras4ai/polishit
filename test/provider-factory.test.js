'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createProvider } = require('../src/ai/provider-factory');
const { PRESETS } = require('../src/ai/presets');

test('built-in Together preset ignores stale user overrides', () => {
  const provider = createProvider({
    preset: 'together',
    apiUrl: 'https://example.com/should-not-be-used',
    apiKey: 'stale-user-key',
    model: 'stale-model',
  });

  assert.equal(provider.apiUrl, PRESETS.together.apiUrl);
  assert.equal(provider.model, PRESETS.together.model);
  assert.equal(provider.apiKey, 'stale-user-key');
});

test('custom preset keeps explicit user configuration', () => {
  const provider = createProvider({
    preset: 'custom',
    apiUrl: 'https://example.com/v1',
    apiKey: 'sk-test',
    model: 'test-model',
  });

  assert.equal(provider.apiUrl, 'https://example.com/v1');
  assert.equal(provider.apiKey, 'sk-test');
  assert.equal(provider.model, 'test-model');
});
