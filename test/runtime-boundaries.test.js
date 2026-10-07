'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { SlidingWindowCounter } = require('../server/middleware/rate-limiter');
const { AgentPipeline } = require('../src/ai/pipeline');

test('daily limit survives cleanup after eleven minutes of inactivity', t => {
  const counter = new SlidingWindowCounter();
  t.after(() => counter.destroy());
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  counter.check('daily', 1, 86400000);
  now += 660000;
  counter._globalCleanup();
  assert.equal(counter.check('daily', 1, 86400000).allowed, false);
  now += 86400000;
  counter._globalCleanup();
  assert.equal(counter.buckets.size, 0);
});

test('pipeline respects a configured zero temperature', async () => {
  const temperatures = [];
  const config = { get: key => ({ 'pipeline.temperature': 0, 'pipeline.mode': 'single' })[key] };
  const pipeline = new AgentPipeline({ chat: async (_messages, options) => {
    temperatures.push(options.temperature);
    return '这是一段测试文字。';
  } }, config);
  await pipeline.process('这是一段测试文字。', () => {}, 'polish', { skipExplanations: true });
  assert.equal(temperatures[0], 0);
});

test('Word restores tracking mode when a granular write fails', async () => {
  let syncs = 0;
  const target = { text: 'original', insertText() { throw new Error('write failed'); } };
  const anchored = { text: 'original', isNullObject: false, load() {},
    search: () => ({ load() {}, items: [target] }) };
  const document = {
    changeTrackingMode: 'off', load() {},
    getBookmarkRangeOrNullObject: () => anchored,
    deleteBookmark() {},
  };
  const window = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../integrations/word/adapter.js'), 'utf8'), {
    window,
    Office: { context: { document: {}, requirements: { isSetSupported: () => true } } },
    Word: { run: fn => fn({ document, sync: async () => { syncs++; } }), InsertLocation: { replace: 'replace', before: 'before', end: 'end' }, ChangeTrackingMode: { trackAll: 'all' } },
  });
  await assert.rejects(window.RunShiHost.applyAcceptedChanges({ text: 'original', bookmarkName: '_fixture' }, [
    { type: 'replace', oldText: 'original', newText: 'new', originalStart: 0, originalEnd: 8 },
  ], 'new'), /write failed/);
  assert.equal(document.changeTrackingMode, 'off');
  assert.ok(syncs >= 4);
});

test('Word annotations target the changed occurrence and reject another document', async () => {
  const targets = [];
  const hostDocument = { url: 'https://example.test/first.docx' };
  const Office = { context: { document: hostDocument, requirements: { isSetSupported: () => true } } };
  const selection = { text: '甲乙，甲乙。', isNullObject: false, load() {}, insertBookmark() {},
    search: () => ({ load() {}, items: [0, 3].map(offset => ({ text: '甲乙', insertComment() { targets.push(offset); } })) }),
    insertComment() { targets.push('summary'); },
  };
  const window = {};
  const context = { document: { getSelection: () => selection,
    getBookmarkRangeOrNullObject: () => selection, deleteBookmark() {} }, sync: async () => {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../integrations/word/adapter.js'), 'utf8'), {
    window, Office, Word: { run: fn => fn(context) },
  });
  const snapshot = await window.RunShiHost.captureSelection();
  await window.RunShiHost.annotateSuggestions(snapshot, [{ type: 'replace', oldText: '甲乙', newText: '丙丁', originalStart: 3 }]);
  assert.deepEqual(targets, [3]);
  Office.context.document = { url: 'https://example.test/second.docx' };
  await assert.rejects(window.RunShiHost.annotateSuggestions(snapshot, []), /文档已切换/);
});
