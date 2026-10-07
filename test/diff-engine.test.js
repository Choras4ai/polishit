'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const DiffEngine = require('../src/diff');

function acceptAll(changes) {
  return changes.map((c) => (c.type === 'equal' ? c : { ...c, status: 'accepted' }));
}

function rejectAll(changes) {
  return changes.map((c) => (c.type === 'equal' ? c : { ...c, status: 'rejected' }));
}

test('identical texts produce no changes', () => {
  const r = DiffEngine.compute('相同文本', '相同文本');
  assert.equal(r.hasChanges, false);
  assert.deepEqual(r.changes, []);
});

test('empty to non-empty produces insert', () => {
  const r = DiffEngine.compute('', '你好');
  assert.equal(r.hasChanges, true);
  assert.equal(DiffEngine.applyChanges(acceptAll(r.changes)), '你好');
});

test('non-empty to empty produces delete', () => {
  const r = DiffEngine.compute('你好', '');
  assert.equal(r.hasChanges, true);
  assert.equal(DiffEngine.applyChanges(acceptAll(r.changes)), '');
  assert.equal(DiffEngine.applyChanges(rejectAll(r.changes)), '你好');
});

test('surrogate pairs (emoji) are not split', () => {
  const r = DiffEngine.compute('测试😀文本', '测试😎文本');
  assert.equal(DiffEngine.applyChanges(acceptAll(r.changes)), '测试😎文本');
  assert.equal(DiffEngine.applyChanges(rejectAll(r.changes)), '测试😀文本');
});

test('reject all restores original, accept all yields new text', () => {
  const oldText = '今天天气很好';
  const newText = '今日天气不错';
  const r = DiffEngine.compute(oldText, newText);
  assert.equal(DiffEngine.applyChanges(rejectAll(r.changes)), oldText);
  assert.equal(DiffEngine.applyChanges(acceptAll(r.changes)), newText);
});

test('changes without explicit status default to keeping the original', () => {
  const r = DiffEngine.compute('abc', 'axc');
  assert.equal(DiffEngine.applyChanges(r.changes), 'abc');
});

test('very large texts fall back to line-level diff without hanging', () => {
  const a = '这是一个很长的段落。'.repeat(400);
  const b = '这是一个非常长的段落！'.repeat(400);
  const start = Date.now();
  const r = DiffEngine.compute(a, b);
  const elapsed = Date.now() - start;
  assert.ok(r.hasChanges);
  assert.ok(elapsed < 5000, `diff took too long: ${elapsed}ms`);
  assert.equal(DiffEngine.applyChanges(acceptAll(r.changes)), b);
});

test('changes across newlines round-trip correctly', () => {
  const r = DiffEngine.compute('第一行\n第二行', '第一行\n第贰行');
  assert.equal(DiffEngine.applyChanges(acceptAll(r.changes)), '第一行\n第贰行');
});

test('append at end produces trailing insert', () => {
  const r = DiffEngine.compute('你好', '你好世界');
  const ins = r.changes.find((c) => c.type === 'insert');
  assert.ok(ins);
  assert.equal(ins.newText, '世界');
});

test('prepend at start produces leading insert', () => {
  const r = DiffEngine.compute('世界', '你好世界');
  const ins = r.changes.find((c) => c.type === 'insert');
  assert.ok(ins);
  assert.equal(ins.newText, '你好');
});
