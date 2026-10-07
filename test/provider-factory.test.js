'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createProvider } = require('../src/ai/provider-factory');
const { PRESETS, PRESET_ORDER, PRESET_ALIASES } = require('../src/ai/presets');

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

test('SiliconFlow picker contains the five current models with matching provider names', () => {
  const current = PRESET_ORDER.filter(id => id.startsWith('siliconflow-'));
  assert.deepEqual(current.map(id => PRESETS[id].model), [
    'deepseek-ai/DeepSeek-V4-Flash',
    'deepseek-ai/DeepSeek-V4-Pro',
    'zai-org/GLM-5.3',
    'Qwen/Qwen3.8-27B',
    'Pro/moonshotai/Kimi-K2.6',
  ]);
  for (const id of current) {
    const provider = createProvider({ preset: id, apiKey: 'fixture-key', model: 'stale-model' });
    assert.equal(provider.model, PRESETS[id].model);
    assert.equal(provider.apiUrl, 'https://api.siliconflow.cn/v1');
    assert.equal(PRESETS[id].id, id);
  }
});

test('retired preset IDs resolve to current models without appearing in the picker', () => {
  for (const [legacy, current] of Object.entries(PRESET_ALIASES)) {
    assert.ok(!PRESET_ORDER.includes(legacy));
    assert.ok(PRESET_ORDER.includes(current));
    const provider = createProvider({ preset: legacy, apiKey: 'fixture-key' });
    assert.equal(provider.model, PRESETS[current].model);
    assert.equal(provider.apiKey, 'fixture-key');
  }
});

function loadConfig(provider) {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const filename = path.resolve(__dirname, '../src/config.js');
  const writes = [];
  const data = { provider };
  class Store {
    get(key) { return data[key]; }
    set(key, value) { data[key] = value; writes.push(key); }
  }
  const context = { module: { exports: {} }, require(name) {
    if (name === 'electron-store') return Store;
    if (name === './commercial/feature') return { COMMERCIAL_AVAILABLE: false };
    if (name === './ai/presets') return { PRESETS, PRESET_ALIASES };
    throw new Error(`Unexpected dependency: ${name}`);
  } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  new context.module.exports();
  return { provider: data.provider, writes };
}

test('saved legacy configurations migrate to selectable IDs and current display values, retaining credentials', () => {
  for (const [legacy, current] of Object.entries(PRESET_ALIASES)) {
    const migrated = loadConfig({ preset: legacy, apiUrl: 'https://api.siliconflow.cn/v1',
      apiKey: 'saved-user-key', model: 'old-model', extraOption: true });
    assert.equal(migrated.provider.preset, current);
    assert.ok(PRESET_ORDER.includes(migrated.provider.preset));
    assert.equal(migrated.provider.model, PRESETS[current].model);
    assert.equal(migrated.provider.apiUrl, PRESETS[current].apiUrl);
    assert.equal(migrated.provider.apiKey, 'saved-user-key');
    assert.equal(migrated.provider.extraOption, true);
    assert.deepEqual(loadConfig(migrated.provider).writes, []);
  }
});

test('preset migration leaves custom endpoints and all unrelated configurations untouched', () => {
  for (const preset of ['custom', 'openai', 'deepseek', 'unlisted-provider', 'siliconflow-glm-5-3', 'toString']) {
    const original = { preset, apiUrl: 'https://private.example/v1', model: 'private-model', apiKey: 'user-key' };
    const result = loadConfig(original);
    assert.equal(result.provider, original);
    assert.deepEqual(result.writes, []);
  }
});
