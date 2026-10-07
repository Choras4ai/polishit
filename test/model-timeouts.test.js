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
    getChatTimeoutMs({ modelId: 'deepseek-v4-flash' }),
    DEFAULT_CHAT_TIMEOUT_MS,
  );
});

test('large SiliconFlow models receive the same timeout by hosted ID and API model name', () => {
  for (const [modelId, model] of [
    ['glm-5.1', 'zai-org/GLM-5.1'],
    ['glm-5.2', 'zai-org/GLM-5.2'],
    ['glm-5.3', 'zai-org/GLM-5.3'],
    ['kimi-k2.5', 'moonshotai/Kimi-K2.5'],
    ['kimi-k2.6', 'Pro/moonshotai/Kimi-K2.6'],
    ['deepseek-v4-pro', 'deepseek-ai/DeepSeek-V4-Pro'],
  ]) {
    assert.equal(getChatTimeoutMs({ modelId }), LARGE_MODEL_CHAT_TIMEOUT_MS, modelId);
    assert.equal(getChatTimeoutMs({ model }), LARGE_MODEL_CHAT_TIMEOUT_MS, model);
    assert.equal(getProxyTimeoutMs({ model }), LARGE_MODEL_CHAT_TIMEOUT_MS + PROXY_TIMEOUT_BUFFER_MS, model);
  }
});

test('large model matching tolerates case but does not match unrelated families', () => {
  assert.equal(getChatTimeoutMs({ modelId: ' GLM-5.3 ' }), LARGE_MODEL_CHAT_TIMEOUT_MS);
  for (const model of ['Qwen/Qwen3.8-27B', 'deepseek-ai/DeepSeek-V4-Flash', 'zai-org/GLM-4.7', 'GLM-50', 'Kimi-K20']) {
    assert.equal(getChatTimeoutMs({ model }), DEFAULT_CHAT_TIMEOUT_MS, model);
  }
});

test('explicit positive timeouts remain authoritative for large models', () => {
  assert.equal(getChatTimeoutMs({ model: 'zai-org/GLM-5.3', requestedTimeoutMs: 240000 }), 240000);
  assert.equal(getProxyTimeoutMs({ modelId: 'kimi-k2.6', requestedTimeoutMs: 240000 }), 270000);
  assert.equal(getChatTimeoutMs({ modelId: 'glm-5.3', requestedTimeoutMs: -1 }), LARGE_MODEL_CHAT_TIMEOUT_MS);
});

test('proxy timeout adds buffer on top of chat timeout', () => {
  assert.equal(
    getProxyTimeoutMs({ modelId: 'qwen3.5-397b' }),
    LARGE_MODEL_CHAT_TIMEOUT_MS + PROXY_TIMEOUT_BUFFER_MS,
  );
});
