'use strict';
let current = null, busy = false;
const $ = id => document.getElementById(id);
const labels = { grammar: '语法与语句', punctuation: '标点', wording: '用词精确', style: '表达方式', logic: '逻辑', deai: '自然化表达', detemplate: '自然化表达' };
window.sourceReview.onRender(payload => {
  if (payload.view === 'marks') {
    $('marks').replaceChildren();
    for (const r of payload.rects) {
      const line = document.createElement('span');
      line.className = 'mark ' + (Object.hasOwn(labels, r.errorType) ? r.errorType : 'grammar');
      Object.assign(line.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
      $('marks').append(line);
    }
    return;
  }
  current = payload; busy = false; $('card').hidden = false;
  $('category').textContent = labels[payload.change.errorType] || '修订建议';
  $('old').textContent = payload.change.oldText || '在此处插入';
  $('accept').textContent = (payload.change.newText || '删除此处') + ' ↵';
  $('reason').textContent = [payload.change.reason || (payload.change.reasonStatus === 'pending' ? '理由正在生成…' : '理由暂未生成，请结合上下文判断。'), ...(payload.change.reviewSafety?.warnings || [])].join('\n');
  $('status').textContent = '';
  document.querySelectorAll('button').forEach(b => b.disabled = false);
  $('accept').disabled = !!current?.change.reviewSafety?.blocked;
});
for (const action of ['accept', 'ignore', 'results', 'close']) $(action).addEventListener('click', async () => {
  if (!current || busy) return;
  busy = true; document.querySelectorAll('button').forEach(b => b.disabled = true);
  try {
    const result = await window.sourceReview.act({ token: current.token, id: current.change.id, action });
    if (!result?.ok) $('status').textContent = result?.error || '未能执行，请返回结果窗检查。';
  } catch (_) { $('status').textContent = '连接中断，请返回结果窗检查。'; }
  finally { busy = false; document.querySelectorAll('button').forEach(b => b.disabled = false);
  $('accept').disabled = !!current?.change.reviewSafety?.blocked; }
});
