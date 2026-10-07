'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeReviewChange, restoreReplacement } = require('../src/review-state');
test('review coordinates must be safe integers consistent with the old text', () => {
  const valid = { id: 1, type: 'replace', originalStart: 3, originalEnd: 5, oldText: '原文', newText: '新版' };
  assert.deepEqual(normalizeReviewChange(valid), valid);
  for (const invalid of [{ originalStart: 0.5 }, { originalStart: -1 }, { originalEnd: 10 }, { id: Infinity }]) {
    assert.equal(normalizeReviewChange({ ...valid, ...invalid }), null);
  }
});
test('restoration verifies the replacement range rather than pasting at the cursor', async () => {
  const record = { originalText: '原文', replacedText: '修改文本', selectionContext: { bundleIdentifier: 'fixture', selectionRange: { location: 5 } } };
  const result = await restoreReplacement(record, { copyText: () => assert.fail(), applyTextEdit: async (request, text) => {
    assert.equal(request.expectedText, '修改文本'); assert.deepEqual(request.targetRange, { location: 5, length: 4 }); assert.equal(text, '原文');
    return { ok: false, sourceMayHaveChanged: true, error: '文档已变化' };
  } });
  assert.equal(result.ok, false);
  assert.equal(result.sourceMayHaveChanged, true);
});
test('unsupported editors return the original by copying without any document write', async () => {
  let copied;
  const result = await restoreReplacement({ originalText: '原文', replacedText: '新文' }, {
    copyText: text => { copied = text; }, applyTextEdit: () => assert.fail('must not edit an unverified document'),
  });
  assert.equal(copied, '原文'); assert.equal(result.mode, 'copied');
});
test('review changes reject out-of-bounds insertion and overlapping accepted edits', () => {
  const { isReviewChangeApplicable } = require('../src/review-state');
  const session = { originalText: 'abcdef', appliedChanges: new Map() };
  const insertion = { id: 1, type: 'insert', originalStart: 7, originalEnd: 7, oldText: '', newText: 'x' };
  assert.equal(isReviewChangeApplicable(session, insertion), false);
  assert.equal(isReviewChangeApplicable(session, { ...insertion, originalStart: 6, originalEnd: 6 }), true);
  session.appliedChanges.set(2, { id: 2, originalStart: 1, originalEnd: 4 });
  assert.equal(isReviewChangeApplicable(session, { id: 3, type: 'replace', originalStart: 3, originalEnd: 5, oldText: 'de', newText: 'x' }), false);
  assert.equal(isReviewChangeApplicable(session, { ...insertion, originalStart: 2, originalEnd: 2 }), false);
});
