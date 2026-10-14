'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const util = require('node:util');

const original = '第一段。\r第二段。\r';
async function probe(axText) {
  const execute = () => {};
  execute[util.promisify.custom] = async () => ({ stdout: `3\n${3 + original.length}\n${Buffer.from('fixture-document').toString('base64')}\n${Buffer.from(original).toString('base64')}` });
  const context = { module: { exports: {} }, Buffer, console, process: { ...process, platform: 'darwin' },
    setTimeout: callback => setTimeout(callback, 0),
    require: name => {
      if (name === 'electron') return { clipboard: {} };
      if (name === 'child_process') return { exec: execute, execFile: execute };
      if (name === './macos-selection-helper') return class { async probe() { return { trusted: true,
        bundleIdentifier: 'com.microsoft.Word', frontmostPid: 9, text: axText, elementToken: 'fixture-element',
        selectionRange: { location: 100, length: axText.length } }; } };
      if (name === './windows-review-helper') return class {};
      if (name === './app-identity') return { isOwnBundleIdentifier: () => false };
      return require(name);
    } };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../src/capture.js'), 'utf8'), context);
  return context.module.exports.probeWordSelectionContext();
}

test('Mac Word accepts equal-length CR to LF AX text without changing document text or offsets', async () => {
  const result = await probe(original.replace(/\r/g, '\n'));
  assert.equal(result.text, original);
  assert.equal(result.geometryContext.wordParagraphSeparator, 'LF');
  assert.equal(result.selectionRange.location, 3);
  assert.equal(result.geometryContext.selectionRange.location, 100);
  assert.equal(result.geometryContext.selectionRange.length, original.length);
});

test('Mac Word keeps native CR geometry and rejects different text or CRLF offset expansion', async () => {
  assert.equal((await probe(original)).geometryContext.wordParagraphSeparator, 'CR');
  for (const axText of [original.replace(/\r/g, '\r\n'), original.replace('第二', '不同')]) {
    assert.equal((await probe(axText)).geometryContext, null);
  }
});

test('geometry uses current LF Word text while source edit baseline stays CR after length-changing edits', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8');
  const code = source.slice(source.indexOf('function getSourceReviewState('), source.indexOf('function prepareReprocessBaseText()'));
  const session = { generation: 1, originalText: original, currentText: '第一段修改。\r第二段。\r', appliedChanges: new Map(),
    bundleIdentifier: 'com.microsoft.Word', documentId: 'fixture-document', windowHandle: null,
    geometryContext: { frontmostPid: 9, elementToken: 'fixture-element', selectionRange: { location: 100 }, wordParagraphSeparator: 'LF' } };
  const data = { session, generation: 1, token: 'fixture-token', ignored: new Set(), changes: [{ id: 1, oldText: '第二', originalStart: 7 }] };
  const context = { sourceReviewData: data, lastSelectionEditSession: session, getRelativeChangeStart: () => 7 };
  vm.runInNewContext(code, context);
  const state = context.getSourceReviewState();
  assert.equal(state.request.expectedText, session.currentText.replace(/\r/g, '\n'));
  assert.equal(state.request.selectionRange.length, session.currentText.length);
  assert.equal(state.request.ranges[0].location, 107);
  assert.equal(session.currentText, '第一段修改。\r第二段。\r');
  session.bundleIdentifier = 'win32.word';
  assert.equal(context.getSourceReviewState().request.expectedText, session.currentText, 'Windows COM geometry remains CR');
});

test('hover state skips range projection while retaining current decisions', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8');
  const code = source.slice(source.indexOf('function getSourceReviewState('), source.indexOf('function offerWordSourceReview()'));
  const session = { generation: 1, appliedChanges: new Map(), sourceStateUncertain: false };
  const data = { session, generation: 1, token: 'token', ignored: new Set(), changes: [{ id: 1 }, { id: 2 }] };
  let projections = 0;
  const context = { sourceReviewData: data, lastSelectionEditSession: session,
    getRelativeChangeStart: () => { projections++; return 0; } };
  vm.runInNewContext(code, context);
  assert.deepEqual(Array.from(context.getSourceReviewState(false).changes, c => c.id), [1, 2]);
  assert.equal(projections, 0);
  data.ignored.add(1);
  assert.deepEqual(Array.from(context.getSourceReviewState(false).changes, c => c.id), [2]);
  assert.equal(context.getSourceReviewState(false).request, undefined);
});

test('geometry requests can reach suggestions beyond the first 32', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8');
  const code = source.slice(source.indexOf('function getSourceReviewState('), source.indexOf('function offerWordSourceReview()'));
  const session = { generation: 1, currentText: '字'.repeat(80), appliedChanges: new Map(), selectionStart: 0,
    frontmostPid: 9, elementToken: 'fixture-element', bundleIdentifier: 'com.microsoft.Word' };
  const changes = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, oldText: '字' }));
  const context = { sourceReviewData: { session, generation: 1, token: 'token', ignored: new Set(), changes },
    lastSelectionEditSession: session, getRelativeChangeStart: (_session, change) => change.id - 1 };
  vm.runInNewContext(code, context);
  assert.deepEqual(Array.from(context.getSourceReviewState(true, 0).request.ranges, r => r.id),
    Array.from({ length: 32 }, (_, i) => i + 1));
  assert.deepEqual(Array.from(context.getSourceReviewState(true, 1).request.ranges, r => r.id),
    Array.from({ length: 8 }, (_, i) => i + 33));
});

test('Word source geometry accepts insertion suggestions without oldText', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8');
  const code = source.slice(source.indexOf('function getSourceReviewState('), source.indexOf('function offerWordSourceReview()'));
  const session = { generation: 1, currentText: '原文', appliedChanges: new Map(), selectionStart: 0,
    frontmostPid: 9, elementToken: 'fixture-element', bundleIdentifier: 'com.microsoft.Word' };
  const changes = [{ id: 1, type: 'insert', newText: '补充', originalStart: 1 }];
  const context = { sourceReviewData: { session, generation: 1, token: 'token', ignored: new Set(), changes },
    lastSelectionEditSession: session, getRelativeChangeStart: () => 1 };
  vm.runInNewContext(code, context);
  assert.equal(context.getSourceReviewState().request.ranges[0].length, 0);
});
