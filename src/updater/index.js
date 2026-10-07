'use strict';

const fs = require('fs');
const { app: electronApp, dialog, shell, BrowserWindow } = require('electron');
const path = require('path');
const { downloadVerifiedFile } = require('./download');
const { launchWindowsInstaller } = require('./windows-installer');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const PACKAGE_JSON = require(path.join(ROOT, 'package.json'));
const DEFAULT_REPOSITORY = 'Choras4ai/polishit';
const LOCAL_MANIFEST_PATH = path.join(ROOT, 'docs', 'version.json');
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 8 * 1000;

function normalizeVersion(version) {
  return String(version || '')
    .trim()
    .replace(/^v/i, '');
}

function parseVersion(version) {
  const normalized = normalizeVersion(version);
  const [core, preRelease = ''] = normalized.split('+', 1)[0].split('-', 2);
  const parts = core
    .split('.')
    .map((item) => Number.parseInt(item, 10))
    .map((item) => (Number.isFinite(item) ? item : 0));

  while (parts.length < 3) {
    parts.push(0);
  }

  return {
    raw: normalized,
    parts,
    preRelease,
  };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);

  for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i += 1) {
    const delta = (a.parts[i] || 0) - (b.parts[i] || 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }

  if (!a.preRelease && b.preRelease) return 1;
  if (a.preRelease && !b.preRelease) return -1;
  if (!a.preRelease && !b.preRelease) return 0;

  // Semver-compliant pre-release comparison: split by '.' and compare segments
  const aPre = a.preRelease.split('.');
  const bPre = b.preRelease.split('.');
  for (let i = 0; i < Math.max(aPre.length, bPre.length); i += 1) {
    if (aPre[i] === undefined) return -1;
    if (bPre[i] === undefined) return 1;
    const aNum = Number(aPre[i]);
    const bNum = Number(bPre[i]);
    if (Number.isFinite(aNum) && Number.isFinite(bNum)) {
      if (aNum !== bNum) return aNum > bNum ? 1 : -1;
    } else {
      if (Number.isFinite(aNum) !== Number.isFinite(bNum)) return Number.isFinite(aNum) ? -1 : 1;
      const cmp = String(aPre[i]).localeCompare(String(bPre[i]));
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

function parseGitHubRepository(packageJson = PACKAGE_JSON) {
  const override = process.env.RUNSHI_UPDATE_REPOSITORY || packageJson?.runshi?.updates?.githubRepository || '';
  if (override) {
    const [owner, repo] = String(override).split('/', 2);
    if (owner && repo) {
      return { owner, repo };
    }
  }

  const repository = packageJson.repository;
  const raw = typeof repository === 'string'
    ? repository
    : (repository?.url || packageJson.homepage || '');
  const match = String(raw).match(/github\.com[:/](.+?)\/(.+?)(?:\.git)?(?:#.*)?$/i);

  if (match) {
    return {
      owner: match[1],
      repo: match[2],
    };
  }

  const [owner, repo] = DEFAULT_REPOSITORY.split('/');
  return { owner, repo };
}

function parseManifestUrl(packageJson = PACKAGE_JSON) {
  const override = process.env.RUNSHI_UPDATE_MANIFEST_URL || packageJson?.runshi?.updates?.manifestUrl || '';
  if (override) {
    return String(override).trim();
  }

  const homepage = String(packageJson.homepage || '').trim().replace(/\/+$/, '');
  if (!homepage) return '';
  return `${homepage}/version.json`;
}

function trimReleaseNotes(body) {
  const text = String(body || '').trim();
  if (!text) return '';
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(0, 6).join('\n').slice(0, 400);
}

function pickAssetUrl(release, platform, arch) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  if (assets.length === 0) return '';

  const lowerArch = String(arch || '').toLowerCase();
  const platformMatchers = platform === 'darwin'
    ? ['.dmg']
    : platform === 'win32'
      ? ['.exe']
      : ['.appimage', '.deb', '.rpm', '.zip', '.tar.gz'];

  const normalized = assets.map((asset) => ({
    name: String(asset?.name || '').toLowerCase(),
    url: asset?.browser_download_url || '',
  }));

  const exact = normalized.find((asset) => (
    platformMatchers.some((suffix) => asset.name.endsWith(suffix))
    && (!lowerArch || asset.name.includes(lowerArch))
  ));
  if (exact?.url) return exact.url;

  const fallback = normalized.find((asset) => platformMatchers.some((suffix) => asset.name.endsWith(suffix))
    && (platform === 'darwin' ? /(?:^|[-_. ])universal(?:[-_. ]|$)/.test(asset.name)
      : platform === 'win32' && lowerArch === 'x64' && !/(?:arm64|aarch64|x86|ia32|amd64|x64)/.test(asset.name)));
  return fallback?.url || '';
}

function mapReleasePayload(payload, platform, arch) {
  const version = normalizeVersion(payload?.tag_name || payload?.name || '');
  const url = pickAssetUrl(payload, platform, arch);
  const asset = (payload?.assets || []).find(item => item.browser_download_url === url);
  return {
    version,
    name: payload?.name || version,
    url,
    sha256: String(asset?.digest || '').replace(/^sha256:/, '').toLowerCase(),
    size: Number(asset?.size) || 0,
    pageUrl: payload?.html_url || '',
    notes: trimReleaseNotes(payload?.body),
    publishedAt: payload?.published_at || '',
  };
}

function normalizeDownloadEntry(entry) {
  if (typeof entry === 'string') {
    return { url: entry, sha256: '', size: 0 };
  }
  if (!entry || typeof entry !== 'object') {
    return { url: '', sha256: '', size: 0 };
  }
  const size = Number(entry.size);
  return {
    url: String(entry.url || entry.downloadUrl || ''),
    sha256: String(entry.sha256 || '').trim().toLowerCase(),
    size: Number.isSafeInteger(size) && size > 0 ? size : 0,
  };
}

function assertMacAppBundlePath(bundlePath, label = '应用路径') {
  const resolved = path.resolve(String(bundlePath || ''));
  if (!path.isAbsolute(resolved) || resolved === '/' || !resolved.endsWith('.app')) {
    throw new Error(`${label}无效，已取消安装。`);
  }
  return resolved;
}

function replaceMacAppBundle(srcApp, destApp, options = {}) {
  const run = options.run || execFileSync;
  const exists = options.exists || fs.existsSync;
  const nonce = String(options.nonce || `${process.pid}-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '');
  const source = assertMacAppBundlePath(srcApp, '更新包路径');
  const destination = assertMacAppBundlePath(destApp, '目标应用路径');
  const destinationDir = path.dirname(destination);
  const baseName = path.basename(destination, '.app');
  const staged = path.join(destinationDir, `.${baseName}.update-${nonce}.app`);
  const backup = path.join(destinationDir, `.${baseName}.backup-${nonce}.app`);
  const commandOptions = { stdio: 'ignore' };

  // Electron patches Node's fs APIs for ASAR archives. Recursively deleting the
  // running bundle with fs.rmSync can therefore treat app.asar as a directory.
  // Native macOS tools do not have that virtual-filesystem behaviour.
  run('/bin/rm', ['-rf', staged, backup], commandOptions);

  try {
    run('/usr/bin/ditto', ['--rsrc', '--extattr', source, staged], commandOptions);
    if (exists(destination)) {
      run('/bin/mv', [destination, backup], commandOptions);
    }
    run('/bin/mv', [staged, destination], commandOptions);
  } catch (err) {
    try { run('/bin/rm', ['-rf', staged], commandOptions); } catch (_) {}
    if (!exists(destination) && exists(backup)) {
      try { run('/bin/mv', [backup, destination], commandOptions); } catch (_) {}
    }
    throw err;
  }

  try { run('/bin/rm', ['-rf', backup], commandOptions); } catch (_) {}
  return { destination, staged, backup };
}

function mapManifestPayload(payload, platform = process.platform, arch = process.arch) {
  const downloads = payload?.downloads || {};
  const checksums = payload?.sha256 || payload?.checksums || {};
  const sizes = payload?.sizes || {};
  const platformArchKey = `${platform}-${arch}`;
  const platformEntry = downloads[platformArchKey]
    || downloads[platform]
    || payload?.downloadUrl
    || payload?.download_url
    || '';
  const download = normalizeDownloadEntry(platformEntry);
  const legacyChecksum = typeof checksums === 'object' && checksums
    ? checksums[platformArchKey] || checksums[platform] || ''
    : '';
  const legacySize = typeof sizes === 'object' && sizes
    ? Number(sizes[platformArchKey] || sizes[platform] || 0)
    : 0;
  return {
    version: normalizeVersion(payload?.version || payload?.tagName || payload?.tag_name || ''),
    name: payload?.name || payload?.version || '',
    url: download.url,
    sha256: download.sha256 || String(legacyChecksum).trim().toLowerCase(),
    size: download.size || (Number.isSafeInteger(legacySize) && legacySize > 0 ? legacySize : 0),
    pageUrl: payload?.pageUrl || payload?.page_url || payload?.url || '',
    notes: trimReleaseNotes(payload?.notes || payload?.body || ''),
    publishedAt: payload?.publishedAt || payload?.published_at || '',
  };
}

class UpdateManager {
  constructor({ app, config }) {
    this.app = app;
    this.config = config;
    this.source = parseGitHubRepository();
    this.manifestUrl = parseManifestUrl();
    this.state = {
      checking: false,
      currentVersion: app.getVersion(),
      latestVersion: '',
      latestName: '',
      hasUpdate: false,
      checkedAt: '',
      publishedAt: '',
      downloadUrl: '',
      releasePageUrl: '',
      releaseNotes: '',
      lastError: '',
      skippedVersion: String(config.get('updates.skippedVersion') || ''),
      source: '',
    };
    this._startupTimer = null;
    this._interval = null;
    this._lastPromptedVersion = '';
    this._installingPromise = null;
  }

  start() {
    clearTimeout(this._startupTimer);
    clearInterval(this._interval);
    this._startupTimer = setTimeout(() => {
      this.checkForUpdates({ silent: true }).catch(() => {});
    }, STARTUP_DELAY_MS);
    this._interval = setInterval(() => {
      this.checkForUpdates({ silent: true }).catch(() => {});
    }, CHECK_INTERVAL_MS);
  }

  stop() {
    clearTimeout(this._startupTimer);
    clearInterval(this._interval);
    this._startupTimer = null;
    this._interval = null;
  }

  getStatus() {
    const persisted = this.config.get('updates') || {};
    return {
      enabled: true,
      source: this.state.source || persisted.source || this._defaultSourceLabel(),
      currentVersion: this.state.currentVersion,
      latestVersion: this.state.latestVersion || persisted.latestVersion || '',
      latestName: this.state.latestName || persisted.latestName || '',
      hasUpdate: compareVersions(this.state.latestVersion || persisted.latestVersion || '', this.state.currentVersion) > 0,
      checkedAt: this.state.checkedAt || persisted.lastCheckedAt || '',
      publishedAt: this.state.publishedAt || persisted.publishedAt || '',
      downloadUrl: this.state.downloadUrl || persisted.downloadUrl || '',
      releasePageUrl: this.state.releasePageUrl || persisted.releasePageUrl || '',
      releaseNotes: this.state.releaseNotes || persisted.releaseNotes || '',
      lastError: this.state.lastError || persisted.lastError || '',
      checking: this.state.checking,
      skippedVersion: this.state.skippedVersion || persisted.skippedVersion || '',
    };
  }

  async openLatestRelease() {
    const status = this.getStatus();
    const target = status.downloadUrl || status.releasePageUrl;
    if (!target) {
      const err = new Error('当前没有可打开的更新地址。');
      err.status = 404;
      throw err;
    }
    if (new URL(target).protocol !== 'https:') throw new Error('更新页面必须通过 HTTPS 打开。');
    await shell.openExternal(target);
    return status;
  }

  async installAvailableUpdate(knownRelease = null) {
    if (this._installingPromise) return this._installingPromise;

    this._installingPromise = (async () => {
      const release = knownRelease || await this._fetchLatestRelease();
      if (!release.version || compareVersions(release.version, this.state.currentVersion) <= 0) {
        throw new Error('当前已经是最新版本。');
      }
      if (!release.url) {
        throw new Error('当前系统的安装包尚未发布，请稍后重试。');
      }
      await this._downloadAndInstall(release);
      return { ok: true, version: release.version };
    })().finally(() => {
      this._installingPromise = null;
    });

    return this._installingPromise;
  }

  async checkForUpdates(options = {}) {
    const { silent = false, force = false } = options;
    const persisted = this.config.get('updates') || {};
    const lastCheckedAt = Date.parse(persisted.lastCheckedAt || '');
    if (!force && Number.isFinite(lastCheckedAt) && (Date.now() - lastCheckedAt) < CHECK_INTERVAL_MS) {
      return this.getStatus();
    }

    this.state.checking = true;
    this.state.lastError = '';

    try {
      const release = await this._fetchLatestRelease();
      const hasUpdate = Boolean(release.version) && compareVersions(release.version, this.state.currentVersion) > 0;
      const checkedAt = new Date().toISOString();

      this.state = {
        ...this.state,
        checking: false,
        source: release.source,
        latestVersion: release.version,
        latestName: release.name,
        hasUpdate,
        checkedAt,
        publishedAt: release.publishedAt,
        downloadUrl: release.url,
        releasePageUrl: release.pageUrl,
        releaseNotes: release.notes,
        lastError: '',
      };

      this._persistState();

      if (hasUpdate && (force || this.state.skippedVersion !== release.version)) {
        await this._promptForUpdate(release, { force });
      }

      return this.getStatus();
    } catch (err) {
      this.state.checking = false;
      this.state.lastError = err.message;
      this._persistState();
      if (!silent) {
        throw err;
      }
      return this.getStatus();
    }
  }

  async _fetchLatestRelease() {
    if (!this.app.isPackaged && fs.existsSync(LOCAL_MANIFEST_PATH)) {
      const payload = JSON.parse(fs.readFileSync(LOCAL_MANIFEST_PATH, 'utf8'));
      return {
        ...mapManifestPayload(payload, process.platform, process.arch),
        source: `local:${path.relative(ROOT, LOCAL_MANIFEST_PATH)}`,
      };
    }

    if (this.manifestUrl) {
      try {
        const response = await fetch(this.manifestUrl, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': `Runshi-Desktop/${this.state.currentVersion}`,
          },
          signal: AbortSignal.timeout(15000),
        });
        const payload = await response.json().catch(() => ({}));
        if (response.ok && /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(payload.version || '')) {
          return {
            ...mapManifestPayload(payload, process.platform, process.arch),
            source: `manifest:${this.manifestUrl}`,
          };
        }
      } catch (_) {
        // Fall through to GitHub Releases.
      }
    }

    const apiUrl = `https://api.github.com/repos/${this.source.owner}/${this.source.repo}/releases/latest`;
    const response = await fetch(apiUrl, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': `Runshi-Desktop/${this.state.currentVersion}`,
      },
      signal: AbortSignal.timeout(15000),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(
        response.status === 404
          ? `更新源不存在，请先发布 ${this.manifestUrl || `github:${this.source.owner}/${this.source.repo}`}。`
          : (payload?.message || `检查更新失败 (${response.status})`),
      );
      err.status = response.status;
      throw err;
    }

    return {
      ...mapReleasePayload(payload, process.platform, process.arch),
      source: `github:${this.source.owner}/${this.source.repo}`,
    };
  }

  async _promptForUpdate(release, { force = false } = {}) {
    if (!release.version) return;
    if (!force && this._lastPromptedVersion === release.version) return;

    this._lastPromptedVersion = release.version;

    const buttons = ['立即更新', '稍后提醒', '忽略此版本'];
    const detailLines = [
      `当前版本：v${this.state.currentVersion}`,
      `最新版本：v${release.version}`,
    ];
    if (release.publishedAt) {
      detailLines.push(`发布时间：${new Date(release.publishedAt).toLocaleString('zh-CN', { hour12: false })}`);
    }
    if (release.notes) {
      detailLines.push('', release.notes);
    }

    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons,
      defaultId: 0,
      cancelId: 1,
      title: '发现新版本',
      message: `润石 PoliShit v${release.version} 已发布`,
      detail: detailLines.join('\n'),
      noLink: true,
    });

    if (response === 0) {
      await this.installAvailableUpdate(release);
      return;
    }

    if (response === 2) {
      this.state.skippedVersion = release.version;
      this.config.set('updates.skippedVersion', release.version);
    }
  }

  async _downloadAndInstall(release, retryState = null) {
    const url = release.url;
    if (!url) {
      throw new Error('当前系统的安装包尚未发布，请稍后重试。');
    }

    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'https:') {
      throw new Error('为保障安全，更新安装包必须通过 HTTPS 下载。');
    }
    const expectedExtension = process.platform === 'darwin' ? '.dmg' : process.platform === 'win32' ? '.exe' : '';
    if (!expectedExtension || !parsedUrl.pathname.toLowerCase().endsWith(expectedExtension)) {
      throw new Error('更新清单中的安装包格式与当前系统不匹配。');
    }

    // Show progress window
    let progressWin = new BrowserWindow({
      width: 400,
      height: 140,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    const progressReady = progressWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
      <!DOCTYPE html><html><head><meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 22px; background: #f6fbf8; color: #173228; -webkit-app-region: drag; }
        .title { font-size: 14px; font-weight: 650; margin-bottom: 14px; color: #173228; }
        .bar { height: 7px; border-radius: 999px; background: #dcebe4; overflow: hidden; }
        .fill { height: 100%; border-radius: inherit; background: linear-gradient(90deg, #0f8f68, #4a7c6b); width: 0%; transition: width 0.25s ease; }
        .status { font-size: 12px; margin-top: 9px; color: #597368; }
      </style></head><body>
        <div class="title">正在下载更新...</div>
        <div class="bar"><div class="fill" id="fill"></div></div>
        <div class="status" id="status">准备中...</div>
        <script>
          window.setProgress = (pct, text) => {
            document.getElementById('fill').style.width = pct + '%';
            document.getElementById('status').textContent = text;
          };
        </script>
      </body></html>
    `)}`);
    const tmpDir = electronApp.getPath('temp') || require('os').tmpdir();
    const state = retryState || (() => {
      const downloadDir = fs.mkdtempSync(path.join(tmpDir, 'runshi-update-'));
      const filePath = path.join(downloadDir, `installer${expectedExtension}`);
      return { downloadDir, filePath, partialPath: `${filePath}.part` };
    })();

    try {
      await progressReady;
      const { filePath, partialPath } = state;
      // Revalidate and reuse the completed installer after an installation error.
      const downloadPath = fs.existsSync(filePath) ? filePath : partialPath;
      await downloadVerifiedFile(url, downloadPath, {
        sha256: release.sha256,
        size: release.size,
        userAgent: `Runshi-Desktop/${this.state.currentVersion}`,
        resume: true,
        onProgress(received, total) {
          if (progressWin.isDestroyed()) return;
          const pct = total ? Math.min(99, Math.round(received / total * 100)) : 0;
          const label = `${(received / 1048576).toFixed(1)} MB / ${total ? (total / 1048576).toFixed(1) : '?'} MB`;
          progressWin.webContents.executeJavaScript(`window.setProgress(${pct}, ${JSON.stringify(label)})`).catch(() => {});
        },
      });

      if (downloadPath !== filePath) fs.renameSync(partialPath, filePath);

      try {
        progressWin.webContents.executeJavaScript(
          `window.setProgress(100, '下载完成，正在安装...')`,
        ).catch(() => {});
      } catch (_) {}

      // Install
      if (process.platform === 'darwin' && filePath.endsWith('.dmg')) {
        // Mount DMG, copy .app, unmount, restart
        await this._installDmg(filePath);
      } else if (process.platform === 'win32' && filePath.endsWith('.exe')) {
        // Run installer silently and quit
        await launchWindowsInstaller(filePath);
        electronApp.quit();
      } else {
        // Fallback: open the downloaded file
        await shell.openPath(filePath);
        electronApp.quit();
      }
    } catch (err) {
      if (progressWin && !progressWin.isDestroyed()) progressWin.close();
      const { response: retry } = await dialog.showMessageBox({
        type: 'error',
        buttons: ['重试', '取消'],
        title: '更新失败',
        message: `下载安装失败：${err.message}`,
      });
      if (retry === 0) return await this._downloadAndInstall(release, retryState || state);
      throw err;
    } finally {
      if (!progressWin.isDestroyed()) progressWin.close();
    }
  }

  async _installDmg(dmgPath) {
    const mountPoint = fs.mkdtempSync(path.join(electronApp.getPath('temp'), 'runshi-mount-'));

    try {
      // Mount DMG
      execFileSync('hdiutil', ['attach', dmgPath, '-mountpoint', mountPoint, '-nobrowse', '-quiet']);

      // Find .app in mounted DMG
      const items = fs.readdirSync(mountPoint);
      const appName = items.find(i => i.endsWith('.app'));
      if (!appName) throw new Error('DMG 中未找到 .app');

      const srcApp = path.join(mountPoint, appName);
      const currentBundle = path.resolve(path.dirname(electronApp.getPath('exe')), '..', '..');
      const canReplaceCurrentBundle = currentBundle.endsWith('.app') && !currentBundle.startsWith('/Volumes/');
      const destApp = canReplaceCurrentBundle ? currentBundle : path.join('/Applications', appName);

      // Stage and atomically replace the bundle using native tools. This avoids
      // Electron's ASAR fs shim interpreting app.asar as a real directory.
      replaceMacAppBundle(srcApp, destApp);

      // Unmount
      try { execFileSync('hdiutil', ['detach', mountPoint, '-quiet'], { stdio: 'ignore' }); } catch (_) {}

      // Relaunch
      electronApp.relaunch({ execPath: path.join(destApp, 'Contents', 'MacOS', appName.replace('.app', '')) });
      electronApp.quit();
    } catch (err) {
      try { execFileSync('hdiutil', ['detach', mountPoint, '-force'], { stdio: 'ignore' }); } catch (_) {}
      throw err;
    } finally {
      try { fs.rmdirSync(mountPoint); } catch (_) {}
    }
  }

  _persistState() {
    this.config.set('updates.source', this.state.source || this._defaultSourceLabel());
    this.config.set('updates.lastCheckedAt', this.state.checkedAt || '');
    this.config.set('updates.latestVersion', this.state.latestVersion || '');
    this.config.set('updates.latestName', this.state.latestName || '');
    this.config.set('updates.hasUpdate', Boolean(this.state.hasUpdate));
    this.config.set('updates.publishedAt', this.state.publishedAt || '');
    this.config.set('updates.downloadUrl', this.state.downloadUrl || '');
    this.config.set('updates.releasePageUrl', this.state.releasePageUrl || '');
    this.config.set('updates.releaseNotes', this.state.releaseNotes || '');
    this.config.set('updates.lastError', this.state.lastError || '');
    this.config.set('updates.skippedVersion', this.state.skippedVersion || '');
  }

  _defaultSourceLabel() {
    if (this.manifestUrl) return `manifest:${this.manifestUrl}`;
    return `github:${this.source.owner}/${this.source.repo}`;
  }
}

module.exports = {
  UpdateManager,
  compareVersions,
  mapManifestPayload,
  mapReleasePayload,
  normalizeDownloadEntry,
  normalizeVersion,
  parseGitHubRepository,
  parseManifestUrl,
  replaceMacAppBundle,
  trimReleaseNotes,
};
