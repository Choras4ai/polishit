'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);

const _isMac = window.polishAPI.platform === 'darwin';
function formatShortcut(acc) {
  if (_isMac) {
    return acc
      .replace('CommandOrControl', '⌘')
      .replace('Shift', '⇧')
      .replace('Alt', '⌥')
      .replace(/\+/g, '');
  }
  return acc.replace('CommandOrControl', 'Ctrl');
}

// ── Tab switching ──
$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.remove('active'));
    $$('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    $(`#panel-${tab.dataset.tab}`).classList.add('active');
  });
});

// ── "前往" buttons on home tab ──
$$('[data-go-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    const tabId = btn.dataset.goTab;
    const tabBtn = $(`.tab[data-tab="${tabId}"]`);
    if (tabBtn) tabBtn.click();
  });
});

// ── Preset data (loaded from main process) ──
let presetsData = {};
let presetOrder = [];

// ── API Key visibility toggle ──
$('#toggleKeyVis').addEventListener('click', () => {
  const input = $('#apiKey');
  input.type = input.type === 'password' ? 'text' : 'password';
});

// ── Temperature slider ──
$('#temperature').addEventListener('input', (e) => {
  $('#tempValue').textContent = (e.target.value / 10).toFixed(1);
});

// ── Preset selection handler ──
$('#presetSelect').addEventListener('change', (e) => {
  const presetId = e.target.value;
  applyPreset(presetId);
});

function applyPreset(presetId) {
  const preset = presetsData[presetId];
  if (!preset) return;

  // Update description
  $('#presetDesc').textContent = preset.description || '';

  // Show/hide API key field
  const keyGroup = $('#apiKeyGroup');
  const builtinBadge = $('#builtinBadge');
  if (preset.needsKey) {
    keyGroup.classList.remove('hidden');
    builtinBadge.classList.add('hidden');
    $('#apiKey').placeholder = preset.keyPlaceholder || '输入 API Key';
    if (preset.keyUrl) {
      $('#keyLink').href = preset.keyUrl;
      $('#keyLink').classList.remove('hidden');
    } else {
      $('#keyLink').classList.add('hidden');
    }
  } else {
    keyGroup.classList.add('hidden');
    if (presetId === 'together' || presetId === 'siliconflow') {
      builtinBadge.classList.remove('hidden');
    } else {
      builtinBadge.classList.add('hidden');
    }
  }

  // Auto-fill advanced fields
  $('#apiUrl').value = preset.apiUrl || '';
  $('#modelName').value = preset.model || '';

  // Lock advanced fields for built-in free presets (prevent cost overrun)
  const isBuiltin = presetId === 'together' || presetId === 'siliconflow';
  $('#apiUrl').readOnly = isBuiltin;
  $('#modelName').readOnly = isBuiltin;
  if (isBuiltin) {
    $('#advancedApiFields').open = false;
  }

  // Close advanced details for simple presets, open for custom
  if (presetId === 'custom') {
    $('#advancedApiFields').open = true;
  }
}

// ── Shortcut capture ──
let pendingAccelerator = null;

$('#shortcutCapture').addEventListener('keydown', (e) => {
  e.preventDefault();
  e.stopPropagation();

  if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return;
  if (!e.metaKey && !e.ctrlKey && !e.altKey) return;

  const parts = [];
  if (e.metaKey || e.ctrlKey) parts.push('CommandOrControl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');

  let key = e.key;
  if (key.length === 1) key = key.toUpperCase();
  parts.push(key);

  pendingAccelerator = parts.join('+');

  const display = formatShortcut(pendingAccelerator);

  const el = $('#shortcutCapture');
  el.textContent = display;
  el.classList.add('captured');
  $('#btnSaveShortcut').disabled = false;
});

$('#shortcutCapture').addEventListener('focus', () => {
  const el = $('#shortcutCapture');
  if (!el.classList.contains('captured')) {
    el.textContent = '请按下快捷键组合…';
  }
});

$('#shortcutCapture').addEventListener('blur', () => {
  const el = $('#shortcutCapture');
  if (!el.classList.contains('captured')) {
    el.textContent = '点击此处，然后按下快捷键…';
  }
});

// ── Status helper ──
function showStatus(el, message, type) {
  el.textContent = message;
  el.className = `status-text ${type}`;
  if (type === 'success') {
    setTimeout(() => { el.textContent = ''; el.className = 'status-text'; }, 2500);
  }
}

function renderToolbarStatus(status) {
  const enabled = status?.enabled !== false;
  $('#floatingToolbarEnabled').checked = enabled;

  let summary = '浮窗状态未知。';
  let detail = '可通过快捷键继续触发处理。';

  if (!enabled) {
    summary = '浮窗已关闭。';
    detail = '选中或复制文本后都不会自动弹出，仍可使用快捷键触发。';
  } else if (status?.platform === 'darwin' && status?.accessibilityTrusted) {
    summary = '浮窗已启用：选中文本或复制文本都可以触发。';
    detail = '如果某些应用本身不暴露选区，仍可以先复制文本作为回退触发。';
  } else if (status?.platform === 'darwin') {
    summary = '尚未授予 macOS 辅助功能权限。';
    detail = '当前可先通过复制文本触发浮窗；授予权限后，选中文本也会直接弹出。';
  } else {
    summary = '当前平台使用复制回退和快捷键触发。';
    detail = '如果系统不支持选区监听，可先复制文本，或继续使用快捷键。';
  }

  $('#floatingToolbarStatus').textContent = summary;
  $('#floatingToolbarStatusDetail').textContent = detail;
  $('#btnOpenAccessibility').classList.toggle(
    'hidden',
    status?.platform !== 'darwin' || Boolean(status?.accessibilityTrusted),
  );
}

async function refreshToolbarStatus() {
  const status = await window.polishAPI.getToolbarStatus();
  renderToolbarStatus(status);
  return status;
}

// ── Load config ──
async function loadConfig() {
  const [config, { presets, order }, toolbarStatus] = await Promise.all([
    window.polishAPI.getConfig(),
    window.polishAPI.getPresets(),
    window.polishAPI.getToolbarStatus(),
  ]);

  presetsData = presets;
  presetOrder = order;

  // Populate preset dropdown
  const select = $('#presetSelect');
  select.innerHTML = '';
  for (const id of presetOrder) {
    const p = presets[id];
    if (!p) continue;
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = p.name;
    select.appendChild(opt);
  }

  // Set current preset
  const currentPreset = config.provider?.preset || 'together';
  select.value = currentPreset;
  applyPreset(currentPreset);

  // Fill saved values (may override preset defaults)
  if (config.provider?.apiKey) $('#apiKey').value = config.provider.apiKey;
  if (config.provider?.apiUrl) $('#apiUrl').value = config.provider.apiUrl;
  if (config.provider?.model) $('#modelName').value = config.provider.model;

  // Shortcut
  const shortcut = config.shortcut || 'CommandOrControl+Shift+A';
  const display = formatShortcut(shortcut);
  $('#currentShortcut').textContent = display;

  // Pipeline
  const task = config.pipeline?.task || 'polish';
  const taskRadio = $(`input[name="taskMode"][value="${task}"]`);
  if (taskRadio) taskRadio.checked = true;

  const mode = config.pipeline?.mode || 'single';
  const modeRadio = $(`input[name="pipelineMode"][value="${mode}"]`);
  if (modeRadio) modeRadio.checked = true;

  const temp = config.pipeline?.temperature ?? 0.3;
  $('#temperature').value = Math.round(temp * 10);
  $('#tempValue').textContent = temp.toFixed(1);
  $('#customPromptPolish').value = config.pipeline?.customPrompts?.polish || '';
  $('#customPromptDedup').value = config.pipeline?.customPrompts?.dedup || '';
  $('#customPromptDeai').value = config.pipeline?.customPrompts?.deai || '';

  renderToolbarStatus(toolbarStatus);

  // ── Home tab status ──
  const shortcutHome = config.shortcut || 'CommandOrControl+Shift+A';
  $('#homeShortcut').textContent = formatShortcut(shortcutHome);

  const homePresetId = config.provider?.preset || 'together';
  const homePreset = presets[homePresetId];
  $('#homePreset').textContent = homePreset?.name || homePresetId;

  const homeToolbar = config.ui?.floatingToolbarEnabled !== false;
  $('#homeToolbar').textContent = homeToolbar ? '已开启' : '已关闭';

  const taskLabels = { polish: '润色', dedup: '降重', deai: '降AI率（图一乐版）' };
  const homeTaskId = config.pipeline?.task || 'polish';
  $('#homeTask').textContent = taskLabels[homeTaskId] || homeTaskId;
}

// ── Save provider config (shared by Save + Test) ──
async function saveProviderConfig() {
  const presetId = $('#presetSelect').value;
  const preset = presetsData[presetId];
  const isBuiltin = presetId === 'together' || presetId === 'siliconflow';
  const apiKey = preset?.needsKey ? $('#apiKey').value.trim() : '';

  await window.polishAPI.setConfig('provider.preset', presetId);
  // For built-in free presets, always force preset URL/model to prevent cost overrun
  await window.polishAPI.setConfig('provider.apiUrl', isBuiltin ? preset.apiUrl : ($('#apiUrl').value.trim() || preset?.apiUrl || ''));
  await window.polishAPI.setConfig('provider.model', isBuiltin ? preset.model : ($('#modelName').value.trim() || preset?.model || ''));
  await window.polishAPI.setConfig('provider.apiKey', apiKey);
}

// ── Save API ──
$('#btnSaveApi').addEventListener('click', async () => {
  const status = $('#apiStatus');
  const presetId = $('#presetSelect').value;
  const preset = presetsData[presetId];

  if (preset?.needsKey && !$('#apiKey').value.trim()) {
    showStatus(status, '请填写 API Key', 'error');
    return;
  }

  await saveProviderConfig();

  showStatus(status, '已保存', 'success');
});

// ── Test connection ──
$('#btnTest').addEventListener('click', async () => {
  const status = $('#apiStatus');

  // Save current settings first so test uses updated values
  const presetId = $('#presetSelect').value;
  const preset = presetsData[presetId];
  if (preset?.needsKey && !$('#apiKey').value.trim()) {
    showStatus(status, '请填写 API Key', 'error');
    return;
  }
  await saveProviderConfig();

  showStatus(status, '测试中...', '');
  const result = await window.polishAPI.testConnection();
  if (result.success) {
    showStatus(status, '连接成功 ✓', 'success');
  } else {
    showStatus(status, `连接失败: ${result.error}`, 'error');
  }
});

// ── Save shortcut ──
$('#btnSaveShortcut').addEventListener('click', async () => {
  if (!pendingAccelerator) return;
  const status = $('#shortcutStatus');
  const result = await window.polishAPI.setShortcut(pendingAccelerator);
  if (!result?.success) {
    showStatus(status, result?.error || '快捷键注册失败', 'error');
    return;
  }

  const display = formatShortcut(pendingAccelerator);
  $('#currentShortcut').textContent = display;

  pendingAccelerator = null;
  $('#shortcutCapture').classList.remove('captured');
  $('#shortcutCapture').textContent = '点击此处，然后按下快捷键…';
  $('#btnSaveShortcut').disabled = true;

  showStatus(status, '快捷键已更新', 'success');
});

$('#floatingToolbarEnabled').addEventListener('change', async (e) => {
  const status = $('#generalStatus');
  const next = e.target.checked;
  const result = await window.polishAPI.setToolbarEnabled(next);
  renderToolbarStatus(result);
  showStatus(status, next ? '浮窗已启用' : '浮窗已关闭', 'success');
});

$('#btnRefreshToolbarStatus').addEventListener('click', async () => {
  const status = $('#generalStatus');
  await refreshToolbarStatus();
  showStatus(status, '浮窗状态已刷新', 'success');
});

$('#btnOpenAccessibility').addEventListener('click', async () => {
  const status = $('#generalStatus');
  showStatus(status, '正在打开系统设置...', '');
  const result = await window.polishAPI.openAccessibilitySettings();
  renderToolbarStatus(result);
});

// ── Save general ──
$('#btnSaveGeneral').addEventListener('click', async () => {
  const status = $('#generalStatus');
  const task = $('input[name="taskMode"]:checked').value;
  const mode = $('input[name="pipelineMode"]:checked').value;
  const temp = parseInt($('#temperature').value, 10) / 10;

  await window.polishAPI.setConfig('pipeline.task', task);
  await window.polishAPI.setConfig('pipeline.mode', mode);
  await window.polishAPI.setConfig('pipeline.temperature', temp);
  showStatus(status, '已保存', 'success');
});

// ── Save prompts ──
$('#btnSavePrompts').addEventListener('click', async () => {
  const status = $('#promptsStatus');
  const customPromptPolish = $('#customPromptPolish').value.trim();
  const customPromptDedup = $('#customPromptDedup').value.trim();
  const customPromptDeai = $('#customPromptDeai').value.trim();

  await window.polishAPI.setConfig('pipeline.customPrompts.polish', customPromptPolish);
  await window.polishAPI.setConfig('pipeline.customPrompts.dedup', customPromptDedup);
  await window.polishAPI.setConfig('pipeline.customPrompts.deai', customPromptDeai);
  showStatus(status, '已保存', 'success');
});

// ── Author link ──
$('#authorLink').addEventListener('click', (e) => {
  e.preventDefault();
  window.polishAPI.openExternal('https://choraschan.github.io');
});

// ── Init ──
loadConfig();
