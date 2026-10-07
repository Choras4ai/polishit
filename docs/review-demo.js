(() => {
  'use strict';
  const root = document.getElementById('compareWorkspace');
  if (!root) return;
  const modes = {
    polish: {
      title: '服务体验调研 · 讨论稿', filename: '研究综述.docx · Word',
      paragraphs: [
        ['本次调研共', 'typo', '了 120 份问卷，并访谈了 12 位用户。', 'grammar', '等待时间是受访者最关注的问题。'],
        ['研究团队', 'concise', '，发现用户期待更及时的反馈。为改善体验，我们建议', 'word', '，并明确每一步的处理进度。'],
        ['本研究为观察性研究。问卷显示，响应速度与满意度存在相关性；这一结果', 'logic', '。后续还需结合实验验证，并', 'repeat', '完善服务流程。']
      ],
      edits: [
        { id: 'typo', type: '错别字', color: 'red', old: '收急', next: '收集', reason: '这里表示汇总问卷，应使用“收集”。“急”是误用字。' },
        { id: 'grammar', type: '语句问题', color: 'red', old: '通过对资料的分析，使我们发现', next: '通过分析资料，我们发现', reason: '“通过……使……”让句子缺少主语。去掉“使”，让“我们”成为明确的主语。' },
        { id: 'concise', type: '表达精炼', color: 'amber', old: '对访谈资料进行了深入的分析', next: '深入分析了访谈资料', reason: '把“进行了……的分析”改为直接的动词表达，信息不变，句子更紧凑。' },
        { id: 'word', type: '用词精确', color: 'amber', old: '提高服务响应时间', next: '缩短服务响应时间', reason: '时间应“缩短”，速度才是“提高”。原表达可能被理解为让用户等待更久。' },
        { id: 'logic', type: '论证边界', color: 'violet', old: '证明响应更快必然导致满意度上升', next: '提示响应更快可能与更高的满意度相关', reason: '观察性研究中的相关性不能直接证明因果关系。保留发现，同时避免“证明”“必然”的过度推断。' },
        { id: 'repeat', type: '重复用词', color: 'amber', old: '进一步进一步', next: '进一步', reason: '“进一步”连续出现两次，删除重复部分即可。' }
      ]
    },
    natural: {
      title: '让服务更贴近人 · 初稿', filename: '表达练习.docx · Word',
      paragraphs: [
        ['opening', '，', 'subject', '。我们在访谈中听到一个反复出现的诉求：提交问题以后，希望知道下一步会发生什么。'],
        ['filler', '，用户需要的', 'pattern', '。因此，我们准备在每个处理节点给出简短说明，让等待有一个明确的预期。'],
        ['ending', '，', 'abstract', '。先把每一次回复说清楚，再根据反馈改进流程。']
      ],
      edits: [
        { id: 'opening', type: '减少套话', color: 'violet', old: '在当今快速发展的时代', next: '如今', reason: '删去泛化的时代背景，让开头更直接。这里不需要宏大的铺垫。' },
        { id: 'subject', type: '直接表达', color: 'amber', old: '用户体验的重要性不言而喻', next: '用户体验很重要', reason: '保留对用户体验的重视，去掉“不言而喻”的强调，让表达更平实。' },
        { id: 'filler', type: '自然衔接', color: 'violet', old: '值得注意的是', next: '从这些反馈来看', reason: '用已有的访谈反馈承接上文，替换缺少具体指向的提示语。' },
        { id: 'pattern', type: '调整句式', color: 'violet', old: '不仅仅是速度的提升，更是信息透明度的增强', next: '是更快的回应，也是在等待时知道进展', reason: '减少名词堆叠，用具体动作表达两个需求，保留原来的并列含义。' },
        { id: 'ending', type: '减少模板感', color: 'violet', old: '综上所述', next: '接下来', reason: '后文是行动计划，用“接下来”比总结式套语更贴合内容。' },
        { id: 'abstract', type: '落到行动', color: 'amber', old: '我们将持续赋能服务体验的全方位升级', next: '我们会继续改进回复方式和处理流程', reason: '把“赋能”“全方位升级”等抽象词改为可理解的行动，不添加未经说明的成效。' }
      ]
    }
  };
  const doc = document.getElementById('demoDocument');
  const list = document.getElementById('demoSuggestions');
  const status = document.getElementById('demoStatus');
  const undo = document.getElementById('demoUndo');
  const states = { polish: new Map(), natural: new Map() };
  const histories = { polish: [], natural: [] };
  let mode = 'polish', active = null, anchor = null, anchorLine = 0, closeTimer;
  const card = document.createElement('div');
  card.id = 'demoHoverCard'; card.className = 'rd-popover'; card.hidden = true;
  card.setAttribute('role', 'dialog'); card.setAttribute('aria-labelledby', 'demoCardType');
  document.body.append(card);

  function close(returnFocus = false) {
    clearTimeout(closeTimer);
    const previous = anchor;
    card.hidden = true; active = null; anchor = null;
    previous?.setAttribute('aria-expanded', 'false');
    if (returnFocus && previous?.isConnected) {
      previous.dataset.suppressFocus = 'true'; previous.focus({ preventScroll: true });
      delete previous.dataset.suppressFocus;
    }
  }
  function position() {
    if (!anchor || card.hidden) return;
    const lines = anchor.getClientRects();
    const r = lines[Math.min(anchorLine, lines.length - 1)] || anchor.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) return close();
    const w = card.offsetWidth, h = card.offsetHeight, gap = 10;
    card.style.left = Math.max(12, Math.min(r.left, innerWidth - w - 12)) + 'px';
    const below = r.bottom + gap;
    const top = below + h <= innerHeight - 12 ? below : r.top - h - gap;
    card.style.top = Math.max(12, Math.min(top, innerHeight - h - 12)) + 'px';
  }
  function followLine(pointer) {
    if (!pointer || !anchor) return;
    const lines = Array.from(anchor.getClientRects());
    const index = lines.findIndex(r => pointer.clientY >= r.top && pointer.clientY <= r.bottom);
    anchorLine = Math.max(0, index);
  }
  function open(id, focusCard = false, pointer = null) {
    clearTimeout(closeTimer);
    const mark = doc.querySelector(`[data-edit="${id}"]`);
    if (!mark || states[mode].has(id)) return;
    if (active === id && !card.hidden) {
      followLine(pointer); position();
      if (focusCard) card.querySelector('[data-action="accept"]').focus();
      return;
    }
    close(); active = id; anchor = mark; anchorLine = 0; followLine(pointer);
    const edit = modes[mode].edits.find(e => e.id === id);
    card.innerHTML = `<div class="rd-popover-head"><span id="demoCardType" class="rd-${edit.color}">${edit.type}</span><button type="button" data-action="close" aria-label="关闭建议">×</button></div><p class="rd-original"></p><button type="button" class="rd-replacement" data-action="accept"></button><p class="rd-reason"></p><div class="rd-popover-foot"><span>点击上方替换原文 ↵</span><button type="button" data-action="ignore">忽略此处</button></div>`;
    card.querySelector('.rd-original').textContent = edit.old;
    const accept = card.querySelector('.rd-replacement');
    accept.textContent = edit.next + ' ↗'; accept.setAttribute('aria-label', '接受建议：' + edit.next);
    card.querySelector('.rd-reason').textContent = edit.reason;
    card.hidden = false; mark.setAttribute('aria-expanded', 'true'); position();
    if (focusCard) accept.focus();
  }
  function render() {
    close();
    const data = modes[mode];
    document.getElementById('demoFilename').textContent = data.filename;
    document.getElementById('demoDocumentTitle').textContent = data.title;
    doc.replaceChildren(); list.replaceChildren();
    for (const tokens of data.paragraphs) {
      const p = document.createElement('p');
      for (const token of tokens) {
        const edit = data.edits.find(e => e.id === token);
        if (!edit) { p.append(document.createTextNode(token)); continue; }
        const state = states[mode].get(edit.id);
        if (state === 'ignored') { p.append(document.createTextNode(edit.old)); continue; }
        const el = document.createElement(state === 'accepted' ? 'span' : 'button');
        el.textContent = state === 'accepted' ? edit.next : edit.old;
        el.className = state === 'accepted' ? 'rd-accepted' : `rd-mark rd-${edit.color}`;
        if (!state) {
          el.type = 'button'; el.dataset.edit = edit.id;
          el.setAttribute('aria-label', edit.type + '：' + edit.old + '，查看建议');
          el.setAttribute('aria-haspopup', 'dialog'); el.setAttribute('aria-controls', card.id); el.setAttribute('aria-expanded', 'false');
          el.addEventListener('pointerenter', e => { if (e.pointerType !== 'touch') open(edit.id, false, e); });
          el.addEventListener('pointermove', e => { if (active === edit.id && e.pointerType !== 'touch') { followLine(e); position(); } });
          el.addEventListener('pointerleave', scheduleClose);
          el.addEventListener('focus', () => {
            if (el.dataset.suppressFocus) return;
            // Focus can arrive before the page's smooth scroll has exposed the mark.
            el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
            open(edit.id);
          });
          el.addEventListener('click', e => open(edit.id, false, e));
          el.addEventListener('keydown', e => { if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(edit.id, true); } });
        }
        p.append(el);
      }
      doc.append(p);
    }
    for (const edit of data.edits) {
      const state = states[mode].get(edit.id);
      const item = document.createElement('button'); item.type = 'button';
      item.className = `rd-suggestion rd-${edit.color}`; item.disabled = !!state;
      const label = document.createElement('span'); label.textContent = edit.type;
      const text = document.createElement('strong'); text.textContent = state ? (state === 'accepted' ? '已接受 · ' + edit.next : '已忽略 · ' + edit.old) : edit.old + ' → ' + edit.next;
      item.append(label, text);
      item.addEventListener('click', () => {
        doc.querySelector(`[data-edit="${edit.id}"]`)?.scrollIntoView({ block: 'center', behavior: 'instant' });
        open(edit.id, true);
      });
      list.append(item);
    }
    const pending = data.edits.length - states[mode].size;
    document.getElementById('demoCount').textContent = `${pending} 处待处理 / ${data.edits.length} 处建议`;
    undo.disabled = !histories[mode].length;
    root.querySelectorAll('[data-demo-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.demoMode === mode)));
  }
  function scheduleClose() {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      if (!card.contains(document.activeElement) && document.activeElement !== anchor && !card.matches(':hover') && !anchor?.matches(':hover')) close();
    }, 220);
  }
  card.addEventListener('pointerenter', () => clearTimeout(closeTimer));
  card.addEventListener('pointerleave', scheduleClose);
  document.addEventListener('focusin', e => { if (!card.hidden && !card.contains(e.target) && e.target !== anchor) close(); });
  document.addEventListener('pointerdown', e => { if (!card.contains(e.target) && !e.target.closest('.rd-mark')) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !card.hidden) { e.preventDefault(); close(true); } });
  card.addEventListener('click', e => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'close') return close(true);
    const edit = modes[mode].edits.find(item => item.id === active);
    if (!edit) return;
    const keyboard = card.contains(document.activeElement);
    states[mode].set(edit.id, action === 'accept' ? 'accepted' : 'ignored'); histories[mode].push(edit.id);
    render();
    status.textContent = action === 'accept' ? `已替换：“${edit.old}” → “${edit.next}”。其他文字保持原样。` : `已忽略“${edit.old}”，保留原文。`;
    if (keyboard) undo.focus({ preventScroll: true });
  });
  root.querySelectorAll('[data-demo-mode]').forEach(b => b.addEventListener('click', () => {
    mode = b.dataset.demoMode; render();
    status.textContent = mode === 'natural' ? '自然化示例：减少套话，保留含义；不承诺 AI 检测分数。' : '移到下划线文字上查看建议。';
  }));
  undo.addEventListener('click', () => {
    const id = histories[mode].pop(); if (!id) return;
    states[mode].delete(id); render(); status.textContent = '已撤销上一处操作，建议恢复待处理。';
  });
  document.getElementById('demoReset').addEventListener('click', () => {
    states[mode].clear(); histories[mode].length = 0; render(); status.textContent = '当前演示已重置，所有原文和建议已恢复。';
  });
  window.addEventListener('scroll', position, { passive: true });
  window.addEventListener('resize', position);
  render();
})();
