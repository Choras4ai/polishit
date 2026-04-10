'use strict';

const { globalShortcut } = require('electron');

class ShortcutManager {
  constructor(config, triggerCallback) {
    this.config = config;
    this.triggerCallback = triggerCallback;
    this.currentAccelerator = null;
  }

  register(acceleratorOverride) {
    this.unregisterAll();

    const accelerator = acceleratorOverride || this.config.get('shortcut') || 'CommandOrControl+Shift+A';
    try {
      const ok = globalShortcut.register(accelerator, () => this.triggerCallback());
      if (ok) {
        this.currentAccelerator = accelerator;
        return { success: true, accelerator };
      } else {
        return {
          success: false,
          error: `快捷键注册失败，可能已被其他应用占用：${accelerator}`,
        };
      }
    } catch (err) {
      return { success: false, error: `快捷键无效：${err.message}` };
    }
  }

  unregisterAll() {
    if (this.currentAccelerator) {
      globalShortcut.unregister(this.currentAccelerator);
      this.currentAccelerator = null;
    }
  }
}

module.exports = ShortcutManager;
