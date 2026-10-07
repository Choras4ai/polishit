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

  _guardLocalRenderer(window) {
    if (!window || window.isDestroyed()) return;
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => {
      event.preventDefault();
    });
  }

  /**
   * Show the floating selection toolbar near a selection anchor.
   * @param {{ x: number, y: number, width?: number, height?: number }} anchor
   */
  showToolbar(anchor) {
    // Don't show if result window is already open
    if (this.resultWindow && !this.resultWindow.isDestroyed()) return false;

    clearTimeout(this._toolbarHideTimer);

    const winW = 340;
    const winH = 118;
    const anchorRect = this._normalizeAnchorRect(anchor);
    const point = this._anchorToPoint(anchorRect);

    // Position above the current selection, centered.
    const toolbarH = 44;
    const display = screen.getDisplayNearestPoint(point);
    const area = display.workArea;
    let x = Math.round(point.x - winW / 2);
    let y = Math.round((anchorRect?.y ?? point.y) - toolbarH - 8);

    // If above has insufficient space, try below; clamp to screen in both cases
    if (y < area.y + 6) {
      y = Math.round((anchorRect?.y ?? point.y) + (anchorRect?.height ?? 0) + 8);
      // If below also doesn't fit, force to bottom edge
      if (y + winH > area.y + area.height - 6) {
        y = area.y + area.height - winH - 6;
      }
    }
    // Clamp horizontally
    if (x < area.x + 4) x = area.x + 4;
    if (x + winW > area.x + area.width - 4) x = area.x + area.width - winW - 4;

    if (this.toolbarWindow && !this.toolbarWindow.isDestroyed()) {
      // Reposition existing toolbar
      this.toolbarWindow.setBounds({ x, y, width: winW, height: winH });
      this.toolbarWindow.showInactive();
      return true;
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

    this._guardLocalRenderer(this.toolbarWindow);

    this.toolbarWindow.loadFile(
      path.join(__dirname, 'renderer', 'toolbar', 'index.html'),
    );

    this.toolbarWindow.webContents.once('did-finish-load', () => {
      if (this.toolbarWindow && !this.toolbarWindow.isDestroyed()) {
        this.toolbarWindow.showInactive();
      }
    });

    this.toolbarWindow.on('closed', () => { this.toolbarWindow = null; });
    return true;
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

    this._guardLocalRenderer(this.undoWindow);

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

    this._guardLocalRenderer(this.resultWindow);

    this.resultWindow.loadFile(
      path.join(__dirname, 'renderer', 'result', 'index.html'),
    );

    // Register closed handler early to avoid race condition
    this.resultWindow.on('closed', () => { this.resultWindow = null; this.onResultClosed?.(); });

    // Wait for renderer to fully load, then show without stealing focus
    await new Promise(resolve => {
      this.resultWindow.webContents.once('did-finish-load', () => {
        if (this.resultWindow && !this.resultWindow.isDestroyed()) {
          this.resultWindow.showInactive();
        }
        resolve();
      });
      // Also handle load failure to avoid hanging forever
      this.resultWindow.webContents.once('did-fail-load', () => {
        resolve();
      });
    });

    if (this.resultWindow && !this.resultWindow.isDestroyed()) {
      // This listener is installed once per window, and must survive other keys.
      this.resultWindow.webContents.on('before-input-event', (_e, input) => {
        if (input.key === 'Escape' && this.resultWindow && !this.resultWindow.isDestroyed()) {
          this.hideResult();
        }
      });
    }
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
    const point = this._anchorToPoint(anchorBounds);
    const display = screen.getDisplayNearestPoint(point);
    const area = display.workArea;
    const margin = 12;
    const width = Math.min(Math.max(1, area.width - margin * 2), Math.max(560, Math.min(760, Math.round(options.preferredWidth || 700))));
    const height = Math.min(Math.max(1, area.height - margin * 2), Math.max(520, Math.min(720, Math.round(options.preferredHeight || 620))));

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
    // Settings should never be covered by stale always-on-top helper windows.
    // Closing these also prevents the selection watcher from reading our own
    // renderer accessibility tree and recursively triggering another result.
    this.hideToolbar();
    this.hideUndoToast();
    this.hideResult();

    if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
      this.settingsWindow.focus();
      return;
    }

    if (isMac) app.dock.show();

    this.settingsWindow = new BrowserWindow({
      width: 780,
      height: 760,
      minWidth: 680,
      minHeight: 560,
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

    this._guardLocalRenderer(this.settingsWindow);

    this.settingsWindow.loadFile(
      path.join(__dirname, 'renderer', 'settings', 'index.html'),
    );

    this.settingsWindow.on('closed', () => {
      this.settingsWindow = null;
      this._hideDockIfNoWindows();
    });
  }

  showToolbarTest() {
    const point = screen.getCursorScreenPoint();
    return this.showToolbar({ x: point.x, y: point.y, width: 1, height: 1 });
  }

  showOnboarding() {
    if (this.onboardingWindow && !this.onboardingWindow.isDestroyed()) {
      this.onboardingWindow.focus();
      return;
    }

    if (isMac) app.dock.show();

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

    this._guardLocalRenderer(this.onboardingWindow);

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
