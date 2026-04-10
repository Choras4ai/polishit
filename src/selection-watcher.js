'use strict';

const { BrowserWindow, clipboard, screen } = require('electron');
const { execFile } = require('child_process');
const MacOSSelectionHelper = require('./macos-selection-helper');

const isMac = process.platform === 'darwin';

function buildCheckArgs(selfPid) {
  return [
    '-e', 'tell application "System Events"',
    '-e', '  try',
    '-e', '    set fp to first process whose frontmost is true',
    '-e', '    set frontPid to (unix id of fp) as text',
    '-e', `    if frontPid is "${selfPid}" then return "__SELF__"`,
    '-e', '    set fe to focused UI element of fp',
    '-e', '    set st to value of attribute "AXSelectedText" of fe',
    '-e', '    if st is missing value then return ""',
    '-e', '    return st',
    '-e', '  on error',
    '-e', '    return ""',
    '-e', '  end try',
    '-e', 'end tell',
  ];
}

/**
 * SelectionWatcher – monitors text selection in other apps via macOS Accessibility API,
 * with a clipboard fallback so manual copy also triggers the floating toolbar.
 */
class SelectionWatcher {
  constructor(options = {}) {
    this._timer = null;
    this._pending = false;
    this._activeText = '';
    this._activeSource = null;
    this._lastCursorPos = null;
    this._lastClipboardText = '';
    this._selectionCallback = null;
    this._clearCallback = null;
    this._enabled = options.enabled !== false;
    this._paused = false;
    this._checkArgs = buildCheckArgs(String(options.selfPid || process.pid));
    this._selectionHelper = isMac
      ? new MacOSSelectionHelper({ selfPid: options.selfPid || process.pid })
      : null;
    this._activeBoundsKey = '';
  }

  start(onSelection, onClear) {
    this._selectionCallback = onSelection;
    this._clearCallback = onClear;
    this._lastClipboardText = this._readClipboardText();
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
    this._lastClipboardText = this._readClipboardText();
  }

  setEnabled(enabled) {
    this._enabled = Boolean(enabled);
    if (!this._enabled) {
      this._clearState();
    }
  }

  _startPolling() {
    if (this._timer) return;
    this._timer = setInterval(() => this._check(), 400);
  }

  _check() {
    if (!this._enabled || this._paused) return;

    this._checkClipboard();

    if (!isMac || this._pending) return;
    this._pending = true;

    if (this._selectionHelper?.run((err, payload) => {
      this._pending = false;

      if (err || !payload) {
        this._checkWithAppleScriptFallback();
        return;
      }

      if (payload.trusted === false) {
        this._maybeClear('selection');
        return;
      }

      this._handleSelectionPayload(payload);
    })) {
      return;
    }

    this._checkWithAppleScriptFallback();
  }

  _checkClipboard() {
    if (BrowserWindow.getFocusedWindow()) return;

    const rawText = this._readClipboardText();
    if (rawText === this._lastClipboardText) return;

    this._lastClipboardText = rawText;
    const text = this._normalizeText(rawText);

    if (this._isTriggerableText(text)) {
      this._emitSelection(text, 'clipboard', null);
    } else {
      this._maybeClear('clipboard');
    }
  }

  _checkWithAppleScriptFallback() {
    this._pending = true;
    execFile('osascript', this._checkArgs, { timeout: 2000 }, (err, stdout) => {
      this._pending = false;

      if (err) {
        this._maybeClear('selection');
        return;
      }

      const text = this._normalizeText(stdout);
      if (text === '__SELF__') return;

      if (this._isTriggerableText(text)) {
        this._emitSelection(text, 'selection', null);
      } else {
        this._maybeClear('selection');
      }
    });
  }

  _handleSelectionPayload(payload) {
    const text = this._normalizeText(payload.text);
    if (text === '__SELF__') return;

    if (this._isTriggerableText(text)) {
      const selectionBounds = this._normalizeBounds(payload.selectionBounds);
      const elementBounds = this._normalizeBounds(payload.elementBounds);
      this._emitSelection(text, 'selection', selectionBounds, elementBounds);
    } else {
      this._maybeClear('selection');
    }
  }

  _emitSelection(text, source, bounds, fieldBounds = null) {
    const cursorPos = screen.getCursorScreenPoint();
    const validBounds = this._isBoundsNearPoint(bounds, cursorPos) ? bounds : null;
    const validFieldBounds = this._isBoundsNearPoint(fieldBounds, cursorPos, 320) ? fieldBounds : null;
    const boundsKey = this._createBoundsKey(validBounds);
    if (
      text === this._activeText
      && source === this._activeSource
      && boundsKey === this._activeBoundsKey
    ) {
      return;
    }
    this._activeText = text;
    this._activeSource = source;
    this._activeBoundsKey = boundsKey;
    this._lastCursorPos = cursorPos;
    if (this._selectionCallback) {
      this._selectionCallback({
        x: cursorPos.x,
        y: cursorPos.y,
        text,
        textLength: text.length,
        source,
        bounds: validBounds,
        fieldBounds: validFieldBounds,
      });
    }
  }

  _maybeClear(source) {
    if (source && this._activeSource && source !== this._activeSource) return;
    this._clearState();
  }

  _clearState() {
    if (this._activeText !== '' || this._activeSource) {
      this._activeText = '';
      this._activeSource = null;
      this._activeBoundsKey = '';
      this._lastCursorPos = null;
      if (this._clearCallback) {
        this._clearCallback();
      }
    }
  }

  _readClipboardText() {
    try {
      return clipboard.readText();
    } catch (_) {
      return '';
    }
  }

  _normalizeText(text) {
    return (text || '').trim();
  }

  _isTriggerableText(text) {
    return Boolean(text && text.length >= 2);
  }

  _normalizeBounds(bounds) {
    if (!bounds) return null;
    const x = Number(bounds.x);
    const y = Number(bounds.y);
    const width = Number(bounds.width);
    const height = Number(bounds.height);
    if (![x, y, width, height].every(Number.isFinite)) return null;
    return {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
    };
  }

  _createBoundsKey(bounds) {
    if (!bounds) return '';
    return `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
  }

  _isBoundsNearPoint(bounds, point, tolerance = 160) {
    if (!bounds || !point) return false;
    const minX = bounds.x - tolerance;
    const maxX = bounds.x + bounds.width + tolerance;
    const minY = bounds.y - tolerance;
    const maxY = bounds.y + bounds.height + tolerance;
    return point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY;
  }
}

module.exports = SelectionWatcher;
