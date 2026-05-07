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
let commercialStatusCache = null;
let codeCooldownTimer = null;
let updateStatusCache = null;
let modelListCache = [];

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatCredits(value) {
  return new Intl.NumberFormat('zh-CN').format(Math.max(0, Number(value) || 0));
}

function formatPlanQuota(value) {
  return `${formatCredits(value)} 积分`;
}

function formatMembershipPeriod(membership) {
  if (!membership?.currentPeriodStart || !membership?.currentPeriodEnd) {
    return '本周期信息暂不可用';
  }
  return `${formatDateTime(membership.currentPeriodStart)} - ${formatDateTime(membership.currentPeriodEnd)}`;
}

function maskPhone(phone) {
  const normalized = String(phone || '');
  if (normalized.length !== 11) return normalized || '未登录';
  return `${normalized.slice(0, 3)}****${normalized.slice(7)}`;
}

function formatDateTime(value) {
  if (!value) return '未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatVersion(version) {
  const normalized = String(version || '').trim().replace(/^v/i, '');
  return normalized ? `v${normalized}` : '未知版本';
}

function normalizeTask(task) {
  return task === 'deai' ? 'deai' : 'polish';
}

function getPrimaryPlan(status) {
  const plans = Array.isArray(status?.availablePlans) ? status.availablePlans : [];
  if (plans.length > 0) {
    return plans[0];
  }
  const membership = status?.membership || {};
  return {
    planId: membership.planId || 'runshi-basic',
    planName: membership.planName || '润石积分包',
    priceCents: membership.priceCents || 990,
    priceLabel: membership.priceLabel || '9.9 / 300 积分',
    creditsPerPack: membership.creditsPerPack || 300,
    description: '充值积分后可选择多种 AI 模型；标准模型单轮约 800 字 / 1 积分，多轮和高阶模型按倍率累计。',
  };
}

function getCreditPolicy(status) {
  const policy = status?.creditPolicy || {};
  return {
    baseCharsPerCredit: Number(policy.baseCharsPerCredit || 800),
    maxBillableChars: Number(policy.maxBillableChars || 12000),
    explainBillingRatio: Number(policy.explainBillingRatio || 0.5),
  };
}

function renderCreditPolicy(status) {
  const body = $('#creditPolicyBody');
  const footnote = $('#creditPolicyFootnote');
  if (!body || !footnote) return;

  const policy = getCreditPolicy(status);
  body.textContent = `标准模型单轮约 ${policy.baseCharsPerCredit} 字 / 1 基础积分；2× 模型同长度约扣 2 积分，3× 模型约扣 3 积分；单次最多 ${policy.maxBillableChars} 字。`;
  footnote.textContent = `多轮模式按实际调用轮次累计；修改说明按 ${policy.explainBillingRatio} 轮折算；自配 API 不消耗润石积分。`;
}

function normalizePaymentProviders(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') return item.id || '';
      return '';
    })
    .filter(Boolean);
}

function setCommercialVisibility(available) {
  $('#tabAccount').classList.toggle('hidden', !available);
  $('#panel-account').classList.toggle('commercial-disabled', !available);

  const activeTab = $('.tab.active');
  if (!available && activeTab?.dataset.tab === 'account') {
    $('.tab[data-tab="home"]').click();
  }
}

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
    builtinBadge.classList.add('hidden');
  }

  // Auto-fill advanced fields
  $('#apiUrl').value = preset.apiUrl || '';
  $('#modelName').value = preset.model || '';

  // Allow editing for all presets except ollama-like local ones
  $('#apiUrl').readOnly = false;
  $('#modelName').readOnly = false;

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

function updateHomeCommercialSummary(status) {
  const membership = status?.membership || {};
  const trial = status?.trial || {};
  if (status?.available === false) {
    $('#homeAccount').textContent = '开源模式';
    $('#homeCredits').textContent = '—';
    return;
  }
  if (status?.enabled === false) {
    $('#homeAccount').textContent = '已关闭';
    $('#homeCredits').textContent = '—';
    return;
  }

  $('#homeAccount').textContent = status?.loggedIn
    ? `${maskPhone(status.phone)}${membership.active ? ' · 有积分' : ' · 未充值'}`
    : '未登录';
  $('#homeCredits').textContent = !status?.loggedIn
    ? '—'
    : (membership.active
      ? `${membership.creditsRemaining} 积分`
      : `${Number(trial.remaining || 0)} 次免费试用`);
}

function renderUpdateStatus(status) {
  updateStatusCache = status || null;
  if (!status) return;

  const hasUpdate = Boolean(status.hasUpdate && status.latestVersion);
  const checkedAt = status.checkedAt ? formatDateTime(status.checkedAt) : '尚未检查';
  const currentVersion = formatVersion(status.currentVersion);
  const latestVersion = formatVersion(status.latestVersion);

  $('#aboutVersion').textContent = currentVersion.replace(/^v/, '');
  $('#btnCheckUpdates').disabled = Boolean(status.checking);
  $('#btnOpenLatestRelease').classList.toggle('hidden', !hasUpdate);

  if (status.checking) {
    $('#aboutUpdateStatus').textContent = '正在检查更新...';
    $('#aboutUpdateMeta').textContent = `当前版本 ${currentVersion}`;
    return;
  }

  if (hasUpdate) {
    $('#aboutUpdateStatus').textContent = `发现新版本 ${latestVersion}`;
    const lines = [
      `当前版本 ${currentVersion} · 最近检查 ${checkedAt}`,
    ];
    if (status.publishedAt) {
      lines.push(`发布时间 ${formatDateTime(status.publishedAt)}`);
    }
    if (status.releaseNotes) {
      lines.push(status.releaseNotes);
    }
    $('#aboutUpdateMeta').textContent = lines.join('\n');
    return;
  }

  if (status.lastError) {
    $('#aboutUpdateStatus').textContent = '检查更新失败';
    $('#aboutUpdateMeta').textContent = `当前版本 ${currentVersion} · ${status.lastError}`;
    return;
  }

  $('#aboutUpdateStatus').textContent = '当前已是最新版本';
  $('#aboutUpdateMeta').textContent = `当前版本 ${currentVersion} · 最近检查 ${checkedAt}`;
}

async function renderModelList() {
  const container = $('#modelList');
  if (!container) return;

  if (modelListCache.length === 0) {
    try {
      modelListCache = await window.polishAPI.getCommercialModels() || [];
    } catch (_) {
      modelListCache = [];
    }
    if (modelListCache.length === 0) {
      modelListCache = [
        { id: 'qwen3-8b', name: 'Qwen3-8B', provider: '通义千问', credits: 0.5, description: '极速模型', badge: '极速', tier: '基础' },
        { id: 'kimi-k2.6', name: 'Kimi-K2.6', provider: 'Moonshot', credits: 1, description: '最新旗舰，多模态智能体', badge: '新', tier: '标准' },
        { id: 'kimi-k2.5', name: 'Kimi-K2.5', provider: 'Moonshot', credits: 1, description: '中文理解力强', badge: '', tier: '标准' },
        { id: 'glm-4.7', name: 'GLM-4.7', provider: '智谱', credits: 1, description: '快速高效', badge: '', tier: '标准' },
        { id: 'deepseek-v3-671b', name: 'DeepSeek-V3', provider: 'DeepSeek', credits: 1, description: '671B MoE', badge: '', tier: '标准' },
        { id: 'deepseek-v3.2', name: 'DeepSeek-V3.2', provider: 'DeepSeek', credits: 2, description: '最新旗舰', badge: '', tier: '高级' },
        { id: 'qwen3.5-397b', name: 'Qwen3.5-397B', provider: '通义千问', credits: 2, description: '397B MoE', badge: '', tier: '高级' },
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', provider: 'DeepSeek', credits: 2, description: 'V4 预览版 284B MoE', badge: '新', tier: '高级' },
        { id: 'glm-5.1', name: 'GLM-5.1', provider: '智谱', credits: 3, description: '智谱旗舰 754B MoE', badge: '旗舰', tier: '旗舰' },
        { id: 'minimax-m2.5', name: 'MiniMax-M2.5', provider: 'MiniMax', credits: 3, description: '最新大语言模型', badge: '', tier: '旗舰' },
      ];
    }
  }

  const cfg = await window.polishAPI.getConfig() || {};
  const selectedModel = cfg.commercial?.selectedModel || '';
  const canSelectModel = Boolean(commercialStatusCache?.loggedIn && (commercialStatusCache?.totalAvailable || 0) > 0);
  container.innerHTML = '';

  // Speed hints based on credits tier
  const speedHint = (credits) => {
    if (credits <= 0.5) return { text: '极速', cls: 'speed-fast' };
    if (credits <= 1) return { text: '较快', cls: 'speed-fast' };
    if (credits <= 2) return null;
    return { text: '较慢', cls: 'speed-slow' };
  };

  // Group by tier
  const tierMap = new Map();
  const tiers = [];
  for (const model of modelListCache) {
    const tier = model.tier || '';
    if (!tierMap.has(tier)) { tierMap.set(tier, []); tiers.push(tier); }
    tierMap.get(tier).push(model);
  }

  for (const tier of tiers) {
    if (tier && tiers.length > 1) {
      const header = document.createElement('div');
      header.className = 'model-tier-header';
      header.textContent = tier;
      container.appendChild(header);
    }
    for (const model of tierMap.get(tier)) {
      const isActive = model.id === selectedModel;
      const row = document.createElement('div');
      row.className = 'model-row' + (isActive ? ' active' : '') + (!canSelectModel ? ' disabled' : '');

      const badgeHtml = model.badge
        ? `<span class="model-badge${model.credits >= 5 ? ' premium' : ''}">${escapeHtml(model.badge)}</span>`
        : '';
      const speed = speedHint(model.credits);
      const speedHtml = speed
        ? `<span class="model-badge ${speed.cls}">${speed.text}</span>`
        : '';

      row.innerHTML = `
        <div class="model-row-check">✓</div>
        <div class="model-row-body">
          <div class="model-row-name">${escapeHtml(model.name)} ${badgeHtml}</div>
          <div class="model-row-provider">${escapeHtml(model.provider)} · ${escapeHtml(model.description || '')}</div>
        </div>
        <div class="model-row-meta">
          ${speedHtml}
          <span class="model-multiplier">${model.credits}×</span>
        </div>
      `;

      if (canSelectModel) {
        row.addEventListener('click', async () => {
          await window.polishAPI.setConfig('commercial.selectedModel', model.id);
          container.querySelectorAll('.model-row').forEach(el => el.classList.remove('active'));
          row.classList.add('active');
        });
      }
      container.appendChild(row);
    }
  }

  if (!selectedModel && modelListCache.length > 0 && canSelectModel) {
    await window.polishAPI.setConfig('commercial.selectedModel', modelListCache[0].id);
    const first = container.querySelector('.model-row');
    if (first) first.classList.add('active');
  }
}

function renderPlansGrid(status) {
  const grid = $('#plansGrid');
  if (!grid) return;
  const plans = Array.isArray(status?.availablePlans) ? status.availablePlans : [];
  const paymentProviders = normalizePaymentProviders(status?.paymentProviders);
  const loggedIn = Boolean(status?.loggedIn);
  grid.innerHTML = '';

  if (plans.length === 0) {
    // Fallback
    grid.innerHTML = '<p class="form-hint">暂无可用积分包</p>';
    return;
  }

  for (const plan of plans) {
    const card = document.createElement('div');
    card.className = 'plan-card';
    const priceYuan = (Number(plan.priceCents || 0) / 100).toFixed(1).replace(/\.0$/, '');
    card.innerHTML = `
      <div class="plan-card-header">
        <div class="plan-card-name">${escapeHtml(plan.planName)}</div>
        <div class="plan-card-price">¥${priceYuan}</div>
      </div>
      <div class="plan-card-credits">${plan.creditsPerPack} 积分</div>
      <div class="plan-card-desc">${escapeHtml(plan.description)}</div>
      <div class="plan-card-actions">
        <button class="btn btn-primary btn-sm plan-buy-btn" data-plan-id="${escapeHtml(plan.planId)}" ${!loggedIn ? 'disabled' : ''}>
          ${loggedIn ? '立即充值' : '请先登录'}
        </button>
      </div>
    `;
    grid.appendChild(card);
  }

  // Attach click handlers
  grid.querySelectorAll('.plan-buy-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const planId = btn.dataset.planId;
      btn.disabled = true;
      btn.textContent = '处理中…';
      try {
        if (paymentProviders.includes('wechatpay') || paymentProviders.includes('alipay')) {
          const provider = paymentProviders.includes('wechatpay') ? 'wechatpay' : 'alipay';
          const res = await window.polishAPI.createCommercialOrder(provider, planId);
          if (res.checkoutUrl) {
            // 优先用本地后端地址打开支付页，避免公网不可达
            const backendUrl = $('#commercialBackendUrl')?.value || 'http://127.0.0.1:8787';
            const checkoutPath = new URL(res.checkoutUrl).pathname;
            const localCheckoutUrl = backendUrl + checkoutPath;
            window.polishAPI.openExternal(localCheckoutUrl);
            const statusEl = $('#commercialAccountStatus');
            if (statusEl) showStatus(statusEl, '已打开支付页面，正在等待支付结果…', 'success');

            // 自动轮询订单状态
            if (res.orderId) {
              let pollCount = 0;
              const maxPolls = 60; // 最多轮询3分钟 (每3秒一次)
              const pollTimer = setInterval(async () => {
                pollCount++;
                if (pollCount >= maxPolls) {
                  clearInterval(pollTimer);
                  if (statusEl) showStatus(statusEl, '支付超时，如已支付请点击「刷新状态」。', 'error');
                  return;
                }
                try {
                  const orderRes = await window.polishAPI.getCommercialOrder(res.orderId);
                  if (orderRes?.order?.status === 'paid') {
                    clearInterval(pollTimer);
                    if (statusEl) showStatus(statusEl, '支付成功！积分已到账。', 'success');
                    // 刷新账户状态
                    const freshStatus = await window.polishAPI.getCommercialStatus();
                    if (freshStatus) renderCommercialStatus(freshStatus);
                  }
                } catch (_e) { /* ignore poll errors */ }
              }, 3000);
            }
          } else if (res.user) {
            renderCommercialStatus({ ...commercialStatusCache, ...res.user });
          }
        } else {
          const result = await window.polishAPI.subscribeCommercial(planId);
          renderCommercialStatus(result);
        }
      } catch (err) {
        const status = $('#commercialAccountStatus');
        if (status) showStatus(status, err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '立即充值';
      }
    });
  });
}

function renderCommercialStatus(status) {
  commercialStatusCache = status || null;
  const available = status?.available !== false;
  const moduleEnabled = status?.enabled !== false;
  const loggedIn = Boolean(status?.loggedIn);
  const trial = status?.trial || {};
  const membership = status?.membership || {};
  const primaryPlan = getPrimaryPlan(status);
  const membershipActive = Boolean(loggedIn && membership.active);
  const paymentProviders = normalizePaymentProviders(status?.paymentProviders);
  const canUseHosted = membershipActive || Number(trial.remaining || 0) > 0;

  setCommercialVisibility(available);
  $('#commercialEnabled').checked = moduleEnabled;
  $('#commercialBackendUrl').value = status?.backendUrl || 'http://127.0.0.1:8787';

  // ── Login Card vs Dashboard ──
  const loginCard = $('#loginCard');
  const dashboard = $('#accountDashboard');
  if (loginCard && dashboard) {
    loginCard.classList.toggle('hidden', loggedIn);
    dashboard.classList.toggle('hidden', !loggedIn);
  }

  // ── Account Card ──
  const freeCredits = Number(status?.freeCredits || 0);
  const totalAvailable = Number(status?.totalAvailable || 0);
  $('#accountSubtitle').textContent = !available
    ? '商业模块已关闭'
    : (!moduleEnabled ? '商业模式已关闭' : (totalAvailable > 0 ? '✦ 积分可用' : (loggedIn ? '免费用户' : '未登录')));
  $('#accountPhone').textContent = loggedIn ? (status.email || status.phone || '–') : '–';
  $('#accountPlanName').textContent = !loggedIn ? '游客' : (membershipActive ? (membership.planName || primaryPlan.planName) : (freeCredits > 0 ? '签到用户' : '免费用户'));
  $('#accountSessionInfo').textContent = loggedIn
    ? `可用 ${totalAvailable} 积分`
    : '–';

  // ── Credits Card ──
  const creditsCard = $('#creditsCard');
  if (creditsCard) {
    if (loggedIn && totalAvailable > 0) {
      const creditsGranted = Number(status?.creditGranted || totalAvailable);
      const pct = creditsGranted > 0 ? Math.round((totalAvailable / creditsGranted) * 100) : 0;
      $('#creditsSummary').textContent = `${totalAvailable}`;
      const bar = $('#creditsBarFill');
      bar.style.width = `${Math.min(100, pct)}%`;
      bar.classList.toggle('low', pct < 20);
      const parts = [];
      if (membershipActive) parts.push(`充值 ${membership.creditsRemaining}`);
      if (freeCredits > 0) parts.push(`签到 ${freeCredits}`);
      if (!membershipActive && trial.remaining > 0) parts.push(`试用 ${trial.remaining} 次`);
      $('#creditsHint').textContent = parts.length ? `可用积分明细：${parts.join(' + ')}` : '';
    } else if (loggedIn) {
      $('#creditsSummary').textContent = '0';
      $('#creditsBarFill').style.width = '0%';
      $('#creditsHint').textContent = '积分已用完，请充值或每日签到获取积分';
    } else {
      $('#creditsSummary').textContent = '–';
      $('#creditsBarFill').style.width = '0%';
      $('#creditsHint').textContent = '登录后每日签到可领取积分';
    }
  }

  // ── Model Picker ──
  renderModelList();

  // ── Credit Policy ──
  renderCreditPolicy(status);

  // ── Plans Grid ──
  renderPlansGrid(status);

  // ── Login Section ──
  const loginSection = $('#loginCard');
  if (loginSection) {
    if (loggedIn) {
      loginSection.classList.add('hidden');
    } else {
      loginSection.classList.remove('hidden');
    }
  }
  $('#btnCommercialLogout').disabled = !loggedIn;

  updateHomeCommercialSummary(status);
}

function startCodeCooldown(seconds) {
  const button = $('#btnSendCommercialCode');
  let remaining = Math.max(0, Number(seconds) || 0);
  clearInterval(codeCooldownTimer);

  if (remaining <= 0) {
    button.disabled = false;
    button.textContent = '发送验证码';
    return;
  }

  button.disabled = true;
  button.textContent = `${remaining}s`;
  codeCooldownTimer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(codeCooldownTimer);
      codeCooldownTimer = null;
      button.disabled = false;
      button.textContent = '发送验证码';
      return;
    }
    button.textContent = `${remaining}s`;
  }, 1000);
}

async function refreshToolbarStatus() {
  const status = await window.polishAPI.getToolbarStatus();
  renderToolbarStatus(status);
  return status;
}

async function saveCommercialPreference(overrides = {}) {
  return window.polishAPI.saveCommercialSettings({
    enabled: $('#commercialEnabled').checked,
    backendUrl: $('#commercialBackendUrl').value.trim(),
    preferredSource: $('#sourceToggle').checked ? 'direct' : 'hosted',
    ...overrides,
  });
}

// ── Load config ──
async function loadConfig() {
  const [config, { presets, order }, toolbarStatus, initialCommercialStatus, initialUpdateStatus] = await Promise.all([
    window.polishAPI.getConfig(),
    window.polishAPI.getPresets(),
    window.polishAPI.getToolbarStatus(),
    window.polishAPI.getCommercialStatus(),
    window.polishAPI.getUpdateStatus(),
  ]);

  let commercialStatus = initialCommercialStatus;
  if (
    commercialStatus?.available !== false
    && (!Array.isArray(commercialStatus?.availablePlans) || commercialStatus.availablePlans.length === 0)
  ) {
    try {
      const plans = await window.polishAPI.getCommercialPlans();
      commercialStatus = {
        ...commercialStatus,
        availablePlans: plans,
      };
    } catch (_) {
      // Ignore plan bootstrap errors and keep the rest of the settings page usable.
    }
  }

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
  const shortcut = config.shortcut || 'CommandOrControl+Alt+V';
  const display = formatShortcut(shortcut);
  $('#currentShortcut').textContent = display;

  // Pipeline
  const task = normalizeTask(config.pipeline?.task || 'polish');
  const taskRadio = $(`input[name="taskMode"][value="${task}"]`);
  if (taskRadio) taskRadio.checked = true;

  const genre = config.pipeline?.genre || 'academic';
  const genreRadio = $(`input[name="genreMode"][value="${genre}"]`);
  if (genreRadio) genreRadio.checked = true;

  const mode = config.pipeline?.mode || 'single';
  const modeRadio = $(`input[name="pipelineMode"][value="${mode}"]`);
  if (modeRadio) modeRadio.checked = true;

  const temp = config.pipeline?.temperature ?? 0.3;
  $('#temperature').value = Math.round(temp * 10);
  $('#tempValue').textContent = temp.toFixed(1);
  $('#customPromptPolish').value = config.pipeline?.customPrompts?.polish || '';
  $('#customPromptDeai').value = config.pipeline?.customPrompts?.deai || '';
  const requestSource = commercialStatus?.preferredSource || config.commercial?.preferredSource || 'hosted';
  $('#sourceToggle').checked = requestSource === 'direct';

  renderToolbarStatus(toolbarStatus);
  renderCommercialStatus(commercialStatus);
  loadCheckinStatus();
  renderUpdateStatus(initialUpdateStatus);
  $('#commercialBackendUrl').value = commercialStatus?.backendUrl || config.commercial?.backendUrl || 'http://127.0.0.1:8787';
  $('#commercialEnabled').checked = commercialStatus?.enabled !== false;
  $('#aboutVersion').textContent = String(config.appVersion || '1.6.1');

  // ── Home tab status ──
  const shortcutHome = config.shortcut || 'CommandOrControl+Alt+V';
  $('#homeShortcut').textContent = formatShortcut(shortcutHome);

  const homePresetId = config.provider?.preset || 'together';
  const homePreset = presets[homePresetId];
  $('#homePreset').textContent = homePreset?.name || homePresetId;

  const homeToolbar = config.ui?.floatingToolbarEnabled !== false;
  $('#homeToolbar').textContent = homeToolbar ? '已开启' : '已关闭';

  const taskLabels = { polish: '润色', deai: '降AIGC' };
  const homeTaskId = normalizeTask(config.pipeline?.task || 'polish');
  $('#homeTask').textContent = taskLabels[homeTaskId] || homeTaskId;
  updateHomeCommercialSummary(commercialStatus);
}

// ── Save provider config (shared by Save + Test) ──
async function saveProviderConfig() {
  const presetId = $('#presetSelect').value;
  const preset = presetsData[presetId];
  const apiKey = preset?.needsKey ? $('#apiKey').value.trim() : '';

  await window.polishAPI.setConfig('provider.preset', presetId);
  await window.polishAPI.setConfig('provider.apiUrl', $('#apiUrl').value.trim() || preset?.apiUrl || '');
  await window.polishAPI.setConfig('provider.model', $('#modelName').value.trim() || preset?.model || '');
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
    // Enable source toggle and hint user
    const hint = $('#sourceToggleHint');
    if (hint && !$('#sourceToggle').checked) {
      hint.textContent = '✅ API 连接正常，可以开启此开关来使用自配 API。';
      hint.classList.add('success');
    }
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
  $('#homeShortcut').textContent = display;

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

$('#btnSaveCommercialSettings').addEventListener('click', async () => {
  const status = $('#commercialBackendStatus');
  try {
    const result = await saveCommercialPreference();
    renderCommercialStatus(result);
    showStatus(status, '商业后端配置已保存', 'success');
  } catch (err) {
    showStatus(status, err.message, 'error');
  }
});

$('#btnTestCommercialBackend').addEventListener('click', async () => {
  const status = $('#commercialBackendStatus');
  try {
    await saveCommercialPreference();
    showStatus(status, '测试中...', '');
    const result = await window.polishAPI.testCommercialBackend();
    showStatus(
      status,
      `后端可用：短信=${result.smsProvider || 'mock'}，支付通道=${(result.paymentProviders || []).map((item) => item.label || item).join('、') || '未配置'}`,
      'success',
    );
  } catch (err) {
    showStatus(status, `后端不可用: ${err.message}`, 'error');
  }
});

$('#btnRefreshCommercialStatus').addEventListener('click', async () => {
  const status = $('#commercialAccountStatus');
  try {
    const result = await window.polishAPI.refreshCommercialStatus();
    renderCommercialStatus(result);
    showStatus(status, '积分状态已刷新', 'success');
  } catch (err) {
    showStatus(status, err.message, 'error');
  }
});

$('#btnCommercialLogin').addEventListener('click', async () => {
  const status = $('#commercialAccountStatus');
  try {
    await saveCommercialPreference();
    const result = await window.polishAPI.loginCommercialEmail(
      $('#loginEmail').value.trim(),
      $('#loginPassword').value,
    );
    renderCommercialStatus(result);
    $('#loginPassword').value = '';
    showStatus(status, '登录成功', 'success');
  } catch (err) {
    showStatus(status, err.message, 'error');
  }
});

$('#btnCommercialRegister').addEventListener('click', async () => {
  const status = $('#commercialAccountStatus');
  try {
    await saveCommercialPreference();
    const result = await window.polishAPI.registerCommercial(
      $('#loginEmail').value.trim(),
      $('#loginPassword').value,
    );
    renderCommercialStatus(result);
    $('#loginPassword').value = '';
    showStatus(status, '注册成功，每日签到即可获取积分', 'success');
  } catch (err) {
    showStatus(status, err.message, 'error');
  }
});

$('#sourceToggle').addEventListener('change', async () => {
  const status = $('#apiStatus');
  const hint = $('#sourceToggleHint');
  const checked = $('#sourceToggle').checked;
  try {
    await saveCommercialPreference();
    if (checked) {
      showStatus(status, '已切换到自配 API', 'success');
      if (hint) { hint.textContent = '当前使用自配 API；关闭此开关可恢复使用润石积分。'; hint.className = 'form-hint'; }
    } else {
      showStatus(status, '已恢复使用润石积分', 'success');
      if (hint) { hint.textContent = '配置并测试通过后，开启此开关即可使用自己的 API；关闭后恢复使用润石积分。'; hint.className = 'form-hint'; }
    }
  } catch (err) {
    showStatus(status, err.message, 'error');
  }
});

$('#btnCommercialLogout').addEventListener('click', async () => {
  const status = $('#commercialAccountStatus');
  try {
    const result = await window.polishAPI.logoutCommercial();
    renderCommercialStatus(result);
    showStatus(status, '已退出登录', 'success');
  } catch (err) {
    showStatus(status, err.message, 'error');
  }
});

// ── Daily Check-in ──
async function loadCheckinStatus() {
  try {
    const data = await window.polishAPI.getCheckinStatus();
    if (!data || !data.ok) return;
    const btn = $('#btnCheckin');
    const hint = $('#checkinHint');
    const days = document.querySelectorAll('.checkin-day');
    const checkedDays = Math.max(0, Number(data.checkedDays || data.currentStreak || 0));

    if (data.checkedInToday) {
      btn.disabled = true;
      btn.textContent = '今日已签到 ✓';
    } else {
      btn.disabled = false;
      btn.textContent = '签到领 +1 积分';
    }

    // Highlight checked days
    days.forEach(d => {
      const day = Number(d.dataset.day);
      d.classList.remove('checked', 'today');
      if (day <= checkedDays) {
        d.classList.add('checked');
      }
      if (data.checkedInToday && day === Math.max(1, checkedDays)) {
        d.classList.add('today');
      } else if (!data.checkedInToday && day === Math.min(7, checkedDays + 1)) {
        d.classList.add('today');
      }
    });

    hint.textContent = data.checkedInToday
      ? '今日已签到，已领取 1 积分'
      : '每天签到可领取 1 积分';
  } catch (_) { /* not logged in */ }
}

$('#btnCheckin').addEventListener('click', async () => {
  const btn = $('#btnCheckin');
  const hint = $('#checkinHint');
  btn.disabled = true;
  try {
    const result = await window.polishAPI.checkin();
    if (result.ok) {
      hint.textContent = result.message;
      btn.textContent = '今日已签到 ✓';
      loadCheckinStatus();
      // Refresh account to update credit balance
      const refreshed = await window.polishAPI.refreshCommercialStatus();
      if (refreshed) renderCommercialStatus(refreshed);
    } else {
      hint.textContent = result.error || '签到失败';
      if (!result.alreadyCheckedIn) btn.disabled = false;
    }
  } catch (err) {
    hint.textContent = '签到失败：' + err.message;
    btn.disabled = false;
  }
});

// ── Save general ──
$('#btnSaveGeneral').addEventListener('click', async () => {
  const status = $('#generalStatus');
  const task = normalizeTask($('input[name="taskMode"]:checked').value);
  const genre = $('input[name="genreMode"]:checked').value;
  const mode = $('input[name="pipelineMode"]:checked').value;
  const temp = parseInt($('#temperature').value, 10) / 10;

  await window.polishAPI.setConfig('pipeline.task', task);
  await window.polishAPI.setConfig('pipeline.genre', genre);
  await window.polishAPI.setConfig('pipeline.mode', mode);
  await window.polishAPI.setConfig('pipeline.temperature', temp);
  $('#homeTask').textContent = ({ polish: '润色', deai: '降AIGC' }[task]) || task;
  showStatus(status, '已保存', 'success');
});

// ── Save prompts ──
$('#btnSavePrompts').addEventListener('click', async () => {
  const status = $('#promptsStatus');
  const customPromptPolish = $('#customPromptPolish').value.trim();
  const customPromptDeai = $('#customPromptDeai').value.trim();

  await window.polishAPI.setConfig('pipeline.customPrompts.polish', customPromptPolish);
  await window.polishAPI.setConfig('pipeline.customPrompts.deai', customPromptDeai);
  showStatus(status, '已保存', 'success');
});

// ── Author link ──
$('#authorLink').addEventListener('click', (e) => {
  e.preventDefault();
  window.polishAPI.openExternal('https://www.xiaohongshu.com/user/profile/5baad820f7e8b908db85cf62');
});

$('#btnCheckUpdates').addEventListener('click', async () => {
  const button = $('#btnCheckUpdates');
  const previousText = button.textContent;
  button.disabled = true;
  button.textContent = '检查中...';
  try {
    const status = await window.polishAPI.checkForUpdates();
    renderUpdateStatus(status);
  } catch (err) {
    renderUpdateStatus({
      ...(updateStatusCache || {}),
      checking: false,
      lastError: err.message,
    });
  } finally {
    button.disabled = false;
    button.textContent = previousText;
  }
});

$('#btnOpenLatestRelease').addEventListener('click', async () => {
  try {
    await window.polishAPI.openLatestRelease();
  } catch (err) {
    renderUpdateStatus({
      ...(updateStatusCache || {}),
      lastError: err.message,
    });
  }
});

// ── Init ──
loadConfig();
