'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createProvider } = require('../src/ai/provider-factory');
const { PRESETS } = require('../src/ai/presets');

function settingsProviderFixture(presetId) {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/renderer/settings/script.js'), 'utf8');
  const applyStart = source.indexOf('function applyPreset(presetId)');
  const applyEnd = source.indexOf('// ── Shortcut capture', applyStart);
  const saveStart = source.indexOf('async function saveProviderConfig()');
  const saveEnd = source.indexOf('// ── Save API', saveStart);
  assert(applyStart >= 0 && applyEnd > applyStart && saveStart >= 0 && saveEnd > saveStart);
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { value: '', classList: { add() {}, remove() {} } });
    return elements.get(selector);
  };
  element('#presetSelect').value = presetId;
  element('#apiKey').value = 'fixture-key';
  const provider = {};
  const context = vm.createContext({
    $: element, presetsData: PRESETS,
    window: { polishAPI: { setConfig: async (key, value) => { provider[key.slice('provider.'.length)] = value; } } },
  });
  vm.runInContext(source.slice(applyStart, applyEnd) + source.slice(saveStart, saveEnd), context);
  vm.runInContext('applyPreset(' + JSON.stringify(presetId) + ')', context);
  return { element, provider, save: () => vm.runInContext('saveProviderConfig()', context),
    select: id => {
      element('#presetSelect').value = id;
      return vm.runInContext('applyPreset(' + JSON.stringify(id) + ')', context);
    } };
}

test('Doubao settings let a user save an endpoint ID that the runtime actually uses', async () => {
  const fixture = settingsProviderFixture('doubao');
  assert.equal(fixture.element('#modelName').readOnly, false);
  assert.equal(fixture.element('#apiUrl').readOnly, true);
  assert.equal(fixture.element('#advancedApiFields').open, true);
  fixture.element('#modelName').value = 'ep-fixture-endpoint';
  await fixture.save();
  const provider = createProvider(fixture.provider);
  assert.equal(provider.model, 'ep-fixture-endpoint');
  assert.equal(provider.apiUrl, PRESETS.doubao.apiUrl);
});

test('Ollama settings keep the native provider and use the selected locally installed model', async () => {
  const fixture = settingsProviderFixture('ollama');
  assert.equal(fixture.element('#modelName').readOnly, false);
  assert.equal(fixture.element('#advancedApiFields').open, true);
  fixture.element('#modelName').value = 'qwen3:8b';
  await fixture.save();
  const provider = createProvider(fixture.provider);
  assert.equal(provider.constructor.name, 'OllamaProvider');
  assert.equal(provider.model, 'qwen3:8b');
  assert.equal(provider.apiKey, undefined);
  assert.equal(fixture.provider.apiKey, '');
});

test('fixed SiliconFlow presets still lock advanced fields and ignore stale model overrides', async () => {
  const fixture = settingsProviderFixture('siliconflow-deepseek-v4-flash');
  assert.equal(fixture.element('#modelName').readOnly, true);
  assert.equal(fixture.element('#apiUrl').readOnly, true);
  await fixture.save();
  fixture.provider.model = 'stale-model';
  fixture.provider.apiUrl = 'https://wrong.test/v1';
  const provider = createProvider(fixture.provider);
  assert.equal(provider.model, PRESETS['siliconflow-deepseek-v4-flash'].model);
  assert.equal(provider.apiUrl, PRESETS['siliconflow-deepseek-v4-flash'].apiUrl);
});

test('editable built-in models fall back to their default when no model has been saved', () => {
  for (const preset of ['doubao', 'ollama']) {
    assert.equal(createProvider({ preset, apiKey: 'fixture-key' }).model, PRESETS[preset].model);
  }
});

test('switching editable presets resets the model field instead of carrying another provider endpoint', async () => {
  const fixture = settingsProviderFixture('doubao');
  fixture.element('#modelName').value = 'ep-fixture-endpoint';
  fixture.select('ollama');
  assert.equal(fixture.element('#modelName').value, PRESETS.ollama.model);
  await fixture.save();
  assert.equal(createProvider(fixture.provider).model, PRESETS.ollama.model);
  fixture.element('#modelName').value = 'qwen3:8b';
  fixture.select('doubao');
  assert.equal(fixture.element('#modelName').value, PRESETS.doubao.model);
});
