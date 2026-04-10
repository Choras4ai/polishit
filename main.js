'use strict';

const { app, ipcMain, clipboard } = require('electron');
const ConfigStore = require('./src/config');
const WindowManager = require('./src/windows');
const ShortcutManager = require('./src/shortcuts');
const TrayManager = require('./src/tray');
const SelectionWatcher = require('./src/selection-watcher');
const { captureSelectedText, pasteText, getLastTextFieldBounds } = require('./src/capture');
const { AgentPipeline } = require('./src/ai/pipeline');
const { createProvider } = require('./src/ai/provider-factory');
const { PRESETS, PRESET_ORDER } = require('./src/ai/presets');

// ── Single instance lock ──
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ── State ──
const config = new ConfigStore();
let windowManager, shortcutManager, trayManager, selectionWatcher;
let isProcessing = false;
let lastOriginalText = '';

// ── App lifecycle ──
app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    app.dock.hide();
  }

  windowManager = new WindowManager();
  shortcutManager = new ShortcutManager(config, handleTrigger);
  trayManager = new TrayManager(config, windowManager, shortcutManager);

  shortcutManager.register();
  trayManager.create();
  registerIPC();

  // Start selection watcher for floating toolbar
  selectionWatcher = new SelectionWatcher();
  selectionWatcher.start(
    (sel) => windowManager.showToolbar({ x: sel.x, y: sel.y }),
    () => windowManager.hideToolbarDelayed(),
  );

  // Show onboarding on first launch
  if (!config.get('onboarding.completed')) {
    windowManager.showOnboarding();
  }
});

app.on('window-all-closed', () => {
  // Keep running in tray – do not quit
});

app.on('will-quit', () => {
  shortcutManager?.unregisterAll();
  selectionWatcher?.stop();
});

app.on('second-instance', () => {
  windowManager?.showSettings();
});

// ── Trigger handler ──
async function handleTrigger() {
  if (isProcessing) return;
  isProcessing = true;
  selectionWatcher?.pause();

  try {
    const text = await captureSelectedText();
    if (!text || text.trim().length === 0) {
      await windowManager.showResult(getLastTextFieldBounds());
      windowManager.sendToResult('polish:error', '未检测到选中的文本，请先选中需要润色的内容。');
      return;
    }

    await windowManager.showResult(getLastTextFieldBounds());
    windowManager.sendToResult('polish:original', text);
    windowManager.sendToResult('polish:progress', { stage: '正在分析文本...', percent: 5 });
    // Send current task mode so UI can display it
    const currentTask = config.get('pipeline.task') || 'polish';
    windowManager.sendToResult('polish:task', currentTask);

    lastOriginalText = text;

    const providerConfig = config.get('provider');
    const preset = PRESETS[providerConfig.preset] || PRESETS.custom;
    if (preset.needsKey && !providerConfig.apiKey) {
      windowManager.sendToResult(
        'polish:error',
        `${preset.name} 需要 API Key，请先在设置中填写。`,
      );
      return;
    }

    const provider = createProvider(providerConfig);
    const pipeline = new AgentPipeline(provider, config);

    const result = await pipeline.process(text, (progress) => {
      windowManager.sendToResult('polish:progress', progress);
    });

    windowManager.sendToResult('polish:result', result);
  } catch (err) {
    windowManager.sendToResult('polish:error', `处理失败: ${err.message}`);
  } finally {
    isProcessing = false;
    selectionWatcher?.resume();
  }
}

// ── IPC handlers ──
function registerIPC() {
  ipcMain.handle('config:get', () => config.getAll());
  ipcMain.handle('config:set', (_e, key, value) => config.set(key, value));

  ipcMain.handle('action:replace', async (_e, text) => {
    windowManager.hideResult();
    await new Promise(r => setTimeout(r, 300));
    await pasteText(text);
  });

  ipcMain.handle('action:copy', (_e, text) => clipboard.writeText(text));

  ipcMain.handle('window:open-settings', () => windowManager.showSettings());
  ipcMain.handle('window:close-result', () => windowManager.hideResult());

  ipcMain.handle('shortcut:get', () => config.get('shortcut'));
  ipcMain.handle('shortcut:set', (_e, acc) => {
    config.set('shortcut', acc);
    shortcutManager.register();
    return { success: true };
  });

  ipcMain.handle('ai:test-connection', async () => {
    try {
      const provider = createProvider(config.get('provider'));
      await provider.testConnection();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('presets:get', () => ({ presets: PRESETS, order: PRESET_ORDER }));

  ipcMain.handle('task:set', (_e, task) => {
    config.set('pipeline.task', task);
  });

  ipcMain.handle('task:get', () => config.get('pipeline.task') || 'polish');

  // Re-process with a different task (switch mode on the fly)
  ipcMain.handle('action:reprocess', async (_e, task) => {
    if (isProcessing) return;
    isProcessing = true;
    try {
      config.set('pipeline.task', task);
      windowManager.sendToResult('polish:task', task);
      windowManager.sendToResult('polish:progress', { stage: '正在分析文本...', percent: 5 });

      const providerConfig = config.get('provider');
      const preset = PRESETS[providerConfig.preset] || PRESETS.custom;
      if (preset.needsKey && !providerConfig.apiKey) {
        windowManager.sendToResult('polish:error', `${preset.name} 需要 API Key，请先在设置中填写。`);
        return;
      }

      const provider = createProvider(providerConfig);
      const pipeline = new AgentPipeline(provider, config);
      // lastOriginalText is stored globally for re-processing
      const text = lastOriginalText;
      if (!text) {
        windowManager.sendToResult('polish:error', '无原始文本可重新处理。');
        return;
      }

      const result = await pipeline.process(text, (progress) => {
        windowManager.sendToResult('polish:progress', progress);
      }, task);

      windowManager.sendToResult('polish:result', result);
    } catch (err) {
      windowManager.sendToResult('polish:error', `处理失败: ${err.message}`);
    } finally {
      isProcessing = false;
    }
  });

  ipcMain.handle('onboarding:complete', (_e, presetId) => {
    const preset = PRESETS[presetId];
    if (preset) {
      config.set('provider.preset', presetId);
      config.set('provider.apiUrl', preset.apiUrl);
      config.set('provider.model', preset.model);
    }
    config.set('onboarding.completed', true);
    windowManager.hideOnboarding();
  });

  ipcMain.handle('window:open-onboarding', () => windowManager.showOnboarding());

  // ── Toolbar action: user clicked 润色/降重 on the floating toolbar ──
  ipcMain.handle('toolbar:action', async (_e, task) => {
    windowManager.hideToolbar();
    // Set the task mode
    config.set('pipeline.task', task);
    // Trigger the main processing flow
    handleTrigger();
  });
}
