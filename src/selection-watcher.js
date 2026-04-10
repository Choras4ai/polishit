'use strict';

const { screen } = require('electron');
const { execFile } = require('child_process');

const isMac = process.platform === 'darwin';

// Each line as a separate -e argument to avoid stdin encoding issues
const CHECK_ARGS = [
  '-e', 'tell application "System Events"',
  '-e', '  try',
  '-e', '    set fp to first process whose frontmost is true',
  '-e', '    set bid to bundle identifier of fp',
  '-e', '    if bid is "com.runshi.app" then return "__SELF__"',
  '-e', '    set fe to focused UI element of fp',
  '-e', '    set st to value of attribute "AXSelectedText" of fe',
  '-e', '    if st is missing value then return ""',
  '-e', '    return st',
  '-e', '  on error',
  '-e', '    return ""',
  '-e', '  end try',
  '-e', 'end tell',
];

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

    execFile('osascript', CHECK_ARGS, { timeout: 2000 }, (err, stdout) => {
      this._pending = false;

      if (err) {
        this._maybeClear();
        return;
      }

      const text = (stdout || '').trim();
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
