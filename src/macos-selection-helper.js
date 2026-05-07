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
    this.binaryPath = '';
    this._compileAttempted = false;
    this._compileFailed = false;
  }

  run(callback) {
    return this.runProbe(callback);
  }

  runProbe(callback) {
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
