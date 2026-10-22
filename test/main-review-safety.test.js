'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const DiffEngine = require('../src/diff');
const safety = require('../src/review-safety');
function fixture(original, revised, terms = [], response = 1) {
  const source = fs.readFileSync(require.resolve('../main.js'), 'utf8');
  const start = source.indexOf('function reviewChangeKey(');
  assert(start >= 0, 'main-process safety authorization must exist');
  const changes = DiffEngine.compute(original, revised).changes;
  let prompts = 0;
  const context = { ...safety, DiffEngine, config: { get: () => terms }, lastReviewOriginalText: original,
    lastReviewResults: [{ diff: { changes } }], approvedReviewChanges: new Map(), lastSelectionEditSession: null,
    dialog: { showMessageBox: async () => { prompts++; return { response }; } } };
  vm.runInNewContext(source.slice(start, source.indexOf('function prepareReprocessBaseText()', start)), context);
  return { context, changes: changes.filter(c => c.type !== 'equal'), prompts: () => prompts };
}
test('main refuses protected and forged edits regardless of renderer safety flags', async () => {
  const f = fixture('Cox', 'Fox', ['Cox']);
  assert.equal((await f.context.authorizeReviewChange({ ...f.changes[0], reviewSafety: {} })).ok, false);
  assert.equal(f.prompts(), 0);
  assert.equal((await f.context.authorizeReviewChange({ ...f.changes[0], newText: 'arbitrary' })).ok, false);
});
test('a confirmed exact alternative can finalize but unrelated text cannot', async () => {
  const f = fixture('剂量10', '剂量20', [], 0);
  f.changes[0].alternatives = ['3'];
  assert.equal((await f.context.authorizeReviewChange({ ...f.changes[0], newText: '3' })).ok, true);
  assert.equal(f.context.replacementSafetyError('剂量30'), null);
  assert(f.context.replacementSafetyError('剂量40'));
});
test('final drafts may keep any subset of individually confirmed changes', async () => {
  const f = fixture('A10 B30', 'A20 B40', [], 0);
  for (const c of f.changes) assert.equal((await f.context.authorizeReviewChange(c)).ok, true);
  assert.equal(f.context.replacementSafetyError('A10 B40'), null);
  assert.equal(f.context.replacementSafetyError('A20 B30'), null);
  assert(f.context.replacementSafetyError('A90 B40'));
});
test('main asks before a numerical edit and blocks unapproved whole-text writes', async () => {
  const f = fixture('HR=0.82', 'HR=0.28');
  assert(f.context.replacementSafetyError('HR=0.28'));
  assert.equal((await f.context.authorizeReviewChange(f.changes[0])).ok, false);
  assert.equal(f.prompts(), 1);
  const approved = fixture('HR=0.82', 'HR=0.28', [], 0);
  for (const c of approved.changes) assert.equal((await approved.context.authorizeReviewChange(c)).ok, true);
  assert.equal(approved.context.replacementSafetyError('HR=0.28'), null);
  assert.equal(approved.context.replacementSafetyError('HR=0.99') !== null, true);
});
