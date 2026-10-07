'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MEMBERSHIP_MODELS, DEFAULT_MODEL_ID, PRICING_VERIFIED_AT, getModelById } = require('../server/commercial/models');
const { CostGuard } = require('../server/middleware/cost-guard');
const {
  calculateCreditCharge,
  calculateMaxOutputTokens,
} = require('../src/commercial/credit-policy');
const {
  TARGET_CONTRIBUTION_MARGIN,
  calculateProfitProtectedCreditCharge,
} = require('../src/commercial/profit-policy');

test('hosted model catalog uses current IDs and excludes retired entries', () => {
  const ids = new Set(MEMBERSHIP_MODELS.map(model => model.model));
  assert.equal(PRICING_VERIFIED_AT, '2026-09-15');
  assert.equal(DEFAULT_MODEL_ID, 'deepseek-v4-flash');
  assert.equal(ids.has('Pro/moonshotai/Kimi-K2.5'), false);
  assert.equal(ids.has('Pro/zai-org/GLM-4.7'), false);
  assert.equal(ids.has('deepseek-ai/DeepSeek-V4-Pro'), true);
  assert.equal(ids.has('zai-org/GLM-5.3'), true);
  assert.equal(ids.has('Qwen/Qwen3.8-27B'), true);
  assert.equal(ids.has('moonshotai/Kimi-K2.7-Code'), false);
  for (const removed of ['meituan-longcat/LongCat-2.0', 'nex-agi/Nex-N2-Pro', 'stepfun-ai/Step-3.5-Flash', 'Qwen/Qwen3.5-397B-A17B', 'MiniMaxAI/MiniMax-M2.5']) assert.equal(ids.has(removed), false);
  assert.equal(MEMBERSHIP_MODELS.length, 7);
  assert.equal(getModelById(DEFAULT_MODEL_ID).inputPricePerMTokens, 3);
  assert.equal(getModelById(DEFAULT_MODEL_ID).outputPricePerMTokens, 9);
  assert.equal(MEMBERSHIP_MODELS.every(model => Number.isInteger(model.credits)), true);
  assert.equal(MEMBERSHIP_MODELS.every(model => !/code/i.test(`${model.id} ${model.name} ${model.model}`)), true);
});

test('retired or unknown model choices never silently bill a different model', () => {
  for (const id of ['minimax-m2.5', 'nex-n2-pro', 'qwen3.5-397b', 'unknown']) {
    assert.throws(() => getModelById(id), error => error.status === 400 && /重新选择/.test(error.message));
  }
  assert.equal(getModelById('').id, DEFAULT_MODEL_ID);
});

test('profit protection keeps every hosted model at or above the 55% safety margin', () => {
  for (const model of MEMBERSHIP_MODELS) {
    for (const billableChars of [1, 800, 12_000]) {
      const messages = [
        { role: 'system', content: '你是中文润色助手。请忠实保留原意并只返回润色结果。'.repeat(20) },
        { role: 'user', content: '文'.repeat(billableChars) },
      ];
      const maxOutputTokens = calculateMaxOutputTokens({ billableChars });
      const baseCredits = calculateCreditCharge({
        billableChars,
        modelCredits: model.credits,
      });
      const protectedCharge = calculateProfitProtectedCreditCharge({
        messages,
        maxOutputTokens,
        model,
        baseCredits,
      });
      assert.ok(
        protectedCharge.guardedContributionMargin + 1e-12 >= TARGET_CONTRIBUTION_MARGIN,
        `${model.id}/${billableChars}: ${protectedCharge.guardedContributionMargin}`,
      );
      assert.ok(protectedCharge.credits >= baseCredits);
      assert.equal((protectedCharge.credits * 2) % 1, 0);
    }
  }
});

test('output cap scales with text and never exceeds the hard limit', () => {
  assert.equal(calculateMaxOutputTokens({ billableChars: 1 }), 256);
  assert.equal(calculateMaxOutputTokens({ billableChars: 800 }), 1600);
  assert.equal(calculateMaxOutputTokens({ billableChars: 12_000 }), 4096);
  assert.equal(calculateMaxOutputTokens({ billableChars: 800, requestedMaxTokens: 512 }), 512);
});

test('cost guard calculates current per-million-token model prices', () => {
  const guard = new CostGuard();
  const cost = guard.estimateCost(1000, 2000, {
    inputPricePerMTokens: 12,
    outputPricePerMTokens: 24,
  });
  assert.equal(cost, 0.06);
});
