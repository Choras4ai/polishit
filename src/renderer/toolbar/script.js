'use strict';

const $ = (id) => document.getElementById(id);
const contextMenu = $('contextMenu');

// ── Toolbar button click → trigger task ──
document.querySelectorAll('.tool-btn[data-task]').forEach(btn => {
  btn.addEventListener('click', () => {
    const task = btn.dataset.task;
    window.polishAPI.toolbarAction(task);
  });
});

// ── Show/hide context menu ──
function showContextMenu() {
  contextMenu.classList.remove('hidden');
}

function hideContextMenu() {
  contextMenu.classList.add('hidden');
}

// ⋯ button → toggle context menu
$('btnMenu').addEventListener('click', (e) => {
  e.stopPropagation();
  if (contextMenu.classList.contains('hidden')) {
    showContextMenu();
  } else {
    hideContextMenu();
  }
});

// Right-click anywhere on toolbar → context menu
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  showContextMenu();
});

// Click outside → close
document.addEventListener('click', (e) => {
  if (!contextMenu.contains(e.target) && e.target !== $('btnMenu')) {
    hideContextMenu();
  }
});

// ── Context menu actions ──
$('ctxSettings').addEventListener('click', () => {
  hideContextMenu();
  window.polishAPI.openSettings();
});

$('ctxCloseToolbar').addEventListener('click', () => {
  hideContextMenu();
  window.polishAPI.setToolbarEnabled(false);
});
