'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('stopping native review replaces the stale enabled message and ignores old sessions', () => {
  const script = read('src/renderer/result/script.js');
  const handler = script.slice(script.indexOf('window.polishAPI.onSourceStatus?.'), script.indexOf('window.polishAPI.onSourceDecision?.'));
  let receive;
  const messages = [];
  const context = { window: { polishAPI: { onSourceStatus: cb => { receive = cb; } } },
    sourceReviewToken: 'current', sourceReviewRunning: true,
    updateSourceReviewButton() {}, flashActionMessage: message => messages.push(message) };
  vm.runInNewContext(handler, context);
  receive({ token: 'current', running: true, message: '原文浮窗已开启' });
  receive({ token: 'current', running: false });
  assert.equal(context.sourceReviewRunning, false);
  assert.match(messages.at(-1), /已停止/);
  receive({ token: 'old', running: true, message: '陈旧消息' });
  assert.equal(messages.length, 2);
});

test('multiple polish versions are enabled by default and configurable', () => {
  const config = read('src/config.js');
  const settings = read('src/renderer/settings/index.html');
  const settingsLogic = read('src/renderer/settings/script.js');
  assert.match(config, /multipleVersionsEnabled:\s*true/);
  assert.match(settings, /id="multipleVersionsEnabled"[^>]*checked/);
  assert.match(settingsLogic, /ui\.multipleVersionsEnabled/);
});

test('inline review supports hover suggestions and click-to-apply', () => {
  const html = read('src/renderer/result/index.html');
  const script = read('src/renderer/result/script.js');
  assert.match(html, /修订前 · 含修订意见/);
  assert.match(html, /修订意见直接标在修订前原文中/);
  assert.match(html, /修订后/);
  assert.match(script, /inline-opinion/);
  assert.match(script, /marker\.addEventListener\('mouseenter'/);
  assert.match(script, /popupSuggestion\.addEventListener\('click', applyActivePopupSuggestion\)/);
  assert.match(script, /applyReviewChange\(change, 'accept'\)/);
  assert.match(script, /applyReviewChange\(change, 'revert'\)[\s\S]*sourceStateUncertain = true/);
});

test('selection watcher has dedicated Word and WPS fallbacks', () => {
  const watcher = fs.readFileSync(path.join(__dirname, '..', 'src', 'selection-watcher.js'), 'utf8');
  const helper = fs.readFileSync(path.join(__dirname, '..', 'src', 'macos-selection-helper.js'), 'utf8');
  const native = fs.readFileSync(path.join(__dirname, '..', 'native', 'macos-selection.mm'), 'utf8');
  assert.match(watcher, /probeWordSelectionContext/);
  assert.match(watcher, /com\.kingsoft\.wpsoffice\.mac/);
  assert.match(watcher, /_probeWpsSelection/);
  assert.match(watcher, /_snapshotClipboard/);
  assert.match(helper, /copySelection\(\)/);
  assert.match(native, /CGEventPost\(kCGHIDEventTap/);
});

test('alternative versions are generated without extra explanation calls', () => {
  const main = read('main.js');
  const pipeline = read('src/ai/pipeline.js');
  assert.match(main, /generateAlternativeVersions/);
  assert.match(main, /skipExplanations:\s*true/);
  assert.match(pipeline, /options\.skipExplanations/);
});

test('late explanations use canonical IDs for repeated phrases without overwriting decisions or alternative versions', () => {
  const script = read('src/renderer/result/script.js');
  const handler = script.slice(script.indexOf('window.polishAPI.onExplanations?.'), script.indexOf('/* ────────── Upper pane'));
  const primary = [
    { id: 1, type: 'replace', oldText: '提高', newText: '缩短', status: 'accepted', appliedInSource: true },
    { id: 2, type: 'replace', oldText: '提高', newText: '缩短', status: 'pending', appliedInSource: false },
  ];
  const canonical = primary.map((change, index) => ({ ...change, reason: `第${index + 1}处独立理由`, errorType: 'wording', alternatives: [] }));
  let receive, renders = 0;
  const context = { window: { polishAPI: { onExplanations: cb => { receive = cb; } } },
    diffChanges: primary, activeVersionIndex: 0, versionResults: [{ diff: { changes: primary } }],
    renderDiff: () => { renders++; } };
  vm.runInNewContext(handler, context);
  receive({ explanations: [{ original: '提高', modified: '缩短', reason: '不应重复模糊匹配' }], changes: canonical });
  assert.equal(primary[0].reason, '第1处独立理由');
  assert.equal(primary[1].reason, '第2处独立理由');
  assert.equal(primary[0].status, 'accepted'); assert.equal(primary[0].appliedInSource, true);
  assert.equal(primary[1].status, 'pending'); assert.equal(renders, 1);

  const alternative = [{ ...primary[0], reason: '替代版本自身理由' }];
  context.activeVersionIndex = 1; context.diffChanges = alternative;
  receive({ explanations: [{}], changes: canonical.map(c => ({ ...c, reason: c.reason + '更新' })) });
  assert.equal(alternative[0].reason, '替代版本自身理由');
  assert.equal(context.versionResults[0].diff.changes[1].reason, '第2处独立理由更新');
  assert.equal(renders, 1, 'late primary explanations must not re-render an active alternative');
});

test('native hover cards display the actual detemplate category in Chinese and retain its mark class', () => {
  const elements = new Map();
  const node = () => ({ style: {}, children: [], addEventListener() {}, replaceChildren() { this.children = []; }, append(child) { this.children.push(child); } });
  const element = id => { if (!elements.has(id)) elements.set(id, node()); return elements.get(id); };
  let render;
  vm.runInNewContext(read('src/renderer/source-review/script.js'), {
    window: { sourceReview: { onRender: cb => { render = cb; } } },
    document: { getElementById: element, createElement: node, querySelectorAll: () => [] },
  });
  render({ view: 'card', token: 'test', change: { id: 1, errorType: 'detemplate', oldText: '综上所述', newText: '接下来', reason: '后文是行动计划。' } });
  assert.equal(element('category').textContent, '自然化表达');
  assert.equal(element('reason').textContent, '后文是行动计划。');
  render({ view: 'marks', rects: [{ x: 10, y: 20, width: 30, height: 20, errorType: 'detemplate' }] });
  assert.equal(element('marks').children[0].className, 'mark detemplate');
  assert.match(read('src/renderer/source-review/style.css'), /\.mark\.detemplate\s*\{\s*border-color:\s*#a18bd2/);
  assert.match(read('src/renderer/result/script.js'), /detemplate:\s*'自然化表达'/);
});
