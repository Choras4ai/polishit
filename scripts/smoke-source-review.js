'use strict';
// Live macOS Word fixture: creates and closes only its own unsaved document.
// No AI requests, no user documents, no published update manifest changes.
const { app, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const exec = promisify(execFile);
const { SourceReview } = require('../src/source-review');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'runshi-source-review-'));
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
const fixturePrefix = 'Runshi isolated hover fixture ' + Date.now();
let fixtureName, review, exitCode = 0;
let originalCursor;
const osa = async (code, args = []) => (await exec('osascript', ['-e', code, ...args], { timeout: 12000 })).stdout.trim();
app.whenReady().then(async () => {
  originalCursor = screen.getCursorScreenPoint;
  if (process.platform !== 'darwin') throw Error('Live fixture requires macOS Word');
  app.dock.hide();
  const source = fixturePrefix + '。本次调研收急了资料。研究团队建议提高响应时间，以便更及时地回应问题。后续还需继续收集反馈，逐步完善整个服务流程。';
  fixtureName = await osa('on run argv\ntell application id "com.microsoft.Word"\nset d to make new document\nset content of text object of d to item 1 of argv\nactivate\nselect (create range d start 0 end (length of item 1 of argv))\nreturn name of d\nend tell\nend run', [source]);
  await delay(350);
  const capture = require('../src/capture');
  const context = await capture.probeWordSelectionContext();
  assert(context.text.startsWith(fixturePrefix), 'capture did not return our fixture');
  assert(context.geometryContext?.elementToken, 'Word did not expose per-text AX identity');
  let currentText = context.text;
  const changes = [
    { id: 1, oldText: '收急', newText: '收集', reason: '表示汇总资料，应使用“收集”；“急”是误用字。' },
    { id: 2, oldText: '提高响应时间', newText: '缩短响应时间', reason: '更及时地回应问题，需要缩短等待时间。' },
  ].map(change => ({ ...change, type: 'replace', errorType: 'wording',
    originalStart: currentText.indexOf(change.oldText), originalEnd: currentText.indexOf(change.oldText) + change.oldText.length }));
  const pending = new Set(changes.map(change => change.id));
  let geometryContext = context.geometryContext;
  const state = () => ({ token: fixturePrefix, uncertain: false, changes: changes.filter(change => pending.has(change.id)),
    request: { ...geometryContext, expectedText: currentText,
      selectionRange: { location: geometryContext.selectionRange.location, length: currentText.length },
      ranges: changes.filter(change => pending.has(change.id)).map(change => ({ id: change.id,
        location: geometryContext.selectionRange.location + currentText.indexOf(change.oldText), length: change.oldText.length })) } });
  const decisions = [], errors = [];
  review = new SourceReview({ geometry: capture.reviewSourceGeometry, getState: state,
    apply: async (selected, action, token) => {
      assert.equal(token, fixturePrefix); assert.equal(action, 'accept');
      review.setWriting(true);
      try {
        const { oldText, newText } = selected;
        const start = currentText.indexOf(oldText);
        assert(start >= 0);
        const response = await capture.applyTextEdit({ ...context, expectedText: currentText,
          selectionRange: { location: context.selectionRange.location, length: currentText.length },
          targetRange: { location: context.selectionRange.location + start, length: oldText.length } }, newText, { sourceOverlay: true });
        if (response.ok) {
          currentText = currentText.slice(0, start) + newText + currentText.slice(start + oldText.length);
          pending.delete(selected.id);
          assert(response.geometryContext?.elementToken, 'Word AX identity must refresh after a write');
          geometryContext = response.geometryContext;
        }
        return response;
      } finally { review.setWriting(false); }
    }, onDecision: event => decisions.push(event), onStatus: () => {}, openResult: () => {} });
  ipcMain.handle('source-review:action', (event, payload) => review.action(event.sender, payload));
  const started = await review.start(fixturePrefix);
  if (!started.ok) {
    const windowState = await osa('with timeout of 5 seconds\ntell application "System Events" to tell process "Microsoft Word" to get {name, position, size, value of attribute "AXMinimized"} of windows\nend timeout').catch(error => error.message);
    fs.writeFileSync(path.join(output, 'geometry-failure.json'), JSON.stringify({ started, context, windowState, displays: screen.getAllDisplays() }, null, 2));
    console.error('Geometry diagnostics:', output);
  }
  assert.equal(started.ok, true, JSON.stringify(started));
  for (const change of changes) {
  await review.refresh();
  const rect = review.rects.find(rect => rect.id === change.id);
  assert(rect, 'next pending suggestion must retain source geometry');
  // Native rects are measured from the actual Word range. Feed a deterministic
  // cursor point into the same polling path without moving the user's mouse.
  screen.getCursorScreenPoint = () => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  review.pointer();
  screen.getCursorScreenPoint = () => { const r = review.card.getBounds(); return { x: r.x + 30, y: r.y + 30 }; };
  await delay(70);
  assert.equal(review.card.isVisible(), true);
  review.card.webContents.on('console-message', details => { if (/Uncaught|TypeError|ReferenceError/.test(details.message)) errors.push(details.message); });
  assert.equal(await review.card.webContents.executeJavaScript('document.getElementById("reason").textContent'), change.reason);
  fs.writeFileSync(path.join(output, `word-source-card-${change.id}.png`), (await review.card.capturePage()).toPNG());
  const bounds = await review.card.webContents.executeJavaScript('(() => { const r=document.getElementById("accept").getBoundingClientRect();return {x:Math.round(r.x+12),y:Math.round(r.y+8)} })()');
  review.card.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...bounds });
  review.card.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...bounds });
  for (let i = 0; i < 60 && decisions.length < change.id; i++) await delay(100);
  assert.equal(decisions[change.id - 1]?.ok, true, JSON.stringify(decisions));
  const actual = await osa('on run argv\ntell application id "com.microsoft.Word"\nreturn content of (create range document (item 1 of argv) start 0 end (item 2 of argv as integer))\nend tell\nend run', [fixtureName, String(currentText.length)]);
  assert.equal(actual, currentText, 'Word source must match exactly, including unchanged text');
  }
  const stale = await capture.reviewSourceGeometry({ ...state().request, expectedText: context.text });
  assert.equal(stale.ok, false, 'stale original text must invalidate geometry');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ ok: true, decisions, output }, null, 2));
  console.log(JSON.stringify({ ok: true, checks: ['Word text range identity', 'native word-level geometry', 'source hover card', 'real card clicks', 'Word consecutive replacements and full text verification', 'stale source rejection'], output }));
}).catch(error => {
  exitCode = 1; console.error(error.stack);
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, output }, null, 2));
}).finally(async () => {
  if (originalCursor) screen.getCursorScreenPoint = originalCursor;
  review?.destroy();
  if (fixtureName) {
    await osa('on run argv\ntell application id "com.microsoft.Word"\nset d to document (item 1 of argv)\nif (content of text object of d) starts with (item 2 of argv) then close d saving no\nend tell\nend run', [fixtureName, fixturePrefix]).catch(error => console.error('Fixture cleanup:', error.message));
  }
  app.exit(exitCode);
});
