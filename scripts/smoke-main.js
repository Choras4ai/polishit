'use strict';
// Boots the real application and its local backend using a disposable profile/DB.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');
const packagedResources = process.env.RUNSHI_SMOKE_PACKAGED_RESOURCES;
const { setTimeout: delay } = require('node:timers/promises');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'runshi-main-smoke-'));
const profile = path.join(output, 'profile'); fs.mkdirSync(profile);
app.setPath('userData', profile);
for (const key of Object.keys(process.env)) if (key.startsWith('RUNSHI_')) delete process.env[key];
Object.assign(process.env, { RUNSHI_LOAD_DOTENV: '0', RUNSHI_SERVER_DB: path.join(output, 'fixture.sqlite3'), NODE_ENV: 'test' });
const errors = [];
let finished = false;
function finish(error) {
  if (finished) return; finished = true;
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ ok: !error, errors, error: error?.stack, output }, null, 2));
  console.log(JSON.stringify({ ok: !error, output, error: error?.message }));
  process.exitCode = error ? 1 : 0;
  app.quit();
}
process.on('uncaughtException', finish);
process.on('unhandledRejection', finish);
setTimeout(() => finish(new Error('Application startup timed out')), 20000).unref();
(async () => {
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  process.env.RUNSHI_PUBLIC_BASE_URL = origin;
  fs.writeFileSync(path.join(profile, 'chinese-polish-config.json'), JSON.stringify({
    commercial: { enabled: true, backendUrl: origin },
    ui: { floatingToolbarEnabled: false }, onboarding: { completed: true },
    shortcut: 'CommandOrControl+Alt+Shift+F11',
  }));
  await app.whenReady();
  const nativeFetch = global.fetch;
  global.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' ? input : input.url || input.href);
    if (url.origin !== origin) return Promise.reject(new Error('External network disabled by smoke test'));
    return nativeFetch(input, options);
  };
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: /^https?:/.test(details.url) && new URL(details.url).origin !== origin });
  });
  app.on('web-contents-created', (_event, contents) => {
    contents.on('console-message', details => {
      if (details.level === 'error' && /Uncaught|TypeError|ReferenceError|SyntaxError/.test(details.message)) errors.push(details.message);
    });
  });
  if (packagedResources) {
    Object.defineProperty(app, 'isPackaged', { value: true });
    Object.defineProperty(process, 'resourcesPath', { value: path.resolve(packagedResources) });
    require(path.join(process.resourcesPath, 'app.asar', 'main.js'));
  } else require('../main');
  let home;
  for (let attempt = 0; attempt < 150; attempt++) {
    home = BrowserWindow.getAllWindows().find(window => /renderer\/settings\/index.html/.test(window.webContents.getURL()) && !window.webContents.isLoading());
    if (home) break;
    await delay(50);
  }
  assert(home, 'Real main process must open the unified home/settings page');
  const cfg = await home.webContents.executeJavaScript('window.polishAPI.getConfig()');
  assert.equal(cfg.commercial.backendUrl, origin);
  assert.equal(cfg.onboarding.completed, true);
  const health = await nativeFetch(origin + '/api/health'); assert.equal(health.status, 200);
  assert.equal(await home.webContents.executeJavaScript('typeof require'), 'undefined');
  await home.webContents.executeJavaScript('window.polishAPI.openSettings()');
  await delay(200);
  assert(BrowserWindow.getAllWindows().some(window => /renderer\/settings\/index.html/.test(window.webContents.getURL())));
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'home.png'), (await home.capturePage()).toPNG());
  finish();
})().catch(finish);
