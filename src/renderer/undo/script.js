'use strict';

const undoChip = document.getElementById('undoChip');
const closeBtn = document.getElementById('btnClose');

let busy = false;
let locked = false;

async function rollback() {
  if (busy || locked) return;
  busy = true;
  undoChip.disabled = true;
  try {
    const result = await window.polishAPI.rollbackLastReplace();
    if (!result?.ok) {
      const subtitle = undoChip.querySelector('.undo-subtitle');
      if (subtitle) subtitle.textContent = result?.error || '恢复失败';
      undoChip.style.opacity = '0.6';
      if (result?.sourceMayHaveChanged) {
        locked = true;
        undoChip.disabled = true;
      } else {
        undoChip.disabled = false;
      }
      return;
    }
    await window.polishAPI.dismissUndoToast();
  } catch (err) {
    const subtitle = undoChip.querySelector('.undo-subtitle');
    if (subtitle) subtitle.textContent = '恢复失败';
    undoChip.style.opacity = '0.6';
    undoChip.disabled = false;
  } finally {
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
