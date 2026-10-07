'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('task pane limits collection to explicit selection and verifies before write', () => {
  const html = read('integrations/shared/taskpane.html');
  const word = read('integrations/word/adapter.js');
  const wps = read('integrations/wps/adapter.js');
  assert.match(html, /只发送你主动选中的文字/);
  assert.match(word, /getSelection\(\)/);
  assert.match(word, /range\.text\) !== normalized\(snapshot\.text/);
  assert.match(wps, /application\.Selection/);
  assert.match(wps, /range\.Text\) !== normalized\(snapshot\.text/);
  assert.match(word, /changeTrackingMode = Word\.ChangeTrackingMode\.trackAll/);
  assert.match(word, /insertComment/);
  assert.match(wps, /TrackRevisions = true/);
  assert.match(wps, /Comments\.Add/);
  assert.match(html, /id="reviewCapability"/);
  assert.match(word, /insertBookmark/);
  assert.match(word, /getBookmarkRangeOrNullObject/);
  assert.match(wps, /写入失败，已恢复本次修改/);
});

test('Word manifest and WPS sources use the public HTTPS add-in origin', () => {
  const manifest = read('integrations/word/manifest.xml');
  const wpsMain = read('integrations/wps/main.js');
  assert.match(manifest, /https:\/\/www\.runshi\.top\/addins\/word\/taskpane\.html/);
  assert.match(manifest, /<Permissions>ReadWriteDocument<\/Permissions>/);
  assert.match(wpsMain, /https:\/\/www\.runshi\.top\/addins\/wps/);
});

test('add-in build includes the supplemental task pane layout stylesheet', () => {
  const build = read('scripts/build-addins.js');
  const html = read('integrations/shared/taskpane.html');
  assert.match(build, /taskpane-layout\.css/);
  assert.match(html, /href="taskpane-layout\.css"/);
});

test('Word uses its hidden bookmark after the visible selection moves', async () => {
  const writes = [];
  const hostDocument = { url: 'fixture://document' };
  const target = { text: '原文', insertText(text) { writes.push(text); } };
  const anchoredRange = { text: '原文', isNullObject: false, load() {},
    search() { return { items: [target], load() {} }; }, insertText(text) { writes.push(`whole:${text}`); } };
  const selection = { text: '原文', load() {}, insertBookmark() {} };
  const document = {
    changeTrackingMode: 'off', load() {}, getSelection: () => selection,
    getBookmarkRangeOrNullObject: () => anchoredRange, deleteBookmark() {},
  };
  const window = {};
  vm.runInNewContext(read('integrations/word/adapter.js'), {
    window,
    Office: { HostType: { Word: 'word' }, onReady: async () => ({ host: 'word' }),
      context: { document: hostDocument, requirements: { isSetSupported: () => true } } },
    Word: { run: fn => fn({ document, sync: async () => {} }),
      InsertLocation: { replace: 'replace', before: 'before', end: 'end' }, ChangeTrackingMode: { trackAll: 'trackAll' } },
  });
  const snapshot = await window.RunShiHost.captureSelection();
  selection.text = '别处的原文';
  await window.RunShiHost.applyAcceptedChanges(snapshot, [
    { type: 'replace', originalStart: 0, originalEnd: 2, oldText: '原文', newText: '新文' },
  ], '新文');
  assert.deepEqual(writes, ['新文']);
});

test('WPS rolls back already-written changes when a later write fails', async () => {
  const window = {};
  const state = { text: '甲乙丙丁' };
  const document = { Name: 'fixture.docx', TrackRevisions: false, Range(start, end) {
    return { get Text() { return state.text.slice(start, end); }, set Text(value) {
      if (start === 0) throw new Error('protected fixture');
      state.text = state.text.slice(0, start) + value + state.text.slice(end);
    }, Select() {} };
  } };
  vm.runInNewContext(read('integrations/wps/adapter.js'), { window });
  window.Application = { ActiveDocument: document, Selection: { Text: state.text, Start: 0, End: 4 } };
  const snapshot = await window.RunShiHost.captureSelection();
  await assert.rejects(window.RunShiHost.applyAcceptedChanges(snapshot, [
    { type: 'replace', originalStart: 0, originalEnd: 1, oldText: '甲', newText: '戊' },
    { type: 'replace', originalStart: 2, originalEnd: 3, oldText: '丙', newText: '己' },
  ], '戊乙己丁'), /已恢复本次修改/);
  assert.equal(state.text, '甲乙丙丁');
  assert.equal(document.TrackRevisions, false);
});

test('WPS rollback handles multiple length-changing edits in reverse order', async () => {
  const window = {};
  const state = { text: 'abcdefgh' };
  const document = { Name: 'fixture.docx', TrackRevisions: false, Range(start, end) {
    return { get Text() { return state.text.slice(start, end); }, set Text(value) {
      if (start === 0) throw new Error('protected fixture');
      state.text = state.text.slice(0, start) + value + state.text.slice(end);
    }, Select() {} };
  } };
  vm.runInNewContext(read('integrations/wps/adapter.js'), { window });
  window.Application = { ActiveDocument: document, Selection: { Text: state.text, Start: 0, End: 8 } };
  const snapshot = await window.RunShiHost.captureSelection();
  await assert.rejects(window.RunShiHost.applyAcceptedChanges(snapshot, [
    { type: 'replace', originalStart: 0, originalEnd: 1, oldText: 'a', newText: 'Q' },
    { type: 'delete', originalStart: 3, originalEnd: 4, oldText: 'd', newText: '' },
    { type: 'replace', originalStart: 6, originalEnd: 7, oldText: 'g', newText: 'XYZ' },
  ], 'QbcefXYZh'), /已恢复本次修改/);
  assert.equal(state.text, 'abcdefgh');
  assert.equal(document.TrackRevisions, false);
});
