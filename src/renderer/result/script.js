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
let reviewContext = { surgicalEditing: false };
let transientActionMessage = '';
let transientActionTimer = null;

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
modeToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('.mode-btn');
  if (!btn || btn.classList.contains('active')) return;
  const task = normalizeTask(btn.dataset.task);
  currentTask = task;
  modeToggle.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  showView('loading');
  startFlavorRotation();
  progressFill.style.width = '5%';
  window.polishAPI.reprocess(task);
});

/* ────────── Resizable divider ────────── */
(function initDivider() {
  const divider = $('paneDivider');
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
  reviewContext = { surgicalEditing: false };
  transientActionMessage = '';
  showView('loading');
  startFlavorRotation();
});

window.polishAPI.onReviewContext?.((context) => {
  reviewContext = {
    surgicalEditing: Boolean(context?.surgicalEditing),
    platform: context?.platform || window.polishAPI.platform,
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
  $('btnErrorSettings').style.display = msg.includes('Key') ? 'inline-block' : 'none';
  showView('error');
});

$('btnErrorRetry').addEventListener('click', async () => {
  showView('loading');
  startFlavorRotation();
  progressFill.style.width = '5%';
  try { await window.polishAPI.releaseLock(); } catch (_) {}
  window.polishAPI.reprocess(currentTask);
});

window.polishAPI.onResult((result) => {
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
});

// Async explanations update — received after initial result
window.polishAPI.onExplanations?.(({ explanations, changes }) => {
  if (!explanations || !explanations.length) return;
  // Update diffChanges with explanation data
  for (const change of diffChanges) {
    if (change.type === 'equal') continue;
    const oldText = change.oldText || '';
    const newText = change.newText || '';
    const match = explanations.find(exp => {
      const origMatch = oldText.includes(exp.original) || exp.original.includes(oldText);
      const modMatch = newText.includes(exp.modified) || exp.modified.includes(newText);
      return origMatch || modMatch;
    });
    if (match) {
      change.reason = match.reason;
      change.errorType = match.type;
      change.alternatives = match.alternatives || [];
    }
  }
  // Re-render to show explanations
  renderDiff(diffChanges);
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
  polishedBody.textContent = text;
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
    $('popupAccept').textContent = '接受修改';
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
}

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
  let sourceError = '';
  if (reviewContext.surgicalEditing) {
    const response = await window.polishAPI.applyReviewChange(change, 'accept');
    if (response?.ok) {
      change.appliedInSource = Boolean(response.applied);
    } else {
      change.appliedInSource = false;
      sourceError = response?.error || '当前应用暂不支持逐条原位修订，本次会在最终确认时统一同步。';
    }
  } else {
    change.appliedInSource = false;
  }
  change.status = 'accepted';
  hidePopup();
  refreshReviewState();
  if (sourceError) {
    flashActionMessage(`${sourceError} 这条修改目前只在当前窗口暂存，Word 原文尚未改动。`, 4200);
  }
}

function dismissChange(change) {
  change.status = 'rejected';
  hidePopup();
  refreshReviewState();
}

async function revertDecision(change) {
  if (change.status === 'accepted' && change.appliedInSource && reviewContext.surgicalEditing) {
    const response = await window.polishAPI.applyReviewChange(change, 'revert');
    if (!response?.ok) {
      flashActionMessage(response?.error || '撤销这条原位修订失败，请重新选择文本后再试。');
      return;
    }
    change.appliedInSource = false;
  }
  change.status = 'pending';
  hidePopup();
  refreshReviewState();
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
  const reviewable = diffChanges.filter(c => c.type !== 'equal' && c.status !== 'accepted');
  for (const change of reviewable) {
    await acceptChange(change);
  }
});
$('btnRegenerate').addEventListener('click', () => {
  showView('loading');
  startFlavorRotation();
  progressFill.style.width = '5%';
  window.polishAPI.regenerate();
});
$('btnRecapture').addEventListener('click', () => {
  showView('loading');
  startFlavorRotation();
  progressFill.style.width = '0%';
  window.polishAPI.recapture();
});

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

modelSelect.addEventListener('change', () => {
  const modelId = modelSelect.value;
  if (!modelId || modelId === currentModelId) return;
  currentModelId = modelId;
  showView('loading');
  startFlavorRotation();
  progressFill.style.width = '5%';
  window.polishAPI.reprocessWithModel(modelId);
});
$('btnRejectAll').addEventListener('click', () => {
  (async () => {
    hidePopup();
    const acceptedChanges = diffChanges.filter(c => c.type !== 'equal' && c.status === 'accepted');
    for (const change of acceptedChanges) {
      await revertDecision(change);
    }
    diffChanges.filter(c => c.type !== 'equal').forEach(c => {
      c.status = 'rejected';
      c.appliedInSource = false;
    });
    refreshReviewState();
  })();
});

/* ────────── Lower pane actions ────────── */
$('btnUsePolished').addEventListener('click', async () => {
  if (reviewContext.surgicalEditing) {
    const result = await window.polishAPI.finalizeReview(polishedText);
    if (!result?.ok) {
      flashActionMessage(result?.error || '无法把完整修改稿同步回原文。');
    }
    return;
  }
  window.polishAPI.replaceText(polishedText);
  window.polishAPI.closeResult();
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
  if (transientActionMessage) {
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
    actionHint.textContent = `已接受 ${accepted}/${total} 处修改`;
  } else {
    actionHint.textContent = `共 ${total} 处修改建议`;
  }
  const applyBtn = $('btnApplyAccepted');
  applyBtn.disabled = accepted === 0;
  if (reviewContext.surgicalEditing) {
    applyBtn.textContent = accepted > 0 ? `完成批阅 (${accepted})` : '完成批阅';
    applyBtn.title = '已接受的修改会直接落到原文，点击后结束本次批阅';
  } else {
    applyBtn.textContent = accepted > 0 ? `确认选用 (${accepted})` : '确认选用';
    applyBtn.title = '应用已接受的修改并替换原文';
  }
}

/* ────────── Apply accepted changes (upper pane) ────────── */
$('btnApplyAccepted').addEventListener('click', async () => {
  const accepted = diffChanges.filter(c => c.type !== 'equal' && c.status === 'accepted').length;
  if (accepted === 0) return;
  const finalText = computeFinalText();
  if (reviewContext.surgicalEditing) {
    const result = await window.polishAPI.finalizeReview(finalText);
    if (!result?.ok) {
      flashActionMessage(result?.error || '无法完成最终同步，请重新选择文本后再试。');
    }
    return;
  }
  window.polishAPI.replaceText(finalText);
  window.polishAPI.closeResult();
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
