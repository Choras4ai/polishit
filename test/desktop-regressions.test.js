'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

function load(file, electron, extra = {}) {
  const filename = path.resolve(__dirname, '..', file);
  const nativeRequire = createRequire(filename);
  const context = { module: { exports: {} }, __dirname: path.dirname(filename), Buffer, URL, process, console, setImmediate, setTimeout, clearTimeout, setInterval, clearInterval,
    require: name => name === 'electron' ? electron : extra[name] || nativeRequire(name) };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return context.module.exports;
}

test('installation retry revalidates the completed installer without downloading again', { skip: process.platform !== 'darwin' }, async t => {
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'runshi-install-retry-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('fixture-complete-installer');
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(bytes));
  class ProgressWindow {
    constructor() { this.webContents = { executeJavaScript: async () => {} }; }
    async loadURL() {}
    isDestroyed() { return Boolean(this.closed); }
    close() { this.closed = true; }
  }
  const electron = { app: { getPath: () => directory }, BrowserWindow: ProgressWindow,
    dialog: { showMessageBox: async () => ({ response: 0 }) } };
  const { UpdateManager } = load('src/updater/index.js', electron);
  const manager = new UpdateManager({ app: { getVersion: () => '1.6.8' }, config: { get: () => ({}) } });
  let installs = 0;
  manager._installDmg = async file => {
    assert.deepEqual(fs.readFileSync(file), bytes);
    if (++installs === 1) throw Error('fixture installation failed');
  };
  await manager._downloadAndInstall({ url: 'https://example.test/app.dmg', size: bytes.length,
    sha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex') });
  assert.equal(installs, 2); assert.equal(fetch.mock.callCount(), 1);
});

test('clipboard restoration preserves text and rich content using supported Electron keys', () => {
  let written;
  const clipboard = {
    availableFormats: () => ['text/plain', 'text/html', 'text/rtf'],
    readText: () => 'original', readHTML: () => '<b>original</b>', readRTF: () => '{rtf}',
    readImage: () => ({ isEmpty: () => true }), readBookmark: () => ({ title: '', url: '' }),
    readBuffer: f => Buffer.from(f), clear() {}, write: data => { written = data; },
  };
  const capture = load('src/capture.js', { clipboard }, { './macos-selection-helper': class {} });
  assert.equal(typeof capture.snapshotClipboard, 'function');
  capture.restoreClipboard(capture.snapshotClipboard());
  assert.equal(written.text, 'original');
  assert.equal(written.html, '<b>original</b>');
  assert.equal(written.rtf, '{rtf}');
});

test('Escape still closes the result after other keystrokes', async () => {
  class Window extends EventEmitter {
    constructor() { super(); this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = () => {}; }
    isDestroyed() { return false; }
    loadFile() { setImmediate(() => this.webContents.emit('did-finish-load')); return Promise.resolve(); }
    showInactive() {}
    close() { this.emit('closed'); }
  }
  const WindowManager = load('src/windows.js', {
    BrowserWindow: Window, screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }) },
  });
  const manager = new WindowManager();
  await manager.showResult();
  const result = manager.resultWindow;
  result.webContents.emit('before-input-event', {}, { key: 'a', type: 'keyDown' });
  result.webContents.emit('before-input-event', {}, { key: 'Escape', type: 'keyDown' });
  assert.equal(manager.resultWindow, null);
});

test('result bounds fit within a small work area', () => {
  const area = { x: -800, y: 0, width: 640, height: 480 };
  const WindowManager = load('src/windows.js', { screen: { getCursorScreenPoint: () => ({ x: -600, y: 200 }), getDisplayNearestPoint: () => ({ workArea: area }) } });
  const bounds = new WindowManager()._computeResultBounds(null);
  assert.ok(bounds.width <= area.width && bounds.height <= area.height);
  assert.ok(bounds.x >= area.x && bounds.y >= area.y);
  assert.ok(bounds.x + bounds.width <= area.x + area.width);
  assert.ok(bounds.y + bounds.height <= area.y + area.height);
});

test('Windows selection polling does not inject copy shortcuts into other apps', () => {
  let command;
  const Watcher = load('src/selection-watcher.js', { BrowserWindow: { getFocusedWindow: () => null } }, {
    child_process: { execFile: (_file, args) => { command = args.join(' '); } },
    './macos-selection-helper': class {}, './capture': {},
  });
  new Watcher()._checkClipboardForSelection();
  assert.doesNotMatch(command, /SendKeys|Clipboard.*Clear|Clipboard.*SetText/);
  assert.match(command, /TextPattern/);
});

test('Word source editing binds read and write to the captured document', async () => {
  let documentId = 'Macintosh HD:fixture-a.docx';
  let moved = false;
  let sourceText = '原文字';
  const commands = [];
  const capture = load('src/capture.js', { clipboard: {} }, {
    './macos-selection-helper': class { async probe() { return null; } },
    util: { promisify: fn => fn },
    child_process: { exec: async () => ({}), execFile: async (_file, args) => {
      const script = args.join('\n'); commands.push(args);
      if (script.includes('set targetBundle')) return { stdout: 'true' };
      if (script.includes('set selectedText to content')) return { stdout: `${moved ? 50 : 2}\n${moved ? 53 : 5}\n${Buffer.from(documentId).toString('base64')}\n${Buffer.from('原文字').toString('base64')}` };
      if (script.includes('set currentText to content')) return { stdout: Buffer.from(moved && String(args.at(-3)) !== '50' ? '已改变' : sourceText).toString('base64') };
      if (script.includes('set shouldTrack')) sourceText = '新文字';
      return { stdout: 'OK' };
    } },
  });
  const context = await capture.probeWordSelectionContext();
  assert.equal(context.documentId, documentId);
  const request = { ...context, expectedText: '原文字', targetRange: { location: 2, length: 3 } };
  const result = await capture.applyTextEdit(request, '新文字');
  assert.equal(result.ok, true);
  const write = commands.find(args => args.join('\n').includes('set shouldTrack'));
  assert.deepEqual(Array.from(write.slice(-2)), [documentId, '原文字']);
  assert.match(write.join('\n'), /content of validationRange/);
  commands.length = 0; moved = true;
  assert.equal((await capture.applyTextEdit(request, '错误重复段')).ok, false, 'must not follow a different occurrence of the same text');
  assert.equal(commands.some(args => args.join('\n').includes('set shouldTrack')), false);
  moved = false;
  commands.length = 0; documentId = 'Macintosh HD:fixture-b.docx';
  assert.equal((await capture.applyTextEdit(request, '错误写入')).ok, false);
  assert.equal(commands.some(args => args.join('\n').includes('set shouldTrack')), false);
  assert.equal((await capture.applyTextEdit({ ...request, targetRange: { location: 4, length: 5 } }, 'x')).ok, false);
});

test('shortcut capture keeps the native control token needed for verified edits', async () => {
  let clipboardText = '用户剪贴板';
  class Helper {
    probe() {
      return Promise.resolve({
        trusted: true,
        text: '选中文本',
        bundleIdentifier: 'com.apple.TextEdit',
        frontmostPid: 42,
        elementToken: 'control-abc',
        selectionRange: { location: 3, length: 4 },
        supportsRangeEditing: true,
      });
    }
  }
  const clipboard = {
    readText: () => clipboardText,
    writeText: text => { clipboardText = text; },
    readHTML: () => '', readRTF: () => '', readImage: () => ({ isEmpty: () => true }),
    readBookmark: () => ({}), write: snapshot => { clipboardText = snapshot.text || ''; },
  };
  const callbackResult = (stdout = '') => (_command, _options, callback) => {
    if (typeof _options === 'function') callback = _options;
    callback(null, { stdout, stderr: '' });
  };
  const capture = load('src/capture.js', { clipboard }, {
    './macos-selection-helper': Helper,
    child_process: {
      exec(command, options, callback) {
        const stdout = command.includes('bundle identifier') ? 'com.apple.TextEdit\n' : '';
        callbackResult(stdout)(command, options, callback);
      },
      execFile: callbackResult(''),
    },
  });
  const result = await capture.captureSelectedText();
  assert.equal(result.text, '选中文本');
  assert.equal(result.selectionContext.elementToken, 'control-abc');
  assert.deepEqual({ ...result.selectionContext.selectionRange }, { location: 3, length: 4 });
});

test('a thrown post-write verification locks the session even if clipboard restore also fails', async () => {
  let selectionCalls = 0;
  class Helper {
    async setSelection() {
      selectionCalls += 1;
      if (selectionCalls === 1) return { ok: true };
      throw new Error('AX read failed');
    }
  }
  let clipboardText = '原剪贴板';
  const clipboard = {
    readText: () => clipboardText,
    writeText: text => { clipboardText = text; },
    readHTML: () => '', readRTF: () => '', readImage: () => ({ isEmpty: () => true }),
    readBookmark: () => ({}), write: () => { throw new Error('restore failed'); },
  };
  const succeeds = (_command, _options, callback) => {
    if (typeof _options === 'function') callback = _options;
    const restore = Array.isArray(_options) && _options.some(argument => typeof argument === 'string' && argument.includes('set targetBundle'));
    callback(null, { stdout: restore ? 'true' : '', stderr: '' });
  };
  const capture = load('src/capture.js', { clipboard }, {
    './macos-selection-helper': Helper,
    child_process: { exec: succeeds, execFile: succeeds },
  });
  const request = {
    bundleIdentifier: 'com.apple.TextEdit', frontmostPid: 42, elementToken: 'control-abc',
    expectedText: '原文', selectionRange: { location: 3, length: 2 },
    targetRange: { location: 3, length: 2 },
  };
  const result = await capture.applyTextEdit(request, '新文');
  assert.equal(result.ok, false);
  assert.equal(result.sourceMayHaveChanged, true);
  assert.match(result.error, /AX read failed/);
  assert.equal(selectionCalls, 2);
});

test('standard replacement preserves the source on verification failure and copies for unsupported editors', async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8');
  const code = source.slice(source.indexOf('async function performStandardReplace('), source.indexOf('async function applyReviewChangeInSource('));
  let copied = ''; let hidden = 0; let writes = 0;
  const context = { clipboard: { writeText: text => { copied = text; } }, Notification: class { show() {} },
    windowManager: { hideResult: () => { hidden++; }, focusResult() {}, showUndoToast() {} },
    lastSelectionEditSession: null, lastAppliedReplacement: null, lastOriginalText: '原文',
    applyTextEdit: async request => { writes++; assert.equal(request.expectedText, '原文'); return { ok: false, sourceMayHaveChanged: true, error: 'changed' }; },
  };
  vm.runInNewContext(code, context);
  assert.equal((await context.performStandardReplace('新文')).mode, 'copied');
  assert.equal(copied, '新文'); assert.equal(writes, 0); assert.equal(hidden, 0);
  context.lastSelectionEditSession = { selectionStart: 4, currentText: '原文', bundleIdentifier: 'fixture', sourceStateUncertain: false };
  const failedWrite = await context.performStandardReplace('新文');
  assert.equal(failedWrite.ok, false);
  assert.equal(failedWrite.sourceMayHaveChanged, true);
  assert.equal(writes, 1); assert.equal(hidden, 0); assert.ok(context.lastSelectionEditSession);
  assert.equal(context.lastSelectionEditSession.sourceStateUncertain, true);
  const blockedRetry = await context.performStandardReplace('再次写入');
  assert.equal(blockedRetry.sourceMayHaveChanged, true);
  assert.equal(writes, 1, 'an uncertain session must not attempt another source write');
});

test('a new generation resets review ids against the current source text', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8');
  const code = source.slice(source.indexOf('function prepareReprocessBaseText('), source.indexOf('function getAcceptedChangeDelta('));
  const session = { originalText: '原文', currentText: '新文', appliedChanges: new Map([[1, {}]]), generation: 1, sourceStateUncertain: false };
  const events = [];
  const context = { process: { platform: 'darwin' }, lastSelectionEditSession: session, lastOriginalText: '原文', windowManager: { sendToResult(...args) { events.push(args); } } };
  vm.runInNewContext(code, context);
  assert.equal(context.prepareReprocessBaseText(), '新文');
  assert.equal(session.originalText, '新文');
  assert.equal(session.appliedChanges.size, 0);
  assert.equal(session.generation, 2);
  assert.deepEqual(events.map(([name]) => name), ['polish:original', 'polish:reviewContext']);
  assert.equal(events[1][1].writeMode, 'inline');
  session.sourceStateUncertain = true;
  assert.throws(() => context.prepareReprocessBaseText(), /无法确认上一条修改/);
  assert.equal(events.length, 2, 'a blocked regeneration must not reset renderer state');
});

test('WPS clipboard restore uses the native snapshot and refuses stale ownership', () => {
  let changeCount = 10;
  let restored = 0;
  class Helper {
    snapshotClipboard() { return [[{ type: 'fixture', data: Buffer.from('x') }]]; }
    restoreClipboard() { restored++; return true; }
    clipboardChangeCount() { return changeCount; }
  }
  const clipboard = { readText: () => 'selection', readHTML: () => '', readRTF: () => '',
    readImage: () => ({ isEmpty: () => true }), write() {} };
  const Watcher = load('src/selection-watcher.js', {
    BrowserWindow: { getFocusedWindow: () => null }, clipboard, screen: {},
  }, { './macos-selection-helper': Helper, './capture': {}, child_process: {} });
  const watcher = new Watcher();
  const snapshot = watcher._snapshotClipboard();
  assert.ok(snapshot.nativeItems);
  assert.equal(watcher._restoreClipboard(snapshot, 'selection', 10), true);
  changeCount = 11;
  assert.equal(watcher._restoreClipboard(snapshot, 'selection', 10), false);
  assert.equal(restored, 1);
});

test('WPS restores its sentinel when the copy shortcut produces no clipboard result', async () => {
  let currentText = '用户原剪贴板';
  let changeCount = 0;
  class Helper {
    copySelection() { return Promise.resolve(); }
    snapshotClipboard() { return [[{ type: 'public.utf8-plain-text', data: Buffer.from(currentText) }]]; }
    restoreClipboard() { currentText = '用户原剪贴板'; changeCount += 1; return true; }
    clipboardChangeCount() { return changeCount; }
  }
  const clipboard = {
    readText: () => currentText,
    writeText: text => { currentText = text; changeCount += 1; },
    readHTML: () => '', readRTF: () => '', readImage: () => ({ isEmpty: () => true }), write() {},
  };
  const Watcher = load('src/selection-watcher.js', {
    BrowserWindow: { getFocusedWindow: () => null }, clipboard, screen: {},
  }, { './macos-selection-helper': Helper, './capture': {}, child_process: {} });
  const watcher = new Watcher();
  watcher._maybeClear = () => {};
  watcher._probeWpsSelection({});
  await new Promise(resolve => setTimeout(resolve, 320));
  assert.equal(currentText, '用户原剪贴板');
  assert.match(watcher._lastProbeError, /未复制到选中的文本/);
});

test('native range editing binds writes to the captured control and accepts a verified empty range', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../native/macos-selection.mm'), 'utf8');
  assert.match(source, /elementToken\.empty\(\)/);
  assert.match(source, /CFHash\(element\).*elementToken/);
  assert.match(source, /expected\.empty\(\) && range\.length != 0/);
  assert.match(source, /rangeExists && text == expected/);
});

test('an uncertain whole-document rollback cannot be retried from the undo toast', () => {
  const main = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8');
  const undo = fs.readFileSync(path.resolve(__dirname, '../src/renderer/undo/script.js'), 'utf8');
  assert.match(main, /lastAppliedReplacement\?\.sourceStateUncertain/);
  assert.match(main, /lastAppliedReplacement\.sourceStateUncertain = true/);
  assert.match(undo, /if \(busy \|\| locked\) return/);
  assert.match(undo, /result\?\.sourceMayHaveChanged[\s\S]*locked = true/);
});
