'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_CHAT_TIMEOUT_MS,
  LARGE_MODEL_CHAT_TIMEOUT_MS,
  PROXY_TIMEOUT_BUFFER_MS,
  getChatTimeoutMs,
  getProxyTimeoutMs,
} = require('../src/commercial/model-timeouts');

test('qwen3.5-397b gets extended chat timeout', () => {
  assert.equal(
    getChatTimeoutMs({ modelId: 'qwen3.5-397b' }),
    LARGE_MODEL_CHAT_TIMEOUT_MS,
  );
});

test('regular models keep default chat timeout', () => {
  assert.equal(
    getChatTimeoutMs({ modelId: 'kimi-k2.5' }),
    DEFAULT_CHAT_TIMEOUT_MS,
  );
});

test('proxy timeout adds buffer on top of chat timeout', () => {
  assert.equal(
    getProxyTimeoutMs({ modelId: 'qwen3.5-397b' }),
    LARGE_MODEL_CHAT_TIMEOUT_MS + PROXY_TIMEOUT_BUFFER_MS,
  );
});