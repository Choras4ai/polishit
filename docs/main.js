'use strict';
(() => {
  const original = '这项研究对这个问题进行了分析，结果表明该方法具有一定的应用价值。';
  const versions = {
    steady: ['这项研究分析了这一问题，结果表明该方法具有一定的应用价值。', '保留原意，缩短动词结构：将“对这个问题进行了分析”改为“分析了这一问题”。'],
    academic: ['本研究分析了这一问题，结果表明该方法具有一定的应用价值。', '采用学术语体“本研究”，保留“一定的应用价值”的审慎判断。'],
    concise: ['研究分析了这一问题，结果显示该方法具有一定的应用价值。', '压缩冗余表达，保留研究结果与判断的强度。'],
  };
  let selected = 'steady';
  const result = document.getElementById('demoResult');
  const status = document.getElementById('demoStatus');
  const apply = document.getElementById('demoApply');
  function reset() {
    result.textContent = original;
    status.textContent = '请选择一个版本，再接受或忽略建议。';
    apply.disabled = true;
  }
  document.querySelectorAll('[data-version]').forEach(button => {
    button.addEventListener('click', () => {
      selected = button.dataset.version;
      document.querySelectorAll('[data-version]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
      document.getElementById('demoReason').textContent = versions[selected][1];
      reset();
    });
  });
  document.getElementById('demoAccept').addEventListener('click', () => {
    result.textContent = versions[selected][0];
    status.textContent = '已接受建议，可预览应用效果。';
    apply.disabled = false;
  });
  document.getElementById('demoIgnore').addEventListener('click', () => {
    reset(); status.textContent = '已忽略建议，保留原文。';
  });
  apply.addEventListener('click', () => {
    status.textContent = '演示：已应用所选修订。实际文档未被修改。';
    apply.disabled = true;
  });
  document.getElementById('demoReset').addEventListener('click', reset);
  const nav = document.querySelector('nav');
  window.addEventListener('scroll', () => nav.classList.toggle('nav-scrolled', window.scrollY > 20), { passive: true });
})();
