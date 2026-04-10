'use strict';

const { screen } = require('electron');
const { spawn } = require('child_process');

const isMac = process.platform === 'darwin';

const CHECK_SCRIPT = `
tell application "System Events"
  try
    set frontProcess to first process whose frontmost is true
    set bundleId to bundle identifier of frontProcess
    if bundleId is "com.runshi.app" then return "__SELF__"
    set focusedElement to focused UI element of frontProcess
    set selText to value of attribute "AXSelectedText" of focusedElement
    if selText is missing value then return ""
    return selText
  on error
    return ""
  end try
end tell
`;

/**
 * SelectionWatcher – monitors text selection in other apps via macOS Accessibility API.
 * On Windows, this watcher is a no-op (floating toolbar unavailable; use shortcut instead).
 */
class SelectionWatcher {
  constructor() {
    this._timer = null;
    this._pending = false;
    this._lastText = '';
    this._lastCursorPos = null;
    this._selectionCallback = null;
    this._clearCallback = null;
    this._enabled = true;
    this._paused = false;
  }

  start(onSelection, onClear) {
    if (!isMac) return; // Windows: no selection watching, use shortcut key instead
    this._selectionCallback = onSelection;
    this._clearCallback = onClear;
    this._startPolling();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  pause() {
    this._paused = true;
  }

  resume() {
    this._paused = false;
  }

  _startPolling() {
    this._timer = setInterval(() => this._check(), 400);
  }

  _check() {
    if (!this._enabled || this._paused || this._pending) return;
    this._pending = true;

    // Spawn osascript and feed script via stdin to avoid shell quoting issues
    const proc = spawn('osascript', ['-']);
    let stdout = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill();
    }, 2000);

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.on('close', () => {
      clearTimeout(timer);
      this._pending = false;
      if (killed) {
        this._maybeClear();
        return;
      }

      const text = stdout.trim();
      if (text === '__SELF__') return;

      if (text && text.length >= 2) {
        if (text !== this._lastText) {
          this._lastText = text;
          const cursorPos = screen.getCursorScreenPoint();
          this._lastCursorPos = cursorPos;
          if (this._selectionCallback) {
            this._selectionCallback({
              x: cursorPos.x,
              y: cursorPos.y,
              textLength: text.length,
            });
          }
        }
      } else {
        this._maybeClear();
      }
    });

    proc.stdin.write(CHECK_SCRIPT);
    proc.stdin.end();
  }

  _maybeClear() {
    if (this._lastText !== '') {
      this._lastText = '';
      this._lastCursorPos = null;
      if (this._clearCallback) {
        this._clearCallback();
      }
    }
  }
}

module.exports = SelectionWatcher;
