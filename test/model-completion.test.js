'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const OpenAIProvider = require('../src/ai/openai-provider');
const AnthropicProvider = require('../src/ai/anthropic-provider');
const OllamaProvider = require('../src/ai/ollama-provider');
const { proxyChat } = require('../server/services/upstream-service');

async function withFetch(responseBody, action) {
  const original = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => responseBody });
  try { return await action(); } finally { global.fetch = original; }
}

test('providers reject truncated model completions instead of applying partial text', async () => {
  await withFetch({ choices: [{ finish_reason: 'length', message: { content: '半段' } }] }, async () => {
    await assert.rejects(new OpenAIProvider({ apiKey: 'fixture' }).chat([]), /可能不完整/);
    await assert.rejects(proxyChat({ providerType: 'openai', apiUrl: 'https://fixture', apiKey: 'x', model: 'x' }, []), /可能不完整/);
  });
  await withFetch({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '半段' }] }, async () => {
    await assert.rejects(new AnthropicProvider({ apiKey: 'fixture' }).chat([]), /可能不完整/);
  });
  await withFetch({ done_reason: 'length', message: { content: '半段' } }, async () => {
    await assert.rejects(new OllamaProvider({ model: 'fixture' }).chat([]), /可能不完整/);
  });
});

test('connection checks accept a valid response that only reached the tiny probe limit', async () => {
  await withFetch({ choices: [{ finish_reason: 'length', message: { content: '你好' } }] }, async () => {
    assert.equal(await new OpenAIProvider({ apiKey: 'fixture' }).testConnection(), true);
  });
  await withFetch({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '你好' }] }, async () => {
    assert.equal(await new AnthropicProvider({ apiKey: 'fixture' }).testConnection(), true);
  });
});

test('direct API calls use the same large-model timeout as hosted requests', async t => {
  const calls = [];
  t.mock.method(AbortSignal, 'timeout', ms => { calls.push(ms); return new AbortController().signal; });
  await withFetch({ choices: [{ finish_reason: 'stop', message: { content: '结果' } }] }, async () => {
    await new OpenAIProvider({ apiKey: 'fixture', model: 'zai-org/GLM-5.3' }).chat([]);
    await new OpenAIProvider({ apiKey: 'fixture', model: 'deepseek-ai/DeepSeek-V4-Flash' }).chat([]);
  });
  assert.deepEqual(calls, [180000, 60000]);
});
