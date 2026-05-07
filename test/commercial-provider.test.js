'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createProvider } = require('../src/ai/provider-factory');
const ProxyProvider = require('../src/commercial/proxy-provider');

test('commercial context falls back to normal provider before login', () => {
  const provider = createProvider(
    {
      preset: 'custom',
      apiUrl: 'https://example.com/v1',
      apiKey: 'sk-test',
      model: 'demo-model',
    },
    {
      enabled: true,
      backendUrl: 'http://127.0.0.1:8787',
      authToken: '',
    },
  );

  assert.equal(provider.apiUrl, 'https://example.com/v1');
  assert.equal(provider.model, 'demo-model');
});

test('commercial context uses proxy provider after login', () => {
  const provider = createProvider(
    {
      preset: 'custom',
      apiUrl: 'https://example.com/v1',
      apiKey: 'sk-test',
      model: 'demo-model',
    },
    {
      enabled: true,
      backendUrl: 'http://127.0.0.1:8787',
      authToken: 'token-123',
    },
  );

  assert.ok(provider instanceof ProxyProvider);
  assert.equal(provider.backendUrl, 'http://127.0.0.1:8787');
});
