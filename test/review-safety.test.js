'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Diff = require('../src/diff');
const safety = require('../src/review-safety');
const check = (a, b, terms = []) => safety.analyzeReviewSafety(a, Diff.compute(a, b).changes, terms);
test('protected terms use exact repeated UTF-16 ranges including internal insertions', () => {
  assert(check('😀Cox 和 Cox', '😀Cox 和 Fox', ['Cox']).some(c => c.reviewSafety?.blocked));
  assert(check('Cox', 'Coax', ['Cox']).some(c => c.reviewSafety?.blocked));
  assert(check('Cox', 'Cox模型', ['Cox']).every(c => !c.reviewSafety?.blocked));
  assert(check('措词 Cox', '措辞 Cox', ['Cox']).every(c => !c.reviewSafety?.blocked));
});
test('numeric swaps and claim changes require review while ordinary typos do not', () => {
  assert(check('HR=0.82，P=0.28', 'HR=0.28，P=0.82').some(c => c.reviewSafety?.requiresConfirmation));
  assert(check('可能相关', '直接导致').some(c => c.reviewSafety?.requiresConfirmation));
  assert(check('收急资料', '收集资料').every(c => !c.reviewSafety?.requiresConfirmation));
});
test('DOI suffixes, inserted negation and new units cannot bypass risk checks', () => {
  for (const [a, b] of [['doi:10.1234/abc', 'doi:10.1234/xyz'], ['结果支持这一结论', '结果不支持这一结论'], ['剂量为10', '剂量为10kg']]) {
    assert(check(a, b).some(c => c.reviewSafety?.requiresConfirmation), `${a} -> ${b}`);
  }
});
test('term input is bounded and canonical edits reject forged text or IDs', () => {
  assert.deepEqual(safety.normalizeProtectedTerms('Cox\nCox\n BRCA1 '), ['Cox', 'BRCA1']);
  assert.throws(() => safety.normalizeProtectedTerms(['x'.repeat(121)]));
  const changes = Diff.compute('错子', '错字').changes;
  const change = changes.find(c => c.type !== 'equal');
  assert(safety.canonicalReviewChange(changes, change));
  assert.equal(safety.canonicalReviewChange(changes, { ...change, newText: '任意文本' }), null);
  assert.equal(safety.canonicalReviewChange(changes, { ...change, id: 999 }), null);
});
