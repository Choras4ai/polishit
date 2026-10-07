'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { AgentPipeline } = require('../src/ai/pipeline');

const cfg = { get: () => '' };
const pipeline = new AgentPipeline({ chat: async () => '' }, cfg);
const original = '本文研究了城市交通拥堵问题的成因与对策。';

test('normal rewrite passes through unchanged', () => {
  const rewritten = '本文探讨了城市交通拥堵的成因及应对策略。';
  assert.equal(pipeline._sanitizeOutput(rewritten, original), rewritten);
});

test('advice-style responses fall back to original', () => {
  const advice = '好的，以下是修改建议：\n1. **用词优化**：建议将……\n你可以考虑以下几点，通过这些方法提升文章质量。';
  assert.equal(pipeline._sanitizeOutput(advice, original), original);
});

test('empty or whitespace output falls back to original', () => {
  assert.equal(pipeline._sanitizeOutput('', original), original);
  assert.equal(pipeline._sanitizeOutput('   \n  ', original), original);
});

test('overly long explanatory output never exceeds 3x original length', () => {
  const longOut = original.repeat(5) + '\n\n' + '额外的解释内容。'.repeat(20);
  const out = pipeline._sanitizeOutput(longOut, original);
  assert.ok(out.length <= original.length * 3);
});

test('a single markdown bold marker does not trigger fallback', () => {
  const out = pipeline._sanitizeOutput('本文研究了**城市交通**拥堵问题的成因与对策。', original);
  assert.notEqual(out, original);
});

test('pipeline keeps Word CR paragraphs and the selected final paragraph out of the diff', async () => {
  const source = '共收急了数据。\r方法保持不变。\r';
  const p = new AgentPipeline({ chat: async () => '共收集了数据。\n方法保持不变。' }, cfg);
  const result = await p.process(source, () => {}, 'polish', { skipExplanations: true });
  assert.equal(result.polishedText, '共收集了数据。\r方法保持不变。\r');
  const edits = result.diff.changes.filter(c => c.type !== 'equal');
  assert.equal(edits.length, 1);
  assert.equal(edits[0].oldText, '急');
  assert.equal(edits[0].newText, '集');
});

test('pipeline respects CRLF and LF boundaries without adding paragraph-only suggestions', async () => {
  for (const ending of ['\r\n', '\n']) {
    const source = ending + '第一段。' + ending + '第二段。' + ending;
    const p = new AgentPipeline({ chat: async () => '第一段。\n第二段。' }, cfg);
    const result = await p.process(source, () => {}, 'polish', { skipExplanations: true });
    assert.equal(result.polishedText, source);
    assert.equal(result.diff.hasChanges, false);
  }
});
