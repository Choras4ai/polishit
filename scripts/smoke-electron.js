'use strict';

// Run with: npm run test:ui
// Uses temporary settings and mocked IPC; never connects to payment/AI services.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const http = require('node:http');
let siteServer;
let siteOrigin;
app.on('will-quit', () => siteServer?.close());
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'runshi-ui-smoke-'));
// Optional Windows renderer branch on this host; IPC stays mocked. This is
// explicitly UI branch coverage, not Windows OS/COM/installer acceptance.
const uiPlatform = process.env.RUNSHI_SMOKE_UI_PLATFORM === 'win32' ? 'win32' : process.platform;
let preloadPath = path.join(root, 'preload.js');
if (uiPlatform !== process.platform) {
  preloadPath = path.join(output, 'platform-preload.js');
  fs.writeFileSync(preloadPath, fs.readFileSync(path.join(root, 'preload.js'), 'utf8')
    .replace('platform: process.platform,', `platform: ${JSON.stringify(uiPlatform)},`));
}
app.setPath('userData', path.join(output, 'profile'));
const checks = [];
const errors = [];
let currentPage = '';
const calls = [];

async function inspect(window, script) {
  return window.webContents.executeJavaScript(script);
}
async function frame(window) {
  await inspect(window, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
}
app.whenReady().then(async () => {
  siteServer = http.createServer((request, response) => {
    try {
      const base = path.join(root, '.site-dist');
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      let file = path.resolve(base, '.' + pathname);
      if (!file.startsWith(base + path.sep) && file !== base) { response.writeHead(403); return response.end(); }
      if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
      response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      response.end(fs.readFileSync(file));
    } catch (_) { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => siteServer.listen(0, '127.0.0.1', resolve));
  siteOrigin = `http://127.0.0.1:${siteServer.address().port}`;
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: /^https?:/.test(details.url) && !details.url.startsWith(siteOrigin + '/') });
  });
  const Config = require('../src/config');
  const cfg = new Config().getAll();
  if (process.platform === 'darwin') {
    const native = require('../native/bin/runshi_selection.node');
    const originalClipboard = native.snapshotClipboard();
    const fixture = [[{ type: 'org.runshi.audit.custom', data: Buffer.from('custom-format-fixture') },
      { type: 'public.utf8-plain-text', data: Buffer.from('clipboard fixture') }]];
    try {
      assert.equal(native.restoreClipboard(fixture), true);
      const captured = native.snapshotClipboard();
      assert(captured[0].some(entry => entry.type === 'org.runshi.audit.custom' && entry.data.equals(fixture[0][0].data)));
      checks.push('macOS native clipboard: custom binary format preserved');
    } finally {
      assert.equal(native.restoreClipboard(originalClipboard), true);
    }
  }
  const { PRESETS, PRESET_ORDER } = require('../src/ai/presets');
  const responses = {
    'config:get': { ...cfg, appVersion: 'smoke' },
    'presets:get': { presets: PRESETS, order: PRESET_ORDER }, 'toolbar:status': { enabled: false },
    'task:get': 'polish', 'shortcut:get': 'CommandOrControl+Alt+V',
    'commercial:get-status': { available: true, loggedIn: false, membership: {}, trial: {}, account: {} },
    'commercial:get-plans': [], 'commercial:getModels': [],
    'updates:get-status': { currentVersion: 'smoke', hasUpdate: false },
    'commercial:checkin-status': { checkedInToday: false },
  };
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  for (const [, channel] of preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)) {
    ipcMain.handle(channel, (_event, ...args) => {
      calls.push({ channel, args });
      return responses[channel] ?? { ok: true, success: true };
    });
  }
  const window = new BrowserWindow({ width: 1200, height: 900, show: false,
    webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.webContents.on('console-message', details => {
    if (details.level === 'error') errors.push({ page: currentPage, message: details.message });
  });
  for (const page of ['home', 'settings', 'onboarding', 'result', 'toolbar', 'undo']) {
    currentPage = page;
    await window.loadFile(path.join(root, 'src/renderer', page, 'index.html'));
    await frame(window);
    assert(await inspect(window, 'document.body.innerText.length > 0'), `${page} is empty`);
    assert.equal(await inspect(window, 'typeof require'), 'undefined', `${page} leaked Node`);
    if (page === 'result') {
      const DiffEngine = require('../src/diff');
      const originalText = '这项研究对这个问题进行了分析。';
      const polishedText = '这项研究分析了这一问题。';
      window.webContents.send('polish:original', originalText);
      window.webContents.send('polish:result', { originalText, polishedText, diff: DiffEngine.compute(originalText, polishedText), explanations: [] });
      await frame(window);
      await inspect(window, "document.getElementById('btnAcceptAll').click()");
      await frame(window);
      await inspect(window, "document.getElementById('btnCopyPolished').click()");
      await frame(window);
      assert(calls.some(call => call.channel === 'action:copy' && call.args[0] === polishedText), 'result copy did not preserve polished text');
      responses['action:replace'] = { ok: false, error: 'fixture write denied' };
      const closes = calls.filter(call => call.channel === 'window:close-result').length;
      await inspect(window, "document.getElementById('btnUsePolished').click()");
      await frame(window);
      assert.equal(calls.filter(call => call.channel === 'window:close-result').length, closes, 'failed replacement closed the results');
      checks.push('result: failed document write preserves the review');
      window.webContents.send('polish:original', originalText);
      window.webContents.send('polish:reviewContext', { surgicalEditing: true, platform: 'darwin', writeMode: 'inline' });
      window.webContents.send('polish:result', { originalText, polishedText, diff: DiffEngine.compute(originalText, polishedText), explanations: [], sourceReviewToken: 'word-session' });
      await frame(window);
      responses['action:apply-review-change'] = { ok: false, error: 'fixture Word write denied' };
      await inspect(window, "document.getElementById('btnAcceptAll').click()");
      await frame(window);
      assert.equal(await inspect(window, "diffChanges.filter(c=>c.type!=='equal').every(c=>c.status==='pending' && !c.appliedInSource)"), true, 'failed bulk write must remain pending');
      assert.match(await inspect(window, 'actionHint.textContent'), /fixture Word write denied/);
      responses['action:apply-review-change'] = { ok: true, applied: true };
      await inspect(window, "document.getElementById('btnAcceptAll').click()");
      await frame(window);
      assert.equal(await inspect(window, "diffChanges.filter(c=>c.type!=='equal').every(c=>c.status==='accepted' && c.appliedInSource)"), true, 'successful bulk writes are reflected in source state');
      const opens = calls.filter(call => call.channel === 'source-review:start').length;
      window.webContents.send('polish:auto-source-review', 'word-session');
      await frame(window);
      assert.equal(calls.filter(call => call.channel === 'source-review:start').length, opens + 1, 'Word source-review offer must start native marks');
      checks.push('result: bulk Word failure remains pending, retry succeeds, automatic Word overlay starts');
    }
    if (page === 'settings') {
      await inspect(window, 'loadConfig()');
      if (uiPlatform === 'win32') {
        assert.match(await inspect(window, "document.getElementById('currentShortcut').textContent"), /Ctrl/);
        checks.push('Windows renderer: configured shortcut uses Ctrl display');
      }
      await inspect(window, "document.querySelector('[data-tab=about]').click();document.getElementById('authorLink').click()");
      await frame(window);
      assert.equal(await inspect(window, "document.querySelector('.tab-panel.active').id"), 'panel-about');
      assert(calls.some(call => call.channel === 'shell:open-external' && call.args[0] === 'https://www.runshi.top/lab/'), 'about link must open NEO LAB');
      assert.equal(new URL(window.webContents.getURL()).protocol, 'file:', 'about link must stay outside the APP');
      await inspect(window, 'new Promise(resolve => setTimeout(resolve, 200))');
      fs.writeFileSync(path.join(output, 'about-neo-lab.png'), (await window.capturePage()).toPNG());
      await inspect(window, "document.getElementById('authorLink').scrollIntoView({block:'center',behavior:'instant'})");
      await frame(window);
      await inspect(window, 'new Promise(resolve => setTimeout(resolve, 200))');
      fs.writeFileSync(path.join(output, 'about-neo-lab-link.png'), (await window.capturePage()).toPNG());
      checks.push('settings: about page opens NEO LAB in external browser');
      assert.equal(await inspect(window, "document.getElementById('btnCheckin').disabled"), true);
      checks.push('settings: guest check-in disabled');
      assert.equal(await inspect(window, "document.querySelectorAll('#modelList .model-row').length"), 0);
      responses['commercial:getModels'] = require('../server/commercial/models').getModelList();
      await inspect(window, 'renderModelList()');
      assert.equal(await inspect(window, "document.querySelectorAll('#modelList .model-row').length"), 7);
      const catalogText = await inspect(window, "document.getElementById('modelList').textContent");
      assert.match(catalogText, /GLM-5.3/); assert.match(catalogText, /Qwen3.8-27B/);
      assert.doesNotMatch(catalogText, /MiniMax|Nex|397B|LongCat|Step-/);
      responses['commercial:getModels'] = [];
      await inspect(window, 'renderModelList()');
      assert.equal(await inspect(window, "document.querySelectorAll('#modelList .model-row').length"), 0);
      checks.push('settings: current seven-model catalog; unavailable list never revives retired models');
    }
    if (page === 'onboarding' && uiPlatform === 'win32') {
      responses['toolbar:status'] = { enabled: true, selectionMonitoringAvailable: true, platform: 'win32' };
      await inspect(window, 'prepareDefaultExperience()');
      assert.equal(await inspect(window, "getComputedStyle(document.getElementById('permissionSetupRow')).display"), 'none');
      assert.equal(await inspect(window, "document.getElementById('onboardPermissionState').textContent"), '无需授权');
      assert.match(await inspect(window, "document.getElementById('onboardSetupMessage').textContent"), /核心功能已就绪/);
      await inspect(window, "document.getElementById('btnTestToolbar').click()");
      await frame(window);
      assert(calls.some(call => call.channel === 'toolbar:test'), 'Windows onboarding can show a test toolbar');
      await inspect(window, "document.getElementById('btnContinueReady').click()");
      await frame(window);
      assert.equal(await inspect(window, "document.querySelector('.step.active').id"), 'step-ready');
      checks.push('Windows renderer: setup, no macOS permission prompt, toolbar test and ready flow');
    }
    checks.push(`${page}: loaded with isolated preload`);
  }
  currentPage = 'website';
  await window.loadURL(siteOrigin + '/'); await frame(window);
  await inspect(window, 'Promise.all(document.getAnimations().filter(animation => animation.effect.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))');
  assert.equal(await inspect(window, 'getComputedStyle(document.querySelector(".hero h1")).opacity'), '1');
  assert.equal(await inspect(window, "document.querySelectorAll('#demoDocument .rd-mark').length"), 6);
  await inspect(window, "document.querySelector('[data-edit=typo]').scrollIntoView({block:'center',behavior:'instant'})");
  await frame(window);
  const hoverPoint = await inspect(window, "(() => { const r=document.querySelector('[data-edit=typo]').getBoundingClientRect();return {x:Math.round(r.left+8),y:Math.round(r.top+8)} })()");
  window.webContents.sendInputEvent({type:'mouseMove',...hoverPoint}); await frame(window);
  assert.equal(await inspect(window, "document.getElementById('demoHoverCard').hidden"), false, 'real hover opens source card');
  assert.match(await inspect(window, "document.querySelector('.rd-reason').textContent"), /收集/);
  const acceptPoint = await inspect(window, "(() => { const r=document.querySelector('[data-action=accept]').getBoundingClientRect();return {x:Math.round(r.left+20),y:Math.round(r.top+12)} })()");
  window.webContents.sendInputEvent({type:'mouseMove',...acceptPoint});
  await inspect(window, 'new Promise(resolve => setTimeout(resolve, 280))');
  assert.equal(await inspect(window, "document.getElementById('demoHoverCard').hidden"), false, 'moving from source to card keeps actions available');
  window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...acceptPoint});
  window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...acceptPoint});
  await frame(window);
  assert.match(await inspect(window, "document.getElementById('demoDocument').textContent"), /共收集了 120/);
  assert.equal(await inspect(window, "document.querySelectorAll('#demoDocument .rd-mark').length"), 5);
  await inspect(window, "document.querySelector('[data-edit=word]').click();document.querySelector('[data-action=ignore]').click()");
  assert.match(await inspect(window, "document.getElementById('demoDocument').textContent"), /提高服务响应时间/);
  assert.equal(await inspect(window, "document.querySelector('[data-edit=word]')"), null);
  await inspect(window, "document.getElementById('demoUndo').click()");
  assert.equal(await inspect(window, "!!document.querySelector('[data-edit=word]')"), true);
  await inspect(window, "document.querySelector('[data-demo-mode=natural]').click()");
  assert.equal(await inspect(window, "document.querySelectorAll('#demoDocument .rd-mark').length"), 6);
  await inspect(window, "document.querySelector('[data-edit=opening]').focus();document.querySelector('[data-edit=opening]').dispatchEvent(new FocusEvent('focus'))");
  assert.equal(await inspect(window, "document.getElementById('demoHoverCard').hidden"), false);
  await inspect(window, "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  assert.equal(await inspect(window, "document.getElementById('demoHoverCard').hidden"), true);
  await inspect(window, "document.querySelector('[data-edit=opening]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
  assert.equal(await inspect(window, "document.activeElement.dataset.action"), 'accept');
  await inspect(window, "document.activeElement.click();document.querySelector('[data-demo-mode=polish]').click()");
  assert.match(await inspect(window, "document.getElementById('demoDocument').textContent"), /共收集了 120/);
  await inspect(window, "document.getElementById('demoReset').click()");
  assert.equal(await inspect(window, "document.querySelectorAll('#demoDocument .rd-mark').length"), 6);
  checks.push('website: source hover, focused card, accept, ignore, undo, separate modes and reset');
  for (const width of [390, 768, 1200]) {
    window.setContentSize(width, 900); await frame(window);
    await inspect(window, "document.querySelector('[data-edit=logic]').scrollIntoView({block:'center',behavior:'instant'});document.querySelector('[data-edit=logic]').click()");
    await frame(window);
    const dimensions = await inspect(window, '({ content: document.documentElement.scrollWidth, viewport: innerWidth })');
    assert(dimensions.content <= dimensions.viewport + 1, `horizontal overflow at ${width}: ${JSON.stringify(dimensions)}`);
    const box = await inspect(window, "(() => { const r=document.getElementById('demoHoverCard').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,w:innerWidth,h:innerHeight} })()");
    assert(box.left >= 0 && box.top >= 0 && box.right <= box.w && box.bottom <= box.h, `card outside viewport: ${JSON.stringify(box)}`);
    assert.equal(await inspect(window, "document.getElementById('demoHoverCard').hidden"), false);
    fs.writeFileSync(path.join(output, `website-${width}.png`), (await window.capturePage()).toPNG());
    checks.push(`website: source click and card inside ${width}px viewport`);
  }
  await inspect(window, "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));document.querySelector('.rd-product').scrollIntoView({behavior:'instant',block:'start'});document.querySelector('[data-edit=typo]').click()");
  await frame(window);
  fs.writeFileSync(path.join(output, 'website-review.png'), (await window.capturePage()).toPNG());
  window.setContentSize(390, 900); await frame(window);
  await inspect(window, "document.querySelector('.rd-product').scrollIntoView({behavior:'instant',block:'start'});document.querySelector('[data-edit=typo]').click()");
  await frame(window);
  fs.writeFileSync(path.join(output, 'website-review-mobile.png'), (await window.capturePage()).toPNG());
  await window.loadURL(siteOrigin + '/lab/'); await frame(window);
  assert.match(await inspect(window, 'document.body.innerText'), /波江座人工智能实验室/);
  fs.writeFileSync(path.join(output, 'lab.png'), (await window.capturePage()).toPNG());
  checks.push('NEO LAB: loads local constellation experience');
  await window.loadURL(siteOrigin + '/addins/'); await frame(window);
  assert.match(await inspect(window, 'document.body.innerText'), /Word/);
  checks.push('add-in installation page: loaded');
  // Font/CDN failures are expected because this test deliberately blocks external traffic.
  const runtimeErrors = errors.filter(item => /Uncaught|TypeError|ReferenceError|SyntaxError/.test(item.message));
  assert.deepEqual(runtimeErrors, []);
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ checks, errors, uiPlatform, hostPlatform: process.platform }, null, 2));
  console.log(JSON.stringify({ ok: true, checks, output, uiPlatform, hostPlatform: process.platform }));
  window.destroy(); siteServer.close(); app.exit(0);
}).catch(error => {
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, currentPage, checks, errors }, null, 2));
  console.error(error.stack, output); siteServer?.close(); app.exit(1);
});
