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
  const code = source.slice(source.indexOf('function getSourceReviewState()'), source.indexOf('function prepareReprocessBaseText()'));
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
