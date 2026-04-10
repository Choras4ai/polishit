'use strict';

/* ────────── State ────────── */
let diffChanges = [];
let originalText = '';
let polishedText = '';
let currentTask = 'polish';
let popupTimer = null;
let activeMarkerIdx = null;

const TYPE_LABELS = {
  grammar: '语法',
  punctuation: '标点',
  wording: '用词',
  style: '风格',
  logic: '逻辑',
  dedup: '降重',
  deai: '降AI率（图一乐版）',
};

/* ────────── DOM refs ────────── */
const $ = (id) => document.getElementById(id);
const loadingView = $('loadingView');
const errorView = $('errorView');
const noChangeView = $('noChangeView');
const resultView = $('resultView');
const diffBody = $('diffBody');
const polishedBody = $('polishedBody');
const actionBar = $('actionBar');
const actionHint = $('actionHint');
const changeBadge = $('changeBadge');
const progressFill = $('progressFill');
const loadingText = $('loadingText');
const errorText = $('errorText');

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
  const task = btn.dataset.task;
  currentTask = task;
  modeToggle.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  showView('loading');
  loadingText.textContent = task === 'dedup'
    ? '正在进行降重处理...'
    : task === 'deai'
      ? '正在进行降AI率（图一乐版）处理...'
      : '正在润色分析...';
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
  actionBar.classList.toggle('hidden', name !== 'result');
  hidePopup();
}

/* ────────── Events ────────── */
window.polishAPI.onOriginalText((text) => {
  originalText = text;
  showView('loading');
});

window.polishAPI.onTask((task) => {
  currentTask = task;
  modeToggle.querySelectorAll('.mode-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.task === task);
  });
});

window.polishAPI.onProgress(({ stage, percent }) => {
  loadingText.textContent = stage || '处理中...';
  progressFill.style.width = (percent || 0) + '%';
});

window.polishAPI.onError((msg) => {
  errorText.textContent = msg;
  $('btnErrorSettings').style.display = msg.includes('Key') ? 'inline-block' : 'none';
  showView('error');
});

window.polishAPI.onResult((result) => {
  polishedText = result.polishedText || '';
  const diff = result.diff || { changes: [], hasChanges: false };
  diffChanges = diff.changes || [];

  if (result.task) {
    currentTask = result.task;
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
  marker.dataset.type = change.errorType || (currentTask === 'dedup' ? 'dedup' : currentTask === 'deai' ? 'deai' : 'wording');
  marker.dataset.state = 'pending';

  const textSpan = document.createElement('span');
  textSpan.className = 'change-text';

  if (change.type === 'replace') {
    textSpan.textContent = change.oldText;
  } else if (change.type === 'delete') {
    textSpan.textContent = change.oldText;
  } else if (change.type === 'insert') {
    textSpan.textContent = '⊕';
    textSpan.style.fontSize = '10px';
    textSpan.style.opacity = '0.6';
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

  const errType = change.errorType || (currentTask === 'dedup' ? 'dedup' : currentTask === 'deai' ? 'deai' : 'wording');
  popupType.textContent = TYPE_LABELS[errType] || errType || '修改';
  popupType.dataset.type = errType;

  const orig = change.oldText || '';
  const repl = change.newText || '';
  if (change.type === 'replace') {
    popupSuggestion.innerHTML = `<del>${escHtml(orig)}</del> → <ins>${escHtml(repl)}</ins>`;
  } else if (change.type === 'delete') {
    popupSuggestion.innerHTML = `<del>${escHtml(orig)}</del> → <ins>（删除）</ins>`;
  } else if (change.type === 'insert') {
    popupSuggestion.innerHTML = `<ins>插入: ${escHtml(repl)}</ins>`;
  }

  if (change.alternatives && change.alternatives.length > 0) {
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

  popupReason.textContent = change.reason || '';

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
function acceptChange(change) {
  const marker = diffBody.querySelector(`.change-marker[data-id="${change.id}"]`);
  if (!marker) return;
  marker.classList.add('accepted');
  marker.dataset.state = 'accepted';
  change.status = 'accepted';
  const textSpan = marker.querySelector('.change-text');
  if (textSpan) {
    if (change.type === 'replace' || change.type === 'insert') {
      textSpan.textContent = change.newText || '';
      textSpan.style.color = 'var(--accent)';
      textSpan.style.fontWeight = '500';
    } else if (change.type === 'delete') {
      textSpan.textContent = '';
    }
  }
  hidePopup();
  updateBadge();
  updateActionHint();
}

function dismissChange(change) {
  const marker = diffBody.querySelector(`.change-marker[data-id="${change.id}"]`);
  if (!marker) return;
  marker.classList.add('dismissed');
  marker.dataset.state = 'dismissed';
  change.status = 'rejected';
  hidePopup();
  updateBadge();
  updateActionHint();
}

$('popupAccept').addEventListener('click', () => {
  if (activeMarkerIdx !== null) {
    const change = diffChanges.find(c => c.id === activeMarkerIdx);
    if (change) acceptChange(change);
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
$('btnAcceptAll').addEventListener('click', () => {
  diffChanges.filter(c => c.type !== 'equal').forEach(c => acceptChange(c));
});

$('btnRejectAll').addEventListener('click', () => {
  diffChanges.filter(c => c.type !== 'equal').forEach(c => dismissChange(c));
});

/* ────────── Lower pane actions ────────── */
$('btnUsePolished').addEventListener('click', () => {
  window.polishAPI.replaceText(polishedText);
  window.polishAPI.closeResult();
});

$('btnCopyPolished').addEventListener('click', () => {
  window.polishAPI.copyText(polishedText);
  const btn = $('btnCopyPolished');
  btn.textContent = '已复制 ✓';
  setTimeout(() => { btn.textContent = '复制'; }, 1500);
});

/* ────────── Footer action: replace with partial accepts ────────── */
$('btnReplace').addEventListener('click', () => {
  const finalText = computeFinalText();
  window.polishAPI.replaceText(finalText);
  window.polishAPI.closeResult();
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
  if (accepted > 0 || dismissed > 0) {
    actionHint.textContent = `已接受 ${accepted}/${total} 处修改`;
  } else {
    actionHint.textContent = `共 ${total} 处修改建议`;
  }
  const applyBtn = $('btnApplyAccepted');
  applyBtn.disabled = accepted === 0;
  applyBtn.textContent = accepted > 0 ? `确认选用 (${accepted})` : '确认选用';
}

/* ────────── Apply accepted changes (upper pane) ────────── */
$('btnApplyAccepted').addEventListener('click', () => {
  const accepted = diffChanges.filter(c => c.type !== 'equal' && c.status === 'accepted').length;
  if (accepted === 0) return;
  const finalText = computeFinalText();
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
