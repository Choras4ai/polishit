'use strict';

const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');

const isMac = process.platform === 'darwin';

class TrayManager {
  constructor(config, windowManager, shortcutManager) {
    this.config = config;
    this.windowManager = windowManager;
    this.shortcutManager = shortcutManager;
    this.tray = null;
  }

  create() {
    const iconName = isMac ? 'tray-iconTemplate.png' : 'tray-icon.png';
    const iconPath = path.join(__dirname, '..', 'assets', iconName);
    let icon;
    try {
      icon = nativeImage.createFromPath(iconPath);
      if (isMac) icon.setTemplateImage(true);
    } catch (_) {
      icon = nativeImage.createEmpty();
    }
    this.tray = new Tray(icon);
    this.tray.setToolTip('润石');
    this._buildMenu();
  }

  _buildMenu() {
    const shortcut = this.config.get('shortcut') || 'CommandOrControl+Shift+A';
    let display;
    if (isMac) {
      display = shortcut
        .replace('CommandOrControl', '⌘')
        .replace('Shift', '⇧')
        .replace('Alt', '⌥')
        .replace(/\+/g, '');
    } else {
      display = shortcut
        .replace('CommandOrControl', 'Ctrl')
        .replace(/\+/g, '+');
    }

    const menu = Menu.buildFromTemplate([
      { label: `润石  ${display}`, enabled: false },
      { type: 'separator' },
      { label: '设置…', click: () => this.windowManager.showSettings() },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          this.shortcutManager.unregisterAll();
          app.quit();
        },
      },
    ]);

    this.tray.setContextMenu(menu);
  }

  destroy() {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}

module.exports = TrayManager;
