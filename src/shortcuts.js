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

    const accelerator = acceleratorOverride || this.config.get('shortcut') || 'CommandOrControl+Alt+V';
    try {
      const ok = globalShortcut.register(accelerator, () => this.triggerCallback());
      if (ok) {
        this.currentAccelerator = accelerator;
        return { success: true, accelerator };
      }
      // Try fallback shortcuts
      const fallbacks = [
        'CommandOrControl+Shift+V', 'Alt+Shift+V', 'CommandOrControl+Alt+R',
        'CommandOrControl+Alt+A', 'Alt+Shift+R', 'CommandOrControl+Shift+R',
      ];
      for (const fb of fallbacks) {
        if (fb === accelerator) continue;
        const fbOk = globalShortcut.register(fb, () => this.triggerCallback());
        if (fbOk) {
          this.currentAccelerator = fb;
          this.config.set('shortcut', fb);
          console.log(`默认快捷键被占用，已切换到 ${fb}`);
          return { success: true, accelerator: fb, fallback: true };
        }
      }
      // Find next available to suggest
      const suggestions = fallbacks.filter(f => f !== accelerator);
      return {
        success: false,
        error: `快捷键 ${accelerator} 已被占用。建议尝试：${suggestions.slice(0, 3).join('、')}`,
        suggestions: suggestions.slice(0, 3),
      };
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
