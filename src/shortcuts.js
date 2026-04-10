'use strict';

const { globalShortcut } = require('electron');

class ShortcutManager {
  constructor(config, triggerCallback) {
    this.config = config;
    this.triggerCallback = triggerCallback;
    this.currentAccelerator = null;
  }

  register() {
    this.unregisterAll();

    const accelerator = this.config.get('shortcut') || 'CommandOrControl+Shift+A';
    try {
      const ok = globalShortcut.register(accelerator, () => this.triggerCallback());
      if (ok) {
        this.currentAccelerator = accelerator;
      } else {
        console.error(`快捷键注册失败: ${accelerator}`);
      }
    } catch (err) {
      console.error(`快捷键注册异常: ${err.message}`);
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
