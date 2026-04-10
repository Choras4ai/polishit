'use strict';

document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const task = btn.dataset.task;
    // Tell main process which task was chosen
    window.polishAPI.toolbarAction(task);
  });
});
