'use strict';

const { app, ipcMain, clipboard, shell, systemPreferences, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const ConfigStore = require('./src/config');
const WindowManager = require('./src/windows');
const ShortcutManager = require('./src/shortcuts');
const TrayManager = require('./src/tray');
const SelectionWatcher = require('./src/selection-watcher');
const { CommercialClient, COMMERCIAL_AVAILABLE } = require('./src/commercial');
const { UpdateManager } = require('./src/updater');
const {
  captureSelectedText,
  pasteText,
  applyTextEdit,
  getLastTextFieldBounds,
  getLastSelectionContext,
} = require('./src/capture');
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
const commercialClient = new CommercialClient(config);
let windowManager, shortcutManager, trayManager, selectionWatcher, updateManager;
let isProcessing = false;
let localServerProcess = null;
let lastOriginalText = '';
let lastAppliedReplacement = null;
let lastSelectionEditSession = null;
let lastSelectionAnchor = null;
let lastFieldBounds = null;
let lastSelectionSnapshot = null;
let pendingToolbarSnapshot = null;
let toolbarShowTimer = null;

function isLoopbackBackendUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || '').trim() || 'http://127.0.0.1:8787');
    return ['127.0.0.1', 'localhost'].includes(url.hostname);
  } catch (_) {
    return false;
  }
}

function getEmbeddedServerEntry() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'server', 'index.js');
  }
  return path.join(__dirname, 'server', 'index.js');
}

function getEmbeddedServerCwd() {
  return path.dirname(getEmbeddedServerEntry());
}

function resolveNodeExecutable() {
  const candidates = [
    process.env.RUNSHI_NODE_PATH,
    process.env.NODE_BINARY,
    path.join(os.homedir(), 'local', 'node', 'bin', 'node'),
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
    'node',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const result = spawnSync(candidate, ['-v'], {
        encoding: 'utf8',
        timeout: 3000,
      });
      const versionText = String(result.stdout || result.stderr || '').trim();
      const match = versionText.match(/^v(\d+)\./i);
      const major = match ? Number(match[1]) : 0;
      if (result.status === 0 && major >= 20) {
        return candidate;
      }
    } catch (_) {
      // Try next candidate.
    }
  }

  return '';
}

async function waitForLocalServer(baseUrl, timeoutMs = 15000) {
  const startedAt = Date.now();
  const healthUrl = `${String(baseUrl).replace(/\/+$/, '')}/api/health`;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return true;
    } catch (_) {
      // Retry until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  throw new Error('本地服务启动超时。');
}

async function ensureLocalCommercialServer() {
  const backendUrl = config.get('commercial.backendUrl') || 'http://127.0.0.1:8787';
  if (!isLoopbackBackendUrl(backendUrl)) {
    return false;
  }

  try {
    await waitForLocalServer(backendUrl, 1200);
    return true;
  } catch (_) {
    // Local server is not running yet; try to spawn it.
  }

  const entry = getEmbeddedServerEntry();
  if (!fs.existsSync(entry)) {
    console.error(`[runshi] local server entry missing: ${entry}`);
    return false;
  }

  const nodeExecutable = resolveNodeExecutable();
  if (!nodeExecutable) {
    console.error('[runshi] no usable Node.js executable found for local server');
    return false;
  }
  console.log(`[runshi] using node executable for local server: ${nodeExecutable}`);

  if (!localServerProcess || localServerProcess.exitCode != null) {
    localServerProcess = spawn(nodeExecutable, [entry], {
      cwd: getEmbeddedServerCwd(),
      env: process.env,
      stdio: 'ignore',
      windowsHide: true,
    });

    localServerProcess.on('exit', (code, signal) => {
      if (code !== 0 && signal !== 'SIGTERM') {
        console.error(`[runshi] local server exited unexpectedly: code=${code} signal=${signal || ''}`);
      }
      localServerProcess = null;
    });
  }

  try {
    await waitForLocalServer(backendUrl);
    return true;
  } catch (err) {
    console.error(`[runshi] local server failed to become healthy: ${err.message}`);
    return false;
  }
}

async function ensureCommercialBackendReady() {
  const backendUrl = config.get('commercial.backendUrl') || 'http://127.0.0.1:8787';
  if (!isLoopbackBackendUrl(backendUrl)) {
    return true;
  }

  const ready = await ensureLocalCommercialServer();
  if (!ready) {
    throw new Error('本地服务未启动成功，请重启应用后重试。');
  }
  return true;
}

function withCommercialBackend(action) {
  return async (...args) => {
    await ensureCommercialBackendReady();
    return action(...args);
  };
}

function stopLocalCommercialServer() {
  if (!localServerProcess || localServerProcess.exitCode != null) return;
  localServerProcess.kill('SIGTERM');
}

// ── App lifecycle ──
app.whenReady().then(async () => {
  await ensureLocalCommercialServer();

  if (isMac) {
    app.dock.setIcon(path.join(__dirname, 'assets', 'icon-1024.png'));
    app.dock.hide();
  }

  windowManager = new WindowManager();
  shortcutManager = new ShortcutManager(config, handleTrigger);
  trayManager = new TrayManager(config, windowManager, shortcutManager, handleToolbarToggle);
  updateManager = new UpdateManager({ app, config });

  const shortcutResult = shortcutManager.register();
  if (!shortcutResult?.success) {
    console.error(shortcutResult?.error || '快捷键注册失败');
    if (process.platform === 'win32') {
      new Notification({ title: '润石 PoliShit', body: '快捷键注册失败，请在设置中更换快捷键' }).show();
    }
  } else if (shortcutResult.fallback) {
    const display = shortcutResult.accelerator.replace('CommandOrControl', 'Ctrl').replace(/\+/g, '+');
    new Notification({ title: '润石 PoliShit', body: `默认快捷键被占用，已自动切换到 ${display}` }).show();
    trayManager?.refreshMenu();
  }
  trayManager.create();
  registerIPC();
  commercialClient.getStatus({ refresh: true }).catch(() => {});
  updateManager.start();

  // Start selection watcher for floating toolbar
  selectionWatcher = new SelectionWatcher({
    enabled: config.get('ui.floatingToolbarEnabled') !== false,
  });
  selectionWatcher.start(
    (sel) => {
      const snapshot = {
        text: sel.text || '',
        rawText: sel.rawText || sel.text || '',
        source: sel.source,
        at: Date.now(),
        point: { x: sel.x, y: sel.y },
        bounds: sel.bounds || null,
        fieldBounds: sel.fieldBounds || null,
        selectionContext: sel.selectionContext || null,
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

  // Show onboarding on first launch, otherwise show home
  if (!config.get('onboarding.completed')) {
    windowManager.showOnboarding();
  } else {
    windowManager.showHome();
  }
});

app.on('window-all-closed', () => {
  // Keep running in tray – do not quit
});

app.on('will-quit', () => {
  shortcutManager?.unregisterAll();
  selectionWatcher?.stop();
  updateManager?.stop();
  stopLocalCommercialServer();
});

app.on('second-instance', () => {
  // Show home window when user launches a second instance
  windowManager?.showHome();
});

// ── Shared pipeline runner (eliminates duplication across handlers) ──
async function runPipeline(text, { task, progressPrefix, temperatureOverride, modelOverride } = {}) {
  const currentTask = task || config.get('pipeline.task') || 'polish';
  windowManager.sendToResult('polish:task', currentTask);
  windowManager.sendToResult('polish:progress', { stage: progressPrefix || '正在分析文本...', percent: 5 });
  await sendCurrentModelInfo();

  const providerConfig = config.get('provider');
  const commercialCtx = getCommercialProviderContext();

  if (!commercialCtx) {
    const preset = PRESETS[providerConfig.preset] || PRESETS.custom;
    if (preset.needsKey && !providerConfig.apiKey) {
      windowManager.sendToResult('polish:error', `${preset.name} 需要 API Key，请先在设置中填写。`);
      return;
    }
  }

  if (commercialCtx) {
    const status = await commercialClient.getStatus({ refresh: true });
    if (Number(status.totalAvailable || 0) <= 0) {
      windowManager.sendToResult('polish:error', '积分不足，请先充值或签到获取积分。');
      return;
    }
  }

  // Handle model override (for reprocessWithModel)
  let prevModel;
  if (modelOverride) {
    prevModel = config.get('commercial.selectedModel');
    config.set('commercial.selectedModel', modelOverride);
    const modelList = await commercialClient.getModels();
    const modelDef = modelList.find(m => m.id === modelOverride);
    windowManager.sendToResult('polish:modelInfo', {
      modelId: modelOverride,
      modelName: modelDef?.name || modelOverride,
      credits: modelDef?.credits || 0,
      models: modelList,
    });
  }

  // Handle temperature override (for regenerate)
  let origTemp;
  if (temperatureOverride != null) {
    origTemp = config.get('pipeline.temperature') || 0.3;
    config.set('pipeline.temperature', temperatureOverride);
  }

  try {
    const provider = createProvider(config.get('provider'), getCommercialProviderContext());
    const pipeline = new AgentPipeline(provider, config);
    const result = await pipeline.process(text, (progress) => {
      windowManager.sendToResult('polish:progress', progress);
    }, currentTask);

    const { explainPromise, ...resultToSend } = result;
    windowManager.sendToResult('polish:result', resultToSend);
    if (explainPromise) {
      explainPromise.then((explanations) => {
        if (explanations?.length) {
          windowManager.sendToResult('polish:explanations', { explanations, changes: result.diff.changes });
        }
        windowManager.sendToResult('polish:progress', { stage: '完成', percent: 100 });
      }).catch(() => {});
    }

    await refreshCommercialAccount();
  } finally {
    if (origTemp != null) config.set('pipeline.temperature', origTemp);
  }
}

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
      && cachedSelection.text.trim().length > 0
      && Boolean(cachedSelection.selectionContext);
    const captureResult = shouldUseCached
      ? {
        text: cachedSelection.rawText || cachedSelection.text,
        selectionContext: cachedSelection.selectionContext || null,
      }
      : await captureSelectedText();
    const text = typeof captureResult === 'string' ? captureResult : captureResult?.text;
    const anchorBounds = getResultAnchorBounds();
    const resultMetrics = estimateResultWindowMetrics(text, anchorBounds);
    if (!text || text.trim().length === 0) {
      lastSelectionEditSession = null;
      await windowManager.showResult(anchorBounds, resultMetrics);
      windowManager.sendToResult('polish:error', '未检测到选中的文本，请先选中需要润色的内容。');
      return;
    }

    await windowManager.showResult(anchorBounds, resultMetrics);
    windowManager.sendToResult('polish:original', text);
    lastOriginalText = text;
    lastSelectionEditSession = buildSelectionEditSession(
      text,
      captureResult?.selectionContext || getLastSelectionContext(),
    );
    windowManager.sendToResult('polish:reviewContext', {
      surgicalEditing: Boolean(lastSelectionEditSession),
      platform: process.platform,
    });

    await runPipeline(text);
  } catch (err) {
    lastSelectionEditSession = null;
    windowManager.sendToResult('polish:error', `处理失败: ${err.message}`);
  } finally {
    isProcessing = false;
    selectionWatcher?.resume();
  }
}

async function sendCurrentModelInfo() {
  const commercial = config.get('commercial') || {};
  const commercialCtx = getCommercialProviderContext();
  const modelId = commercialCtx ? (commercial.selectedModel || 'kimi-k2.5') : (config.get('provider.model') || 'unknown');
  const modelList = commercialCtx ? await commercialClient.getModels() : [];
  const modelDef = modelList.find(m => m.id === modelId);
  windowManager.sendToResult('polish:modelInfo', {
    modelId,
    modelName: modelDef?.name || modelId,
    credits: modelDef?.credits || 0,
    models: modelList,
  });
}

function getResultAnchorBounds() {
  return lastSelectionAnchor || lastFieldBounds || getLastTextFieldBounds();
}

function getRecentSelectionSnapshot() {
  if (!lastSelectionSnapshot) return null;
  if (Date.now() - lastSelectionSnapshot.at > 8000) return null;
  return lastSelectionSnapshot;
}

function normalizeSelectionRange(range) {
  if (!range) return null;
  const location = Number(range.location);
  const length = Number(range.length);
  if (!Number.isFinite(location) || !Number.isFinite(length)) return null;
  if (location < 0 || length < 0) return null;
  return {
    location: Math.round(location),
    length: Math.round(length),
  };
}

function isWordBundleIdentifier(bundleIdentifier) {
  return String(bundleIdentifier || '').trim() === 'com.microsoft.Word';
}

function buildSelectionEditSession(text, selectionContext) {
  if (process.platform !== 'darwin') return null;
  const isWordSession = isWordBundleIdentifier(selectionContext?.bundleIdentifier);
  if (!selectionContext?.supportsRangeEditing && !isWordSession) return null;
  const selectionRange = normalizeSelectionRange(selectionContext.selectionRange);
  if (!selectionRange) return null;
  if ((selectionContext.text || '') !== text) return null;

  return {
    bundleIdentifier: selectionContext.bundleIdentifier || '',
    frontmostPid: Number.isFinite(Number(selectionContext.frontmostPid))
      ? Number(selectionContext.frontmostPid)
      : null,
    selectionStart: selectionRange.location,
    currentText: text,
    originalText: text,
    appliedChanges: new Map(),
    createdAt: Date.now(),
  };
}

function normalizeReviewChange(change) {
  if (!change || typeof change !== 'object') return null;
  if (!['replace', 'delete', 'insert'].includes(change.type)) return null;

  const originalStart = Number(change.originalStart);
  if (!Number.isFinite(originalStart) || originalStart < 0) return null;

  return {
    id: Number.isFinite(Number(change.id)) ? Number(change.id) : Date.now(),
    type: change.type,
    oldText: typeof change.oldText === 'string' ? change.oldText : '',
    newText: typeof change.newText === 'string' ? change.newText : '',
    originalStart,
    originalEnd: Number.isFinite(Number(change.originalEnd))
      ? Number(change.originalEnd)
      : originalStart + (typeof change.oldText === 'string' ? change.oldText.length : 0),
  };
}

function getAcceptedChangeDelta(change) {
  switch (change.type) {
    case 'replace':
      return change.newText.length - change.oldText.length;
    case 'delete':
      return -change.oldText.length;
    case 'insert':
      return change.newText.length;
    default:
      return 0;
  }
}

function getRelativeChangeStart(session, change, excludedChangeId = null) {
  let delta = 0;
  const applied = Array.from(session.appliedChanges.values()).sort((left, right) => {
    if (left.originalStart !== right.originalStart) {
      return left.originalStart - right.originalStart;
    }
    return left.id - right.id;
  });

  for (const appliedChange of applied) {
    if (excludedChangeId !== null && appliedChange.id === excludedChangeId) {
      continue;
    }
    if (
      appliedChange.originalStart < change.originalStart
      || (appliedChange.originalStart === change.originalStart && appliedChange.id < change.id)
    ) {
      delta += getAcceptedChangeDelta(appliedChange);
    }
  }

  return change.originalStart + delta;
}

function applyStringEdit(text, start, length, replacement) {
  return text.slice(0, start) + replacement + text.slice(start + length);
}

function buildForwardEdit(change) {
  switch (change.type) {
    case 'replace':
      return { targetLength: change.oldText.length, replacement: change.newText };
    case 'delete':
      return { targetLength: change.oldText.length, replacement: '' };
    case 'insert':
      return { targetLength: 0, replacement: change.newText };
    default:
      return { targetLength: 0, replacement: '' };
  }
}

function buildReverseEdit(change) {
  switch (change.type) {
    case 'replace':
      return { targetLength: change.newText.length, replacement: change.oldText };
    case 'delete':
      return { targetLength: 0, replacement: change.oldText };
    case 'insert':
      return { targetLength: change.newText.length, replacement: '' };
    default:
      return { targetLength: 0, replacement: '' };
  }
}

async function performStandardReplace(text) {
  windowManager.hideResult();
  await new Promise(r => setTimeout(r, 300));
  lastSelectionEditSession = null;

  if (process.platform === 'win32') {
    clipboard.writeText(text);
    lastAppliedReplacement = null;
    new Notification({ title: '润石 PoliShit', body: '已将选用版本保留到剪贴板，请在目标位置粘贴；若插错位置，可撤回后再次粘贴。' }).show();
    return { ok: true, mode: 'clipboard' };
  }

  await pasteText(text, { restoreClipboardAfterPaste: false });
  lastAppliedReplacement = {
    originalText: lastOriginalText,
    replacedText: text,
    at: Date.now(),
  };
  windowManager.showUndoToast();
  return { ok: true, mode: 'replace' };
}

async function applyReviewChangeInSource(change, mode = 'accept') {
  const session = lastSelectionEditSession;
  if (process.platform !== 'darwin' || !session) {
    return { ok: false, error: '当前应用暂不支持逐条原位修订。' };
  }

  const isRevert = mode === 'revert';
  const alreadyApplied = session.appliedChanges.has(change.id);

  if (!isRevert && alreadyApplied) {
    return { ok: true, applied: true, currentText: session.currentText };
  }
  if (isRevert && !alreadyApplied) {
    return { ok: true, applied: false, currentText: session.currentText };
  }

  const relativeStart = getRelativeChangeStart(session, change, isRevert ? change.id : null);
  const edit = isRevert ? buildReverseEdit(change) : buildForwardEdit(change);
  const selectionRequest = {
    bundleIdentifier: session.bundleIdentifier,
    frontmostPid: session.frontmostPid,
    expectedText: session.currentText,
    selectionRange: {
      location: session.selectionStart,
      length: session.currentText.length,
    },
    targetRange: {
      location: session.selectionStart + relativeStart,
      length: edit.targetLength,
    },
  };

  const result = await applyTextEdit(selectionRequest, edit.replacement, { restoreClipboard: true });
  if (!result?.ok) {
    windowManager.focusResult?.();
    return { ok: false, error: result?.error || '原位修订失败。' };
  }

  if (Number.isFinite(Number(result?.selectionRange?.location))) {
    session.selectionStart = Number(result.selectionRange.location);
  }
  session.currentText = applyStringEdit(session.currentText, relativeStart, edit.targetLength, edit.replacement);
  if (isRevert) {
    session.appliedChanges.delete(change.id);
  } else {
    session.appliedChanges.set(change.id, change);
  }
  windowManager.focusResult?.();
  return { ok: true, applied: true, currentText: session.currentText };
}

async function finalizeSurgicalReview(finalText) {
  const session = lastSelectionEditSession;
  if (!session || process.platform !== 'darwin') {
    return performStandardReplace(finalText);
  }

  if (finalText === session.currentText) {
    lastSelectionEditSession = null;
    windowManager.hideResult();
    return { ok: true, mode: 'surgical-noop' };
  }

  const selectionRequest = {
    bundleIdentifier: session.bundleIdentifier,
    frontmostPid: session.frontmostPid,
    expectedText: session.currentText,
    selectionRange: {
      location: session.selectionStart,
      length: session.currentText.length,
    },
    targetRange: {
      location: session.selectionStart,
      length: session.currentText.length,
    },
  };

  const result = await applyTextEdit(selectionRequest, finalText, { restoreClipboard: true });
  if (!result?.ok) {
    windowManager.focusResult?.();
    return { ok: false, error: result?.error || '无法完成最终原位修订。' };
  }

  lastSelectionEditSession = null;
  windowManager.hideResult();
  return { ok: true, mode: 'surgical-finalize' };
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
  // Result contains annotations (~2x) + full revised text (~1x) ≈ 3x original density
  const contentDensity = Math.ceil(density * 2.8);
  const preferredWidth = Math.max(560, Math.min(720, 500 + Math.ceil(normalized.length / 150) * 20));
  const preferredHeight = Math.max(
    420,
    Math.min(960, 260 + contentDensity * 22),
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

function getCommercialProviderContext() {
  const commercial = config.get('commercial') || {};
  if (
    !COMMERCIAL_AVAILABLE
    || commercial.enabled === false
    || commercial.preferredSource === 'direct'
    || !commercial.backendUrl
    || !commercial.authToken
  ) {
    return null;
  }

  return {
    enabled: true,
    backendUrl: commercial.backendUrl,
    authToken: commercial.authToken,
    selectedModel: commercial.selectedModel || '',
    onUnauthorized: () => commercialClient.clearSession(),
  };
}

async function refreshCommercialAccount() {
  try {
    return await commercialClient.getStatus({ refresh: true });
  } catch (_) {
    return commercialClient.getStatus();
  }
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
  ipcMain.handle('config:get', () => {
    const all = JSON.parse(JSON.stringify(config.getAll()));
    if (all.commercial) {
      all.commercial.available = COMMERCIAL_AVAILABLE;
      delete all.commercial.authToken;
    }
    all.appVersion = app.getVersion();
    return all;
  });
  ipcMain.handle('config:set', (_e, key, value) => config.set(key, value));

  ipcMain.handle('action:replace', async (_e, text) => {
    return performStandardReplace(text);
  });

  ipcMain.handle('action:apply-review-change', async (_e, change, mode) => {
    const normalizedChange = normalizeReviewChange(change);
    if (!normalizedChange) {
      return { ok: false, error: '修改数据无效。' };
    }
    return applyReviewChangeInSource(normalizedChange, mode);
  });

  ipcMain.handle('action:finalize-review', async (_e, finalText) => {
    if (typeof finalText !== 'string') {
      return { ok: false, error: '最终文本无效。' };
    }
    return finalizeSurgicalReview(finalText);
  });

  ipcMain.handle('action:rollback-last-replace', async () => {
    if (!lastAppliedReplacement?.originalText) {
      return { ok: false };
    }

    await pasteText(lastAppliedReplacement.originalText, { restoreClipboardAfterPaste: true });
    lastAppliedReplacement = null;
    windowManager.hideUndoToast();
    new Notification({ title: '润石 PoliShit', body: '已回档到替换前的原文。' }).show();
    return { ok: true };
  });

  ipcMain.handle('undo:close', () => {
    windowManager.hideUndoToast();
  });

  ipcMain.handle('action:copy', (_e, text) => clipboard.writeText(text));

  ipcMain.handle('window:open-settings', () => windowManager.showSettings());
  ipcMain.handle('window:open-home', () => windowManager.showHome());

  ipcMain.handle('shell:open-external', (_e, url) => {
    // Only allow https URLs to prevent arbitrary command execution
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
  });
  ipcMain.handle('window:close-result', () => windowManager.hideResult());

  ipcMain.handle('shortcut:get', () => config.get('shortcut'));
  ipcMain.handle('shortcut:set', (_e, acc) => {
    const previousAccelerator = config.get('shortcut') || 'CommandOrControl+Alt+V';
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
      const provider = createProvider(
        config.get('provider'),
        getCommercialProviderContext(),
      );
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
      const text = lastOriginalText;
      if (!text) {
        windowManager.sendToResult('polish:error', '无原始文本可重新处理。');
        return;
      }
      await runPipeline(text, { task });
    } catch (err) {
      windowManager.sendToResult('polish:error', `处理失败: ${err.message}`);
    } finally {
      isProcessing = false;
    }
  });

  // Regenerate: re-run the same task with higher temperature for variation
  ipcMain.handle('action:regenerate', async () => {
    if (isProcessing) return;
    isProcessing = true;
    try {
      const text = lastOriginalText;
      if (!text) {
        windowManager.sendToResult('polish:error', '无原始文本可重新处理。');
        return;
      }
      const origTemp = config.get('pipeline.temperature') || 0.3;
      await runPipeline(text, {
        progressPrefix: '正在重新生成...',
        temperatureOverride: Math.min(origTemp + 0.3, 1.0),
      });
    } catch (err) {
      windowManager.sendToResult('polish:error', `处理失败: ${err.message}`);
    } finally {
      isProcessing = false;
    }
  });

  // Recapture: grab new selection and reprocess
  ipcMain.handle('action:recapture', async () => {
    if (isProcessing) return;
    handleTrigger();
  });

  // Reprocess with a specific model
  ipcMain.handle('action:reprocessWithModel', async (_e, modelId) => {
    if (isProcessing) return;
    isProcessing = true;
    try {
      const text = lastOriginalText;
      if (!text) {
        windowManager.sendToResult('polish:error', '无原始文本可重新处理。');
        return;
      }
      await runPipeline(text, {
        modelOverride: modelId,
        progressPrefix: `正在用 ${modelId} 生成...`,
      });
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
    windowManager.showHome();
  });

  ipcMain.handle('window:open-onboarding', () => windowManager.showOnboarding());

  // ── Toolbar action: user clicked 润色/降AIGC on the floating toolbar ──
  ipcMain.handle('toolbar:action', async (_e, task) => {
    windowManager.hideToolbar();
    // Set the task mode
    config.set('pipeline.task', task);
    // Trigger the main processing flow
    handleTrigger({ preferCachedSelection: true });
  });

  ipcMain.handle('toolbar:get-status', () => getToolbarStatus());
  ipcMain.handle('toolbar:set-enabled', (_e, enabled) => handleToolbarToggle(enabled));
  ipcMain.handle('commercial:get-status', withCommercialBackend(() => commercialClient.getStatus()));
  ipcMain.handle('commercial:refresh-status', withCommercialBackend(() => commercialClient.getStatus({ refresh: true })));
  ipcMain.handle('commercial:save-settings', async (_e, payload) => {
    const result = await commercialClient.saveSettings(payload);
    await ensureCommercialBackendReady();
    return result;
  });
  ipcMain.handle('commercial:test-backend', withCommercialBackend(() => commercialClient.testBackend()));
  ipcMain.handle('commercial:get-plans', withCommercialBackend(() => commercialClient.getPlans()));
  ipcMain.handle('commercial:getModels', withCommercialBackend(() => commercialClient.getModels()));
  ipcMain.handle('commercial:send-code', withCommercialBackend((_e, phone) => commercialClient.sendCode(phone)));
  ipcMain.handle('commercial:login', withCommercialBackend((_e, phone, code) => commercialClient.login(phone, code)));
  ipcMain.handle('commercial:register', withCommercialBackend((_e, email, password) => commercialClient.register(email, password)));
  ipcMain.handle('commercial:login-email', withCommercialBackend((_e, email, password) => commercialClient.loginEmail(email, password)));
  ipcMain.handle('commercial:subscribe', withCommercialBackend((_e, planId) => commercialClient.subscribe(planId)));
  ipcMain.handle('commercial:create-order', withCommercialBackend((_e, provider, planId) => commercialClient.createOrder(provider, planId)));
  ipcMain.handle('commercial:get-order', withCommercialBackend((_e, orderId) => commercialClient.getOrder(orderId)));
  ipcMain.handle('commercial:logout', withCommercialBackend(() => commercialClient.logout()));
  ipcMain.handle('commercial:checkin', withCommercialBackend(() => commercialClient.checkin()));
  ipcMain.handle('commercial:release-lock', withCommercialBackend(() => commercialClient.releaseLock()));
  ipcMain.handle('commercial:checkin-status', withCommercialBackend(() => commercialClient.getCheckinStatus()));
  ipcMain.handle('updates:get-status', () => updateManager?.getStatus());
  ipcMain.handle('updates:check', () => updateManager?.checkForUpdates({ force: true }));
  ipcMain.handle('updates:open-download', () => updateManager?.openLatestRelease());
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
