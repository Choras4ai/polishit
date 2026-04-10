'use strict';

const { clipboard } = require('electron');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);
const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

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

/**
 * Capture the currently selected text by simulating copy.
 * Saves and restores the original clipboard content.
 */
async function captureSelectedText() {
  await saveFrontApp();
  await getTextFieldBounds();

  const savedClipboard = snapshotClipboard();
  const sentinel = `__POLISH_SENTINEL_${Date.now()}__`;
  clipboard.writeText(sentinel);

  try {
    await simulateCopy();
    // Windows PowerShell SendKeys is slower; give extra time for clipboard to update
    await sleep(isWin ? 450 : 250);
    const captured = clipboard.readText();

    if (captured === sentinel) {
      return '';
    }
    return captured;
  } finally {
    await sleep(50);
    restoreClipboard(savedClipboard);
  }
}

/**
 * Paste text by writing to clipboard, re-focusing the original app, and simulating paste.
 */
async function pasteText(text) {
  const savedClipboard = snapshotClipboard();
  clipboard.writeText(text);
  try {
    await sleep(100);
    await restoreFrontApp();
    await simulatePaste();
    await sleep(150);
  } finally {
    restoreClipboard(savedClipboard);
  }
}

module.exports = { captureSelectedText, pasteText, getLastTextFieldBounds };
