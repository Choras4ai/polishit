'use strict';

const fs = require('fs');
const { app: electronApp, dialog, shell, BrowserWindow } = require('electron');
const path = require('path');
const { execFile } = require('child_process');

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
  const [core, preRelease = ''] = normalized.split('-', 2);
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

  return a.preRelease.localeCompare(b.preRelease);
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
    ? ['.dmg', '.zip']
    : platform === 'win32'
      ? ['.exe', '.msi']
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

  const fallback = normalized.find((asset) => platformMatchers.some((suffix) => asset.name.endsWith(suffix)));
  return fallback?.url || '';
}

function mapReleasePayload(payload, platform, arch) {
  const version = normalizeVersion(payload?.tag_name || payload?.name || '');
  return {
    version,
    name: payload?.name || version,
    url: pickAssetUrl(payload, platform, arch) || payload?.html_url || '',
    pageUrl: payload?.html_url || '',
    notes: trimReleaseNotes(payload?.body),
    publishedAt: payload?.published_at || '',
  };
}

function mapManifestPayload(payload) {
  return {
    version: normalizeVersion(payload?.version || payload?.tagName || payload?.tag_name || ''),
    name: payload?.name || payload?.version || '',
    url: payload?.downloadUrl || payload?.download_url || '',
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
      hasUpdate: Boolean(this.state.hasUpdate ?? persisted.hasUpdate),
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
    await shell.openExternal(target);
    return status;
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
        ...mapManifestPayload(payload),
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
        if (response.ok) {
          return {
            ...mapManifestPayload(payload),
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
      await this._downloadAndInstall(release);
      return;
    }

    if (response === 2) {
      this.state.skippedVersion = release.version;
      this.config.set('updates.skippedVersion', release.version);
    }
  }

  async _downloadAndInstall(release) {
    const url = release.url;
    if (!url) {
      await this.openLatestRelease();
      return;
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
    progressWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
      <!DOCTYPE html><html><head><meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 20px; background: #1e1e1e; color: #ccc; -webkit-app-region: drag; }
        .title { font-size: 14px; font-weight: 600; margin-bottom: 12px; color: #fff; }
        .bar { height: 6px; border-radius: 3px; background: #333; overflow: hidden; }
        .fill { height: 100%; background: #0078d4; width: 0%; transition: width 0.3s; }
        .status { font-size: 12px; margin-top: 8px; color: #888; }
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

    try {
      const tmpDir = electronApp.getPath('temp') || require('os').tmpdir();
      const fileName = path.basename(new URL(url).pathname) || (process.platform === 'darwin' ? 'update.dmg' : 'update.exe');
      const filePath = path.join(tmpDir, fileName);

      // Download with progress
      const response = await fetch(url, {
        headers: { 'User-Agent': `Runshi-Desktop/${this.state.currentVersion}` },
        signal: AbortSignal.timeout(300000), // 5 min timeout
      });

      if (!response.ok) throw new Error(`下载失败 (${response.status})`);

      const totalBytes = Number(response.headers.get('content-length')) || 0;
      const reader = response.body.getReader();
      const chunks = [];
      let receivedBytes = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        receivedBytes += value.length;
        const pct = totalBytes > 0 ? Math.round(receivedBytes / totalBytes * 100) : 0;
        const mb = (receivedBytes / 1048576).toFixed(1);
        const totalMb = totalBytes > 0 ? (totalBytes / 1048576).toFixed(1) : '?';
        try {
          progressWin.webContents.executeJavaScript(
            `window.setProgress(${pct}, '${mb} MB / ${totalMb} MB')`,
          );
        } catch (_) {}
      }

      // Write file
      const buffer = Buffer.concat(chunks);
      fs.writeFileSync(filePath, buffer);

      try {
        progressWin.webContents.executeJavaScript(
          `window.setProgress(100, '下载完成，正在安装...')`,
        );
      } catch (_) {}

      // Install
      if (process.platform === 'darwin' && filePath.endsWith('.dmg')) {
        // Mount DMG, copy .app, unmount, restart
        await this._installDmg(filePath);
      } else if (process.platform === 'win32' && filePath.endsWith('.exe')) {
        // Run installer silently and quit
        execFile(filePath, ['/S', '--force-run'], { detached: true, stdio: 'ignore' });
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
        buttons: ['前往手动下载', '取消'],
        title: '更新失败',
        message: `下载安装失败：${err.message}`,
      });
      if (retry === 0) await this.openLatestRelease();
    }
  }

  async _installDmg(dmgPath) {
    const { execSync } = require('child_process');
    const mountPoint = '/Volumes/RunshiUpdate';

    try {
      // Unmount if already mounted
      try { execSync(`hdiutil detach "${mountPoint}" -force 2>/dev/null`); } catch (_) {}

      // Mount DMG
      execSync(`hdiutil attach "${dmgPath}" -mountpoint "${mountPoint}" -nobrowse -quiet`);

      // Find .app in mounted DMG
      const items = fs.readdirSync(mountPoint);
      const appName = items.find(i => i.endsWith('.app'));
      if (!appName) throw new Error('DMG 中未找到 .app');

      const srcApp = path.join(mountPoint, appName);
      const destApp = path.join('/Applications', appName);

      // Remove old app and copy new one
      execSync(`rm -rf "${destApp}"`);
      execSync(`cp -R "${srcApp}" "${destApp}"`);

      // Unmount
      try { execSync(`hdiutil detach "${mountPoint}" -quiet`); } catch (_) {}

      // Relaunch
      electronApp.relaunch({ execPath: path.join(destApp, 'Contents', 'MacOS', appName.replace('.app', '')) });
      electronApp.quit();
    } catch (err) {
      try { execSync(`hdiutil detach "${mountPoint}" -force 2>/dev/null`); } catch (_) {}
      throw err;
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
  normalizeVersion,
  parseGitHubRepository,
  parseManifestUrl,
  trimReleaseNotes,
};
