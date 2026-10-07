'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let selectedPreset = 'together';

const _isMac = window.polishAPI.platform === 'darwin';
if (!_isMac) {
  $('#tipPermission').style.display = 'none';
  $('#btnGrantPermission').style.display = 'none';
  $('#permissionSetupRow').style.display = 'none';
  $('#platformSetupSubtitle').textContent = '确认浮窗和 Windows 选区监听可用；原位修订请使用 Word / WPS 文档助手。';
} else {
  $('#platformSetupSubtitle').textContent = '确认浮窗、辅助功能和选区监听均可用；不同编辑器会按能力原位写回或复制结果。';
}

function showStep(stepId) {
  $$('.step').forEach(step => step.classList.remove('active'));
  $(`#step-${stepId}`).classList.add('active');
}

function formatShortcut(accelerator) {
  if (_isMac) {
    return String(accelerator || '')
      .replace('CommandOrControl', '⌘')
      .replace('Shift', '⇧')
      .replace('Alt', '⌥')
      .replace(/\+/g, '');
  }
  return String(accelerator || '').replace('CommandOrControl', 'Ctrl');
}

function setBadge(selector, label, type = '') {
  const badge = $(selector);
  badge.textContent = label;
  badge.className = `setup-badge${type ? ` ${type}` : ''}`;
}

async function refreshSetupStatus() {
  const message = $('#onboardSetupMessage');
  message.textContent = '正在检查运行环境…';

  try {
    const status = await window.polishAPI.getToolbarStatus();
    const enabled = status?.enabled !== false;
    setBadge('#onboardToolbarState', enabled ? '已开启' : '已关闭', enabled ? 'success' : 'warning');

    if (!_isMac) {
      setBadge('#onboardPermissionState', '无需授权', 'success');
    } else if (status?.accessibilityTrusted) {
      setBadge('#onboardPermissionState', '授权有效', 'success');
    } else if (status?.appAccessibilityTrusted) {
      setBadge('#onboardPermissionState', '需要刷新', 'warning');
    } else {
      setBadge('#onboardPermissionState', '未授权', 'error');
    }

    if (status?.selectionMonitoringAvailable === false) {
      setBadge('#onboardProbeState', '组件不可用', 'error');
    } else if (_isMac && !status?.helperTrusted) {
      setBadge(
        '#onboardProbeState',
        status?.helperBackend === 'in-process-native' ? '主进程 · 等待权限' : '等待权限',
        'warning',
      );
    } else {
      setBadge(
        '#onboardProbeState',
        status?.helperBackend === 'in-process-native' ? '主进程监听正常' : '运行正常',
        'success',
      );
    }

    const monitoringReady = status?.selectionMonitoringAvailable !== false;
    if (enabled && monitoringReady && (!_isMac || status?.accessibilityTrusted)) {
      message.textContent = '核心功能已就绪。请显示一次测试浮窗，确认它可以响应点击。';
      message.className = 'setup-message success';
    } else if (_isMac && status?.appAccessibilityTrusted) {
      message.textContent = 'macOS 保留了旧授权。请在辅助功能中将润石关闭再打开，然后重启应用。';
      message.className = 'setup-message warning';
    } else if (_isMac) {
      message.textContent = '请先允许润石使用辅助功能；这是“选中即弹窗”所必需的权限。';
      message.className = 'setup-message warning';
    } else {
      message.textContent = 'Windows 选区监听组件尚未就绪；仍可复制文本后使用快捷键。';
      message.className = 'setup-message warning';
    }
    return status;
  } catch (err) {
    message.textContent = `检测失败：${err.message}`;
    message.className = 'setup-message error';
    return null;
  }
}

async function prepareDefaultExperience() {
  await window.polishAPI.prepareOnboarding('together');
  await window.polishAPI.setToolbarEnabled(true);
  showStep('setup');
  await refreshSetupStatus();
}

$('#btnQuickStart').addEventListener('click', prepareDefaultExperience);

$('#btnCustomSetup').addEventListener('click', async () => {
  await loadProviders();
  showStep('provider');
});

async function loadProviders() {
  const { presets, order } = await window.polishAPI.getPresets();
  const list = $('#providerList');
  list.innerHTML = '';

  for (const id of order) {
    const preset = presets[id];
    if (!preset || id === 'custom') continue;

    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'provider-card';
    card.dataset.id = id;

    const copy = document.createElement('span');
    const name = document.createElement('span');
    name.className = 'provider-name';
    name.textContent = preset.name.replace(/（.*）/, '');
    const desc = document.createElement('span');
    desc.className = 'provider-desc';
    desc.textContent = preset.description;
    copy.append(name, desc);
    card.appendChild(copy);

    if (preset.badge) {
      const badge = document.createElement('span');
      badge.className = 'provider-badge';
      badge.textContent = preset.badge;
      card.appendChild(badge);
    }

    card.addEventListener('click', () => selectProvider(id, preset));
    list.appendChild(card);
  }
}

function selectProvider(id, preset) {
  $$('.provider-card').forEach(card => card.classList.remove('selected'));
  $(`.provider-card[data-id="${id}"]`).classList.add('selected');
  selectedPreset = id;

  if (preset.needsKey) {
    $('#providerKeyArea').classList.remove('hidden');
    $('#onboardApiKey').placeholder = preset.keyPlaceholder || '输入 API Key';
    $('#onboardApiKey').focus();
  } else {
    $('#providerKeyArea').classList.add('hidden');
    finishWithPreset(id, '');
  }
}

$('#btnStartWithKey').addEventListener('click', () => {
  const key = $('#onboardApiKey').value.trim();
  if (!key) {
    $('#onboardApiKey').style.borderColor = '#ff3b30';
    $('#onboardApiKey').focus();
    return;
  }
  finishWithPreset(selectedPreset, key);
});

async function finishWithPreset(presetId, apiKey) {
  if (apiKey) await window.polishAPI.setConfig('provider.apiKey', apiKey);
  await window.polishAPI.prepareOnboarding(presetId);
  await window.polishAPI.setToolbarEnabled(true);
  showStep('setup');
  await refreshSetupStatus();
}

$('#btnBack').addEventListener('click', () => showStep('welcome'));
$('#btnBackSetup').addEventListener('click', () => showStep('welcome'));

$('#btnGrantPermission').addEventListener('click', async () => {
  $('#onboardSetupMessage').textContent = '系统设置已打开。授权后返回这里点击“重新检查”。';
  await window.polishAPI.openAccessibilitySettings();
});

$('#btnRefreshPermission').addEventListener('click', refreshSetupStatus);

$('#btnTestToolbar').addEventListener('click', async () => {
  const result = await window.polishAPI.testToolbar();
  const message = $('#onboardSetupMessage');
  if (result?.ok) {
    message.textContent = '测试浮窗已显示在鼠标附近。点击“润色”后收到系统通知即表示交互正常。';
    message.className = 'setup-message success';
  } else {
    message.textContent = '测试浮窗未能显示，请重启应用后再试。';
    message.className = 'setup-message error';
  }
});

$('#btnContinueReady').addEventListener('click', async () => {
  const config = await window.polishAPI.getConfig();
  $('#shortcutBadge').textContent = formatShortcut(config.shortcut || 'CommandOrControl+Alt+V');
  showStep('ready');
});

$('#btnFinish').addEventListener('click', async () => {
  $('#btnFinish').disabled = true;
  $('#btnFinish').textContent = '正在进入…';
  await window.polishAPI.completeOnboarding();
});
