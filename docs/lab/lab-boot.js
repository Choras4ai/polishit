'use strict';
// Catch failures in the entry module itself, before any WebGL code can run.
import('./lab.js?v=20260913-brand1').catch(() => {
  document.body.classList.add('lab-ready', 'canvas-fallback');
  document.querySelector('#labLoader')?.remove();
  document.querySelector('#skyControls')?.setAttribute('hidden', '');
  const note = document.createElement('p');
  note.className = 'sky-unavailable';
  note.textContent = '星图暂时无法加载，实验室介绍仍可正常阅读。';
  document.querySelector('.river-copy')?.append(note);
});
