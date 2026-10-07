'use strict';

const { BrowserWindow, clipboard, screen } = require('electron');
const { execFile } = require('child_process');
const MacOSSelectionHelper = require('./macos-selection-helper');
const { isOwnBundleIdentifier } = require('./app-identity');
const { probeWordSelectionContext } = require('./capture');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
const WORD_BUNDLE_ID = 'com.microsoft.Word';
const WPS_BUNDLE_ID = 'com.kingsoft.wpsoffice.mac';

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
    this._selfPid = Number(options.selfPid || process.pid);
    this._timer = null;
    this._pending = false;
    this._activeText = '';
    this._activeSource = null;
    this._activeContextKey = '';
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
    this._lastWinPollAt = 0;
    this._winPollPending = false;
    this._winPollEpoch = 0;
    this._winPollToken = null;
    this._lastProbeAt = 0;
    this._lastProbeTrusted = null;
    this._lastProbeError = '';
    this._lastSelectionAt = 0;
    this._lastSelectionSource = '';
    this._wordProbePending = false;
    this._wpsProbePending = false;
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
    this._pending = false;
    this._winPollPending = false;
    this._winPollEpoch++;
    this._winPollToken = null;
  }

  pause() {
    this._paused = true;
    this._winPollEpoch++;
  }

  resume() {
    this._paused = false;
    this._lastClipboardText = this._readClipboardText();
  }

  setEnabled(enabled) {
    this._enabled = Boolean(enabled);
    this._winPollEpoch++;
    this._clearState();
  }

  async diagnose() {
    const diagnostics = {
      enabled: this._enabled,
      helperAvailable: Boolean(this._selectionHelper),
      helperBackend: this._selectionHelper?.getBackend?.() || '',
      helperTrusted: this._lastProbeTrusted,
      helperError: this._lastProbeError,
      lastProbeAt: this._lastProbeAt || null,
      lastSelectionAt: this._lastSelectionAt || null,
      lastSelectionSource: this._lastSelectionSource || '',
    };

    if (!isMac || !this._selectionHelper) return diagnostics;

    try {
      const payload = await this._selectionHelper.probe();
      this._lastProbeAt = Date.now();
      this._lastProbeTrusted = payload?.trusted !== false;
      if (payload?.text || payload?.bundleIdentifier !== WPS_BUNDLE_ID) {
        this._lastProbeError = '';
      }
    } catch (err) {
      this._lastProbeAt = Date.now();
      this._lastProbeTrusted = false;
      this._lastProbeError = err?.message || '选区探针不可用';
    }

    return {
      ...diagnostics,
      helperBackend: this._selectionHelper?.getBackend?.() || '',
      helperTrusted: this._lastProbeTrusted,
      helperError: this._lastProbeError,
      lastProbeAt: this._lastProbeAt,
      lastSelectionAt: this._lastSelectionAt || null,
      lastSelectionSource: this._lastSelectionSource || '',
    };
  }

  _startPolling() {
    if (this._timer) return;
    this._timer = setInterval(() => this._check(), 500);
  }

  _check() {
    if (!this._enabled || this._paused) return;

    this._checkClipboard();

    // Windows reads UI Automation and verified Word COM without simulating copy.
    if (isWin) {
      this._checkClipboardForSelection();
      return;
    }

    if (this._pending) return;
    this._pending = true;

    if (this._selectionHelper?.run((err, payload) => {
      this._pending = false;
      this._lastProbeAt = Date.now();

      if (err || !payload) {
        this._lastProbeError = err?.message || '选区探针未返回结果';
        this._checkWithAppleScriptFallback();
        return;
      }

      this._lastProbeTrusted = payload.trusted !== false;
      this._lastProbeError = '';

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
    // Don't trigger clipboard-based selection when our own window is focused
    if (BrowserWindow.getFocusedWindow()) return;

    const rawText = this._readClipboardText();
    if (rawText === this._lastClipboardText) return;

    this._lastClipboardText = rawText;
    const text = this._normalizeText(rawText);

    // Clipboard triggers require more text to avoid false positives
    if (text && text.length >= 6 && /[\u4e00-\u9fff]/.test(text)) {
      this._emitSelection(text, 'clipboard', null, null, { rawText });
    } else {
      this._maybeClear('clipboard');
    }
  }

  /**
   * Read Windows UI Automation text selections without touching the clipboard.
   */
  _checkClipboardForSelection() {
    if (BrowserWindow.getFocusedWindow()) return;
    if (this._winPollPending) return;
    const now = Date.now();
    if (now - this._lastWinPollAt < 800) return;
    this._lastWinPollAt = now;
    this._winPollPending = true;
    const epoch = this._winPollEpoch;
    const token = this._winPollToken = {};
    const current = () => this._winPollToken === token && this._winPollEpoch === epoch
      && !this._paused && this._enabled && !BrowserWindow.getFocusedWindow();

    const psScript = [
      'Add-Type -AssemblyName UIAutomationClient',
      'Add-Type -AssemblyName UIAutomationTypes',
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      `Add-Type @'
using System;
using System.Runtime.InteropServices;
public class RunshiSelectionNative {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
}
'@`,
      '$handle = [RunshiSelectionNative]::GetForegroundWindow().ToInt64()',
      '[uint32]$ownerPid = 0',
      '[void][RunshiSelectionNative]::GetWindowThreadProcessId([IntPtr]$handle, [ref]$ownerPid)',
      '$element = [System.Windows.Automation.AutomationElement]::FocusedElement',
      'if (!$element -or $element.Current.ProcessId -ne $ownerPid) { exit }',
      '$pattern = $null',
      '$text = ""',
      'if ($element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) { foreach ($range in $pattern.GetSelection()) { $text += $range.GetText(-1) } }',
      'if ([RunshiSelectionNative]::GetForegroundWindow().ToInt64() -ne $handle) { exit }',
      '$isWord = (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue).ProcessName -ieq "WINWORD"',
      '[Console]::Write((@{text=$text;frontmostPid=$ownerPid;windowHandle=$handle;isWord=$isWord} | ConvertTo-Json -Compress))',
    ].join('; ');

    execFile('powershell', [
      '-NoProfile', '-NonInteractive', '-Command', psScript,
    ], { windowsHide: true, timeout: 3000, encoding: 'utf8' }, async (err, stdout) => {
      try {
        if (err || !current()) return;
        let payload;
        try { payload = JSON.parse(String(stdout || '').replace(/^\uFEFF/u, '').trim()); }
        catch { this._maybeClear('selection'); return; }
        if (typeof payload?.text !== 'string' || !Number.isSafeInteger(payload.frontmostPid) || payload.frontmostPid <= 0
          || !Number.isSafeInteger(payload.windowHandle) || payload.windowHandle <= 0) {
          this._maybeClear('selection'); return;
        }
        let rawText = payload.text;
        let selectionContext = null;
        if (payload.isWord === true) {
          const context = await probeWordSelectionContext().catch(() => null);
          if (!current()) return;
          // UIA may represent paragraph marks as CRLF. COM offsets and text are
          // authoritative only when both reads identify the exact same host.
          const comparable = value => this._normalizeText(value).replace(/\r\n?/g, '\n');
          if (context?.ok === true && context.supportsRangeEditing === true && typeof context.text === 'string'
            && context.text.length > 0 && context.bundleIdentifier === 'win32.word'
            && context.frontmostPid === payload.frontmostPid && context.windowHandle === payload.windowHandle
            && (rawText === '' || comparable(context.text) === comparable(rawText))) {
            rawText = context.text;
            selectionContext = context;
          }
        }
        const text = this._normalizeText(rawText);
        if (this._isTriggerableText(text)) {
          this._emitSelection(text, 'selection', null, null, { rawText, selectionContext });
        } else {
          this._maybeClear('selection');
        }
      } finally {
        if (this._winPollToken === token) {
          this._winPollPending = false;
          this._winPollToken = null;
        }
      }
    });
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
        this._emitSelection(text, 'selection', null, null, { rawText: stdout || '' });
      } else {
        this._maybeClear('selection');
      }
    });
  }

  _handleSelectionPayload(payload) {
    const frontmostPid = Number(payload?.frontmostPid);
    if (
      (Number.isFinite(frontmostPid) && frontmostPid === this._selfPid)
      || isOwnBundleIdentifier(payload?.bundleIdentifier)
    ) {
      this._maybeClear('selection');
      return;
    }

    const rawText = typeof payload.text === 'string' ? payload.text : '';
    const text = this._normalizeText(rawText);
    if (text === '__SELF__') return;

    if (this._isTriggerableText(text)) {
      const selectionBounds = this._normalizeBounds(payload.selectionBounds);
      const elementBounds = this._normalizeBounds(payload.elementBounds);
      this._emitSelection(text, 'selection', selectionBounds, elementBounds, {
        rawText,
        selectionContext: {
          text: rawText,
          bundleIdentifier: payload.bundleIdentifier || '',
          frontmostPid: Number.isFinite(frontmostPid) ? frontmostPid : null,
          selectionRange: this._normalizeRange(payload.selectionRange),
          supportsRangeEditing: Boolean(payload.supportsRangeEditing),
          elementToken: String(payload.elementToken || ''),
        },
      });
    } else if (payload?.bundleIdentifier === WORD_BUNDLE_ID) {
      this._probeWordSelection(payload);
    } else if (payload?.bundleIdentifier === WPS_BUNDLE_ID) {
      this._probeWpsSelection(payload);
    } else {
      this._maybeClear('selection');
    }
  }

  _probeWordSelection(payload) {
    if (this._wordProbePending) return;
    this._wordProbePending = true;
    probeWordSelectionContext()
      .then((context) => {
        const rawText = typeof context?.text === 'string' ? context.text : '';
        const text = this._normalizeText(rawText);
        if (!this._isTriggerableText(text)) {
          this._maybeClear('selection');
          return;
        }
        this._emitSelection(text, 'selection', null, payload?.elementBounds || null, {
          rawText,
          selectionContext: {
            ...context,
            frontmostPid: Number.isFinite(Number(payload?.frontmostPid))
              ? Number(payload.frontmostPid) : null,
          },
        });
      })
      .catch((err) => {
        this._lastProbeError = err?.message || 'Word 选区读取失败';
        this._maybeClear('selection');
      })
      .finally(() => {
        this._wordProbePending = false;
      });
  }

  _probeWpsSelection(payload) {
    if (this._wpsProbePending || BrowserWindow.getFocusedWindow()) return;
    this._wpsProbePending = true;
    const clipboardSnapshot = this._snapshotClipboard();
    const sentinel = `__RUNSHI_WPS_SELECTION_${Date.now()}__`;
    clipboard.writeText(sentinel);
    const sentinelChangeCount = this._clipboardChangeCount();

    this._selectionHelper.copySelection()
      .then(() => {
        setTimeout(() => {
          try {
            const rawText = clipboard.readText();
            const capturedChangeCount = this._clipboardChangeCount();
            const sentinelStillPresent = rawText === sentinel
              && (sentinelChangeCount == null || capturedChangeCount == null
                || capturedChangeCount === sentinelChangeCount);
            if (sentinelStillPresent) {
              this._restoreClipboard(clipboardSnapshot, sentinel, capturedChangeCount);
              this._lastClipboardText = this._readClipboardText();
              this._lastProbeError = 'WPS 未复制到选中的文本，请确认文本仍处于选中状态。';
              this._maybeClear('selection');
              return;
            }
            const copyWasOwned = sentinelChangeCount == null
              || capturedChangeCount == null
              || capturedChangeCount === sentinelChangeCount + 1;
            if (!copyWasOwned) {
              this._lastClipboardText = rawText;
              this._lastProbeError = '检测到剪贴板已被其他操作更新，本次没有覆盖或读取该内容。';
              this._maybeClear('selection');
              return;
            }
            const text = this._normalizeText(rawText);
            this._restoreClipboard(clipboardSnapshot, rawText, capturedChangeCount);
            this._lastClipboardText = this._readClipboardText();

            if (this._isTriggerableText(text)) {
              this._lastProbeError = '';
              const selectionBounds = this._normalizeBounds(payload?.selectionBounds);
              const elementBounds = this._normalizeBounds(payload?.elementBounds);
              this._emitSelection(text, 'selection', selectionBounds, elementBounds, {
                rawText,
                selectionContext: null,
              });
            } else {
              this._lastProbeError = 'WPS 未复制到选中的文本，请确认文本仍处于选中状态。';
              this._maybeClear('selection');
            }
          } finally {
            this._wpsProbePending = false;
          }
        }, 260);
      })
      .catch((err) => {
        this._restoreClipboard(clipboardSnapshot, sentinel, sentinelChangeCount);
        this._lastClipboardText = this._readClipboardText();
        this._lastProbeError = err?.message || 'WPS 选区读取失败';
        this._wpsProbePending = false;
        this._maybeClear('selection');
      });
  }

  _snapshotClipboard() {
    const nativeItems = this._selectionHelper?.snapshotClipboard?.();
    if (nativeItems) return { nativeItems };
    const snapshot = {
      text: clipboard.readText(),
      html: clipboard.readHTML(),
      rtf: clipboard.readRTF(),
    };
    const image = clipboard.readImage();
    if (!image.isEmpty()) snapshot.image = image;
    return snapshot;
  }

  _clipboardChangeCount() {
    return this._selectionHelper?.clipboardChangeCount?.() ?? null;
  }

  _restoreClipboard(snapshot, expectedText, expectedChangeCount = null) {
    if (expectedText !== undefined && clipboard.readText() !== expectedText) return false;
    const currentChangeCount = this._clipboardChangeCount();
    if (expectedChangeCount != null && currentChangeCount != null
      && currentChangeCount !== expectedChangeCount) return false;
    if (snapshot?.nativeItems) {
      return this._selectionHelper.restoreClipboard(snapshot.nativeItems);
    }
    if (snapshot) clipboard.write(snapshot);
    return true;
  }

  _emitSelection(text, source, bounds, fieldBounds = null, extra = {}) {
    const cursorPos = screen.getCursorScreenPoint();
    const validBounds = this._isBoundsNearPoint(bounds, cursorPos) ? bounds : null;
    const validFieldBounds = this._isBoundsNearPoint(fieldBounds, cursorPos, 320) ? fieldBounds : null;
    const boundsKey = this._createBoundsKey(validBounds);
    const context = extra.selectionContext;
    const contextKey = context ? JSON.stringify([context.bundleIdentifier, context.frontmostPid, context.windowHandle,
      context.documentId, context.elementToken, context.selectionRange?.location, context.selectionRange?.length,
      extra.rawText]) : '';
    if (
      text === this._activeText
      && source === this._activeSource
      && boundsKey === this._activeBoundsKey
      && contextKey === this._activeContextKey
    ) {
      return;
    }
    this._activeText = text;
    this._activeSource = source;
    this._activeContextKey = contextKey;
    this._activeBoundsKey = boundsKey;
    this._lastCursorPos = cursorPos;
    this._lastSelectionAt = Date.now();
    this._lastSelectionSource = source;
    if (this._selectionCallback) {
      this._selectionCallback({
        x: cursorPos.x,
        y: cursorPos.y,
        text,
        rawText: typeof extra.rawText === 'string' ? extra.rawText : text,
        textLength: text.length,
        source,
        bounds: validBounds,
        fieldBounds: validFieldBounds,
        selectionContext: extra.selectionContext || null,
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
      this._activeContextKey = '';
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
    if (!text || text.length < 4) return false;
    // Must contain at least one CJK character or be a substantial selection
    if (text.length < 10 && !/[\u4e00-\u9fff\u3400-\u4dbf]/.test(text)) return false;
    return true;
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

  _normalizeRange(range) {
    if (!range) return null;
    const location = Number(range.location);
    const length = Number(range.length);
    if (!Number.isFinite(location) || !Number.isFinite(length)) return null;
    if (location < 0 || length < 0) return null;
    return {
      location: Math.round(location),
      length: Math.round(length),
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
