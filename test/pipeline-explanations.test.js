'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AgentPipeline } = require('../src/ai/pipeline');
const config = { get: () => undefined };
test('duplicate source fragments bind reasons by ID and exact replacement only', () => {
  const pipeline = new AgentPipeline({}, config);
  const changes = [1, 2].map(id => ({ id, type: 'replace', oldText: '错词', newText: id === 1 ? '甲' : '乙' }));
  pipeline._mapExplanations(changes, [
    { id: 2, original: '错词', modified: '乙', reason: '第二处', type: 'wording' },
    { id: 1, original: '错词', modified: '错误替换', reason: '不能错配', type: 'wording' },
  ]);
  assert.equal(changes[0].reason, undefined);
  assert.equal(changes[1].reason, '第二处');
});
test('short corrections get explanations and protected terms remain flagged', async () => {
  let calls = 0;
  const pipeline = new AgentPipeline({ chat: async () => ++calls === 1 ? 'Fox错字' : JSON.stringify([
    { id: 0, original: 'C', modified: 'F', reason: '本条理由', type: 'wording' },
  ]) }, { get: key => key === 'pipeline.protectedTerms' ? ['Cox'] : undefined });
  const result = await pipeline.process('Cox错子', () => {});
  assert(result.explainPromise);
  await result.explainPromise;
  assert.equal(calls, 2);
  assert(result.diff.changes.some(c => c.reviewSafety?.blocked));
});
test('large correction lists are explained in batches and failed batches are explicit', async () => {
  let calls = 0;
  const pipeline = new AgentPipeline({ chat: async () => { calls++; return 'not json'; } }, config);
  const changes = Array.from({ length: 21 }, (_, id) => ({ id, type: 'replace', originalStart: id, oldText: '错', newText: '对' }));
  const explanations = await pipeline._explain('错'.repeat(21), '对'.repeat(21), 'zh', changes);
  assert.equal(calls, 3);
  assert.deepEqual(explanations, []);
});
