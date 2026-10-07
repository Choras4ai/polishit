'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { isReviewChangeApplicable } = require('../src/review-state');

test('LF AX geometry never changes the canonical CR Word write request or document offsets', async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8');
  const originalText = '第一段。\r第二段。\r';
  const session = { bundleIdentifier: 'com.microsoft.Word', frontmostPid: 9, documentId: 'bound-document',
    windowHandle: null, elementToken: 'bound-control', selectionStart: 3, originalText, currentText: originalText,
    appliedChanges: new Map(), geometryContext: { frontmostPid: 9, elementToken: 'bound-control',
      selectionRange: { location: 100, length: originalText.length }, wordParagraphSeparator: 'LF' } };
  const change = { id: 1, type: 'replace', originalStart: 0, originalEnd: 2, oldText: '第一', newText: '较长的第一' };
  let request;
  const context = { lastSelectionEditSession: session, isReviewChangeApplicable,
    isWordBundleIdentifier: value => value === 'com.microsoft.Word', windowManager: { focusResult() {} },
    applyTextEdit: async value => { request = value; return { ok: true, selectionRange: { location: 3 },
      geometryContext: session.geometryContext }; } };
  const helpers = source.slice(source.indexOf('function getAcceptedChangeDelta('), source.indexOf('let isApplyingSourceEdit'));
  const apply = source.slice(source.indexOf('async function applyReviewChangeInSource('), source.indexOf('async function finalizeSurgicalReview('));
  vm.runInNewContext(helpers + apply, context);
  const result = await context.applyReviewChangeInSource(change, 'accept', { sourceOverlay: true });
  assert.equal(result.ok, true);
  assert.equal(request.expectedText, originalText);
  assert.equal(request.bundleIdentifier, 'com.microsoft.Word');
  assert.equal(request.documentId, 'bound-document');
  assert.equal(request.frontmostPid, 9);
  assert.equal(request.elementToken, 'bound-control');
  assert.equal(request.selectionRange.location, 3);
  assert.equal(request.selectionRange.length, originalText.length);
  assert.equal(request.targetRange.location, 3, 'Write uses document offset, not AX offset 100');
  assert.equal(session.currentText, '较长的第一段。\r第二段。\r');
  assert.equal(session.geometryContext.selectionRange.location, 100);
  assert.equal(session.geometryContext.wordParagraphSeparator, 'LF');
});
