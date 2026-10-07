'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  compareVersions,
  mapManifestPayload,
  mapReleasePayload,
  UpdateManager,
  normalizeDownloadEntry,
  normalizeVersion,
  parseGitHubRepository,
  parseManifestUrl,
  replaceMacAppBundle,
  trimReleaseNotes,
} = require('../src/updater');

test('normalizeVersion removes leading v', () => {
  assert.equal(normalizeVersion('v1.5.0'), '1.5.0');
  assert.equal(normalizeVersion('1.5.1'), '1.5.1');
});

test('GitHub release mapping preserves digest and size for verified installation', () => {
  const release = mapReleasePayload({ tag_name: 'v1.8.0', assets: [{ name: 'runshi-arm64.dmg', browser_download_url: 'https://example.test/app.dmg', digest: `sha256:${'a'.repeat(64)}`, size: 123 }] }, 'darwin', 'arm64');
  assert.equal(release.sha256, 'a'.repeat(64)); assert.equal(release.size, 123);
});

test('automatic updates never fall back to a different architecture', () => {
  const release = { tag_name: 'v1.8.0', assets: [{ name: 'runshi-arm64.dmg', browser_download_url: 'https://example.test/arm64.dmg' }] };
  assert.equal(mapReleasePayload(release, 'darwin', 'x64').url, '');
  release.assets.push({ name: 'runshi-universal.dmg', browser_download_url: 'https://example.test/universal.dmg' });
  assert.equal(mapReleasePayload(release, 'darwin', 'x64').url, 'https://example.test/universal.dmg');
});

test('cached newer release remains visible immediately after restart', () => {
  const manager = new UpdateManager({ app: { getVersion: () => '1.0.0' }, config: { get: () => ({ latestVersion: '1.1.0', hasUpdate: true }) } });
  assert.equal(manager.getStatus().hasUpdate, true);
});

test('automatic prompt and settings share one installer in either entry order', async () => {
  const fs = require('node:fs');
  const { createRequire } = require('node:module');
  const { runInNewContext } = require('node:vm');
  const filename = require.resolve('../src/updater');
  const localRequire = createRequire(filename);
  const mockedModule = { exports: {} };
  runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: mockedModule, exports: mockedModule.exports,
    __dirname: require('node:path').dirname(filename), process,
    require: id => id === 'electron'
      ? { dialog: { showMessageBox: async () => ({ response: 0 }) } }
      : localRequire(id),
  }, { filename });
  const release = { version: '1.6.9', url: 'https://example.test/installer.dmg' };
  for (const first of ['prompt', 'settings']) {
    const manager = new mockedModule.exports.UpdateManager({
      app: { getVersion: () => '1.6.8' }, config: { get: () => null },
    });
    let downloads = 0, fetches = 0, finish;
    const pending = new Promise(resolve => { finish = resolve; });
    manager._fetchLatestRelease = async () => { fetches++; return release; };
    manager._downloadAndInstall = async value => {
      assert.equal(value, release); downloads++; await pending;
    };
    const prompt = () => manager._promptForUpdate(release);
    const settings = () => manager.installAvailableUpdate();
    const firstCall = first === 'prompt' ? prompt() : settings();
    await new Promise(resolve => setImmediate(resolve));
    const secondCall = first === 'prompt' ? settings() : prompt();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(downloads, 1, first);
    assert.equal(fetches, first === 'prompt' ? 0 : 1, 'reuse the prompted release');
    finish();
    await Promise.all([firstCall, secondCall]);
    assert.equal(manager._installingPromise, null);
  }
});

test('failed installation releases the shared lock for a later retry', async () => {
  const manager = new UpdateManager({ app: { getVersion: () => '1.6.8' }, config: { get: () => null } });
  const release = { version: '1.6.9', url: 'https://example.test/installer.dmg' };
  let attempts = 0;
  manager._downloadAndInstall = async () => { if (++attempts === 1) throw Error('fixture failure'); };
  await assert.rejects(manager.installAvailableUpdate(release), /fixture failure/);
  assert.equal(manager._installingPromise, null);
  assert.equal((await manager.installAvailableUpdate(release)).ok, true);
  assert.equal(attempts, 2);
});

test('compareVersions sorts semantic versions correctly', () => {
  assert.equal(compareVersions('1.5.1', '1.5.0') > 0, true);
  assert.equal(compareVersions('1.5.0', '1.5.0'), 0);
  assert.equal(compareVersions('1.4.9', '1.5.0') < 0, true);
  assert.equal(compareVersions('1.5.0', '1.5.0-beta.1') > 0, true);
});

test('parseGitHubRepository reads owner and repo from package metadata', () => {
  const parsed = parseGitHubRepository({
    repository: {
      type: 'git',
      url: 'https://github.com/nicecho/runshi.git',
    },
  });

  assert.deepEqual(parsed, { owner: 'nicecho', repo: 'runshi' });
});

test('parseManifestUrl derives version.json from homepage', () => {
  const parsed = parseManifestUrl({
    homepage: 'https://nicecho.github.io/runshi/',
  });

  assert.equal(parsed, 'https://nicecho.github.io/runshi/version.json');
});

test('mapManifestPayload selects the Windows x64 download', () => {
  const result = mapManifestPayload({
    version: '1.6.3',
    downloads: {
      'darwin-arm64': 'https://www.runshi.top/downloads/runshi-polis-1.6.3-arm64.dmg',
      'win32-x64': 'https://www.runshi.top/downloads/runshi-polis-setup-1.6.3.exe',
    },
  }, 'win32', 'x64');

  assert.equal(result.url, 'https://www.runshi.top/downloads/runshi-polis-setup-1.6.3.exe');
});

test('mapManifestPayload carries checksum and size for in-app installation', () => {
  const result = mapManifestPayload({
    version: '1.6.4',
    downloads: {
      'darwin-arm64': {
        url: 'https://www.runshi.top/downloads/runshi-polis-1.6.4-arm64.dmg',
        sha256: 'ABCDEF',
        size: 123456,
      },
    },
  }, 'darwin', 'arm64');

  assert.equal(result.url, 'https://www.runshi.top/downloads/runshi-polis-1.6.4-arm64.dmg');
  assert.equal(result.sha256, 'abcdef');
  assert.equal(result.size, 123456);
});

test('mapManifestPayload supports legacy string downloads with separate integrity metadata', () => {
  const result = mapManifestPayload({
    version: '1.6.4',
    downloads: {
      'win32-x64': 'https://www.runshi.top/downloads/runshi-polis-setup-1.6.4.exe',
    },
    sha256: {
      'win32-x64': 'A'.repeat(64),
    },
    sizes: {
      'win32-x64': 654321,
    },
  }, 'win32', 'x64');

  assert.equal(result.sha256, 'a'.repeat(64));
  assert.equal(result.size, 654321);
});

test('download metadata rejects invalid values without weakening URL selection', () => {
  assert.deepEqual(normalizeDownloadEntry(null), { url: '', sha256: '', size: 0 });
  assert.deepEqual(normalizeDownloadEntry('https://example.com/update.exe'), {
    url: 'https://example.com/update.exe',
    sha256: '',
    size: 0,
  });
});

test('mapManifestPayload falls back safely for legacy manifests', () => {
  const result = mapManifestPayload({ version: '1.6.2', pageUrl: 'https://www.runshi.top/' }, 'darwin', 'arm64');
  assert.equal(result.url, '');
  assert.equal(result.pageUrl, 'https://www.runshi.top/');
});

test('settings update action installs in-app instead of opening a webpage', () => {
  const fs = require('fs');
  const mainSource = fs.readFileSync(require.resolve('../main'), 'utf8');
  const preloadSource = fs.readFileSync(require.resolve('../preload'), 'utf8');
  const settingsSource = fs.readFileSync(require.resolve('../src/renderer/settings/script'), 'utf8');
  const settingsHtml = fs.readFileSync(require.resolve('../src/renderer/settings/index.html'), 'utf8');

  assert.match(mainSource, /updates:install/);
  assert.match(preloadSource, /installUpdate/);
  assert.match(settingsSource, /polishAPI\.installUpdate\(\)/);
  assert.doesNotMatch(settingsSource, /btnOpenLatestRelease/);
  assert.match(settingsHtml, /id="btnInstallUpdate"[^>]*>立即更新</);
});

test('macOS updater replaces the app bundle with native tools instead of recursively deleting app.asar', () => {
  const src = '/Volumes/RunshiUpdate/润石 PoliShit.app';
  const dest = '/Applications/润石 PoliShit.app';
  const existing = new Set([src, dest]);
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (command === '/usr/bin/ditto') existing.add(args.at(-1));
    if (command === '/bin/mv') {
      existing.delete(args[0]);
      existing.add(args[1]);
    }
    if (command === '/bin/rm') args.slice(1).forEach((item) => existing.delete(item));
  };

  const result = replaceMacAppBundle(src, dest, {
    run,
    exists: (item) => existing.has(item),
    nonce: 'test',
  });

  assert.equal(result.destination, dest);
  assert.equal(existing.has(dest), true);
  assert.equal(calls.some(([command]) => command === '/usr/bin/ditto'), true);
  assert.equal(calls.some(([command]) => command === '/bin/mv'), true);
  assert.equal(calls.some((call) => call.includes('/Applications/润石 PoliShit.app/Contents/Resources/app.asar')), false);
});

test('macOS updater rejects a target that is not an app bundle', () => {
  assert.throws(
    () => replaceMacAppBundle('/Volumes/RunshiUpdate/润石 PoliShit.app', '/Applications', { run: () => {} }),
    /目标应用路径无效/,
  );
});

test('trimReleaseNotes keeps the first non-empty lines only', () => {
  const result = trimReleaseNotes(`

  ## 更新内容

  - 修复浮窗定位
  - 增加版本检查

  - 优化设置页
  - 调整会员状态
  - 清理旧逻辑
  - 第七行
  - 第八行
  `);

  assert.match(result, /修复浮窗定位/);
  assert.equal(result.includes('第八行'), false);
});
