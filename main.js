'use strict';

const { app, ipcMain, clipboard, shell, systemPreferences } = require('electron');
const ConfigStore = require('./src/config');
const WindowManager = require('./src/windows');
const ShortcutManager = require('./src/shortcuts');
const TrayManager = require('./src/tray');
const SelectionWatcher = require('./src/selection-watcher');
const { captureSelectedText, pasteText, getLastTextFieldBounds } = require('./src/capture');
const { AgentPipeline } = require('./src/ai/pipeline');
const { createProvider } = require('./src/ai/provider-factory');
const { PRESETS, PRESET_ORDER } = require('./src/ai/presets');

const isMac = process.platform === 'darwin';

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
let lastSelectionAnchor = null;
let lastFieldBounds = null;
let lastSelectionSnapshot = null;
let pendingToolbarSnapshot = null;
let toolbarShowTimer = null;

// ── App lifecycle ──
app.whenReady().then(() => {
  if (isMac) {
    app.dock.hide();
  }

  windowManager = new WindowManager();
  shortcutManager = new ShortcutManager(config, handleTrigger);
  trayManager = new TrayManager(config, windowManager, shortcutManager, handleToolbarToggle);

  const shortcutResult = shortcutManager.register();
  if (!shortcutResult?.success) {
    console.error(shortcutResult?.error || '快捷键注册失败');
  }
  trayManager.create();
  registerIPC();

  // Start selection watcher for floating toolbar
  selectionWatcher = new SelectionWatcher({
    enabled: config.get('ui.floatingToolbarEnabled') !== false,
  });
  selectionWatcher.start(
    (sel) => {
      const snapshot = {
        text: sel.text || '',
        source: sel.source,
        at: Date.now(),
        point: { x: sel.x, y: sel.y },
        bounds: sel.bounds || null,
        fieldBounds: sel.fieldBounds || null,
      };
      lastSelectionSnapshot = snapshot;
      lastSelectionAnchor = snapshot.bounds || { x: sel.x, y: sel.y, width: 1, height: 1 };
      lastFieldBounds = sel.fieldBounds || null;
      scheduleToolbarShow(snapshot);
      if (sel.source === 'clipboard') {
        windowManager.hideToolbarDelayed(5000);
      }
    },
    () => {
      clearToolbarShowTimer();
      pendingToolbarSnapshot = null;
      windowManager.hideToolbarDelayed();
    },
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
  // Only bring an existing visible window to front; don't auto-open settings
  if (windowManager?.settingsWindow && !windowManager.settingsWindow.isDestroyed()) {
    windowManager.settingsWindow.focus();
  } else if (windowManager?.resultWindow && !windowManager.resultWindow.isDestroyed()) {
    windowManager.resultWindow.focus();
  }
  // else: app is running silently in tray – do nothing
});

// ── Trigger handler ──
async function handleTrigger(options = {}) {
  if (isProcessing) return;
  isProcessing = true;
  clearToolbarShowTimer();
  selectionWatcher?.pause();

  try {
    const cachedSelection = getRecentSelectionSnapshot();
    const shouldUseCached = options.preferCachedSelection === true
      && cachedSelection
      && cachedSelection.text
      && cachedSelection.text.trim().length > 0;
    const text = shouldUseCached ? cachedSelection.text : await captureSelectedText();
    const anchorBounds = getResultAnchorBounds();
    const resultMetrics = estimateResultWindowMetrics(text, anchorBounds);
    if (!text || text.trim().length === 0) {
      await windowManager.showResult(anchorBounds, resultMetrics);
      windowManager.sendToResult('polish:error', '未检测到选中的文本，请先选中需要润色的内容。');
      return;
    }

    await windowManager.showResult(anchorBounds, resultMetrics);
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

function getResultAnchorBounds() {
  return lastSelectionAnchor || lastFieldBounds || getLastTextFieldBounds();
}

function getRecentSelectionSnapshot() {
  if (!lastSelectionSnapshot) return null;
  if (Date.now() - lastSelectionSnapshot.at > 8000) return null;
  return lastSelectionSnapshot;
}

function clearToolbarShowTimer() {
  if (toolbarShowTimer) {
    clearTimeout(toolbarShowTimer);
    toolbarShowTimer = null;
  }
}

function scheduleToolbarShow(snapshot) {
  clearToolbarShowTimer();
  pendingToolbarSnapshot = snapshot;
  toolbarShowTimer = setTimeout(() => {
    toolbarShowTimer = null;
    if (!pendingToolbarSnapshot || pendingToolbarSnapshot !== snapshot) return;
    const current = getRecentSelectionSnapshot();
    if (!current || current !== snapshot) return;
    windowManager.showToolbar(
      snapshot.bounds
      || snapshot.fieldBounds
      || {
        x: snapshot.point.x,
        y: snapshot.point.y,
        width: 1,
        height: 1,
      },
    );
    pendingToolbarSnapshot = null;
  }, 500);
}

function estimateResultWindowMetrics(text, anchorBounds) {
  const normalized = (text || '').trim();
  const lineCount = normalized ? normalized.split(/\r?\n/).length : 1;
  const density = Math.max(lineCount, Math.ceil(normalized.length / 60));
  const preferredWidth = Math.max(520, Math.min(680, 480 + Math.ceil(normalized.length / 200) * 20));
  const preferredHeight = Math.max(
    300,
    Math.min(800, 220 + density * 22),
  );

  return { preferredWidth, preferredHeight };
}

function getToolbarStatus() {
  const enabled = config.get('ui.floatingToolbarEnabled') !== false;
  return {
    enabled,
    platform: process.platform,
    accessibilityTrusted: isMac ? systemPreferences.isTrustedAccessibilityClient(false) : null,
    selectionMonitoringAvailable: isMac,
    copyFallbackAvailable: true,
  };
}

function handleToolbarToggle(enabled) {
  const normalized = Boolean(enabled);
  config.set('ui.floatingToolbarEnabled', normalized);
  selectionWatcher?.setEnabled(normalized);
  if (!normalized) {
    windowManager?.hideToolbar();
  }
  trayManager?.refreshMenu();
  return getToolbarStatus();
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
    const previousAccelerator = config.get('shortcut') || 'CommandOrControl+Shift+A';
    const result = shortcutManager.register(acc);
    if (!result?.success) {
      const rollback = shortcutManager.register(previousAccelerator);
      if (!rollback?.success) {
        console.error(rollback?.error || '快捷键回滚失败');
      }
      return result;
    }

    config.set('shortcut', acc);
    trayManager?.refreshMenu();
    return result;
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
      if (!preset.needsKey) {
        config.set('provider.apiKey', '');
      }
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
    handleTrigger({ preferCachedSelection: true });
  });

  ipcMain.handle('toolbar:get-status', () => getToolbarStatus());
  ipcMain.handle('toolbar:set-enabled', (_e, enabled) => handleToolbarToggle(enabled));
  ipcMain.handle('toolbar:open-accessibility-settings', async () => {
    if (isMac) {
      try {
        systemPreferences.isTrustedAccessibilityClient(true);
      } catch (_) {
        // Ignore prompt errors and still attempt to open System Settings.
      }

      try {
        await shell.openExternal(
          'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
        );
      } catch (_) {
        // Ignore failures; the user can still navigate manually.
      }
    }

    return getToolbarStatus();
  });
}
