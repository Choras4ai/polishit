'use strict';

const undoChip = document.getElementById('undoChip');
const closeBtn = document.getElementById('btnClose');

let busy = false;

async function rollback() {
  if (busy) return;
  busy = true;
  undoChip.disabled = true;
  try {
    await window.polishAPI.rollbackLastReplace();
  } finally {
    await window.polishAPI.dismissUndoToast();
    busy = false;
  }
}

undoChip.addEventListener('click', rollback);
closeBtn.addEventListener('click', async (event) => {
  event.stopPropagation();
  await window.polishAPI.dismissUndoToast();
});

document.addEventListener('keydown', async (event) => {
  if (event.key === 'Escape') {
    await window.polishAPI.dismissUndoToast();
    return;
  }
  if (event.key === 'Enter' || event.key === 'u' || event.key === 'U') {
    event.preventDefault();
    await rollback();
  }
});