'use strict';

const { app, BrowserWindow, screen } = require('electron');
const path = require('path');

const isMac = process.platform === 'darwin';

class WindowManager {
  constructor() {
    this.resultWindow = null;
    this.resultAnchorBounds = null;
    this.settingsWindow = null;
    this.onboardingWindow = null;
    this.toolbarWindow = null;
    this.undoWindow = null;
    this._toolbarHideTimer = null;
    this._undoHideTimer = null;
  }

  // ── Floating Toolbar ──

  /**
   * Show the floating selection toolbar near a selection anchor.
   * @param {{ x: number, y: number, width?: number, height?: number }} anchor
   */
  showToolbar(anchor) {
    // Don't show if result window is already open
    if (this.resultWindow && !this.resultWindow.isDestroyed()) return;

    clearTimeout(this._toolbarHideTimer);

    const winW = 252;
    const winH = 44;
    const anchorRect = this._normalizeAnchorRect(anchor);
    const point = this._anchorToPoint(anchorRect);

    // Position above the current selection, centered.
    const display = screen.getDisplayNearestPoint(point);
    const area = display.workArea;
    let x = Math.round(point.x - winW / 2);
    let y = Math.round((anchorRect?.y ?? point.y) - winH - 10);

    if (y < area.y + 6) {
      y = Math.round((anchorRect?.y ?? point.y) + (anchorRect?.height ?? 0) + 14);
    }
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
      transparent: true,
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

  showUndoToast() {
    clearTimeout(this._undoHideTimer);

    const winW = 228;
    const winH = 64;
    const point = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(point);
    const area = display.workArea;
    const x = area.x + area.width - winW - 18;
    const y = area.y + area.height - winH - 18;

    if (this.undoWindow && !this.undoWindow.isDestroyed()) {
      this.undoWindow.setBounds({ x, y, width: winW, height: winH });
      this.undoWindow.showInactive();
      this._scheduleUndoToastHide();
      return;
    }

    this.undoWindow = new BrowserWindow({
      width: winW,
      height: winH,
      x,
      y,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      movable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      transparent: true,
      hasShadow: true,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    this.undoWindow.loadFile(
      path.join(__dirname, 'renderer', 'undo', 'index.html'),
    );

    this.undoWindow.webContents.once('did-finish-load', () => {
      if (this.undoWindow && !this.undoWindow.isDestroyed()) {
        this.undoWindow.showInactive();
        this._scheduleUndoToastHide();
      }
    });

    this.undoWindow.on('closed', () => {
      this.undoWindow = null;
      clearTimeout(this._undoHideTimer);
      this._undoHideTimer = null;
    });
  }

  hideUndoToast() {
    clearTimeout(this._undoHideTimer);
    this._undoHideTimer = null;
    if (this.undoWindow && !this.undoWindow.isDestroyed()) {
      this.undoWindow.close();
      this.undoWindow = null;
    }
  }

  _scheduleUndoToastHide(ms = 15000) {
    clearTimeout(this._undoHideTimer);
    this._undoHideTimer = setTimeout(() => this.hideUndoToast(), ms);
  }

  /**
   * Show result panel positioned near the current text selection.
   * @param {Object|null} anchorBounds - {x, y, width, height} of the selection/text area
   * @param {Object} options - preferred floating window size
   */
  async showResult(anchorBounds, options = {}) {
    this.resultAnchorBounds = this._normalizeAnchorRect(anchorBounds);
    const resultBounds = this._computeResultBounds(this.resultAnchorBounds, options);

    if (this.resultWindow && !this.resultWindow.isDestroyed()) {
      this.resultWindow.setBounds(resultBounds);
      this.resultWindow.showInactive();
      return;
    }

    this.resultWindow = new BrowserWindow({
      width: resultBounds.width,
      height: resultBounds.height,
      x: resultBounds.x,
      y: resultBounds.y,
      frame: false,
      resizable: true,
      minimizable: false,
      maximizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      ...(isMac
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
    this.resultAnchorBounds = null;
  }

  sendToResult(channel, data) {
    if (this.resultWindow && !this.resultWindow.isDestroyed()) {
      this.resultWindow.webContents.send(channel, data);
    }
  }

  focusResult() {
    if (this.resultWindow && !this.resultWindow.isDestroyed()) {
      this.resultWindow.show();
      this.resultWindow.focus();
    }
  }

  _normalizeAnchorRect(anchor) {
    if (!anchor) return null;
    const x = Number(anchor.x);
    const y = Number(anchor.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const width = Math.max(1, Number(anchor.width) || 1);
    const height = Math.max(1, Number(anchor.height) || 1);
    return {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    };
  }

  _anchorToPoint(anchor) {
    if (!anchor) return screen.getCursorScreenPoint();
    return {
      x: Math.round(anchor.x + anchor.width / 2),
      y: Math.round(anchor.y + anchor.height / 2),
    };
  }

  _computeResultBounds(anchorBounds, options = {}) {
    const width = Math.max(480, Math.min(680, Math.round(options.preferredWidth || 520)));
    const height = Math.max(260, Math.min(800, Math.round(options.preferredHeight || 420)));
    const point = this._anchorToPoint(anchorBounds);
    const display = screen.getDisplayNearestPoint(point);
    const area = display.workArea;
    const margin = 12;

    let x;
    let y;

    if (anchorBounds) {
      const anchorRight = anchorBounds.x + anchorBounds.width;
      const anchorBottom = anchorBounds.y + anchorBounds.height;
      const spaceRight = area.x + area.width - anchorRight;
      const spaceLeft = anchorBounds.x - area.x;
      const belowY = anchorBottom + 14;
      const aboveY = anchorBounds.y - height - 14;

      if (spaceRight >= width + 16) {
        x = anchorRight + 14;
      } else if (spaceLeft >= width + 16) {
        x = anchorBounds.x - width - 14;
      } else {
        x = Math.round(anchorBounds.x + anchorBounds.width / 2 - width / 2);
      }

      if (belowY + height <= area.y + area.height - margin) {
        y = belowY;
      } else if (aboveY >= area.y + margin) {
        y = aboveY;
      } else {
        y = Math.round(anchorBounds.y + anchorBounds.height / 2 - height / 2);
      }
    } else {
      x = area.x + area.width - width - 24;
      y = area.y + 24;
    }

    x = Math.max(area.x + margin, Math.min(x, area.x + area.width - width - margin));
    y = Math.max(area.y + margin, Math.min(y, area.y + area.height - height - margin));

    return { x, y, width, height };
  }

  // ── Home Window (opens settings on Home tab) ──

  showHome() {
    this.showSettings();
  }

  showSettings() {
    if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
      this.settingsWindow.focus();
      return;
    }

    if (isMac) app.dock.show();

    this.settingsWindow = new BrowserWindow({
      width: 600,
      height: 720,
      minWidth: 480,
      minHeight: 500,
      resizable: true,
      minimizable: true,
      ...(isMac
        ? { titleBarStyle: 'hiddenInset', vibrancy: 'under-window', visualEffectState: 'active' }
        : { titleBarStyle: 'hidden', titleBarOverlay: { color: '#f5f5f7', symbolColor: '#1d1d1f', height: 38 } }),
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

    this.settingsWindow.on('closed', () => {
      this.settingsWindow = null;
      this._hideDockIfNoWindows();
    });
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
        : { titleBarStyle: 'hidden', titleBarOverlay: { color: '#f5f5f7', symbolColor: '#1d1d1f', height: 38 } }),
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
    this.onboardingWindow.on('closed', () => {
      this.onboardingWindow = null;
      this._hideDockIfNoWindows();
    });
  }

  /** Hide dock icon when no visible normal windows remain. */
  _hideDockIfNoWindows() {
    if (!isMac) return;
    const hasVisible = [this.settingsWindow, this.onboardingWindow].some(
      w => w && !w.isDestroyed(),
    );
    if (!hasVisible) {
      app.dock.hide();
    }
  }

  hideOnboarding() {
    if (this.onboardingWindow && !this.onboardingWindow.isDestroyed()) {
      this.onboardingWindow.close();
      this.onboardingWindow = null;
    }
  }
}

module.exports = WindowManager;
