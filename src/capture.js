'use strict';

const { clipboard } = require('electron');
const { exec, execFile } = require('child_process');
const { promisify } = require('util');
const MacOSSelectionHelper = require('./macos-selection-helper');

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
const selectionHelper = isMac ? new MacOSSelectionHelper({ selfPid: process.pid }) : null;
const WORD_BUNDLE_ID = 'com.microsoft.Word';
const WORD_SPACE_LIKE_RE = /[\u00A0\u2007\u202F]/g;
const WORD_ZERO_WIDTH_RE = /[\u200B\u200C\u200D\u2060\uFEFF]/g;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function snapshotClipboard() {
  const formats = clipboard.availableFormats();
  return formats.map((format) => {
    try {
      return {
        format,
        data: Buffer.from(clipboard.readBuffer(format)),
      };
    } catch (_) {
      return null;
    }
  }).filter(Boolean);
}

function restoreClipboard(snapshot) {
  clipboard.clear();
  for (const item of snapshot) {
    try {
      clipboard.writeBuffer(item.format, item.data);
    } catch (_) {
      // Skip formats that cannot be restored in the current environment.
    }
  }
}

/**
 * Get the identifier of the frontmost app (before our window takes focus).
 */
let lastFrontApp = '';
let lastTextFieldBounds = null;
let lastSelectionContext = null;

async function saveFrontApp() {
  try {
    if (isMac) {
      const { stdout } = await execAsync(
        'osascript -e \'tell application "System Events" to get bundle identifier of first process whose frontmost is true\'',
      );
      lastFrontApp = stdout.trim();
    } else if (isWin) {
      // PowerShell: get foreground window handle
      const { stdout } = await execAsync(
        'powershell -NoProfile -Command "Add-Type -TypeDefinition \'using System;using System.Runtime.InteropServices;public class WinAPI{[DllImport(\\\"user32.dll\\\")]public static extern IntPtr GetForegroundWindow();}\'; [WinAPI]::GetForegroundWindow().ToInt64()"',        { windowsHide: true },      );
      lastFrontApp = stdout.trim();
    }
  } catch (_) {
    lastFrontApp = '';
  }
}

/**
 * Get the screen bounds of the focused text field in the frontmost app.
 */
async function getTextFieldBounds() {
  if (!isMac) {
    // Windows: skip text field bounds detection, use fallback positioning
    lastTextFieldBounds = null;
    return null;
  }
  try {
    const { stdout } = await execAsync(`osascript -e '
tell application "System Events"
  set frontApp to first process whose frontmost is true
  try
    set focusedEl to focused UI element of frontApp
    set {x, y} to position of focusedEl
    set {w, h} to size of focusedEl
    return (x as text) & "," & (y as text) & "," & (w as text) & "," & (h as text)
  on error
    -- Try to get the focused window bounds instead
    try
      set frontWin to front window of frontApp
      set {x, y} to position of frontWin
      set {w, h} to size of frontWin
      return (x as text) & "," & (y as text) & "," & (w as text) & "," & (h as text)
    on error
      return ""
    end try
  end try
end tell'`);
    const parts = stdout.trim().split(',').map(Number);
    if (parts.length === 4 && parts.every(n => !isNaN(n))) {
      lastTextFieldBounds = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
      return lastTextFieldBounds;
    }
  } catch (_) {
    // Fall through
  }
  lastTextFieldBounds = null;
  return null;
}

function getLastTextFieldBounds() {
  return lastTextFieldBounds;
}

function getLastSelectionContext() {
  return lastSelectionContext;
}

function normalizeSelectionRange(range) {
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

function isWordBundleIdentifier(bundleIdentifier) {
  return String(bundleIdentifier || '').trim() === WORD_BUNDLE_ID;
}

function normalizeWordComparableText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(WORD_SPACE_LIKE_RE, ' ')
    .replace(WORD_ZERO_WIDTH_RE, '');
}

async function runOsaScript(lines, argv = []) {
  const args = [];
  for (const line of lines) {
    args.push('-e', line);
  }
  args.push(...argv.map((value) => String(value)));
  const { stdout } = await execFileAsync('osascript', args, {
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  return String(stdout || '');
}

async function probeWordSelectionContext() {
  const output = await runOsaScript([
    'on run argv',
    '  tell application id "com.microsoft.Word"',
    '    if (count of documents) is 0 then return ""',
    '    set selectedText to content of selection',
    '    if selectedText is missing value then return ""',
    '    set startPos to start of content of formatted text of selection',
    "    set encodeCmd to \"import base64,sys;print(base64.b64encode(sys.argv[1].encode('utf-8')).decode('ascii'), end='')\"",
    '    set encodedText to do shell script "/usr/bin/python3 -c " & quoted form of encodeCmd & " " & quoted form of selectedText',
    '    set endPos to startPos + (length of selectedText)',
    '    return (startPos as text) & linefeed & (endPos as text) & linefeed & encodedText',
    '  end tell',
    'end run',
  ]);

  const lines = output.replace(/\r/g, '').split('\n');
  if (lines.length < 3) return null;

  const startPos = Number(lines[0].trim());
  const endPos = Number(lines[1].trim());
  const encodedText = lines.slice(2).join('').trim();
  if (!Number.isFinite(startPos) || !Number.isFinite(endPos) || !encodedText) {
    return null;
  }

  const text = Buffer.from(encodedText, 'base64').toString('utf8');
  return {
    text,
    bundleIdentifier: WORD_BUNDLE_ID,
    frontmostPid: null,
    selectionRange: {
      location: Math.max(0, startPos),
      length: Math.max(0, endPos - startPos),
    },
    supportsRangeEditing: true,
  };
}

async function readWordRangeText(baseStart, baseLength) {
  const output = await runOsaScript([
    'on run argv',
    '  set baseStart to (item 1 of argv) as integer',
    '  set baseLength to (item 2 of argv) as integer',
    '  tell application id "com.microsoft.Word"',
    '    if (count of documents) is 0 then error "当前没有打开的 Word 文档。"',
    '    set targetRange to create range active document start baseStart end (baseStart + baseLength)',
    '    set currentText to content of targetRange',
    '    if currentText is missing value then set currentText to ""',
    "    set encodeCmd to \"import base64,sys;print(base64.b64encode(sys.argv[1].encode('utf-8')).decode('ascii'), end='')\"",
    '    set encodedText to do shell script "/usr/bin/python3 -c " & quoted form of encodeCmd & " " & quoted form of currentText',
    '    return encodedText',
    '  end tell',
    'end run',
  ], [baseStart, baseLength]);

  const encodedText = String(output || '').trim();
  if (!encodedText) return '';
  return Buffer.from(encodedText, 'base64').toString('utf8');
}

async function replaceWordSelectionText(baseStart, nextText) {
  await runOsaScript([
    'on run argv',
    '  set baseStart to (item 1 of argv) as integer',
    '  set nextText to item 2 of argv',
    '  tell application id "com.microsoft.Word"',
    '    if (count of documents) is 0 then error "当前没有打开的 Word 文档。"',
    '    set content of selection to nextText',
    '    try',
    '      set refreshedRange to create range active document start baseStart end (baseStart + (length of nextText))',
    '      select refreshedRange',
    '    end try',
    '  end tell',
    '  return "OK"',
    'end run',
  ], [baseStart, nextText]);
}

async function replaceWordRangeText(baseStart, baseLength, nextText) {
  await runOsaScript([
    'on run argv',
    '  set baseStart to (item 1 of argv) as integer',
    '  set baseLength to (item 2 of argv) as integer',
    '  set nextText to item 3 of argv',
    '  tell application id "com.microsoft.Word"',
    '    if (count of documents) is 0 then error "当前没有打开的 Word 文档。"',
    '    set targetRange to create range active document start baseStart end (baseStart + baseLength)',
    '    set content of targetRange to nextText',
    '    try',
    '      set refreshedRange to create range active document start baseStart end (baseStart + (length of nextText))',
    '      select refreshedRange',
    '    end try',
    '  end tell',
    '  return "OK"',
    'end run',
  ], [baseStart, baseLength, nextText]);
}

async function probeSelectionContext() {
  if (isWordBundleIdentifier(lastFrontApp)) {
    try {
      return await probeWordSelectionContext();
    } catch (_) {
      return null;
    }
  }

  if (!selectionHelper) return null;
  try {
    const payload = await selectionHelper.probe();
    if (!payload || payload.trusted === false) return null;
    const selectionRange = normalizeSelectionRange(payload.selectionRange);
    return {
      text: typeof payload.text === 'string' ? payload.text : '',
      bundleIdentifier: payload.bundleIdentifier || '',
      frontmostPid: Number.isFinite(Number(payload.frontmostPid)) ? Number(payload.frontmostPid) : null,
      selectionRange,
      supportsRangeEditing: Boolean(payload.supportsRangeEditing && selectionRange),
    };
  } catch (_) {
    return null;
  }
}

/**
 * Re-activate the previously frontmost app.
 */
async function restoreFrontApp() {
  if (!lastFrontApp) return;
  try {
    if (isMac) {
      await execAsync(
        `osascript -e 'tell application id "${lastFrontApp}" to activate'`,
      );
    } else if (isWin) {
      await execAsync(
        `powershell -NoProfile -Command "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class WinAPI{[DllImport(\\\"user32.dll\\\")]public static extern bool SetForegroundWindow(IntPtr hWnd);}'; [WinAPI]::SetForegroundWindow([IntPtr]::new(${lastFrontApp}))"`,
        { windowsHide: true },
      );
    }
    await sleep(300);
  } catch (_) {
    // Fallback: use generic approach
  }
}

/**
 * Simulate copy keystroke (Cmd+C on macOS, Ctrl+C on Windows).
 */
async function simulateCopy() {
  if (isMac) {
    await execAsync(
      'osascript -e \'tell application "System Events" to keystroke "c" using command down\'',
    );
  } else if (isWin) {
    await execAsync(
      'powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(\'^c\')"',
      { windowsHide: true },
    );
  }
}

/**
 * Simulate paste keystroke (Cmd+V on macOS, Ctrl+V on Windows).
 */
async function simulatePaste() {
  if (isMac) {
    await execAsync(
      'osascript -e \'tell application "System Events" to keystroke "v" using command down\'',
    );
  } else if (isWin) {
    await execAsync(
      'powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(\'^v\')"',
      { windowsHide: true },
    );
  }
}

async function simulateDeleteSelection() {
  if (isMac) {
    await execAsync(
      'osascript -e \'tell application "System Events" to key code 51\'',
    );
  } else if (isWin) {
    await execAsync(
      'powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(\'{BACKSPACE}\')"',
      { windowsHide: true },
    );
  }
}

/**
 * Capture the currently selected text by simulating copy.
 * Saves and restores the original clipboard content.
 */
async function captureSelectedText() {
  await saveFrontApp();
  await getTextFieldBounds();
  const selectionContextPromise = probeSelectionContext();

  const savedClipboard = snapshotClipboard();
  const sentinel = `__POLISH_SENTINEL_${Date.now()}__`;
  clipboard.writeText(sentinel);

  let captured = '';

  try {
    await simulateCopy();
    // Windows PowerShell SendKeys is slower; give extra time for clipboard to update
    await sleep(isWin ? 450 : 250);
    captured = clipboard.readText();
  } finally {
    await sleep(50);
    restoreClipboard(savedClipboard);
  }

  const probedContext = await selectionContextPromise;
  let text = captured === sentinel ? '' : captured;
  if (probedContext?.text && isWordBundleIdentifier(probedContext.bundleIdentifier)) {
    text = probedContext.text;
  } else if (!text && probedContext?.text) {
    text = probedContext.text;
  }

  if (probedContext && (probedContext.text === text || isWordBundleIdentifier(probedContext.bundleIdentifier))) {
    lastSelectionContext = probedContext;
  } else {
    lastSelectionContext = null;
  }

  return {
    text,
    selectionContext: lastSelectionContext,
  };
}

/**
 * Paste text by writing to clipboard, re-focusing the original app, and simulating paste.
 */
async function pasteText(text, options = {}) {
  const restoreClipboardAfterPaste = options.restoreClipboardAfterPaste !== false;
  const savedClipboard = restoreClipboardAfterPaste ? snapshotClipboard() : null;
  clipboard.writeText(text);
  try {
    await sleep(100);
    await restoreFrontApp();
    await simulatePaste();
    await sleep(150);
  } finally {
    if (restoreClipboardAfterPaste && savedClipboard) {
      restoreClipboard(savedClipboard);
    }
  }
}

async function applyTextEdit(selectionRequest, replacementText, options = {}) {
  if (!isMac || !selectionHelper) {
    return { ok: false, error: '当前平台暂不支持原位修订。' };
  }

  await restoreFrontApp();
  await sleep(120);

  if (isWordBundleIdentifier(selectionRequest?.bundleIdentifier)) {
    const baseRange = normalizeSelectionRange(selectionRequest?.selectionRange);
    const targetRange = normalizeSelectionRange(selectionRequest?.targetRange);
    if (!baseRange || !targetRange) {
      return { ok: false, error: 'Word 原位修订缺少有效选区范围。' };
    }

    const expectedText = String(selectionRequest.expectedText || '');
    const relativeStart = targetRange.location - baseRange.location;
    if (relativeStart < 0 || relativeStart > expectedText.length) {
      return { ok: false, error: 'Word 原位修订目标位置超出原文范围。' };
    }
    const nextText = expectedText.slice(0, relativeStart)
      + String(replacementText || '')
      + expectedText.slice(relativeStart + targetRange.length);
    const normalizedExpectedText = normalizeWordComparableText(expectedText);
    let lastWordError = '';

    let liveSelection = null;
    try {
      liveSelection = await probeWordSelectionContext();
    } catch (_) {
      liveSelection = null;
    }

    if (liveSelection?.text) {
      const liveSelectionStart = normalizeSelectionRange(liveSelection.selectionRange)?.location ?? baseRange.location;
      if (normalizeWordComparableText(liveSelection.text) === normalizedExpectedText) {
        try {
          await replaceWordSelectionText(liveSelectionStart, nextText);
          return {
            ok: true,
            selectionRange: {
              location: liveSelectionStart,
              length: nextText.length,
            },
            strategy: 'word-live-selection',
          };
        } catch (err) {
          lastWordError = String(err.stderr || err.message || '').trim();
        }
      }
    }

    const candidateStarts = [];
    const appendCandidateStart = (value) => {
      if (!Number.isFinite(value) || value < 0) return;
      const rounded = Math.round(value);
      if (!candidateStarts.includes(rounded)) candidateStarts.push(rounded);
    };

    appendCandidateStart(baseRange.location);
    appendCandidateStart(baseRange.location - 1);
    appendCandidateStart(baseRange.location + 1);
    appendCandidateStart(baseRange.location - 2);
    appendCandidateStart(baseRange.location + 2);
    if (liveSelection?.selectionRange) {
      appendCandidateStart(liveSelection.selectionRange.location);
    }

    try {
      for (const candidateStart of candidateStarts) {
        const currentText = await readWordRangeText(candidateStart, baseRange.length);
        if (normalizeWordComparableText(currentText) !== normalizedExpectedText) {
          continue;
        }
        await replaceWordRangeText(candidateStart, baseRange.length, nextText);
        return {
          ok: true,
          selectionRange: {
            location: candidateStart,
            length: nextText.length,
          },
          strategy: 'word-range',
        };
      }
      return {
        ok: false,
        error: 'Word 当前原文已变化，停止原位修订。请保持原始选区不变后重试。',
      };
    } catch (err) {
      return {
        ok: false,
        error: String(
          err.stderr
          || err.message
          || lastWordError
          || 'Word 原位修订失败。'
        ).trim(),
      };
    }
  }

  let prepared;
  try {
    prepared = await selectionHelper.setSelection(selectionRequest);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  if (!prepared?.ok) {
    return { ok: false, error: prepared?.error || '无法定位原始选区。' };
  }

  const shouldRestoreClipboard = options.restoreClipboard !== false;
  const hasReplacement = typeof replacementText === 'string' && replacementText.length > 0;
  const savedClipboard = hasReplacement && shouldRestoreClipboard ? snapshotClipboard() : null;

  try {
    if (hasReplacement) {
      clipboard.writeText(replacementText);
      await sleep(60);
      await simulatePaste();
      await sleep(120);
    } else {
      await simulateDeleteSelection();
      await sleep(90);
    }
    return { ok: true };
  } finally {
    if (savedClipboard) {
      restoreClipboard(savedClipboard);
    }
  }
}

module.exports = {
  captureSelectedText,
  pasteText,
  applyTextEdit,
  getLastTextFieldBounds,
  getLastSelectionContext,
};
