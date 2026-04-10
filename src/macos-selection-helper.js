'use strict';

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

class MacOSSelectionHelper {
  constructor(options = {}) {
    this.selfPid = String(options.selfPid || process.pid);
    this.sourcePath = path.join(__dirname, '..', 'scripts', 'selection_probe.swift');
    this.binaryPath = path.join(app.getPath('userData'), 'selection-probe');
    this._compileAttempted = false;
    this._compileFailed = false;
  }

  run(callback) {
    if (!this._ensureBinary()) {
      return false;
    }

    execFile(
      this.binaryPath,
      [this.selfPid],
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
      fs.mkdirSync(path.dirname(this.binaryPath), { recursive: true });
      execFileSync(
        '/usr/bin/xcrun',
        ['swiftc', '-O', this.sourcePath, '-o', this.binaryPath],
        { timeout: 20000, stdio: 'pipe' },
      );
      fs.chmodSync(this.binaryPath, 0o755);
      return true;
    } catch (err) {
      this._compileFailed = true;
      console.error('Failed to compile macOS selection helper:', err.message);
      return false;
    }
  }

  _isBinaryCurrent() {
    try {
      const binaryStat = fs.statSync(this.binaryPath);
      const sourceStat = fs.statSync(this.sourcePath);
      return binaryStat.size > 0 && binaryStat.mtimeMs >= sourceStat.mtimeMs;
    } catch (_) {
      return false;
    }
  }
}

module.exports = MacOSSelectionHelper;
