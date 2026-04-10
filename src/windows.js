'use strict';

const { BrowserWindow, screen } = require('electron');
const path = require('path');

const isMac = process.platform === 'darwin';

const isMac = process.platform === 'darwin';

class WindowManager {
  constructor() {
    this.resultWindow = null;
    this.settingsWindow = null;
    this.onboardingWindow = null;
    this.toolbarWindow = null;
    this._toolbarHideTimer = null;
  }

  // ── Floating Toolbar ──

  /**
   * Show the floating selection toolbar near a cursor position.
   * @param {{ x: number, y: number }} pos - Screen coordinates of the cursor
   */
  showToolbar(pos) {
    // Don't show if result window is already open
    if (this.resultWindow && !this.resultWindow.isDestroyed()) return;

    clearTimeout(this._toolbarHideTimer);

    const winW = 250;
    const winH = 44;

    // Position above cursor, centered
    const display = screen.getDisplayNearestPoint(pos);
    const area = display.workArea;
    let x = Math.round(pos.x - winW / 2);
    let y = Math.round(pos.y - winH - 12);  // 12px above cursor

    // If above would overflow, place below
    if (y < area.y) y = pos.y + 18;
    // Clamp horizontally
    if (x < area.x + 4) x = area.x + 4;
    if (x + winW > area.x + area.width - 4) x = area.x + area.width - winW - 4;

    if (this.toolbarWindow && !this.toolbarWindow.isDestroyed()) {
      // Reposition existing toolbar
      this.toolbarWindow.setBounds({ x, y, width: winW, height: winH });
      this.toolbarWindow.showInactive();
      return;
    }

    this.toolbarWindow = new BrowserWindow({
      width: winW,
      height: winH,
      x, y,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      hasShadow: false,
      ...(isMac ? { type: 'panel' } : {})true,
      focusable: false,
      ...(isMac ? { type: 'panel' } : {}),
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    this.toolbarWindow.loadFile(
      path.join(__dirname, 'renderer', 'toolbar', 'index.html'),
    );

    this.toolbarWindow.webContents.once('did-finish-load', () => {
      if (this.toolbarWindow && !this.toolbarWindow.isDestroyed()) {
        this.toolbarWindow.showInactive();
      }
    });

    this.toolbarWindow.on('closed', () => { this.toolbarWindow = null; });
  }

  hideToolbar() {
    clearTimeout(this._toolbarHideTimer);
    if (this.toolbarWindow && !this.toolbarWindow.isDestroyed()) {
      this.toolbarWindow.close();
      this.toolbarWindow = null;
    }
  }

  /**
   * Hide toolbar after a delay (debounced for selection flickering).
   */
  hideToolbarDelayed(ms = 600) {
    clearTimeout(this._toolbarHideTimer);
    this._toolbarHideTimer = setTimeout(() => this.hideToolbar(), ms);
  }

  /**
   * Show result panel positioned over the source text field (Grammarly-style).
   * @param {Object|null} textFieldBounds - {x, y, width, height} of the focused text area
   */
  async showResult(textFieldBounds) {
    if (this.resultWindow && !this.resultWindow.isDestroyed()) {
      this.resultWindow.focus();
      return;
    }

    const winW = 380;
    let x, y, winH;

    if (textFieldBounds && textFieldBounds.width > 0) {
      // Grammarly-style: overlap the right edge of the text field
      const tfRight = textFieldBounds.x + textFieldBounds.width;
      x = tfRight - winW;  // overlap right side of text area
      y = textFieldBounds.y;
      winH = Math.max(400, textFieldBounds.height);

      // Ensure minimum overlap and not off-screen
      const display = screen.getDisplayNearestPoint({ x, y });
      const area = display.workArea;

      // If text field is too narrow, position at its right edge
      if (textFieldBounds.width < winW + 100) {
        x = tfRight - winW;
      }

      // Clamp to screen bounds
      if (x < area.x) x = area.x;
      if (x + winW > area.x + area.width) x = area.x + area.width - winW;
      if (y < area.y) y = area.y;
      if (winH > area.height) winH = area.height;
      if (y + winH > area.y + area.height) y = area.y + area.height - winH;
    } else {
      // Fallback: right-side sidebar
      const display = screen.getPrimaryDisplay();
      const area = display.workArea;
      winH = area.height;
      x = area.x + area.width - winW;
      y = area.y;
    }

    this.resultWindow = new BrowserWindow({
      width: winW,
      height: winH,
      x, y,
      frame: false,
      resizable: true,
      minimizable: false,
      maximizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      ...(isMac
        ? { vibrancy: 'under-window', visualEffectState: 'active', backgroundColor: '#00000000' }
        : { backgroundColor: '#ffffff' })
        ? { vibrancy: 'under-window', visualEffectState: 'active', backgroundColor: '#00000000' }
        : { backgroundColor: '#ffffff' }),
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    this.resultWindow.loadFile(
      path.join(__dirname, 'renderer', 'result', 'index.html'),
    );

    // Wait for renderer to fully load, then show without stealing focus
    await new Promise(resolve => {
      this.resultWindow.webContents.once('did-finish-load', () => {
        this.resultWindow.showInactive();
        resolve();
      });
    });

    this.resultWindow.on('closed', () => { this.resultWindow = null; });

    this.resultWindow.webContents.on('before-input-event', (_e, input) => {
      if (input.key === 'Escape') this.hideResult();
    });
  }

  hideResult() {
    if (this.resultWindow && !this.resultWindow.isDestroyed()) {
      this.resultWindow.close();
      this.resultWindow = null;
    }
  }

  sendToResult(channel, data) {
    if (this.resultWindow && !this.resultWindow.isDestroyed()) {
      this.resultWindow.webContents.send(channel, data);
    }
  }

  showSettings() {
    if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
      this.settingsWindow.focus();
      return;
    }

    this.settingsWindow = new BrowserWindow({
      width: 520,
      height: 580,
      resizable: false,
      minimizable: false,
      ...(isMac
        ? { titleBarStyle: 'hiddenInset', vibrancy: 'under-window', visualEffectState: 'active' }
        : { titleBarStyle: 'hidden' })
        ? { titleBarStyle: 'hiddenInset', vibrancy: 'under-window', visualEffectState: 'active' }
        : { titleBarStyle: 'hidden' }),
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    this.settingsWindow.loadFile(
      path.join(__dirname, 'renderer', 'settings', 'index.html'),
    );

    this.settingsWindow.on('closed', () => { this.settingsWindow = null; });
  }

  showOnboarding() {
    if (this.onboardingWindow && !this.onboardingWindow.isDestroyed()) {
      this.onboardingWindow.focus();
      return;
    }

    this.onboardingWindow = new BrowserWindow({
      width: 560,
      height: 640,
      resizable: false,
      minimizable: false,
      ...(isMac
        ? { titleBarStyle: 'hiddenInset', vibrancy: 'under-window', visualEffectState: 'active' }
        : { titleBarStyle: 'hidden' })
        ? { titleBarStyle: 'hiddenInset', vibrancy: 'under-window', visualEffectState: 'active' }
        : { titleBarStyle: 'hidden' }),
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    this.onboardingWindow.loadFile(
      path.join(__dirname, 'renderer', 'onboarding', 'index.html'),
    );

    this.onboardingWindow.once('ready-to-show', () => this.onboardingWindow.show());
    this.onboardingWindow.on('closed', () => { this.onboardingWindow = null; });
  }

  hideOnboarding() {
    if (this.onboardingWindow && !this.onboardingWindow.isDestroyed()) {
      this.onboardingWindow.close();
      this.onboardingWindow = null;
    }
  }
}

module.exports = WindowManager;
