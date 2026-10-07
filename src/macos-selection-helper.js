'use strict';

const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

class MacOSSelectionHelper {
  constructor(options = {}) {
    this.selfPid = String(options.selfPid || process.pid);
    this.sourcePath = path.join(__dirname, '..', 'scripts', 'selection_probe.swift');
    this.binaryPath = app?.isPackaged
      ? path.join(process.resourcesPath, 'runshi-selection-probe')
      : '';
    this._compileAttempted = false;
    this._compileFailed = false;
    this._nativeAddon = this._loadNativeAddon();
  }

  run(callback) {
    return this.runProbe(callback);
  }

  runProbe(callback) {
    if (this._nativeAddon?.probe) {
      setImmediate(() => {
        try {
          callback(null, this._nativeAddon.probe(Number(this.selfPid)));
        } catch (err) {
          callback(err);
        }
      });
      return true;
    }
    return this._runCommand('probe', null, callback);
  }

  probe() {
    return new Promise((resolve, reject) => {
      const started = this.runProbe((err, payload) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(payload);
      });
      if (!started) {
        reject(new Error('macOS selection helper unavailable'));
      }
    });
  }

  setSelection(payload) {
    if (this._nativeAddon?.setSelection) {
      try {
        return Promise.resolve(this._nativeAddon.setSelection(payload));
      } catch (err) {
        return Promise.reject(err);
      }
    }
    return new Promise((resolve, reject) => {
      const started = this._runCommand('set-selection', payload, (err, result) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(result);
      });
      if (!started) {
        reject(new Error('macOS selection helper unavailable'));
      }
    });
  }

  reviewGeometry(payload) {
    // The legacy Swift probe cannot provide per-line geometry. Never substitute
    // the bounding box of the whole selection for individual revision ranges.
    if (!this._nativeAddon?.reviewGeometry) {
      return Promise.resolve({ ok: false, rects: [], reason: 'geometry-unavailable' });
    }
    try {
      return Promise.resolve(this._nativeAddon.reviewGeometry(payload));
    } catch (_) {
      return Promise.resolve({ ok: false, rects: [], reason: 'geometry-error' });
    }
  }

  applyReviewEdit(payload, replacement) {
    if (!this._nativeAddon?.applyReviewEdit) {
      return Promise.resolve({ ok: false, reason: 'direct-edit-unavailable' });
    }
    try {
      return Promise.resolve(this._nativeAddon.applyReviewEdit(payload, replacement));
    } catch (_) {
      // A native exception could occur after an editor processed the setter.
      return Promise.resolve({ ok: false, reason: 'direct-edit-error', sourceMayHaveChanged: true });
    }
  }

  snapshotClipboard() {
    return this._nativeAddon?.snapshotClipboard?.() ?? null;
  }

  restoreClipboard(snapshot) {
    return this._nativeAddon?.restoreClipboard?.(snapshot) === true;
  }

  clipboardChangeCount() {
    const value = this._nativeAddon?.clipboardChangeCount?.();
    return Number.isSafeInteger(value) ? value : null;
  }

  copySelection() {
    if (!this._nativeAddon?.copySelection) {
      return Promise.reject(new Error('WPS 选区复制功能不可用'));
    }
    try {
      const result = this._nativeAddon.copySelection();
      if (!result?.ok) {
        return Promise.reject(new Error(result?.error || 'WPS 选区复制失败'));
      }
      return Promise.resolve(result);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  getBackend() {
    return this._nativeAddon ? 'in-process-native' : 'external-helper';
  }

  _loadNativeAddon() {
    const addonPath = app?.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'native', 'bin', 'runshi_selection.node')
      : path.join(__dirname, '..', 'native', 'bin', 'runshi_selection.node');
    if (!fs.existsSync(addonPath)) return null;
    try {
      return require(addonPath);
    } catch (err) {
      console.error(`Failed to load in-process selection addon: ${err.message}`);
      return null;
    }
  }

  _runCommand(command, payload, callback) {
    if (!this._ensureBinary()) {
      return false;
    }

    const args = [this.selfPid, command];
    if (payload != null) {
      args.push(Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'));
    }

    execFile(
      this._getBinaryPath(),
      args,
      { timeout: 1500, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          callback(err);
          return;
        }

        const raw = (stdout || '').trim();
        if (!raw) {
          callback(null, null);
          return;
        }

        try {
          callback(null, JSON.parse(raw));
        } catch (parseErr) {
          callback(parseErr);
        }
      },
    );

    return true;
  }

  _ensureBinary() {
    if (this._compileFailed) return false;

    // Packaged builds ship a signed helper inside the app bundle so it shares
    // the app's stable macOS privacy identity. Never replace it at runtime.
    if (app?.isPackaged) {
      const available = fs.existsSync(this._getBinaryPath());
      if (!available) this._compileFailed = true;
      return available;
    }

    if (!fs.existsSync(this.sourcePath)) {
      this._compileFailed = true;
      return false;
    }

    if (this._isBinaryCurrent()) return true;
    if (this._compileAttempted) return false;
    this._compileAttempted = true;

    try {
      fs.mkdirSync(path.dirname(this._getBinaryPath()), { recursive: true });
      execFileSync(
        '/usr/bin/xcrun',
        ['swiftc', '-O', this.sourcePath, '-o', this._getBinaryPath()],
        { timeout: 20000, stdio: 'pipe' },
      );
      fs.chmodSync(this._getBinaryPath(), 0o755);
      return true;
    } catch (err) {
      this._compileFailed = true;
      console.error('Failed to compile macOS selection helper:', err.message);
      return false;
    }
  }

  _isBinaryCurrent() {
    try {
      const binaryStat = fs.statSync(this._getBinaryPath());
      const sourceStat = fs.statSync(this.sourcePath);
      return binaryStat.size > 0 && binaryStat.mtimeMs >= sourceStat.mtimeMs;
    } catch (_) {
      return false;
    }
  }

  _getBinaryPath() {
    if (this.binaryPath) return this.binaryPath;
    const baseDir = app && typeof app.getPath === 'function'
      ? app.getPath('userData')
      : path.join(os.tmpdir(), 'runshi-selection-helper');
    this.binaryPath = path.join(baseDir, 'selection-probe');
    return this.binaryPath;
  }
}

module.exports = MacOSSelectionHelper;
