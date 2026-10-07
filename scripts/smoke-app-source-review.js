'use strict';
// Full real-main / real-pipeline / real-UI / Word acceptance. All AI responses
// are deterministic localhost fixtures; only this test's unsaved Word file is edited.
const { app, BrowserWindow, screen, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const exec = promisify(execFile);
const task = process.env.RUNSHI_SMOKE_TASK === 'deai' ? 'deai' : 'polish';
const packagedResources = process.env.RUNSHI_SMOKE_PACKAGED_RESOURCES;
const toolbarEntry = process.env.RUNSHI_SMOKE_ENTRY === 'toolbar';
const paragraphs = process.env.RUNSHI_SMOKE_PARAGRAPHS === '1';
const bulk = process.env.RUNSHI_SMOKE_BULK === '1';
const allowManualFallback = process.env.RUNSHI_SMOKE_MANUAL_FALLBACK === '1';
const trackingGuard = process.env.RUNSHI_SMOKE_TRACKING === '1';
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'runshi-app-word-'));
const profile = path.join(output, 'profile'); fs.mkdirSync(profile);
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
for (const key of Object.keys(process.env)) if (key.startsWith('RUNSHI_')) delete process.env[key];
Object.assign(process.env, { RUNSHI_LOAD_DOTENV: '0', RUNSHI_SERVER_DB: path.join(output, 'fixture.sqlite3'), NODE_ENV: 'test' });
const fixturePrefix = 'Runshi app acceptance fixture ' + Date.now();
const source = fixturePrefix + (task === 'deai'
  ? '。研究团队将进行追踪，并据此调整后续服务。我们保留用户反馈中的具体问题，逐项核对，以免流于泛泛的总结。'
  : '。本次调研收急了资料。研究团队建议提高响应时间，以便更及时地回应问题。我们因该继续记录用户反馈，逐步完善整个服务流程。')
  .replace(/。(?=研究团队|我们)/g, paragraphs ? '。\r' : '。') + (paragraphs ? '\r' : '');
const polished = task === 'deai' ? source.replace('进行追踪', '持续追踪') : source.replace('收急', '收集').replace('提高响应时间', '缩短响应时间').replace('因该', '应该');
const explanations = task === 'deai' ? [
  { original: '进行追踪', modified: '持续追踪', reason: '把空泛的“进行”改为具体的持续动作，保留追踪对象和后续服务的含义。', type: 'detemplate' },
] : [
  { original: '收急', modified: '收集', reason: '资料应当收集；“急”是误用字。', type: 'wording' },
  { original: '提高响应时间', modified: '缩短响应时间', reason: '更及时地响应需要缩短等待时间。', type: 'logic' },
  { original: '因该', modified: '应该', reason: '表示应当时应使用“应该”。', type: 'grammar' },
];
const checks = [], requests = [], errors = [];
const geometryDiagnostics = [];
const restorationDiagnostics = [];
const wordProbeDiagnostics = [];
const nativeProbeDiagnostics = [];
let geometryFailureSnapshot;
let fixtureName, fakeAI, originalCursor, exitCode = 0;
let captureCalls = 0;
const osa = async (code, args = []) => (await exec('osascript', ['-e', code, ...args], { timeout: 12000 })).stdout.trim();
async function until(check, label, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { const value = await check(); if (value) return value; await delay(80); }
  throw Error('Timed out: ' + label);
}
async function click(win, selector) {
  const point = await win.webContents.executeJavaScript(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
}
async function readWord(expected) {
  const encoded = await osa('on run argv\ntell application id "com.microsoft.Word"\nset selectedContent to content of (create range document (item 1 of argv) start 0 end (item 2 of argv as integer))\nend tell\nreturn do shell script "printf %s " & quoted form of selectedContent & " | /usr/bin/base64"\nend run', [fixtureName, String(expected.length)]);
  const text = Buffer.from(encoded, 'base64').toString('utf8');
  assert.equal(text, expected, 'Read back Word text exactly, not only the result preview');
}
async function main() {
  assert.equal(process.platform, 'darwin');
  fakeAI = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    const explaining = body.messages?.[0]?.content.includes('editorial reviewer');
    const stage = explaining ? 'explain' : task;
    requests.push({ path: req.url, model: body.model, stage });
    if (!explaining && task === 'deai') assert(body.messages[0].content.includes('自然化编辑'), 'Actual de-AI prompt must be used');
    assert.equal(req.url, '/v1/chat/completions'); assert.equal(body.model, 'fixture-local');
    await delay(250);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: explaining ? JSON.stringify(explanations) : polished } }] }));
  });
  await new Promise(resolve => fakeAI.listen(0, '127.0.0.1', resolve));
  const aiOrigin = `http://127.0.0.1:${fakeAI.address().port}`;
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const backendOrigin = `http://127.0.0.1:${reservation.address().port}`;
  await new Promise(resolve => reservation.close(resolve));
  process.env.RUNSHI_PUBLIC_BASE_URL = backendOrigin;
  fs.writeFileSync(path.join(profile, 'chinese-polish-config.json'), JSON.stringify({
    provider: { preset: 'custom', apiUrl: aiOrigin + '/v1', apiKey: 'fixture-no-real-key', model: 'fixture-local' },
    pipeline: { mode: 'single', task, genre: 'academic' },
    commercial: { enabled: false, preferredSource: 'direct', backendUrl: backendOrigin },
    ui: { floatingToolbarEnabled: toolbarEntry, multipleVersionsEnabled: false },
    onboarding: { completed: true }, shortcut: 'CommandOrControl+Alt+Shift+F11',
  }));
  await app.whenReady();
  originalCursor = screen.getCursorScreenPoint;
  const allowed = new Set([aiOrigin, backendOrigin]), nativeFetch = global.fetch;
  global.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' ? input : input.url || input.href);
    if (!allowed.has(url.origin)) return Promise.reject(Error('External network disabled by acceptance test'));
    return nativeFetch(input, options);
  };
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) && !allowed.has(new URL(details.url).origin) }));
  app.on('web-contents-created', (_event, contents) => contents.on('console-message', details => {
    if (/Uncaught|TypeError|ReferenceError|SyntaxError/.test(details.message)) errors.push(details.message);
  }));
  if (packagedResources) {
    Object.defineProperty(app, 'isPackaged', { value: true });
    Object.defineProperty(process, 'resourcesPath', { value: path.resolve(packagedResources) });
  }
  const SelectionHelper = require(packagedResources ? path.join(process.resourcesPath, 'app.asar', 'src', 'macos-selection-helper.js') : '../src/macos-selection-helper');
  const selectionProbe = SelectionHelper.prototype.probe;
  SelectionHelper.prototype.probe = async function () {
    const payload = await selectionProbe.call(this); nativeProbeDiagnostics.push(payload); return payload;
  };
  const capture = require(packagedResources ? path.join(process.resourcesPath, 'app.asar', 'src', 'capture.js') : '../src/capture');
  const captureSelected = capture.captureSelectedText;
  capture.captureSelectedText = async (...args) => { captureCalls++; return captureSelected(...args); };
  const wordProbe = capture.probeWordSelectionContext;
  capture.probeWordSelectionContext = async () => {
    const context = await wordProbe(); wordProbeDiagnostics.push(context); return context;
  };
  // Read-only test diagnostics: preserve every native return value unchanged.
  // The one failure-time foreground snapshot is asynchronous and does not hold
  // the geometry reply or mutate the native captured-element identity.
  const nativeGeometry = capture.reviewSourceGeometry;
  const foreground = () => osa('tell application "System Events"\nset p to first process whose frontmost is true\nreturn {unix id of p, bundle identifier of p, name of p}\nend tell');
  const restore = capture.restoreFrontApp;
  capture.restoreFrontApp = async context => {
    const before = await foreground().catch(error => error.message);
    const result = await restore(context);
    const after = await foreground().catch(error => error.message);
    restorationDiagnostics.push({ before, after });
    return result;
  };
  capture.reviewSourceGeometry = async request => {
    const started = Date.now();
    const result = await nativeGeometry(request);
    geometryDiagnostics.push({ elapsedMs: Date.now() - started, expectedPid: request.frontmostPid,
      elementToken: request.elementToken, result });
    if (!result?.ok && !geometryFailureSnapshot) {
      geometryFailureSnapshot = osa('tell application "System Events"\nset p to first process whose frontmost is true\nreturn {unix id of p, bundle identifier of p, name of p}\nend tell').then(foreground => ({ foreground })).catch(error => ({ error: error.message }));
    }
    return result;
  };
  require(packagedResources ? path.join(process.resourcesPath, 'app.asar', 'main.js') : '../main');
  const home = await until(() => BrowserWindow.getAllWindows().find(w => /renderer\/settings\/index.html/.test(w.webContents.getURL()) && !w.webContents.isLoading()), 'real home UI');
  fixtureName = await osa('on run argv\ntell application id "com.microsoft.Word"\nset d to make new document\nset track revisions of d to false\nset content of text object of d to item 1 of argv\nactivate\nselect (create range d start 0 end (length of item 1 of argv))\nreturn name of d\nend tell\nend run', [source]);
  await delay(500);
  // Word can reset the initial range while its new document window is being
  // attached. Select again once that fixture's window has settled, just as a
  // user highlights text after opening a document; no production checks change.
  await until(async () => osa('on run argv\ntell application id "com.microsoft.Word"\nactivate\nselect (create range document (item 1 of argv) start 0 end (item 2 of argv as integer))\nend tell\nend run', [fixtureName, String(source.length)]).then(() => true, () => false), 'fixture Word range selection', 20000);
  await until(async () => {
    const selection = await capture.probeWordSelectionContext();
    return selection?.text === source && selection.geometryContext?.elementToken;
  }, 'fixture full selection and Word AX readiness');
  if (toolbarEntry) {
    const toolbar = await until(() => BrowserWindow.getAllWindows().find(w => /renderer\/toolbar\/index.html/.test(w.webContents.getURL()) && w.isVisible()), 'real watcher toolbar for cached selection');
    await click(toolbar, `.tool-btn[data-task="${task}"]`);
    checks.push('Real selection watcher and cached floating-toolbar entry');
  } else await home.webContents.executeJavaScript('window.polishAPI.recapture()');
  const result = await until(() => BrowserWindow.getAllWindows().find(w => /renderer\/result\/index.html/.test(w.webContents.getURL()) && !w.webContents.isLoading()), 'real result UI');
  await until(() => result.webContents.executeJavaScript('!!sourceReviewToken && diffChanges.some(c=>c.type!=="equal")'), 'pipeline result');
  const changes = await result.webContents.executeJavaScript('diffChanges.filter(c=>c.type!=="equal")');
  if (toolbarEntry) assert.equal(captureCalls, 0, 'Toolbar must exercise actual cached selection without capturing/saving a global app');
  assert(changes.length >= (task === 'deai' ? 1 : 3), 'fixture must create separate suggestions');
  if (task === 'deai') assert.equal(changes.length, 1, 'Naturalization fixture has exactly one complete phrase revision');
  assert.equal(await result.webContents.executeJavaScript('originalText'), source);
  assert.equal(await result.webContents.executeJavaScript('polishedText'), polished);
  await until(() => result.webContents.executeJavaScript('diffChanges.filter(c=>c.type!=="equal").every(c=>c.reason)'), 'AI reasons merged');
  checks.push('Actual Word capture through main and real AgentPipeline into result UI');
  await until(() => result.webContents.executeJavaScript('document.getElementById("loadingView").classList.contains("hidden") && !document.getElementById("resultView").classList.contains("hidden")'), 'loaded visible result view');
  await delay(150);
  fs.writeFileSync(path.join(output, 'result-before.png'), (await result.capturePage()).toPNG());
  let autoStarted = true;
  let marks = await until(() => BrowserWindow.getAllWindows().find(w => /view=marks/.test(w.webContents.getURL()) && w.isVisible()), 'automatic native Word underlines', 8000).catch(error => {
    if (!allowManualFallback) throw error;
    autoStarted = false;
    return null;
  });
  if (!marks) {
    app.focus({ steal: true }); result.focus();
    await until(() => result.isFocused(), 'result focus before manual fallback');
    await click(result, '#btnSourceReview');
    marks = await until(() => BrowserWindow.getAllWindows().find(w => /view=marks/.test(w.webContents.getURL()) && w.isVisible()), 'manual source review fallback');
  }
  const card = await until(() => BrowserWindow.getAllWindows().find(w => /view=card/.test(w.webContents.getURL())), 'source card window');
  if (autoStarted) checks.push('Word source underlines open automatically without clicking the result-window switch');
  if (bulk) {
    const firstRect = await marks.webContents.executeJavaScript('(()=>{const r=document.querySelector(".mark").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()');
    const base = marks.getBounds();
    screen.getCursorScreenPoint = () => ({ x: base.x + firstRect.x + firstRect.width / 2, y: base.y + firstRect.y + firstRect.height / 2 });
    await until(() => card.isVisible(), 'automatic source hover card');
    screen.getCursorScreenPoint = () => { const b = card.getBounds(); return { x: b.x + 25, y: b.y + 25 }; };
    await click(card, '#results');
    await until(() => result.isVisible() && !marks.isVisible(), 'return to result for bulk action');
    if (trackingGuard) {
      await osa('on run argv\ntell application id "com.microsoft.Word" to set track revisions of document (item 1 of argv) to true\nend run', [fixtureName]);
      await click(result, '#btnAcceptAll');
      await until(() => result.webContents.executeJavaScript('document.getElementById("btnAcceptAll").disabled'), 'tracking guard begins');
      await until(() => result.webContents.executeJavaScript('!document.getElementById("btnAcceptAll").disabled'), 'tracking guard completes');
      assert.equal(await result.webContents.executeJavaScript('diffChanges.filter(c=>c.type!=="equal").every(c=>c.status==="pending") && !sourceStateUncertain'), true);
      assert.match(await result.webContents.executeJavaScript('actionHint.textContent'), /修订.*未写入/);
      await readWord(source);
      assert.equal(await osa('on run argv\ntell application id "com.microsoft.Word" to return count of revisions of document (item 1 of argv)\nend run', [fixtureName]), '0');
      await osa('on run argv\ntell application id "com.microsoft.Word" to set track revisions of document (item 1 of argv) to false\nend run', [fixtureName]);
      checks.push('Word tracking mode rejected before any write; all suggestions stay pending and retryable');
    }
    await click(result, '#btnAcceptAll');
    await until(() => result.webContents.executeJavaScript('document.getElementById("btnAcceptAll").disabled'), 'bulk action begins');
    await until(() => result.webContents.executeJavaScript('!document.getElementById("btnAcceptAll").disabled'), 'bulk action completes', 40000);
    const state = await result.webContents.executeJavaScript('({ changes: diffChanges.filter(c=>c.type!=="equal").map(c=>({id:c.id,status:c.status,appliedInSource:c.appliedInSource})), message: transientActionMessage, hint: actionHint.textContent, uncertain: sourceStateUncertain })');
    state.wordText = await osa('on run argv\ntell application id "com.microsoft.Word"\nreturn content of text object of document (item 1 of argv)\nend tell\nend run', [fixtureName]).catch(error => error.message);
    state.wordRevisions = await osa('on run argv\ntell application id "com.microsoft.Word"\nreturn count of revisions of document (item 1 of argv)\nend tell\nend run', [fixtureName]).catch(error => error.message);
    fs.writeFileSync(path.join(output, 'bulk-state.json'), JSON.stringify(state, null, 2));
    assert(state.changes.every(c => c.status === 'accepted' && c.appliedInSource), JSON.stringify(state));
    await readWord(polished);
    checks.push('Accept all writes every Word change and verifies exact document text');
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ ok: true, bulk, autoStarted, trackingGuard, task, paragraphs, checks, state, output }, null, 2));
    console.log(JSON.stringify({ ok: true, bulk, autoStarted, checks, output }));
    return;
  }
  await marks.webContents.executeJavaScript('window.__smokeRects=[];window.sourceReview.onRender(p=>{if(p.view==="marks")window.__smokeRects=p.rects;});true;');
  let expected = source;
  const decisions = [];
  // First accepted, second ignored, third accepted: exercises shifted offsets
  // and real result/source state synchronization after each individual action.
  for (const [index, change] of changes.slice(0, 3).entries()) {
    await until(() => marks.isVisible() && marks.webContents.executeJavaScript(`window.__smokeRects[0]?.id===${JSON.stringify(change.id)}`), 'fresh visible native ranges for change ' + change.id);
    const rect = await marks.webContents.executeJavaScript(`window.__smokeRects.find(r=>r.id===${JSON.stringify(change.id)})`);
    const base = marks.getBounds();
    screen.getCursorScreenPoint = () => ({ x: base.x + rect.x + rect.width / 2, y: base.y + rect.y + rect.height / 2 });
    await until(async () => card.isVisible() && await card.webContents.executeJavaScript('document.getElementById("old").textContent') === (change.oldText || '在此处插入'), 'original source hover for change ' + change.id);
    screen.getCursorScreenPoint = () => { const b = card.getBounds(); return { x: b.x + 25, y: b.y + 25 }; };
    assert.equal(await card.webContents.executeJavaScript('document.getElementById("reason").textContent'), explanations[index].reason, 'AI explanation must reach the native source card');
    if (task === 'deai') {
      assert.equal(await card.webContents.executeJavaScript('document.getElementById("category").textContent'), '自然化表达');
      assert.equal(await marks.webContents.executeJavaScript('getComputedStyle(document.querySelector(".mark")).borderBottomColor'), 'rgb(161, 139, 210)');
      assert(await marks.webContents.executeJavaScript('document.querySelector(".mark").classList.contains("detemplate")'));
      checks.push('Actual de-AI system prompt and Chinese naturalization category with purple native underline');
    }
    await delay(150); // Allow the transparent native window to finish compositing.
    fs.writeFileSync(path.join(output, `source-card-${index + 1}.png`), (await card.capturePage()).toPNG());
    if (index === 1) {
      await click(card, '#results');
      await until(() => result.isVisible() && !marks.isVisible(), 'explicit card return stops source marks');
      await click(result, '#btnSourceReview');
      await until(() => marks.isVisible(), 'restart source review after returning');
      const next = await marks.webContents.executeJavaScript('(()=>{const r=document.querySelector(".mark").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()');
      const b = marks.getBounds();
      screen.getCursorScreenPoint = () => ({ x: b.x + next.x + next.width/2, y: b.y + next.y + next.height/2 });
      await until(() => card.isVisible(), 'source card reopened after restart');
      screen.getCursorScreenPoint = () => { const b=card.getBounds();return {x:b.x+25,y:b.y+25}; };
      checks.push('Explicit source-card return stops overlays and source review can restart');
    }
    const accept = task === 'deai' || index !== 1;
    await click(card, accept ? '#accept' : '#ignore');
    const status = accept ? 'accepted' : 'rejected';
    await until(() => result.webContents.executeJavaScript(`diffChanges.find(c=>c.id===${JSON.stringify(change.id)})?.status===${JSON.stringify(status)}`), 'source decision sync ' + change.id);
    if (accept) {
      // Current source positions come from canonical session offsets; reconstruct
      // expected text independently in the same left-to-right fixture order.
      const location = expected.indexOf(change.oldText);
      assert(location >= 0);
      expected = expected.slice(0, location) + change.newText + expected.slice(location + change.oldText.length);
    }
    await readWord(expected);
    if (task === 'deai') assert.equal(expected, polished, 'Accepted naturalization must produce the full intended Word text');
    decisions.push({ id: change.id, status, oldText: change.oldText, newText: change.newText });
    await delay(500);
  }
  checks.push('Native source hover with replacement and reason', task === 'deai' ? 'Real naturalization card acceptance writes the intended full Word text' : 'Real card clicks accept / ignore / consecutive accept', 'Each decision synchronized to result UI and exact Word text readback');
  // A remaining suggestion lets the actual source-card return control be used.
  if (changes.length > 3) {
    const rect = await marks.webContents.executeJavaScript('(()=>{const r=document.querySelector(".mark").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()');
    const base = marks.getBounds();
    screen.getCursorScreenPoint = () => ({ x: base.x + rect.x + rect.width/2, y: base.y + rect.y + rect.height/2 });
    await until(() => card.isVisible(), 'remaining source card');
    screen.getCursorScreenPoint = () => { const b=card.getBounds(); return {x:b.x+25,y:b.y+25}; };
    await click(card, '#results');
  } else {
    // Completion automatically brings back the real result window.
    await until(() => result.isVisible(), 'completed source review returns results');
  }
  await until(() => result.isVisible(), 'return to real result UI');
  fs.writeFileSync(path.join(output, 'result-decisions.png'), (await result.capturePage()).toPNG());
  // Hover the accepted first marker and click its actual "undo" popup control.
  const first = changes[0];
  const marker = await result.webContents.executeJavaScript(`(()=>{const e=document.querySelector('.change-marker[data-id="${first.id}"]');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  result.webContents.sendInputEvent({ type: 'mouseMove', ...marker });
  await until(() => result.webContents.executeJavaScript('activeMarkerIdx!==null'), 'accepted marker hover');
  await click(result, '#popupAccept');
  await until(() => result.webContents.executeJavaScript(`diffChanges.find(c=>c.id===${first.id})?.status==='pending'`), 'undo accepted source edit');
  const location = expected.indexOf(first.newText); assert(location >= 0);
  expected = expected.slice(0, location) + first.oldText + expected.slice(location + first.newText.length);
  await readWord(expected);
  checks.push('Accepted source edit undone through real result hover UI and verified in Word');
  assert.equal(requests.filter(r=>r.stage===task).length, 1);
  assert.equal(requests.filter(r=>r.stage==='explain').length, 1);
  assert.deepEqual(errors, []);
  const packaged = packagedResources ? path.resolve(packagedResources) : null;
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ ok: true, autoStarted, task, paragraphs, entry: toolbarEntry ? 'toolbar' : 'recapture', captureCalls, packaged, checks, decisions, requests, errors, output }, null, 2));
  console.log(JSON.stringify({ ok: true, task, packaged, checks, output }));
}
main().catch(async error => {
  exitCode = 1; console.error(error.stack);
  const windows = [];
  for (const [index, win] of BrowserWindow.getAllWindows().entries()) {
    if (win.isDestroyed()) continue;
    try {
      const url = win.webContents.getURL();
      windows.push({ url, visible: win.isVisible(), text: await win.webContents.executeJavaScript('document.body.innerText') });
      fs.writeFileSync(path.join(output, `failure-window-${index}.png`), (await win.capturePage()).toPNG());
    } catch (_) {}
  }
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, checks, requests, errors, windows, output }, null, 2));
}).finally(async () => {
  if (originalCursor) screen.getCursorScreenPoint = originalCursor;
  if (fixtureName) await osa('on run argv\ntell application id "com.microsoft.Word"\nset d to document (item 1 of argv)\nif (content of text object of d) starts with (item 2 of argv) then close d saving no\nend tell\nend run', [fixtureName, fixturePrefix]).catch(error => console.error('Fixture cleanup:', error.message));
  fakeAI?.close();
  fs.writeFileSync(path.join(output, 'geometry-diagnostics.json'), JSON.stringify({ calls: geometryDiagnostics, restorations: restorationDiagnostics, wordProbes: wordProbeDiagnostics, nativeProbes: nativeProbeDiagnostics,
    firstFailureForeground: geometryFailureSnapshot ? await geometryFailureSnapshot : null }, null, 2));
  app.exit(exitCode);
});
