'use strict';

const { clipboard } = require('electron');
const { exec, execFile } = require('child_process');
const { promisify } = require('util');
const MacOSSelectionHelper = require('./macos-selection-helper');
const WindowsReviewHelper = require('./windows-review-helper');
const { isOwnBundleIdentifier } = require('./app-identity');

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
const selectionHelper = isMac ? new MacOSSelectionHelper({ selfPid: process.pid }) : null;
const windowsReviewHelper = isWin ? new WindowsReviewHelper() : null;
const WORD_BUNDLE_ID = 'com.microsoft.Word';
const WORD_SPACE_LIKE_RE = /[\u00A0\u2007\u202F]/g;
const WORD_ZERO_WIDTH_RE = /[\u200B\u200C\u200D\u2060\uFEFF]/g;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function snapshotClipboard() {
  const nativeItems = selectionHelper?.snapshotClipboard?.();
  if (nativeItems) {
    return { nativeItems, changeCount: selectionHelper.clipboardChangeCount?.() ?? null };
  }
  const snapshot = {
    text: clipboard.readText(),
    html: clipboard.readHTML(),
    rtf: clipboard.readRTF(),
  };
  const image = clipboard.readImage();
  if (!image.isEmpty()) snapshot.image = image;
  if (isMac || isWin) {
    const bookmark = clipboard.readBookmark();
    if (bookmark.title) snapshot.bookmark = bookmark.title;
  }
  return snapshot;
}

function restoreClipboard(snapshot, expectedText, expectedChangeCount = null) {
  // Do not overwrite a new copy the user made while an async paste was running.
  if (expectedText !== undefined && clipboard.readText() !== expectedText) return;
  const currentChangeCount = selectionHelper?.clipboardChangeCount?.() ?? null;
  if (expectedChangeCount != null && currentChangeCount != null
    && currentChangeCount !== expectedChangeCount) return;
  if (snapshot?.nativeItems) {
    if (!selectionHelper.restoreClipboard(snapshot.nativeItems)) throw new Error('无法恢复原剪贴板。');
  } else if (snapshot) clipboard.write(snapshot);
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
      // PowerShell: get foreground window handle (use here-string to avoid quote escaping issues)
      const { stdout } = await execFileAsync('powershell', [
        '-NoProfile', '-Command',
        `Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WinAPI {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
}
'@; [WinAPI]::GetForegroundWindow().ToInt64()`,
      ], { windowsHide: true });
      lastFrontApp = (stdout || '').trim();
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
  if (isWin) return windowsReviewHelper.probe();
  const output = await runOsaScript([
    'on run argv',
    '  tell application id "com.microsoft.Word"',
    '    if (count of documents) is 0 then return ""',
    '    set documentIdentity to full name of active document',
    '    set encodedIdentity to do shell script "printf %s " & quoted form of documentIdentity & " | /usr/bin/base64 | /usr/bin/tr -d [:space:]"',
    '    set selectedText to content of selection',
    '    if selectedText is missing value then return ""',
    '    set startPos to start of content of formatted text of selection',
    '    set encodedText to do shell script "printf %s " & quoted form of selectedText & " | /usr/bin/base64"',
    '    set endPos to startPos + (length of selectedText)',
    '    return (startPos as text) & linefeed & (endPos as text) & linefeed & encodedIdentity & linefeed & encodedText',
    '  end tell',
    'end run',
  ]);

  const lines = output.replace(/\r/g, '').split('\n');
  if (lines.length < 4) return null;

  const startPos = Number(lines[0].trim());
  const endPos = Number(lines[1].trim());
  const documentId = Buffer.from(lines[2].trim(), 'base64').toString('utf8');
  const encodedText = lines.slice(3).join('').trim();
  if (!Number.isFinite(startPos) || !Number.isFinite(endPos) || !encodedText) {
    return null;
  }

  const text = Buffer.from(encodedText, 'base64').toString('utf8');
  // Word's document API uses CR; its AX text uses LF on some versions.
  // Only this one-code-unit substitution preserves native range offsets.
  const matchesWordAxText = value => value === text || value === text.replace(/\r/g, '\n');
  let ax = await selectionHelper?.probe().catch(() => null);
  if (ax?.trusted && ax.bundleIdentifier === WORD_BUNDLE_ID && (!ax.elementToken || !matchesWordAxText(ax.text))) {
    // Word publishes its enhanced AX tree on the next UI turn.
    await sleep(60);
    ax = await selectionHelper.probe().catch(() => null);
  }
  return {
    text,
    documentId,
    bundleIdentifier: WORD_BUNDLE_ID,
    frontmostPid: ax?.bundleIdentifier === WORD_BUNDLE_ID ? ax.frontmostPid : null,
    geometryContext: ax?.bundleIdentifier === WORD_BUNDLE_ID && matchesWordAxText(ax.text) && ax.elementToken
      ? { frontmostPid: ax.frontmostPid, elementToken: ax.elementToken, selectionRange: ax.selectionRange,
        wordParagraphSeparator: ax.text === text ? 'CR' : 'LF' } : null,
    selectionRange: {
      location: Math.max(0, startPos),
      length: Math.max(0, endPos - startPos),
    },
    supportsRangeEditing: true,
  };
}

async function readWordRangeText(baseStart, baseLength, documentId) {
  const output = await runOsaScript([
    'on run argv',
    '  set baseStart to (item 1 of argv) as integer',
    '  set baseLength to (item 2 of argv) as integer',
    '  tell application id "com.microsoft.Word"',
    '    if (count of documents) is 0 then error "当前没有打开的 Word 文档。"',
    '    if (full name of active document) is not (item 3 of argv) then error "Word 文档已变化，请重新分析。"',
    '    set targetRange to create range active document start baseStart end (baseStart + baseLength)',
    '    set currentText to content of targetRange',
    '    if currentText is missing value then set currentText to ""',
    '    set encodedText to do shell script "printf %s " & quoted form of currentText & " | /usr/bin/base64"',
    '    return encodedText',
    '  end tell',
    'end run',
  ], [baseStart, baseLength, documentId]);

  const encodedText = String(output || '').trim();
  if (!encodedText) return '';
  return Buffer.from(encodedText, 'base64').toString('utf8');
}

async function replaceWordRangeText(baseStart, baseLength, nextText, options = {}) {
  const selectionStart = Number.isFinite(Number(options.selectionStart))
    ? Math.max(0, Math.round(Number(options.selectionStart)))
    : baseStart;
  const selectionLength = Number.isFinite(Number(options.selectionLength))
    ? Math.max(0, Math.round(Number(options.selectionLength)))
    : nextText.length;
  const trackChanges = options.trackChanges === true;
  return runOsaScript([
    'on run argv',
    '  set baseStart to (item 1 of argv) as integer',
    '  set baseLength to (item 2 of argv) as integer',
    '  set nextText to item 3 of argv',
    '  set selectionStart to (item 4 of argv) as integer',
    '  set selectionLength to (item 5 of argv) as integer',
    '  set shouldTrack to (item 6 of argv) is "1"',
    '  tell application id "com.microsoft.Word"',
    '    if (count of documents) is 0 then error "当前没有打开的 Word 文档。"',
    '    set currentDocument to active document',
    '    if (full name of currentDocument) is not (item 7 of argv) then error "Word 文档已变化，请重新分析。"',
    '    set expectedText to item 8 of argv',
    '    set validationRange to create range currentDocument start selectionStart end (selectionStart + (length of expectedText))',
    '    if (content of validationRange) is not expectedText then error "Word 原文已变化，请重新分析。"',
    '    set previousTracking to track revisions of currentDocument',
    '    if previousTracking and not shouldTrack then return "RUNSHI_TRACKING_ENABLED"',
    '    try',
    '      if shouldTrack then',
    '        set track revisions of currentDocument to true',
    '        set show revisions of currentDocument to true',
    '      end if',
    '      set targetRange to create range currentDocument start baseStart end (baseStart + baseLength)',
    '      set content of targetRange to nextText',
    '      if shouldTrack then set track revisions of currentDocument to previousTracking',
    '      set refreshedRange to create range currentDocument start selectionStart end (selectionStart + selectionLength)',
    '      select refreshedRange',
    '    on error errorMessage number errorNumber',
    '      try',
    '        if shouldTrack then set track revisions of currentDocument to previousTracking',
    '      end try',
    '      error errorMessage number errorNumber',
    '    end try',
    '  end tell',
    '  return "OK"',
    'end run',
  ], [baseStart, baseLength, nextText, selectionStart, selectionLength, trackChanges ? '1' : '0', options.documentId, options.expectedText]);
}

async function probeSelectionContext() {
  if (isWin) return windowsReviewHelper.probe();
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
    if (isOwnBundleIdentifier(payload.bundleIdentifier)) return null;
    const selectionRange = normalizeSelectionRange(payload.selectionRange);
    return {
      text: typeof payload.text === 'string' ? payload.text : '',
      bundleIdentifier: payload.bundleIdentifier || '',
      frontmostPid: Number.isFinite(Number(payload.frontmostPid)) ? Number(payload.frontmostPid) : null,
      elementToken: String(payload.elementToken || ''),
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
async function restoreFrontApp(selectionContext = null) {
  try {
    if (isMac) {
      const bundle = selectionContext ? selectionContext.bundleIdentifier : lastFrontApp;
      if (typeof bundle !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/.test(bundle)) return false;
      const rawPid = selectionContext?.geometryContext?.frontmostPid || selectionContext?.frontmostPid;
      if (rawPid != null && rawPid !== 0 && (!Number.isSafeInteger(rawPid) || rawPid < 0)) return false;
      const pid = Number.isSafeInteger(rawPid) && rawPid > 0 ? rawPid : 0;
      const { stdout } = await execFileAsync('osascript', ['-e',
        'on run argv\nset targetBundle to item 1 of argv\nset targetPid to item 2 of argv as integer\ntell application "System Events"\nset targets to every process whose bundle identifier is targetBundle\nrepeat with p in targets\nif targetPid is 0 or (unix id of p) is targetPid then\nset frontmost of p to true\nreturn true\nend if\nend repeat\nend tell\nreturn false\nend run', bundle, String(pid)]);
      if (stdout.trim() !== 'true') return false;
    } else if (isWin) {
      const handle = String(selectionContext ? selectionContext.windowHandle ?? '' : lastFrontApp);
      if (!/^[1-9]\d{0,18}$/.test(handle) || BigInt(handle) > 9223372036854775807n) return false;
      const { stdout } = await execFileAsync('powershell', [
        '-NoProfile', '-Command',
        `Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WinAPI {
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@; [WinAPI]::SetForegroundWindow([IntPtr]::new([long]${handle}))`,
      ], { windowsHide: true });
      if (stdout.trim().toLowerCase() !== 'true') return false;
    }
    await sleep(300);
    return true;
  } catch (_) {
    return false;
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
  if (isOwnBundleIdentifier(lastFrontApp)) {
    lastTextFieldBounds = null;
    lastSelectionContext = null;
    return { text: '', selectionContext: null };
  }
  await getTextFieldBounds();
  const selectionContextPromise = probeSelectionContext();

  const savedClipboard = snapshotClipboard();
  const sentinel = `__POLISH_SENTINEL_${Date.now()}__`;
  clipboard.writeText(sentinel);
  const sentinelChangeCount = selectionHelper?.clipboardChangeCount?.() ?? null;

  let captured = '';
  let capturedChangeCount = null;
  let captureOwned = true;

  try {
    await simulateCopy();
    // Windows PowerShell SendKeys is slower; give extra time for clipboard to update
    await sleep(isWin ? 450 : 250);
    captured = clipboard.readText();
    capturedChangeCount = selectionHelper?.clipboardChangeCount?.() ?? null;
    captureOwned = sentinelChangeCount == null || capturedChangeCount == null
      || (captured === sentinel
        ? capturedChangeCount === sentinelChangeCount
        : capturedChangeCount === sentinelChangeCount + 1);
    if (!captureOwned) captured = '';
  } finally {
    await sleep(50);
    if (captureOwned) restoreClipboard(savedClipboard, captured || sentinel, capturedChangeCount);
  }

  const probedContext = await selectionContextPromise;
  let text = captured === sentinel ? '' : captured;
  const verifiedWordContext = probedContext?.text && (isWordBundleIdentifier(probedContext.bundleIdentifier)
    || (isWin && probedContext.ok === true && probedContext.bundleIdentifier === 'win32.word'));
  if (verifiedWordContext) {
    text = probedContext.text;
  } else if (!text && probedContext?.text) {
    text = probedContext.text;
  }

  if (probedContext && (probedContext.text === text || verifiedWordContext)) {
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
    if (await restoreFrontApp() === false) throw new Error('无法恢复原文应用，已停止粘贴。请回到原文重试。');
    await simulatePaste();
    await sleep(150);
  } finally {
    if (restoreClipboardAfterPaste && savedClipboard) {
      restoreClipboard(savedClipboard, text);
    }
  }
}

async function applyTextEdit(selectionRequest, replacementText, options = {}) {
  if ((isMac || isWin) && !await restoreFrontApp(selectionRequest)) {
    return { ok: false, error: '原文应用已关闭或无法安全恢复，请回到原文重新选择文字分析。' };
  }
  if (isWin && selectionRequest?.bundleIdentifier === 'win32.word') {
    return windowsReviewHelper.applyEdit(selectionRequest, String(replacementText ?? ''), options);
  }
  if (options.sourceOverlay && isMac && !isWordBundleIdentifier(selectionRequest?.bundleIdentifier)) {
    // Source overlays write to the verified AX element, never to whichever
    // app happens to receive a simulated paste after a focus change.
    return selectionHelper.applyReviewEdit(selectionRequest, String(replacementText ?? ''));
  }
  // On Windows, use clipboard paste to replace the still-selected text
  if (!isMac) {
    await sleep(150);
    const savedClipboard = snapshotClipboard();
    clipboard.writeText(String(replacementText || ''));
    try {
      await sleep(50);
      await simulatePaste();
      await sleep(200);
    } finally {
      await sleep(50);
      restoreClipboard(savedClipboard, String(replacementText || ''));
    }
    return { ok: true, strategy: 'win-clipboard-paste' };
  }

  if (!selectionHelper) {
    return { ok: false, error: '当前平台暂不支持原位修订。' };
  }

  await sleep(120);

  if (isWordBundleIdentifier(selectionRequest?.bundleIdentifier)) {
    const baseRange = normalizeSelectionRange(selectionRequest?.selectionRange);
    const targetRange = normalizeSelectionRange(selectionRequest?.targetRange);
    if (!baseRange || !targetRange) {
      return { ok: false, error: 'Word 原位修订缺少有效选区范围。' };
    }

    const expectedText = String(selectionRequest.expectedText || '');
    const relativeStart = targetRange.location - baseRange.location;
    if (relativeStart < 0 || relativeStart + targetRange.length > expectedText.length) {
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

    if (!selectionRequest.documentId || liveSelection?.documentId !== selectionRequest.documentId) {
      return { ok: false, error: 'Word 文档已变化或无法验证，请重新选择原文分析。' };
    }
    // Never relocate to a matching occurrence after the source range changes.
    const candidateStarts = [baseRange.location];

    let writeAttempted = false;
    try {
      for (const candidateStart of candidateStarts) {
        const currentText = await readWordRangeText(candidateStart, baseRange.length, selectionRequest.documentId);
        if (normalizeWordComparableText(currentText) !== normalizedExpectedText) {
          continue;
        }
        writeAttempted = true;
        const writeStatus = await replaceWordRangeText(
          candidateStart + relativeStart,
          targetRange.length,
          String(replacementText || ''),
          {
            documentId: selectionRequest.documentId,
            expectedText: currentText,
            selectionStart: candidateStart,
            selectionLength: nextText.length,
            trackChanges: options.trackChanges === true,
          },
        );
        if (String(writeStatus).trim() === 'RUNSHI_TRACKING_ENABLED') {
          return { ok: false, error: 'Word 当前开启了“修订”模式，本次未写入。请在 Word 的“审阅”中关闭“修订”，再接受建议。' };
        }
        const verified = await readWordRangeText(candidateStart, nextText.length, selectionRequest.documentId);
        if (verified !== nextText) return { ok: false, sourceMayHaveChanged: true, error: 'Word 已发送修改，但未能核对写回结果，请重新选择原文。' };
        const refreshed = options.sourceOverlay ? await probeWordSelectionContext().catch(() => null) : null;
        return {
          ok: true,
          geometryContext: refreshed?.documentId === selectionRequest.documentId && refreshed.text === nextText
            ? refreshed.geometryContext : null,
          selectionRange: {
            location: candidateStart,
            length: nextText.length,
          },
          strategy: options.trackChanges === true ? 'word-range-tracked' : 'word-range',
        };
      }
      return {
        ok: false,
        error: 'Word 当前原文已变化，停止原位修订。请保持原始选区不变后重试。',
      };
    } catch (err) {
      return {
        ok: false,
        sourceMayHaveChanged: writeAttempted,
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
    const baseRange = normalizeSelectionRange(selectionRequest?.selectionRange);
    const targetRange = normalizeSelectionRange(selectionRequest?.targetRange);
    const expectedText = String(selectionRequest?.expectedText || '');
    const replacement = String(replacementText || '');
    if (!baseRange || !targetRange
      || targetRange.location < baseRange.location
      || targetRange.location + targetRange.length > baseRange.location + baseRange.length) {
      return { ok: false, error: '原始修订范围无效，已停止提交状态。' };
    }
    const relativeStart = targetRange.location - baseRange.location;
    const updatedText = expectedText.slice(0, relativeStart)
      + replacement
      + expectedText.slice(relativeStart + targetRange.length);
    const updatedRange = { location: baseRange.location, length: updatedText.length };
    let verified;
    try {
      verified = await selectionHelper.setSelection({
        ...selectionRequest,
        expectedText: updatedText,
        selectionRange: updatedRange,
        targetRange: updatedRange,
      });
    } catch (err) {
      return {
        ok: false,
        sourceMayHaveChanged: true,
        error: `已发送修改，但读取写回结果失败：${err.message}。请检查原文并重新选择后继续。`,
      };
    }
    if (!verified?.ok) {
      return {
        ok: false,
        sourceMayHaveChanged: true,
        error: '已发送修改，但无法核对写回结果。请检查原文并重新选择后继续。',
      };
    }
    return { ok: true, selectionRange: updatedRange };
  } finally {
    if (savedClipboard) {
      try {
        restoreClipboard(savedClipboard, replacementText);
      } catch (err) {
        console.error('[runshi] clipboard restoration failed after source edit:', err.message);
      }
    }
  }
}

module.exports = {
  restoreFrontApp,
  reviewSourceGeometry: request => isWin ? windowsReviewHelper.reviewGeometry(request)
    : selectionHelper?.reviewGeometry(request) || Promise.resolve({ ok: false, error: '当前平台不支持原文浮窗。' }),
  snapshotClipboard,
  restoreClipboard,
  captureSelectedText,
  pasteText,
  applyTextEdit,
  probeWordSelectionContext,
  getLastTextFieldBounds,
  getLastSelectionContext,
};
