'use strict';

/* ────────── State ────────── */
let diffChanges = [];
let originalText = '';
let polishedText = '';
let currentTask = 'polish';
let popupTimer = null;
let activeMarkerIdx = null;
let currentModelId = '';
let availableModels = [];
let reviewContext = { surgicalEditing: false, writeMode: 'copy' };
let sourceStateUncertain = false;
let transientActionMessage = '';
let transientActionTimer = null;
let versionResults = [];
let activeVersionIndex = 0;
let multipleVersionsEnabled = true;
let variantProgress = { current: 0, total: 0, done: false, error: '' };
let sourceReviewToken = null;
let sourceReviewRunning = false;

const LOADING_FLAVORS = [
  '字句之间，润物无声 ✨',
  '正在用 AI 帮你打磨文字...',
  '好文章是改出来的 📝',
  '逐字推敲中，请稍候...',
  '修辞炼句，精雕细琢 🎯',
  '文字美容进行中 💅',
  '正在施展润色魔法 🪄',
  '每一个字都值得被善待...',
  '语言的炼金术进行中 ⚗️',
  '遣词造句，笔下生花 🌸',
];

const TYPE_LABELS = {
  grammar: '语法',
  punctuation: '标点',
  wording: '用词',
  style: '风格',
  logic: '逻辑',
  deai: '降AIGC',
  detemplate: '自然化表达',
};

const INVISIBLE_CHAR_MAP = {
  ' ': { symbol: '␠', label: '空格' },
  '\n': { symbol: '↵', label: '换行' },
  '\r': { symbol: '␍', label: '回车' },
  '\t': { symbol: '⇥', label: '制表符' },
  '\u00A0': { symbol: '⍽', label: '不换行空格' },
  '\u2007': { symbol: '⍽', label: '数字空格' },
  '\u202F': { symbol: '⍽', label: '窄不换行空格' },
  '\u200B': { symbol: 'ZWSP', label: '零宽空格' },
  '\u200C': { symbol: 'ZWNJ', label: '零宽非连接符' },
  '\u200D': { symbol: 'ZWJ', label: '零宽连接符' },
  '\u2060': { symbol: 'WJ', label: '单词连接符' },
  '\uFEFF': { symbol: 'BOM', label: '零宽不换行空格' },
};

function normalizeTask(task) {
  return task === 'deai' ? 'deai' : 'polish';
}

function isInvisibleOnlyText(text) {
  const chars = [...String(text || '')];
  return chars.length > 0 && chars.every((char) => INVISIBLE_CHAR_MAP[char]);
}

function getVisibleTextPayload(text, fallback = '∅') {
  const raw = String(text || '');
  if (!raw) {
    return {
      raw,
      text: fallback,
      invisibleOnly: true,
      labels: '空内容',
    };
  }

  if (!isInvisibleOnlyText(raw)) {
    return {
      raw,
      text: raw,
      invisibleOnly: false,
      labels: '',
    };
  }

  const chars = [...raw];
  return {
    raw,
    text: chars.map((char) => INVISIBLE_CHAR_MAP[char].symbol).join(''),
    invisibleOnly: true,
    labels: chars.map((char) => INVISIBLE_CHAR_MAP[char].label).join(' + '),
  };
}

function isNoOpChange(change) {
  if (change.type === 'replace') {
    return String(change.oldText || '') === String(change.newText || '');
  }
  if (change.type === 'delete') {
    return !String(change.oldText || '');
  }
  if (change.type === 'insert') {
    return !String(change.newText || '');
  }
  return false;
}

function isIgnorableBoundaryWhitespaceChange(change) {
  const raw = String(change.oldText || change.newText || '');
  if (!raw || !isInvisibleOnlyText(raw)) return false;
  return Number(change.originalStart) === 0 || Number(change.originalEnd) === originalText.length;
}

function sanitizeRenderedChanges(changes) {
  return (changes || []).filter((change) => {
    if (change.type === 'equal') return true;
    if (isNoOpChange(change)) return false;
    if (isIgnorableBoundaryWhitespaceChange(change)) return false;
    return true;
  });
}

function formatSuggestionText(text) {
  return escHtml(getVisibleTextPayload(text).text);
}

/* ────────── DOM refs ────────── */
const $ = (id) => document.getElementById(id);
const loadingView = $('loadingView');
const errorView = $('errorView');
const noChangeView = $('noChangeView');
const resultView = $('resultView');
const diffBody = $('diffBody');
const polishedBody = $('polishedBody');
const actionHint = $('actionHint');
const changeBadge = $('changeBadge');
const progressFill = $('progressFill');
const loadingText = $('loadingText');
const loadingModel = $('loadingModel');
const errorText = $('errorText');
const modelSelect = $('modelSelect');
const versionRail = $('versionRail');
const versionTabs = $('versionTabs');
const versionStatus = $('versionStatus');

window.polishAPI.getConfig().then((config) => {
  multipleVersionsEnabled = config.ui?.multipleVersionsEnabled !== false;
  renderVersionTabs();
}).catch(() => {});

let flavorTimer = null;
function startFlavorRotation() {
  stopFlavorRotation();
  let idx = Math.floor(Math.random() * LOADING_FLAVORS.length);
  loadingText.textContent = LOADING_FLAVORS[idx];
  flavorTimer = setInterval(() => {
    idx = (idx + 1) % LOADING_FLAVORS.length;
    loadingText.style.opacity = '0';
    setTimeout(() => {
      loadingText.textContent = LOADING_FLAVORS[idx];
      loadingText.style.opacity = '1';
    }, 300);
  }, 3000);
}
function stopFlavorRotation() {
  if (flavorTimer) { clearInterval(flavorTimer); flavorTimer = null; }
}

const popupCard = $('popupCard');
const popupType = $('popupType');
const popupSuggestion = $('popupSuggestion');
const popupReason = $('popupReason');
const popupAlternatives = $('popupAlternatives');
const popupAltList = $('popupAltList');

/* ────────── Mode Toggle ────────── */
const modeToggle = $('modeToggle');

// When main process reports busy, keep loading view but tell the user why;
// the in-flight task will deliver polish:result / polish:error and unstick the UI.
function notifyBusyIfNeeded(res) {
  if (res && res.busy) {
    loadingText.textContent = '上一个任务还在进行中，完成后将自动显示结果...';
    return true;
  }
  return false;
}

modeToggle.addEventListener('click', async (e) => {
  const btn = e.target.closest('.mode-btn');
  if (!btn || btn.classList.contains('active')) return;
  const task = normalizeTask(btn.dataset.task);
  currentTask = task;
  modeToggle.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  showView('loading');
  startFlavorRotation();
  progressFill.style.width = '5%';
  const res = await window.polishAPI.reprocess(task);
  notifyBusyIfNeeded(res);
});

/* ────────── Resizable divider ────────── */
(function initDivider() {
  const divider = $('paneDivider');
  if (!divider) return;
  const paneTop = document.querySelector('.pane-top');
  const paneBottom = document.querySelector('.pane-bottom');
  let startY, startTopH, startBottomH;

  divider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startY = e.clientY;
    const rv = resultView.getBoundingClientRect();
    startTopH = paneTop.getBoundingClientRect().height;
    startBottomH = paneBottom.getBoundingClientRect().height;
    divider.classList.add('dragging');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  function onMove(e) {
    const dy = e.clientY - startY;
    const newTop = Math.max(80, startTopH + dy);
    const newBottom = Math.max(80, startBottomH - dy);
    const total = newTop + newBottom;
    paneTop.style.flex = `${newTop / total} 1 0%`;
    paneBottom.style.flex = `${newBottom / total} 1 0%`;
  }

  function onUp() {
    divider.classList.remove('dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
})();

/* ────────── Show / Hide views ────────── */
function showView(name) {
  loadingView.classList.toggle('hidden', name !== 'loading');
  errorView.classList.toggle('hidden', name !== 'error');
  noChangeView.classList.toggle('hidden', name !== 'nochange');
  resultView.classList.toggle('hidden', name !== 'result');
  hidePopup();
}

/* ────────── Events ────────── */
window.polishAPI.onOriginalText((text) => {
  originalText = text;
  sourceReviewToken = null; sourceReviewRunning = false;
  updateSourceReviewButton();
  reviewContext = { surgicalEditing: false, writeMode: 'copy' };
  sourceStateUncertain = false;
  transientActionMessage = '';
  versionResults = [];
  activeVersionIndex = 0;
  variantProgress = { current: 0, total: 0, done: false, error: '' };
  renderVersionTabs();
  showView('loading');
  startFlavorRotation();
});

window.polishAPI.onReviewContext?.((context) => {
  reviewContext = {
    surgicalEditing: Boolean(context?.surgicalEditing),
    platform: context?.platform || window.polishAPI.platform,
    writeMode: context?.writeMode || (context?.surgicalEditing ? 'inline' : 'copy'),
  };
  updateActionHint();
});

window.polishAPI.onTask((task) => {
  currentTask = normalizeTask(task);
  modeToggle.querySelectorAll('.mode-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.task === currentTask);
  });
});

window.polishAPI.onModelInfo((info) => {
  currentModelId = info.modelId || '';
  availableModels = info.models || [];
  loadingModel.textContent = `模型：${info.modelName || info.modelId}${info.credits ? ' (' + info.credits + '×)' : ''}`;
  populateModelSelect();
});

window.polishAPI.onProgress(({ stage, percent }) => {
  progressFill.style.width = (percent || 0) + '%';
});

window.polishAPI.onError((msg) => {
  stopFlavorRotation();
  errorText.textContent = msg;
  $('btnErrorSettings').style.display = /key|api|鉴权|登录|认证|积分/i.test(msg) ? 'inline-block' : 'none';
  showView('error');
});

$('btnErrorRetry').addEventListener('click', async () => {
  showView('loading');
  startFlavorRotation();
  progressFill.style.width = '5%';
  try { await window.polishAPI.releaseLock(); } catch (_) {}
  const res = await window.polishAPI.reprocess(currentTask);
  notifyBusyIfNeeded(res);
});

function cloneVersionResult(result) {
  return {
    ...result,
    diff: {
      ...(result.diff || {}),
      changes: (result.diff?.changes || []).map((change) => ({ ...change })),
    },
  };
}

function renderVersionTabs() {
  if (!versionRail || !versionTabs) return;
  const shouldShow = multipleVersionsEnabled && currentTask === 'polish' && versionResults.length > 0;
  versionRail.classList.toggle('hidden', !shouldShow);
  versionTabs.replaceChildren();
  if (!shouldShow) return;

  const labels = ['稳妥版', '自然版', '灵活版'];
  const locked = hasReviewDecisions();
  versionResults.forEach((_result, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'version-chip';
    button.textContent = labels[index] || `方案 ${index + 1}`;
    button.classList.toggle('active', index === activeVersionIndex);
    button.disabled = locked && index !== activeVersionIndex;
    button.title = button.disabled ? '已有修改写入原文，请先完成本次批阅' : `查看${button.textContent}`;
    button.addEventListener('click', () => selectVersion(index));
    versionTabs.appendChild(button);
  });

  if (variantProgress.error) {
    versionStatus.textContent = variantProgress.error;
  } else if (!variantProgress.done && variantProgress.total > 0) {
    versionStatus.textContent = `其他方案生成中 ${variantProgress.current}/${variantProgress.total}`;
  } else {
    versionStatus.textContent = versionResults.length > 1 ? `可比较 ${versionResults.length} 个版本` : '';
  }
}

function applyVersionResult(result) {
  stopFlavorRotation();
  polishedText = result.polishedText || '';
  const diff = result.diff || { changes: [], hasChanges: false };
  diffChanges = sanitizeRenderedChanges(diff.changes || []);

  // Ensure every non-equal change has explicit status
  diffChanges.forEach(c => {
    if (c.type !== 'equal' && !c.status) c.status = 'pending';
  });

  if (result.task) {
    currentTask = normalizeTask(result.task);
    modeToggle.querySelectorAll('.mode-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.task === currentTask);
    });
  }

  if (!diff.hasChanges || diffChanges.filter(c => c.type !== 'equal').length === 0) {
    showView('nochange');
    return;
  }

  renderDiff(diffChanges);
  renderPolished(polishedText);
  showView('result');
  updateBadge();
  updateActionHint();
  renderVersionTabs();
}

function selectVersion(index) {
  if (index === activeVersionIndex || !versionResults[index]) return;
  if (hasReviewDecisions()) {
    flashActionMessage('已有修改写入原文，请完成本次批阅后再选择其他版本。');
    return;
  }
  activeVersionIndex = index;
  window.polishAPI.stopSourceReview?.(); sourceReviewRunning = false;
  applyVersionResult(versionResults[index]);
  updateSourceReviewButton();
}

window.polishAPI.onResult((result) => {
  sourceReviewToken = result.sourceReviewToken || null; sourceReviewRunning = false;
  versionResults = [cloneVersionResult(result)];
  activeVersionIndex = 0;
  variantProgress = { current: 0, total: 0, done: true, error: '' };
  applyVersionResult(versionResults[0]);
  updateSourceReviewButton();
});

window.polishAPI.onAutoSourceReview?.(token => {
  const button = $('btnSourceReview');
  if (token === sourceReviewToken && !sourceReviewRunning && !button.disabled) button.click();
});

function updateSourceReviewButton() {
  const button = $('btnSourceReview');
  button.disabled = !sourceReviewToken || activeVersionIndex !== 0 || sourceStateUncertain
    || diffChanges.some(c => c.status === 'accepted' && !c.appliedInSource);
  button.textContent = sourceReviewRunning ? '停止原文浮窗' : '原文浮窗';
}
$('btnSourceReview').addEventListener('click', async () => {
  const button = $('btnSourceReview'); button.disabled = true;
  try {
    if (sourceReviewRunning) { await window.polishAPI.stopSourceReview(); sourceReviewRunning = false; }
    else {
      const result = await window.polishAPI.startSourceReview(sourceReviewToken);
      sourceReviewRunning = !!result?.ok;
      if (!result?.ok) flashActionMessage(result?.error || '当前编辑器无法提供精确原文位置，请在结果窗继续批阅。', 6000);
    }
  } finally { updateSourceReviewButton(); }
});
window.polishAPI.onSourceStatus?.(event => {
  if (event.token !== sourceReviewToken) return;
  sourceReviewRunning = event.running; updateSourceReviewButton();
  if (event.message) flashActionMessage(event.message, 5000);
  else if (!event.running) flashActionMessage('原文浮窗已停止，可在结果窗继续批阅。');
});
window.polishAPI.onSourceDecision?.(event => {
  if (event.token !== sourceReviewToken) return;
  const change = diffChanges.find(c => c.id === event.id);
  if (!change) return;
  if (event.ok) { change.status = event.status; change.appliedInSource = event.status === 'accepted'; }
  else {
    if (event.sourceMayHaveChanged) sourceStateUncertain = true;
    flashActionMessage(event.error || '未能写回原文。', 6000);
  }
  refreshReviewState(); updateSourceReviewButton();
});

window.polishAPI.onVariant?.((result) => {
  versionResults.push(cloneVersionResult(result));
  renderVersionTabs();
});

window.polishAPI.onVariantProgress?.((progress) => {
  variantProgress = {
    current: Number(progress?.current || 0),
    total: Number(progress?.total || 0),
    done: Boolean(progress?.done),
    error: String(progress?.error || ''),
  };
  renderVersionTabs();
});

// Async explanations update — received after initial result
window.polishAPI.onExplanations?.(({ explanations, changes }) => {
  if (!explanations?.length || !Array.isArray(changes)) return;
  // Main has already matched each explanation to a specific diff id. Reusing
  // those matches keeps repeated phrases distinct and preserves review state.
  const targetChanges = activeVersionIndex === 0 ? diffChanges : (versionResults[0]?.diff?.changes || []);
  const matchedChanges = new Map(changes.map(change => [change.id, change]));
  for (const change of targetChanges) {
    if (change.type === 'equal') continue;
    const match = matchedChanges.get(change.id);
    if (match && match.type === change.type && match.oldText === change.oldText && match.newText === change.newText) {
      change.reason = match.reason;
      change.errorType = match.errorType;
      change.alternatives = match.alternatives || [];
    }
  }
  // Re-render to show explanations
  if (versionResults[0]) {
    versionResults[0].diff = {
      ...(versionResults[0].diff || {}),
      changes: targetChanges.map((change) => ({ ...change })),
    };
  }
  if (activeVersionIndex === 0) renderDiff(diffChanges);
});

/* ────────── Upper pane: Diff Rendering ────────── */
function renderDiff(changes) {
  diffBody.innerHTML = '';

  changes.forEach((change) => {
    if (change.type === 'equal') {
      const span = document.createElement('span');
      span.className = 'segment';
      span.textContent = change.text;
      diffBody.appendChild(span);
    } else {
      const marker = createMarker(change);
      diffBody.appendChild(marker);
    }
  });
}

function createMarker(change) {
  const marker = document.createElement('span');
  marker.className = 'change-marker';
  marker.dataset.id = change.id;
  marker.dataset.type = change.errorType || (currentTask === 'deai' ? 'deai' : 'wording');
  marker.dataset.state = change.status === 'rejected' ? 'dismissed' : (change.status || 'pending');

  if (change.status === 'accepted') marker.classList.add('accepted');
  if (change.status === 'rejected') marker.classList.add('dismissed');

  const textSpan = document.createElement('span');
  textSpan.className = 'change-text';

  if (change.type === 'replace') {
    const payload = getVisibleTextPayload(change.status === 'accepted' ? (change.newText || '') : (change.oldText || ''));
    textSpan.textContent = payload.text;
    if (payload.invisibleOnly) {
      textSpan.classList.add('change-text-invisible');
      marker.title = payload.labels;
    }
  } else if (change.type === 'delete') {
    const payload = getVisibleTextPayload(change.oldText || '');
    textSpan.textContent = payload.text;
    if (payload.invisibleOnly) {
      textSpan.classList.add('change-text-invisible');
      marker.title = payload.labels;
    }
    if (change.status === 'accepted') {
      textSpan.classList.add('change-text-delete-accepted');
    }
  } else if (change.type === 'insert') {
    if (change.status === 'accepted') {
      const payload = getVisibleTextPayload(change.newText || '');
      textSpan.textContent = payload.text;
      if (payload.invisibleOnly) {
        textSpan.classList.add('change-text-invisible');
        marker.title = payload.labels;
      }
    } else {
      const payload = getVisibleTextPayload(change.newText || '');
      if (payload.invisibleOnly) {
        textSpan.textContent = payload.text;
        textSpan.classList.add('change-text-invisible', 'insert-preview-text');
        marker.title = payload.labels;
      } else {
        textSpan.textContent = '⊕';
        textSpan.classList.add('insert-icon');
      }
    }
  }
  marker.appendChild(textSpan);

  const opinion = document.createElement('span');
  opinion.className = 'inline-opinion';
  const opinionType = change.errorType || (currentTask === 'deai' ? 'deai' : 'wording');
  const stateLabel = change.status === 'accepted'
    ? '已接受'
    : (change.status === 'rejected' ? '已忽略' : '建议');
  opinion.textContent = `${TYPE_LABELS[opinionType] || '修改'} · ${change.reason || stateLabel}`;
  marker.appendChild(opinion);

  marker.addEventListener('mouseenter', () => {
    clearTimeout(popupTimer);
    popupTimer = setTimeout(() => showPopup(marker, change), 180);
  });
  marker.addEventListener('mouseleave', () => {
    clearTimeout(popupTimer);
    popupTimer = setTimeout(hidePopup, 300);
  });

  return marker;
}

/* ────────── Lower pane: Polished text ────────── */
function renderPolished(text) {
  polishedBody.value = text;
}

/* ────────── Popup ────────── */
function showPopup(marker, change) {
  activeMarkerIdx = change.id;
  const isDecisionMade = change.status === 'accepted' || change.status === 'rejected';

  const errType = change.errorType || (currentTask === 'deai' ? 'deai' : 'wording');
  popupType.textContent = TYPE_LABELS[errType] || errType || '修改';
  popupType.dataset.type = errType;

  const orig = change.oldText || '';
  const repl = change.newText || '';
  if (change.type === 'replace') {
    popupSuggestion.innerHTML = `<del>${formatSuggestionText(orig)}</del> → <ins>${formatSuggestionText(repl)}</ins>`;
  } else if (change.type === 'delete') {
    popupSuggestion.innerHTML = `<del>${formatSuggestionText(orig)}</del> → <ins>（删除）</ins>`;
  } else if (change.type === 'insert') {
    popupSuggestion.innerHTML = `<ins>插入: ${formatSuggestionText(repl)}</ins>`;
  }

  if (!isDecisionMade && change.alternatives && change.alternatives.length > 0) {
    popupAlternatives.classList.remove('hidden');
    popupAltList.innerHTML = '';
    change.alternatives.forEach((alt) => {
      const btn = document.createElement('button');
      btn.className = 'popup-alt-item';
      btn.textContent = alt;
      btn.addEventListener('click', () => {
        change.newText = alt;
        acceptChange(change);
      });
      popupAltList.appendChild(btn);
    });
  } else {
    popupAlternatives.classList.add('hidden');
  }

  if (isDecisionMade) {
    if (change.status === 'accepted') {
      if (change.appliedInSource) {
        popupReason.textContent = '这条修改已经直接落到原文里。点击下方按钮可撤销。';
      } else if (reviewContext.surgicalEditing) {
        popupReason.textContent = '这条修改目前只在当前窗口暂存，Word 原文还没改动。点击下方按钮可撤销。';
      } else {
        popupReason.textContent = '这条修改已接受。点击下方按钮可撤销。';
      }
    } else {
      popupReason.textContent = '这条修改已忽略。点击下方按钮可恢复为待批阅。';
    }
    $('popupAccept').textContent = change.status === 'accepted' ? '撤销这条修改' : '恢复待批阅';
    $('popupDismiss').classList.add('hidden');
  } else {
    popupReason.textContent = change.reason || '';
    $('popupAccept').textContent = '应用到原文';
    $('popupDismiss').textContent = '忽略';
    $('popupDismiss').classList.remove('hidden');
  }

  const rect = marker.getBoundingClientRect();
  let top = rect.bottom + 6;
  let left = rect.left;

  popupCard.classList.remove('hidden');
  const cardRect = popupCard.getBoundingClientRect();
  if (top + cardRect.height > window.innerHeight - 10) {
    top = rect.top - cardRect.height - 6;
  }
  if (left + cardRect.width > window.innerWidth - 10) {
    left = window.innerWidth - cardRect.width - 10;
  }
  if (left < 6) left = 6;

  popupCard.style.top = top + 'px';
  popupCard.style.left = left + 'px';
}

function hidePopup() {
  popupCard.classList.add('hidden');
  activeMarkerIdx = null;
}

popupCard.addEventListener('mouseenter', () => clearTimeout(popupTimer));
popupCard.addEventListener('mouseleave', () => {
  popupTimer = setTimeout(hidePopup, 200);
});

async function applyActivePopupSuggestion() {
  if (activeMarkerIdx === null) return;
  const change = diffChanges.find(c => c.id === activeMarkerIdx);
  if (!change || change.status === 'accepted' || change.status === 'rejected') return;
  await acceptChange(change);
}

popupSuggestion.addEventListener('click', applyActivePopupSuggestion);
popupSuggestion.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    applyActivePopupSuggestion();
  }
});

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

/* ────────── Accept / Dismiss ────────── */
function refreshReviewState() {
  renderDiff(diffChanges);
  renderPreviewText();
  updateBadge();
  updateActionHint();
  renderVersionTabs();
}

$('btnToggleComparison').addEventListener('click', () => {
  const content = $('comparisonContent');
  const collapsed = content.classList.toggle('hidden');
  $('btnToggleComparison').textContent = collapsed ? '展开' : '收起';
});

function hasReviewDecisions() {
  return diffChanges.some(c => c.type !== 'equal' && c.status && c.status !== 'pending');
}

function getPreviewText() {
  return hasReviewDecisions() ? computeFinalText() : polishedText;
}

function renderPreviewText() {
  renderPolished(getPreviewText());
}

function flashActionMessage(message, timeout = 2800) {
  transientActionMessage = message || '';
  updateActionHint();
  if (transientActionTimer) clearTimeout(transientActionTimer);
  if (!transientActionMessage) return;
  transientActionTimer = setTimeout(() => {
    transientActionTimer = null;
    transientActionMessage = '';
    updateActionHint();
  }, timeout);
}

async function acceptChange(change) {
  if (sourceStateUncertain) {
    flashActionMessage('无法确认上一条修改是否已写入。请先检查原文并重新选择文字分析。', 6000);
    return false;
  }
  if (reviewContext.surgicalEditing) {
    const response = await window.polishAPI.applyReviewChange(change, 'accept');
    if (response?.ok) {
      change.appliedInSource = Boolean(response.applied);
    } else {
      change.appliedInSource = false;
      if (response?.sourceMayHaveChanged) {
        sourceStateUncertain = true;
        hidePopup();
        refreshReviewState();
        flashActionMessage(response.error || '已发送修改，但无法确认写回结果。请检查原文并重新选择文字分析。', 6000);
        return false;
      }
      flashActionMessage(response?.error || '未能写回原文，这条建议仍待处理。', 8000);
      return false;
    }
  } else {
    change.appliedInSource = false;
  }
  change.status = 'accepted';
  updateSourceReviewButton();
  hidePopup();
  refreshReviewState();
  return true;
}

function dismissChange(change) {
  change.status = 'rejected';
  window.polishAPI.syncSourceDecision?.(sourceReviewToken, change.id, 'rejected');
  hidePopup();
  refreshReviewState();
}

async function revertDecision(change) {
  if (sourceStateUncertain) {
    flashActionMessage('无法确认原文当前状态。请先检查原文并重新选择文字分析。', 6000);
    return false;
  }
  if (change.status === 'accepted' && change.appliedInSource && reviewContext.surgicalEditing) {
    const response = await window.polishAPI.applyReviewChange(change, 'revert');
    if (!response?.ok) {
      if (response?.sourceMayHaveChanged) {
        sourceStateUncertain = true;
        hidePopup();
        refreshReviewState();
      }
      flashActionMessage(response?.error || '撤销这条原位修订失败，请重新选择文本后再试。',
        response?.sourceMayHaveChanged ? 6000 : 2800);
      return false;
    }
    change.appliedInSource = false;
  }
  change.status = 'pending';
  window.polishAPI.syncSourceDecision?.(sourceReviewToken, change.id, 'pending');
  updateSourceReviewButton();
  hidePopup();
  refreshReviewState();
  return true;
}

$('popupAccept').addEventListener('click', async () => {
  if (activeMarkerIdx !== null) {
    const change = diffChanges.find(c => c.id === activeMarkerIdx);
    if (!change) return;
    if (change.status === 'accepted' || change.status === 'rejected') {
      await revertDecision(change);
      return;
    }
    await acceptChange(change);
  }
});

$('popupDismiss').addEventListener('click', () => {
  if (activeMarkerIdx !== null) {
    const change = diffChanges.find(c => c.id === activeMarkerIdx);
    if (change) dismissChange(change);
  }
});

$('popupClose').addEventListener('click', hidePopup);

/* ────────── Bulk actions (in upper pane header) ────────── */
$('btnAcceptAll').addEventListener('click', async () => {
  hidePopup();
  const button = $('btnAcceptAll');
  if (button.disabled) return;
  const reviewable = diffChanges.filter(c => c.type !== 'equal' && c.status === 'pending');
  if (!reviewable.length) {
    flashActionMessage('没有待接受的建议。');
    return;
  }
  button.disabled = true;
  try {
    for (const [index, change] of reviewable.entries()) {
      button.textContent = `正在应用 ${index + 1}/${reviewable.length}`;
      if (!await acceptChange(change)) return;
    }
    flashActionMessage(reviewContext.surgicalEditing
      ? `已在原文应用 ${reviewable.length} 处修改，可逐条撤销。`
      : `已选择 ${reviewable.length} 处修改，请复制已选修改稿。`, 6000);
  } catch (error) {
    flashActionMessage(`未能完成接受全部：${error.message || '请重试'}`, 8000);
  } finally {
    button.disabled = false;
    button.textContent = '接受全部';
  }
});
$('btnRegenerate').addEventListener('click', async () => {
  showView('loading');
  startFlavorRotation();
  progressFill.style.width = '5%';
  try {
    const res = await window.polishAPI.regenerate();
    notifyBusyIfNeeded(res);
  } catch (err) {
    showView('error');
    errorText.textContent = `重新生成失败：${err.message}`;
  }
});

async function beginRecapture() {
  hidePopup();
  showView('loading');
  startFlavorRotation();
  loadingText.textContent = '正在刷新当前选区...';
  progressFill.style.width = '0%';
  try {
    const result = await window.polishAPI.recapture();
    if (result?.queued) {
      loadingText.textContent = '正在结束当前任务，随后读取新选区...';
    }
  } catch (err) {
    showView('error');
    errorText.textContent = `刷新选区失败：${err.message}`;
  }
}

$('btnRecapture').addEventListener('click', beginRecapture);
$('btnTitleRecapture').addEventListener('click', beginRecapture);

/* ────────── Model select ────────── */
function populateModelSelect() {
  modelSelect.innerHTML = '';
  if (!availableModels.length) {
    modelSelect.style.display = 'none';
    return;
  }
  modelSelect.style.display = '';
  const tiers = [];
  const tierMap = {};
  for (const m of availableModels) {
    if (!tierMap[m.tier]) { tierMap[m.tier] = []; tiers.push(m.tier); }
    tierMap[m.tier].push(m);
  }
  for (const tier of tiers) {
    const og = document.createElement('optgroup');
    og.label = tier;
    for (const m of tierMap[tier]) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = `${m.name}  ${m.credits}×`;
      if (m.id === currentModelId) opt.selected = true;
      og.appendChild(opt);
    }
    modelSelect.appendChild(og);
  }
}

modelSelect.addEventListener('change', async () => {
  const modelId = modelSelect.value;
  if (!modelId || modelId === currentModelId) return;
  currentModelId = modelId;
  showView('loading');
  startFlavorRotation();
  progressFill.style.width = '5%';
  const res = await window.polishAPI.reprocessWithModel(modelId);
  notifyBusyIfNeeded(res);
});
$('btnRejectAll').addEventListener('click', () => {
  (async () => {
    hidePopup();
    const acceptedChanges = diffChanges.filter(c => c.type !== 'equal' && c.status === 'accepted');
    const reverted = new Set();
    for (const change of acceptedChanges) {
      if (await revertDecision(change)) reverted.add(change.id);
    }
    diffChanges.filter(c => c.type !== 'equal').forEach(c => {
      if (c.status === 'accepted' && c.appliedInSource && !reverted.has(c.id)) return;
      c.status = 'rejected';
      c.appliedInSource = false;
    });
    refreshReviewState();
  })();
});

/* ────────── Lower pane actions ────────── */
async function applyReplacementText(text) {
  try {
    const result = await window.polishAPI.replaceText(text);
    if (!result?.ok) {
      if (result?.sourceMayHaveChanged) sourceStateUncertain = true;
      flashActionMessage(result?.error || '替换失败，请保留当前结果后重试。');
      refreshReviewState();
      return;
    }
    if (result.mode === 'copied') {
      flashActionMessage('修改稿已复制。当前编辑器无法安全核对原文位置，请回到原文手动粘贴。', 5200);
      return;
    }
    window.polishAPI.closeResult();
  } catch (error) {
    flashActionMessage(`替换失败：${error.message}`);
  }
}

$('btnUsePolished').addEventListener('click', async () => {
  if (sourceStateUncertain) {
    flashActionMessage('无法确认原文当前状态。请先检查原文并重新选择文字分析。', 6000);
    return;
  }
  if (reviewContext.surgicalEditing) {
    const result = await window.polishAPI.finalizeReview(polishedText);
    if (!result?.ok) {
      if (result?.sourceMayHaveChanged) sourceStateUncertain = true;
      flashActionMessage(result?.error || '无法把完整修改稿同步回原文。');
      refreshReviewState();
      return;
    }
    window.polishAPI.closeResult();
    return;
  }
  await applyReplacementText(polishedText);
});

$('btnCopyPolished').addEventListener('click', () => {
  window.polishAPI.copyText(polishedText);
  const btn = $('btnCopyPolished');
  btn.textContent = '已复制 ✓';
  setTimeout(() => { btn.textContent = '复制'; }, 1500);
});

function computeFinalText() {
  let result = '';
  for (const c of diffChanges) {
    switch (c.type) {
      case 'equal':
        result += c.text;
        break;
      case 'replace':
        result += c.status === 'accepted' ? c.newText : c.oldText;
        break;
      case 'delete':
        if (c.status !== 'accepted') result += c.oldText;
        break;
      case 'insert':
        if (c.status === 'accepted') result += c.newText;
        break;
    }
  }
  return result;
}

function updateBadge() {
  const pending = diffChanges.filter(c => c.type !== 'equal' && c.status === 'pending').length;
  if (pending > 0) {
    changeBadge.textContent = pending;
    changeBadge.classList.add('show');
  } else {
    changeBadge.classList.remove('show');
  }
}

function updateActionHint() {
  const total = diffChanges.filter(c => c.type !== 'equal').length;
  const accepted = diffChanges.filter(c => c.type !== 'equal' && c.status === 'accepted').length;
  const dismissed = diffChanges.filter(c => c.type !== 'equal' && c.status === 'rejected').length;
  const applied = diffChanges.filter(c => c.type !== 'equal' && c.status === 'accepted' && c.appliedInSource).length;
  if (sourceStateUncertain) {
    actionHint.textContent = '无法确认上一条修改是否已写入；请检查原文并重新选择文字分析';
  } else if (transientActionMessage) {
    actionHint.textContent = transientActionMessage;
  } else if (reviewContext.surgicalEditing && accepted > 0) {
    if (applied === accepted) {
      actionHint.textContent = `已接受 ${accepted}/${total} 处修改，已原位应用 ${applied} 处`;
    } else if (applied > 0) {
      actionHint.textContent = `已接受 ${accepted}/${total} 处修改，已写回 Word ${applied} 处，其余仍在当前窗口暂存`;
    } else {
      actionHint.textContent = `已在当前窗口接受 ${accepted}/${total} 处修改，尚未同步到 Word 原文`;
    }
  } else if (reviewContext.surgicalEditing) {
    actionHint.textContent = `共 ${total} 处修改建议，接受后会直接落到原文`;
  } else if (accepted > 0 || dismissed > 0) {
    actionHint.textContent = `已选择 ${accepted}/${total} 处修改，确认后复制修改稿`;
  } else {
    actionHint.textContent = `共 ${total} 处修改建议；当前编辑器使用复制回退`;
  }
  const applyBtn = $('btnApplyAccepted');
  const currentPlanButton = $('btnUsePolished');
  const modeDescription = $('reviewModeDescription');
  applyBtn.disabled = accepted === 0;
  if (sourceStateUncertain) applyBtn.disabled = true;
  if (reviewContext.surgicalEditing) {
    applyBtn.textContent = accepted > 0 ? `完成批阅 (${accepted})` : '完成批阅';
    applyBtn.title = '已接受的修改会直接落到原文，点击后结束本次批阅';
    currentPlanButton.textContent = '应用当前方案';
    currentPlanButton.title = '核对当前原文后应用完整修改稿';
    modeDescription.textContent = '点击意见可逐条写回原文；完成前仍可撤销';
  } else {
    applyBtn.textContent = accepted > 0 ? `复制已选修改 (${accepted})` : '复制已选修改';
    applyBtn.title = '复制包含已选修改的文本，再回到原文手动粘贴';
    currentPlanButton.textContent = '复制当前方案';
    currentPlanButton.title = '复制完整修改稿，再回到原文手动粘贴';
    modeDescription.textContent = '当前编辑器使用复制回退，原文不会被自动覆盖';
  }
}

/* ────────── Apply accepted changes (upper pane) ────────── */
$('btnApplyAccepted').addEventListener('click', async () => {
  if (sourceStateUncertain) {
    flashActionMessage('无法确认原文当前状态。请先检查原文并重新选择文字分析。', 6000);
    return;
  }
  const accepted = diffChanges.filter(c => c.type !== 'equal' && c.status === 'accepted').length;
  if (accepted === 0) return;
  const finalText = computeFinalText();
  if (reviewContext.surgicalEditing) {
    const result = await window.polishAPI.finalizeReview(finalText);
    if (!result?.ok) {
      if (result?.sourceMayHaveChanged) sourceStateUncertain = true;
      flashActionMessage(result?.error || '无法完成最终同步，请重新选择文本后再试。');
      refreshReviewState();
    }
    return;
  }
  await applyReplacementText(finalText);
});

/* ────────── Buttons ────────── */
$('btnClose').addEventListener('click', () => window.polishAPI.closeResult());
$('btnSettings').addEventListener('click', () => window.polishAPI.openSettings());
$('btnErrorSettings').addEventListener('click', () => window.polishAPI.openSettings());

/* ────────── Keyboard ────────── */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!popupCard.classList.contains('hidden')) {
      hidePopup();
    } else {
      window.polishAPI.closeResult();
    }
  }
});
