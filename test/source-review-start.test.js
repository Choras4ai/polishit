'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function handlerFixture() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.indexOf("  ipcMain.handle('source-review:start'");
  const end = source.indexOf("  ipcMain.handle('source-review:stop'", start);
  let handler, foreground = 'Electron', ready = false, hidden = false, allocations = 0, starts = 0;
  const sender = {};
  const session = { documentId: 'fixture-document', bundleIdentifier: 'com.microsoft.Word', currentText: '原文测试',
    selectionStart: 3, frontmostPid: 9, geometryContext: null };
  const word = { documentId: session.documentId, text: session.currentText, selectionRange: { location: 3, length: 4 },
    geometryContext: { frontmostPid: 9, elementToken: 'fresh-word-identity', selectionRange: { location: 3, length: 4 } } };
  const context = {
    ipcMain: { handle: (_channel, callback) => { handler = callback; } },
    isProcessing: false, isApplyingSourceEdit: false,
    windowManager: { resultWindow: { webContents: sender, isDestroyed: () => false, hide: () => { hidden = true; } }, focusResult() {} },
    sourceReviewData: { session }, isMac: true, isWordBundleIdentifier: id => id === 'com.microsoft.Word',
    getSourceReviewState: () => ({ token: 'current' }), probeWordSelectionContext: async () => word,
    sourceReview: {
      epoch: 0,
      async windows() { if (!ready) { allocations++; foreground = 'Electron'; ready = true; } },
      async start(token) { starts++; this.epoch++; this.token = token; await this.windows(); return { ok: foreground === 'Word' }; },
      stop() { this.epoch++; },
    },
    restoreFrontApp: async () => { foreground = 'Word'; },
  };
  vm.runInNewContext(source.slice(start, end), context);
  return { handler, sender, context, session, word, starts: () => starts, state: () => ({ foreground, ready, hidden, allocations }) };
}

test('first source review allocates panels before restoring Word, then locates successfully', async () => {
  const fixture = handlerFixture();
  const result = await fixture.handler({ sender: fixture.sender }, 'current');
  assert.equal(result.ok, true);
  assert.deepEqual(fixture.state(), { foreground: 'Word', ready: true, hidden: true, allocations: 1 });
  assert.equal(fixture.session.geometryContext.elementToken, 'fresh-word-identity');
  const reopened = await fixture.handler({ sender: fixture.sender }, 'current');
  assert.equal(reopened.ok, true);
  assert.equal(fixture.state().allocations, 1);
});

test('Word geometry refresh requires the same document, full text, exact ranges and known PID', async () => {
  const mismatches = [
    f => { f.word.documentId = 'another-document'; },
    f => { f.word.text = '不同文本'; },
    f => { f.word.selectionRange.location++; },
    f => { f.word.selectionRange.length--; },
    f => { f.word.geometryContext.selectionRange.location = -1; },
    f => { f.word.geometryContext.selectionRange.location = NaN; },
    f => { f.word.geometryContext.selectionRange.length--; },
    f => { f.word.geometryContext.elementToken = ''; },
    f => { f.word.geometryContext.frontmostPid = 10; },
  ];
  for (const mismatch of mismatches) {
    const fixture = handlerFixture(); mismatch(fixture);
    const result = await fixture.handler({ sender: fixture.sender }, 'current');
    assert.equal(result.ok, false); assert.equal(fixture.starts(), 0);
    assert.equal(fixture.session.geometryContext, null);
  }
});

test('Word document offsets and AX control offsets may differ without relocating the document selection', async () => {
  const fixture = handlerFixture();
  fixture.word.geometryContext.selectionRange.location = 100;
  const result = await fixture.handler({ sender: fixture.sender }, 'current');
  assert.equal(result.ok, true);
  assert.equal(fixture.session.selectionStart, 3);
  assert.equal(fixture.session.geometryContext.selectionRange.location, 100);
});

test('Word refresh keeps its AX paragraph convention for later geometry requests', async () => {
  const fixture = handlerFixture();
  fixture.word.geometryContext.wordParagraphSeparator = 'LF';
  assert.equal((await fixture.handler({ sender: fixture.sender }, 'current')).ok, true);
  assert.equal(fixture.session.geometryContext.wordParagraphSeparator, 'LF');
});

test('an explicit host restoration failure reports the host error and never starts geometry', async () => {
  const fixture = handlerFixture();
  fixture.context.restoreFrontApp = async () => false;
  const result = await fixture.handler({ sender: fixture.sender }, 'current');
  assert.equal(result.ok, false); assert.match(result.error, /无法恢复原文应用/);
  assert.equal(fixture.starts(), 0);
});

test('closing, stopping, recapturing or writing during any async step cannot reopen or hide another result', async () => {
  for (const stage of ['windows', 'restore', 'probe', 'start']) {
    for (const cancellation of ['close', 'replace-window', 'stop', 'token', 'session', 'writing']) {
      const fixture = handlerFixture();
      const cancel = () => {
        if (cancellation === 'close') fixture.context.windowManager.resultWindow = null;
        if (cancellation === 'replace-window') fixture.context.windowManager.resultWindow = { webContents: {},
          isDestroyed: () => false, hide() { throw Error('Old start must never hide a new result window'); } };
        if (cancellation === 'stop') fixture.context.sourceReview.epoch++;
        if (cancellation === 'token') fixture.context.getSourceReviewState = () => ({ token: 'next' });
        if (cancellation === 'session') fixture.context.sourceReviewData.session = {};
        if (cancellation === 'writing') fixture.context.isApplyingSourceEdit = true;
      };
      const target = stage === 'windows' || stage === 'start' ? fixture.context.sourceReview : fixture.context;
      const key = stage === 'windows' ? 'windows' : stage === 'start' ? 'start' : stage === 'restore' ? 'restoreFrontApp' : 'probeWordSelectionContext';
      const original = target[key];
      target[key] = async function (...args) { const result = await original.apply(this, args); cancel(); return result; };
      const result = await fixture.handler({ sender: fixture.sender }, 'current');
      assert.equal(result.ok, false, `${stage}: ${cancellation}`);
      assert.equal(fixture.starts(), stage === 'start' ? 1 : 0, `${stage}: ${cancellation} cannot start after cancellation`);
      assert.equal(fixture.state().hidden, false);
    }
  }
});

test('stale or untrusted source-review requests never allocate panels or restore an app', async () => {
  for (const untrusted of [true, false]) {
    const fixture = handlerFixture();
    const result = await fixture.handler({ sender: untrusted ? {} : fixture.sender }, untrusted ? 'current' : 'stale');
    assert.equal(result.ok, false);
    assert.deepEqual(fixture.state(), { foreground: 'Electron', ready: false, hidden: false, allocations: 0 });
  }
});
