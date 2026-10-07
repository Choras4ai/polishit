'use strict';

const { app, ipcMain, clipboard, shell, systemPreferences, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const dotenv = require('dotenv');
const ConfigStore = require('./src/config');
const WindowManager = require('./src/windows');
const ShortcutManager = require('./src/shortcuts');
const TrayManager = require('./src/tray');
const SelectionWatcher = require('./src/selection-watcher');
const { CommercialClient, COMMERCIAL_AVAILABLE } = require('./src/commercial');
const { UpdateManager } = require('./src/updater');
const {
  captureSelectedText,
  probeWordSelectionContext,
  pasteText,
  applyTextEdit,
  getLastTextFieldBounds,
  getLastSelectionContext,
  restoreFrontApp,
  reviewSourceGeometry,
} = require('./src/capture');
const { SourceReview } = require('./src/source-review');
const { AgentPipeline } = require('./src/ai/pipeline');
const { createProvider } = require('./src/ai/provider-factory');
const { PRESETS, PRESET_ORDER } = require('./src/ai/presets');
const { normalizeReviewChange, isReviewChangeApplicable, restoreReplacement } = require('./src/review-state');

const isMac = process.platform === 'darwin';
const ROOT_ENV_PATH = path.join(__dirname, '.env');
const rootEnvParsed = process.env.RUNSHI_LOAD_DOTENV === '0' ? {} : (dotenv.config({ path: ROOT_ENV_PATH, quiet: true }).parsed || {});
for (const [key, value] of Object.entries(rootEnvParsed)) {
  if (process.env[key] == null || process.env[key] === '') {
    process.env[key] = value;
  }
}

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
let localServerSpawning = null; // Promise lock to prevent concurrent spawns
let lastOriginalText = '';
let lastAppliedReplacement = null;
let lastSelectionEditSession = null;
let lastSelectionAnchor = null;
let lastFieldBounds = null;
let lastSelectionSnapshot = null;
let pendingToolbarSnapshot = null;
let toolbarShowTimer = null;
let activeRunToken = 0;
let pendingRecaptureRequest = false;
let toolbarTestMode = false;
let sourceReview = null;
let sourceReviewData = null;

const DEFAULT_SELECTION_CACHE_MAX_AGE_MS = 8000;
const MANUAL_REFRESH_SELECTION_CACHE_MAX_AGE_MS = 60000;

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
  // The packaged Electron binary provides Node; users need no separate install.
  return process.execPath;
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

  // Prevent concurrent spawn attempts
  if (localServerSpawning) {
    try { return await localServerSpawning; } catch (_) { /* fall through to re-spawn */ }
  }

  const spawnPromise = (async () => {
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
      console.log('[runshi] spawning local server with RUNSHI_SILICONFLOW_API_KEY present:', Boolean(process.env.RUNSHI_SILICONFLOW_API_KEY));
      localServerProcess = spawn(nodeExecutable, [entry], {
        cwd: getEmbeddedServerCwd(),
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          RUNSHI_SERVER_HOST: new URL(backendUrl).hostname,
          RUNSHI_SERVER_PORT: new URL(backendUrl).port || '8787',
          ...(app.isPackaged ? {
            RUNSHI_LOAD_DOTENV: '0',
            RUNSHI_SERVER_DB: path.join(app.getPath('userData'), 'data', 'commercial.sqlite3'),
          } : {}),
        },
        stdio: 'ignore',
        windowsHide: true,
      });

      localServerProcess.on('error', err => console.error('[runshi] local server process failed:', err.message));
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
      // Kill the dead process so next attempt can re-spawn
      if (localServerProcess && localServerProcess.exitCode == null) {
        localServerProcess.kill('SIGTERM');
        localServerProcess = null;
      }
      return false;
    }
  })();

  localServerSpawning = spawnPromise;
  try {
    return await spawnPromise;
  } finally {
    localServerSpawning = null;
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
  sourceReview = new SourceReview({ geometry: reviewSourceGeometry, getState: getSourceReviewState,
    apply: (change, action, token) => withSourceEdit(async () => {
      const state = getSourceReviewState();
      if (!state || state.token !== token || !state.changes.some(c => c.id === change.id)) {
        return { ok: false, error: '这组原文修订已经过期。' };
      }
      if (action === 'ignore') { sourceReviewData.ignored.add(change.id); return { ok: true }; }
      return applyReviewChangeInSource(change, 'accept', { sourceOverlay: true });
    }),
    onDecision: event => windowManager.sendToResult('polish:source-decision', event),
    onStatus: event => windowManager.sendToResult('polish:source-status', event),
    openResult: () => windowManager.focusResult(),
  });
  windowManager.onResultClosed = () => sourceReview?.stop();
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
      toolbarTestMode = false;
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
  sourceReview?.destroy();
  shortcutManager?.unregisterAll();
  selectionWatcher?.stop();
  updateManager?.stop();
  stopLocalCommercialServer();
});

app.on('second-instance', () => {
  // Show home window when user launches a second instance
  windowManager?.showHome();
});

// A tray-only macOS app receives `activate` (rather than `second-instance`)
// when its Dock/Finder icon is opened again. Reopen the home window so users
// are never left with an apparently unresponsive background process.
app.on('activate', () => {
  windowManager?.showHome();
});

// ── Shared pipeline runner (eliminates duplication across handlers) ──
async function runPipeline(text, { task, progressPrefix, temperatureOverride, modelOverride } = {}) {
  sourceReview?.stop(); sourceReviewData = null;
  const runToken = ++activeRunToken;
  const isActiveRun = () => runToken === activeRunToken;
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
  try {
    if (commercialCtx) {
      const modelList = await commercialClient.getModels();
      let modelDef = modelList.find(m => m.id === (modelOverride || commercialCtx.selectedModel));
      if (modelOverride && !modelDef) throw new Error('所选模型已下架，请刷新模型列表后重新选择。');
      if (!modelDef) modelDef = modelList.find(m => m.isDefault) || modelList[0];
      if (!modelDef) throw new Error('暂时无法获取可用模型，请稍后重试。');
      commercialCtx.selectedModel = modelDef.id;
      config.set('commercial.selectedModel', modelDef.id);
      windowManager.sendToResult('polish:modelInfo', {
        modelId: modelDef.id,
        modelName: modelDef.name,
        credits: modelDef.credits,
        models: modelList,
      });
    }

    const provider = createProvider(providerConfig, commercialCtx && {
      ...commercialCtx,
      selectedModel: modelOverride || commercialCtx.selectedModel,
    });
    const pipeline = new AgentPipeline(provider, config, { temperature: temperatureOverride });
    const result = await pipeline.process(text, (progress) => {
      if (isActiveRun()) windowManager.sendToResult('polish:progress', progress);
    }, currentTask);

    if (!isActiveRun()) return;

    const { explainPromise, ...resultToSend } = result;
    if (lastSelectionEditSession) {
      sourceReviewData = { token: `${runToken}:${lastSelectionEditSession.createdAt}:${lastSelectionEditSession.generation}`,
        session: lastSelectionEditSession, generation: lastSelectionEditSession.generation,
        changes: (result.diff?.changes || []).filter(c => normalizeReviewChange(c)).map(c => ({ ...c })), ignored: new Set() };
      resultToSend.sourceReviewToken = sourceReviewData.token;
    }
    windowManager.sendToResult('polish:result', resultToSend);
    if (explainPromise) {
      explainPromise.then((explanations) => {
        if (!isActiveRun()) return;
        if (explanations?.length) {
          if (sourceReviewData?.session === lastSelectionEditSession) {
            // Pipeline updates its own change objects with the matched reasons.
            for (const change of sourceReviewData.changes) {
              const explained = result.diff.changes.find(c => c.id === change.id);
              if (explained) Object.assign(change, { reason: explained.reason, errorType: explained.errorType });
            }
          }
          windowManager.sendToResult('polish:explanations', { explanations, changes: result.diff.changes });
        }
        windowManager.sendToResult('polish:progress', { stage: '完成', percent: 100 });
      }).catch((err) => { console.error('[runshi] explainPromise error:', err.message); });
    }

    await refreshCommercialAccount();
    return result;
  } catch (err) {
    if (!isActiveRun()) return;
    throw err;
  }
}

async function generateAlternativeVersions(text, task, primaryText, runToken) {
  if (config.get('ui.multipleVersionsEnabled') === false) return;
  if (runToken !== activeRunToken) return;
  const baseTemperature = Number(config.get('pipeline.temperature') ?? 0.3);
  const temperatures = [Math.max(0.45, baseTemperature + 0.2), Math.min(0.9, Math.max(0.65, baseTemperature + 0.4))];
  const seen = new Set([String(primaryText || '').trim()]);
  let delivered = 0;

  windowManager.sendToResult('polish:variant-progress', {
    enabled: true,
    current: 0,
    total: temperatures.length,
    done: false,
  });

  for (let index = 0; index < temperatures.length; index += 1) {
    if (runToken !== activeRunToken) return;
    try {
      const provider = createProvider(config.get('provider'), getCommercialProviderContext());
      const pipeline = new AgentPipeline(provider, config, { temperature: temperatures[index] });
      const result = await pipeline.process(text, () => {}, task, { skipExplanations: true });
      if (runToken !== activeRunToken) return;
      const normalized = String(result?.polishedText || '').trim();
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        delivered += 1;
        windowManager.sendToResult('polish:variant', {
          ...result,
          variantIndex: delivered,
        });
      }
      windowManager.sendToResult('polish:variant-progress', {
        enabled: true,
        current: index + 1,
        total: temperatures.length,
        done: index === temperatures.length - 1,
      });
    } catch (err) {
      console.error('[runshi] alternative version failed:', err.message);
      windowManager.sendToResult('polish:variant-progress', {
        enabled: true,
        current: index + 1,
        total: temperatures.length,
        done: true,
        error: /积分|余额|credit/i.test(err.message) ? '积分不足，已保留当前方案' : '其他方案暂未生成',
      });
      break;
    }
  }
}

function runPendingRecaptureIfNeeded() {
  if (!pendingRecaptureRequest || isProcessing || isApplyingSourceEdit) return;
  pendingRecaptureRequest = false;
  setImmediate(() => {
    handleTrigger({
      preferCachedSelection: true,
      selectionCacheMaxAgeMs: MANUAL_REFRESH_SELECTION_CACHE_MAX_AGE_MS,
    });
  });
}

// ── Trigger handler ──
async function handleTrigger(options = {}) {
  if (isProcessing || isApplyingSourceEdit) return;
  sourceReview?.stop(); sourceReviewData = null;
  isProcessing = true;
  clearToolbarShowTimer();
  selectionWatcher?.pause();

  try {
    const cachedSelection = getRecentSelectionSnapshot(options.selectionCacheMaxAgeMs);
    const shouldUseCached = options.preferCachedSelection === true
      && cachedSelection
      && cachedSelection.text
      && cachedSelection.text.trim().length > 0
      && Boolean(cachedSelection.selectionContext);
    let captureResult = shouldUseCached
      ? {
        text: cachedSelection.rawText || cachedSelection.text,
        selectionContext: cachedSelection.selectionContext || null,
      }
      : await captureSelectedText();
    if (shouldUseCached && isWordBundleIdentifier(cachedSelection.selectionContext?.bundleIdentifier)) {
      const context = await probeWordSelectionContext().catch(() => null);
      captureResult = { text: context?.text || '', selectionContext: context };
    }
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
      writeMode: lastSelectionEditSession ? 'inline' : 'copy',
    });

    const primaryResult = await runPipeline(text);
    const activeTask = config.get('pipeline.task') || 'polish';
    if (
      activeTask === 'polish'
      && primaryResult?.polishedText
      && config.get('ui.multipleVersionsEnabled') !== false
    ) {
      const variantRunToken = activeRunToken;
      Promise.resolve(primaryResult.explainPromise)
        .catch(() => [])
        .then(() => generateAlternativeVersions(text, activeTask, primaryResult.polishedText, variantRunToken))
        .catch((err) => console.error('[runshi] background variants failed:', err.message));
    }
  } catch (err) {
    lastSelectionEditSession = null;
    if (!pendingRecaptureRequest) {
      windowManager.sendToResult('polish:error', `处理失败: ${err.message}`);
    }
  } finally {
    isProcessing = false;
    offerWordSourceReview();
    selectionWatcher?.resume();
    runPendingRecaptureIfNeeded();
  }
}

async function sendCurrentModelInfo() {
  try {
    const commercial = config.get('commercial') || {};
    const commercialCtx = getCommercialProviderContext();
    const modelList = commercialCtx ? await commercialClient.getModels() : [];
    const modelDef = modelList.find(m => m.id === commercial.selectedModel) || modelList.find(m => m.isDefault) || modelList[0];
    const modelId = commercialCtx ? (modelDef?.id || '') : (config.get('provider.model') || 'unknown');
    windowManager.sendToResult('polish:modelInfo', {
      modelId,
      modelName: modelDef?.name || modelId,
      credits: modelDef?.credits || 0,
      models: modelList,
    });
  } catch (err) {
    console.error('[runshi] sendCurrentModelInfo failed:', err.message);
  }
}

function getResultAnchorBounds() {
  return lastSelectionAnchor || lastFieldBounds || getLastTextFieldBounds();
}

function getRecentSelectionSnapshot(maxAgeMs = DEFAULT_SELECTION_CACHE_MAX_AGE_MS) {
  if (!lastSelectionSnapshot) return null;
  if (Date.now() - lastSelectionSnapshot.at > maxAgeMs) return null;
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
  const isWindowsWord = process.platform === 'win32' && selectionContext?.bundleIdentifier === 'win32.word';
  if (process.platform !== 'darwin' && !isWindowsWord) return null;
  const isWordSession = isWordBundleIdentifier(selectionContext?.bundleIdentifier);
  if (isWordSession && !selectionContext?.documentId) return null;
  if (!selectionContext?.supportsRangeEditing && !isWordSession) return null;
  if (!isWordSession && !isWindowsWord && !selectionContext?.elementToken) return null;
  if (isWindowsWord && (!selectionContext.documentId || !selectionContext.windowHandle)) return null;
  const selectionRange = normalizeSelectionRange(selectionContext.selectionRange);
  if (!selectionRange) return null;
  if ((selectionContext.text || '') !== text) return null;

  return {
    documentId: selectionContext.documentId || null,
    windowHandle: selectionContext.windowHandle || null,
    geometryContext: selectionContext.geometryContext || null,
    bundleIdentifier: selectionContext.bundleIdentifier || '',
    frontmostPid: Number.isFinite(Number(selectionContext.frontmostPid))
      ? Number(selectionContext.frontmostPid)
      : null,
    elementToken: String(selectionContext.elementToken || ''),
    selectionStart: selectionRange.location,
    currentText: text,
    originalText: text,
    appliedChanges: new Map(),
    generation: 1,
    sourceStateUncertain: false,
    createdAt: Date.now(),
  };
}

function getSourceReviewState() {
  const data = sourceReviewData, session = lastSelectionEditSession;
  if (!data || data.session !== session || session.generation !== data.generation) return null;
  const changes = data.changes.filter(c => !session.appliedChanges.has(c.id) && !data.ignored.has(c.id));
  const context = session.geometryContext || { frontmostPid: session.frontmostPid, elementToken: session.elementToken,
    selectionRange: { location: session.selectionStart } };
  const location = context.selectionRange.location;
  return { token: data.token, changes, uncertain: session.sourceStateUncertain,
    request: { ...context, bundleIdentifier: session.bundleIdentifier, documentId: session.documentId,
      windowHandle: session.windowHandle, expectedText: session.bundleIdentifier === 'com.microsoft.Word' && context.wordParagraphSeparator === 'LF'
        ? session.currentText.replace(/\r/g, '\n') : session.currentText,
      selectionRange: { location, length: session.currentText.length },
      ranges: changes.slice(0, 32).map(c => ({ id: c.id, location: location + getRelativeChangeStart(session, c), length: c.oldText.length })) } };
}

function offerWordSourceReview() {
  if (!isMac || pendingRecaptureRequest || !isWordBundleIdentifier(lastSelectionEditSession?.bundleIdentifier)) return;
  const state = getSourceReviewState();
  if (state?.changes.length) windowManager.sendToResult('polish:auto-source-review', state.token);
}

function prepareReprocessBaseText() {
  const session = lastSelectionEditSession;
  if (!session) return lastOriginalText;
  if (session.sourceStateUncertain) {
    throw new Error('无法确认上一条修改是否已经写入原文。请检查原文，并重新选择文字后再分析。');
  }
  // A new generation must be based on the text that is currently in the
  // source. Old diff ids are local to the previous generation.
  session.originalText = session.currentText;
  session.appliedChanges.clear();
  session.generation += 1;
  lastOriginalText = session.currentText;
  windowManager.sendToResult('polish:original', session.currentText);
  // `polish:original` resets renderer state, including its write-back mode.
  // Re-send the active source capabilities so the next generation can still
  // be reviewed and applied to the same source selection.
  windowManager.sendToResult('polish:reviewContext', {
    surgicalEditing: true,
    platform: process.platform,
    writeMode: 'inline',
  });
  return session.currentText;
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

let isApplyingSourceEdit = false;
async function withSourceEdit(action) {
  if (isProcessing || isApplyingSourceEdit) return { ok: false, error: '当前操作尚未完成，请稍后重试。' };
  isApplyingSourceEdit = true;
  sourceReview?.setWriting(true);
  try { return await action(); } finally { isApplyingSourceEdit = false; sourceReview?.setWriting(false); }
}

async function performStandardReplace(text) {
  if (typeof text !== 'string') return { ok: false, error: '替换文本无效。' };
  const editSession = lastSelectionEditSession;
  if (!editSession) {
    clipboard.writeText(text);
    new Notification({ title: '润石 PoliShit', body: '当前编辑器无法验证原文位置，结果已复制，请在目标位置手动粘贴。' }).show();
    return { ok: true, mode: 'copied' };
  }
  if (editSession.sourceStateUncertain) {
    return { ok: false, sourceMayHaveChanged: true,
      error: '无法确认原文当前状态。请检查原文，并重新选择文字后再分析。' };
  }
  const range = { location: editSession.selectionStart, length: editSession.currentText.length };
  const result = await applyTextEdit({
    bundleIdentifier: editSession.bundleIdentifier, frontmostPid: editSession.frontmostPid,
    windowHandle: editSession.windowHandle,
    elementToken: editSession.elementToken,
    documentId: editSession.documentId, expectedText: editSession.currentText,
    selectionRange: range, targetRange: range,
  }, text, { restoreClipboard: true });
  if (!result?.ok) {
    if (result?.sourceMayHaveChanged) editSession.sourceStateUncertain = true;
    windowManager.focusResult?.();
    return { ok: false, sourceMayHaveChanged: Boolean(result?.sourceMayHaveChanged),
      error: result?.error || '原文位置已变化，请重新分析。' };
  }
  if (Number.isSafeInteger(result.selectionRange?.location)) editSession.selectionStart = result.selectionRange.location;
  if (result.documentId) editSession.documentId = result.documentId;
  lastSelectionEditSession = null;
  windowManager.hideResult();
  lastAppliedReplacement = {
    originalText: lastOriginalText,
    replacedText: text,
    selectionContext: editSession ? {
      documentId: editSession.documentId,
      windowHandle: editSession.windowHandle,
      bundleIdentifier: editSession.bundleIdentifier,
      frontmostPid: editSession.frontmostPid,
      elementToken: editSession.elementToken,
      selectionRange: { location: editSession.selectionStart, length: text.length },
    } : null,
    at: Date.now(),
    sourceStateUncertain: false,
  };
  windowManager.showUndoToast();
  return { ok: true, mode: 'replace' };
}

async function applyReviewChangeInSource(change, mode = 'accept', options = {}) {
  const session = lastSelectionEditSession;
  if (!session) {
    return { ok: false, error: '当前应用暂不支持逐条原位修订。' };
  }
  if (session.sourceStateUncertain) {
    return { ok: false, sourceMayHaveChanged: true,
      error: '无法确认原文当前状态。请检查原文，并重新选择文字后再分析。' };
  }

  if (!['accept', 'revert'].includes(mode) || !isReviewChangeApplicable(session, change)) {
    return { ok: false, error: '修订与原始选区不匹配，请重新分析。' };
  }
  const isRevert = mode === 'revert';
  if (isRevert && session.appliedChanges.has(change.id)) change = session.appliedChanges.get(change.id);
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
    documentId: session.documentId,
    windowHandle: session.windowHandle,
    bundleIdentifier: session.bundleIdentifier,
    frontmostPid: session.frontmostPid,
    elementToken: session.elementToken,
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

  const result = await applyTextEdit(selectionRequest, edit.replacement, {
    restoreClipboard: true,
    sourceOverlay: options.sourceOverlay === true,
    // Word counts tracked deleted text inside Range offsets. Enabling Track
    // Changes here makes exact read-back fail after a successful write and
    // breaks the next suggestion in a batch. Keep this direct-edit path exact.
    trackChanges: false,
  });
  if (!result?.ok) {
    if (result?.sourceMayHaveChanged) session.sourceStateUncertain = true;
    if (!options.sourceOverlay) windowManager.focusResult?.();
    return { ok: false, sourceMayHaveChanged: Boolean(result?.sourceMayHaveChanged),
      error: result?.error || '原位修订失败。' };
  }

  if (Number.isFinite(Number(result?.selectionRange?.location))) {
    session.selectionStart = Number(result.selectionRange.location);
  }
  if (result.documentId) session.documentId = result.documentId;
  if (result.geometryContext) session.geometryContext = result.geometryContext;
  session.currentText = applyStringEdit(session.currentText, relativeStart, edit.targetLength, edit.replacement);
  if (isRevert) {
    session.appliedChanges.delete(change.id);
  } else {
    session.appliedChanges.set(change.id, change);
  }
  if (!options.sourceOverlay) windowManager.focusResult?.();
  return { ok: true, applied: true, currentText: session.currentText };
}

async function finalizeSurgicalReview(finalText) {
  const session = lastSelectionEditSession;
  if (!session) {
    return performStandardReplace(finalText);
  }
  if (session.sourceStateUncertain) {
    return { ok: false, sourceMayHaveChanged: true,
      error: '无法确认原文当前状态。请检查原文，并重新选择文字后再分析。' };
  }

  if (finalText === session.currentText) {
    if (session.currentText !== session.originalText) {
      lastAppliedReplacement = {
        originalText: session.originalText,
        replacedText: session.currentText,
        selectionContext: {
          documentId: session.documentId,
          windowHandle: session.windowHandle,
          bundleIdentifier: session.bundleIdentifier,
          frontmostPid: session.frontmostPid,
          elementToken: session.elementToken,
          selectionRange: { location: session.selectionStart, length: session.currentText.length },
        },
        at: Date.now(),
        sourceStateUncertain: false,
      };
      windowManager.showUndoToast();
    }
    lastSelectionEditSession = null;
    windowManager.hideResult();
    return { ok: true, mode: 'surgical-noop' };
  }

  const selectionRequest = {
    documentId: session.documentId,
    windowHandle: session.windowHandle,
    bundleIdentifier: session.bundleIdentifier,
    frontmostPid: session.frontmostPid,
    elementToken: session.elementToken,
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
    if (result?.sourceMayHaveChanged) session.sourceStateUncertain = true;
    windowManager.focusResult?.();
    return { ok: false, sourceMayHaveChanged: Boolean(result?.sourceMayHaveChanged),
      error: result?.error || '无法完成最终原位修订。' };
  }

  lastAppliedReplacement = {
    originalText: session.originalText,
    replacedText: finalText,
    selectionContext: {
      documentId: result.documentId || session.documentId,
      windowHandle: session.windowHandle,
      bundleIdentifier: session.bundleIdentifier,
      frontmostPid: session.frontmostPid,
      elementToken: session.elementToken,
      selectionRange: { location: session.selectionStart, length: finalText.length },
    },
    at: Date.now(),
    sourceStateUncertain: false,
  };
  lastSelectionEditSession = null;
  windowManager.hideResult();
  windowManager.showUndoToast();
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
    // Compare by timestamp instead of object reference to handle snapshot recycling
    if (!pendingToolbarSnapshot || pendingToolbarSnapshot.at !== snapshot.at) return;
    const current = getRecentSelectionSnapshot();
    if (!current || current.at !== snapshot.at) return;
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
  }, 320);
}

function estimateResultWindowMetrics(text, anchorBounds) {
  const normalized = (text || '').trim();
  const lineCount = normalized ? normalized.split(/\r?\n/).length : 1;
  const density = Math.max(lineCount, Math.ceil(normalized.length / 60));
  // Result contains annotations (~2x) + full revised text (~1x) ≈ 3x original density
  const contentDensity = Math.ceil(density * 2.8);
  const preferredWidth = Math.max(680, Math.min(760, 680 + Math.ceil(normalized.length / 260) * 12));
  const preferredHeight = Math.max(
    560,
    Math.min(720, 470 + contentDensity * 15),
  );

  return { preferredWidth, preferredHeight };
}

async function getToolbarStatus() {
  const enabled = config.get('ui.floatingToolbarEnabled') !== false;
  const diagnostics = selectionWatcher?.diagnose
    ? await selectionWatcher.diagnose()
    : null;
  const appAccessibilityTrusted = isMac
    ? systemPreferences.isTrustedAccessibilityClient(false)
    : null;
  const helperTrusted = isMac ? diagnostics?.helperTrusted === true : null;

  return {
    enabled,
    platform: process.platform,
    // This is the permission that actually matters to the selection path.
    accessibilityTrusted: isMac ? helperTrusted : null,
    appAccessibilityTrusted,
    helperTrusted,
    helperAvailable: diagnostics?.helperAvailable !== false,
    helperBackend: diagnostics?.helperBackend || '',
    helperError: diagnostics?.helperError || '',
    selectionMonitoringAvailable: !isMac || diagnostics?.helperAvailable !== false,
    copyFallbackAvailable: true,
    lastProbeAt: diagnostics?.lastProbeAt || null,
    lastSelectionAt: diagnostics?.lastSelectionAt || null,
    lastSelectionSource: diagnostics?.lastSelectionSource || '',
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
    try {
      return await commercialClient.getStatus();
    } catch (_) {
      return null;
    }
  }
}

async function handleToolbarToggle(enabled) {
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
    return withSourceEdit(() => performStandardReplace(text));
  });

  ipcMain.handle('action:apply-review-change', async (_e, change, mode) => {
    try {
      const normalizedChange = normalizeReviewChange(change);
      if (!normalizedChange) {
        return { ok: false, error: '修改数据无效。' };
      }
      return await withSourceEdit(() => applyReviewChangeInSource(normalizedChange, mode));
    } catch (err) {
      console.error('[runshi] apply-review-change failed:', err.message);
      return { ok: false, error: `修订失败：${err.message}` };
    }
  });

  ipcMain.handle('source-review:start', async (event, token) => {
    if (!token || !sourceReviewData || event.sender !== windowManager.resultWindow?.webContents || isProcessing || isApplyingSourceEdit
      || token !== getSourceReviewState()?.token) return { ok: false, error: '当前修订不可开启原文浮窗。' };
    const resultWindow = windowManager.resultWindow;
    const session = sourceReviewData.session;
    const epoch = sourceReview.epoch;
    const sameSession = () => windowManager.resultWindow === resultWindow && !resultWindow.isDestroyed()
      && event.sender === resultWindow.webContents
      && !isProcessing && !isApplyingSourceEdit && sourceReviewData?.session === session
      && getSourceReviewState()?.token === token;
    const current = () => sameSession() && sourceReview.epoch === epoch;
    const cancelled = { ok: false, error: '原文浮窗已取消，请重新开启。' };
    // Creating/loading the native panels can activate Electron on macOS.
    // Finish that work before restoring the verified source application.
    await sourceReview.windows();
    if (!current()) return cancelled;
    const restored = await restoreFrontApp(session);
    if (!current()) return cancelled;
    if (restored === false) {
      windowManager.focusResult();
      return { ok: false, error: '无法恢复原文应用。请回到原文应用，重新选择文字后分析。' };
    }
    if (isMac && isWordBundleIdentifier(session.bundleIdentifier)) {
      // Word can publish its AX identity after the original capture. Reacquire
      // only the same selected range in the same verified document, never by
      // searching for a matching string or moving the user's selection.
      const context = await probeWordSelectionContext().catch(() => null);
      if (!current()) return cancelled;
      const geometry = context?.geometryContext;
      const previousPid = session.geometryContext?.frontmostPid || session.frontmostPid;
      if (context?.documentId !== session.documentId || context?.text !== session.currentText
        || context?.selectionRange?.location !== session.selectionStart
        || context?.selectionRange?.length !== session.currentText.length
        || !Number.isInteger(geometry?.frontmostPid) || geometry.frontmostPid <= 0
        || typeof geometry?.elementToken !== 'string' || !geometry.elementToken
        || !Number.isSafeInteger(geometry?.selectionRange?.location) || geometry.selectionRange.location < 0
        || geometry?.selectionRange?.length !== session.currentText.length
        || (Number.isInteger(previousPid) && previousPid > 0 && geometry.frontmostPid !== previousPid)) {
        windowManager.focusResult();
        return { ok: false, error: 'Word 原文位置或选区已变化，无法安全定位。请保持原选区或重新选择文字分析。' };
      }
      session.geometryContext = { frontmostPid: geometry.frontmostPid, elementToken: geometry.elementToken,
        wordParagraphSeparator: geometry.wordParagraphSeparator,
        selectionRange: { location: geometry.selectionRange.location, length: geometry.selectionRange.length } };
    }
    const result = await sourceReview.start(token);
    // start() deliberately advances its epoch once; any additional advancement
    // or changed result/session means another action cancelled this request.
    if (!sameSession() || (result.ok && sourceReview.epoch !== epoch + 1)) {
      if (result.ok && sourceReview.token === token && sourceReview.epoch === epoch + 1) sourceReview.stop();
      return cancelled;
    }
    if (result.ok) resultWindow.hide();
    else windowManager.focusResult();
    return result;
  });
  ipcMain.handle('source-review:stop', event => {
    if (event.sender !== windowManager.resultWindow?.webContents) return { ok: false };
    sourceReview.stop();
    return { ok: true };
  });
  ipcMain.handle('source-review:state', (event, token, id, status) => {
    if (event.sender !== windowManager.resultWindow?.webContents || token !== sourceReviewData?.token
      || !sourceReviewData.changes.some(c => c.id === id) || !['pending', 'rejected'].includes(status)) return { ok: false };
    if (status === 'rejected') sourceReviewData.ignored.add(id);
    else sourceReviewData.ignored.delete(id);
    return { ok: true };
  });
  ipcMain.handle('source-review:action', (event, payload) => sourceReview.action(event.sender, payload));

  ipcMain.handle('action:finalize-review', async (_e, finalText) => {
    if (typeof finalText !== 'string') {
      return { ok: false, error: '最终文本无效。' };
    }
    return withSourceEdit(() => finalizeSurgicalReview(finalText));
  });

  ipcMain.handle('action:rollback-last-replace', () => withSourceEdit(async () => {
    try {
      if (lastAppliedReplacement?.sourceStateUncertain) {
        return { ok: false, sourceMayHaveChanged: true,
          error: '无法确认上次恢复是否已经写入原文。请检查原文后关闭此提示。' };
      }
      const result = await restoreReplacement(lastAppliedReplacement, { applyTextEdit, copyText: text => clipboard.writeText(text) });
      if (!result.ok) {
        if (result.sourceMayHaveChanged && lastAppliedReplacement) {
          lastAppliedReplacement.sourceStateUncertain = true;
        }
        return result;
      }
      lastAppliedReplacement = null;
      windowManager.hideUndoToast();
      new Notification({ title: '润石 PoliShit', body: result.mode === 'copied'
        ? '原文已复制。当前编辑器无法安全定位原文，请在编辑器中撤销或手动替换。'
        : '已验证原文位置并恢复替换前的文本。' }).show();
      return result;
    } catch (err) {
      return { ok: false, error: `恢复失败：${err.message}` };
    }
  }));

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
  ipcMain.handle('window:close-result', () => { sourceReview?.stop(); windowManager.hideResult(); });

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

    config.set('shortcut', result.accelerator);
    trayManager?.refreshMenu();
    return result;
  });

  ipcMain.handle('ai:test-connection', async () => {
    try {
      const provider = createProvider(
        config.get('provider'),
        null,
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
    if (isProcessing || isApplyingSourceEdit) return { ok: false, busy: true };
    isProcessing = true;
    try {
      config.set('pipeline.task', task);
      const text = prepareReprocessBaseText();
      if (!text) {
        windowManager.sendToResult('polish:error', '无原始文本可重新处理。');
        return;
      }
      await runPipeline(text, { task });
    } catch (err) {
      windowManager.sendToResult('polish:error', `处理失败: ${err.message}`);
    } finally {
      isProcessing = false;
      offerWordSourceReview();
      runPendingRecaptureIfNeeded();
    }
  });

  // Regenerate: re-run the same task with higher temperature for variation
  ipcMain.handle('action:regenerate', async () => {
    if (isProcessing || isApplyingSourceEdit) return { ok: false, busy: true };
    isProcessing = true;
    try {
      const text = prepareReprocessBaseText();
      if (!text) {
        windowManager.sendToResult('polish:error', '无原始文本可重新处理。');
        return;
      }
      const origTemp = config.get('pipeline.temperature') ?? 0.3;
      await runPipeline(text, {
        progressPrefix: '正在重新生成...',
        temperatureOverride: Math.min(origTemp + 0.3, 1.0),
      });
    } catch (err) {
      windowManager.sendToResult('polish:error', `处理失败: ${err.message}`);
    } finally {
      isProcessing = false;
      offerWordSourceReview();
      runPendingRecaptureIfNeeded();
    }
  });

  // Recapture: grab new selection and reprocess
  ipcMain.handle('action:recapture', async () => {
    activeRunToken += 1;
    if (isProcessing || isApplyingSourceEdit) {
      pendingRecaptureRequest = true;
      windowManager.sendToResult('polish:progress', { stage: '正在结束当前任务...', percent: 0 });
      return { ok: true, queued: true };
    }
    await handleTrigger({
      preferCachedSelection: true,
      selectionCacheMaxAgeMs: MANUAL_REFRESH_SELECTION_CACHE_MAX_AGE_MS,
    });
    return { ok: true, queued: false };
  });

  // Reprocess with a specific model
  ipcMain.handle('action:reprocessWithModel', async (_e, modelId) => {
    if (isProcessing || isApplyingSourceEdit) return { ok: false, busy: true };
    isProcessing = true;
    try {
      const text = prepareReprocessBaseText();
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
      offerWordSourceReview();
      runPendingRecaptureIfNeeded();
    }
  });

  ipcMain.handle('onboarding:prepare', (_e, presetId) => {
    const preset = PRESETS[presetId];
    if (preset) {
      config.set('provider.preset', presetId);
      config.set('provider.apiUrl', preset.apiUrl);
      config.set('provider.model', preset.model);
      if (!preset.needsKey) {
        config.set('provider.apiKey', '');
      }
    }
    return { ok: true, presetId };
  });

  ipcMain.handle('onboarding:complete', () => {
    config.set('onboarding.completed', true);
    windowManager.hideOnboarding();
    windowManager.showHome();
    return { ok: true };
  });

  ipcMain.handle('window:open-onboarding', () => windowManager.showOnboarding());

  // ── Toolbar action: user clicked 润色/降AIGC on the floating toolbar ──
  ipcMain.handle('toolbar:resize', (_e, width, height) => {
    const win = windowManager?.toolbarWindow;
    if (win && !win.isDestroyed()) {
      const bounds = win.getBounds();
      win.setBounds({ x: bounds.x, y: bounds.y, width: Math.round(width), height: Math.round(height) });
    }
  });

  ipcMain.handle('toolbar:action', async (_e, task) => {
    if (toolbarTestMode) {
      toolbarTestMode = false;
      windowManager.hideToolbar();
      new Notification({
        title: '润石 PoliShit',
        body: '测试通过：浮窗可以正常显示并响应点击。',
      }).show();
      return { ok: true, test: true };
    }

    windowManager.hideToolbar();
    // Set the task mode
    config.set('pipeline.task', task);
    // Trigger the main processing flow
    try {
      await handleTrigger({ preferCachedSelection: true });
    } catch (err) {
      windowManager.sendToResult('polish:error', `处理失败: ${err.message}`);
    }
  });

  ipcMain.handle('toolbar:get-status', () => getToolbarStatus());
  ipcMain.handle('toolbar:set-enabled', (_e, enabled) => handleToolbarToggle(enabled));
  ipcMain.handle('toolbar:test', () => {
    toolbarTestMode = true;
    const shown = windowManager.showToolbarTest();
    if (!shown) toolbarTestMode = false;
    return { ok: Boolean(shown) };
  });
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
  ipcMain.handle('updates:install', () => updateManager?.installAvailableUpdate());
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
    } else if (process.platform === 'win32') {
      try {
        await shell.openExternal('ms-settings:easeofaccess');
      } catch (_) {
        // Ignore failures; the user can still navigate manually.
      }
    }

    return getToolbarStatus();
  });
}
