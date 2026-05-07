'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { AgentPipeline, normalizeModelOutputText } = require('../src/ai/pipeline');

function createConfig(customPrompts = {}) {
  return {
    get(key) {
      const values = {
        'pipeline.task': 'polish',
        'pipeline.mode': 'single',
        'pipeline.temperature': 0.3,
        'pipeline.customPrompts.polish': customPrompts.polish || '',
        'pipeline.customPrompts.deai': customPrompts.deai || '',
      };
      return values[key];
    },
  };
}

test('custom polish prompt is appended to the system prompt', async () => {
  const calls = [];
  const provider = {
    async chat(messages) {
      calls.push(messages);
      return '润色后的文本';
    },
  };

  const pipeline = new AgentPipeline(provider, createConfig({
    polish: '尽量保留我的轻口语表达，不要过度书面化。',
  }));

  const result = await pipeline._singleAgent('原始文本', 0.3, () => {}, 'zh');

  assert.equal(result, '润色后的文本');
  assert.equal(calls.length, 1);
  assert.match(calls[0][0].content, /# 用户额外要求/);
  assert.match(calls[0][0].content, /尽量保留我的轻口语表达/);
});

test('empty custom prompt keeps the base system prompt unchanged', () => {
  const provider = { chat: async () => 'ignored' };
  const pipeline = new AgentPipeline(provider, createConfig());
  const prompt = pipeline._withCustomPrompt('基础提示词', 'polish');

  assert.equal(prompt, '基础提示词');
});

test('normalizeModelOutputText removes invisible diff noise from model output', () => {
  const normalized = normalizeModelOutputText('第一句\u00A0第二句\u200B\r\n第三句');

  assert.equal(normalized, '第一句 第二句\n第三句');
});
