'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { SourceReview, cardBounds } = require('../src/source-review');

function fixture(geometry) {
  class Window {
    constructor(options) { this.options = options; this.visible = false; this.bounds = options;
      this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = () => {};
      this.sendCount = 0; this.boundsCount = 0;
      this.webContents.send = (_channel, data) => { this.sendCount++; this.payload = data; }; }
    async loadFile() {} isDestroyed() { return false; } setIgnoreMouseEvents(value) { this.clickThrough = value; }
    setBounds(value) { this.boundsCount++; this.bounds = value; } getBounds() { return this.bounds; }
    showInactive() { this.visible = true; } hide() { this.visible = false; } isVisible() { return this.visible; }
    destroy() { this.visible = false; }
  }
  let state = { token: 'generation-1', changes: [{ id: 1, oldText: '旧', newText: '新' }], request: {} };
  const results = [], actions = [], statuses = [];
  const screen = { getCursorScreenPoint: () => ({ x: 35, y: 45 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 900, height: 700 } }) };
  const review = new SourceReview({ electron: { BrowserWindow: Window, screen },
    geometry: geometry || (async () => ({ ok: true, rects: [{ id: 1, x: 30, y: 40, width: 30, height: 20 }] })),
    getState: () => state,
    apply: async (...args) => { actions.push(args); state.changes = []; return { ok: true }; },
    onDecision: event => results.push(event), onStatus: event => statuses.push(event), openResult: () => {} });
  return { review, actions, results, statuses, screen, setState: value => { state = value; } };
}

test('source marks pass through clicks, hover opens card, only its current canonical action writes once', async () => {
  const { review, actions, results } = fixture();
  try {
    assert.equal((await review.start('generation-1')).ok, true);
    assert.equal(review.overlay.clickThrough, true);
    assert.equal(review.card.options.focusable, false);
    review.pointer(); assert.equal(review.card.isVisible(), true);
    const payload = { token: 'generation-1', id: 1, action: 'accept' };
    assert.equal((await review.action({}, payload)).ok, false);
    assert.equal((await review.action(review.card.webContents, { ...payload, token: 'stale' })).ok, false);
    assert.equal(actions.length, 0);
    assert.equal((await review.action(review.card.webContents, payload)).ok, true);
    assert.equal(results[0].status, 'accepted'); assert.equal(actions.length, 1);
    assert.equal((await review.action(review.card.webContents, payload)).ok, false);
    assert.equal(actions.length, 1);
  } finally { review.destroy(); }
});

test('late geometry never displays after cancellation or invalidation for a source write', async () => {
  let resolveGeometry;
  const { review } = fixture(() => new Promise(resolve => { resolveGeometry = resolve; }));
  try {
    const pending = review.start('generation-1');
    await new Promise(resolve => setImmediate(resolve));
    review.invalidate();
    resolveGeometry({ ok: true, rects: [{ id: 1, x: 30, y: 40, width: 30, height: 20 }] });
    await pending;
    assert.equal(review.overlay.isVisible(), false);
    assert.equal(review.card.isVisible(), false);
  } finally { review.destroy(); }
});

test('source identity or text mismatch hides both marks and an already visible card', async () => {
  let valid = true;
  const { review } = fixture(async () => valid ? { ok: true, rects: [{ id: 1, x: 30, y: 40, width: 30, height: 20 }] } : { ok: false });
  try {
    await review.start('generation-1'); review.pointer();
    valid = false; await review.refresh();
    assert.equal(review.overlay.isVisible(), false); assert.equal(review.card.isVisible(), false);
    assert.deepEqual(review.rects, []);
  } finally { review.destroy(); }
});

test('floating card fits monitors with negative coordinates and small work areas', () => {
  for (const area of [{ x: -900, y: -200, width: 900, height: 600 }, { x: 0, y: 0, width: 320, height: 240 }]) {
    const rect = cardBounds({ x: area.x + area.width - 20, y: area.y + area.height - 10, width: 15, height: 10 }, area);
    assert(rect.x >= area.x && rect.y >= area.y);
    assert(rect.x + rect.width <= area.x + area.width && rect.y + rect.height <= area.y + area.height);
  }
});

test('source editing pauses new geometry polls until writing finishes', async () => {
  let calls = 0;
  const { review } = fixture(async () => { calls++; return { ok: true, rects: [{ id: 1, x: 30, y: 40, width: 30, height: 20 }] }; });
  try {
    await review.start('generation-1'); assert.equal(calls, 1);
    review.setWriting(true); await review.refresh(); assert.equal(calls, 1);
    assert.equal(review.overlay.isVisible(), false);
    review.setWriting(false); await review.refresh(); assert.equal(calls, 2);
  } finally { review.destroy(); }
});

test('a wrapped suggestion stays beside the hovered line across refreshes and follows another line', async () => {
  const { review, screen } = fixture(async () => ({ ok: true, rects: [
    { id: 1, x: 30, y: 40, width: 90, height: 20 },
    { id: 1, x: 30, y: 100, width: 90, height: 20 },
    { id: 1, x: 30, y: 140, width: 90, height: 20 },
  ] }));
  let point = { x: 45, y: 110 };
  screen.getCursorScreenPoint = () => point;
  try {
    await review.start('generation-1'); review.pointer();
    assert.equal(review.card.getBounds().y, 128);
    await review.refresh();
    assert.equal(review.card.getBounds().y, 128, 'refresh must not jump from second line to first');
    point = { x: 45, y: 150 }; // The card overlaps a third line behind it.
    await review.refresh();
    assert.equal(review.card.getBounds().y, 128, 'moving into the card preserves its source line');
    point = { x: 45, y: 50 }; review.pointer();
    assert.equal(review.card.getBounds().y, 68, 'the same suggestion can follow another source line');
  } finally { review.destroy(); }
});

test('unchanged geometry and card content do not redraw native overlay windows', async () => {
  const { review } = fixture();
  try {
    await review.start('generation-1');
    const markSends = review.overlay.sendCount, markBounds = review.overlay.boundsCount;
    review.pointer();
    const cardSends = review.card.sendCount, cardBounds = review.card.boundsCount;
    await review.refresh();
    assert.equal(review.overlay.sendCount, markSends);
    assert.equal(review.overlay.boundsCount, markBounds);
    assert.equal(review.card.sendCount, cardSends);
    assert.equal(review.card.boundsCount, cardBounds);
  } finally { review.destroy(); }
});

test('geometry and suggestion content changes redraw only the affected window', async () => {
  let x = 30;
  const { review, setState } = fixture(async () => ({ ok: true, rects: [{ id: 1, x, y: 40, width: 30, height: 20 }] }));
  try {
    await review.start('generation-1'); review.pointer();
    const markSends = review.overlay.sendCount, cardSends = review.card.sendCount;
    const cardBounds = review.card.boundsCount;
    x = 60; await review.refresh();
    assert.equal(review.overlay.sendCount, markSends + 1);
    assert.equal(review.card.sendCount, cardSends, 'moving the same suggestion must not rebuild card content');
    assert.equal(review.card.boundsCount, cardBounds + 1, 'moving the suggestion must reposition its card');
    setState({ token: 'generation-1', changes: [{ id: 1, oldText: '旧', newText: '更新', reason: '新理由' }], request: {} });
    await review.refresh();
    assert.equal(review.overlay.sendCount, markSends + 1);
    assert.equal(review.card.sendCount, cardSends + 1, 'same id with changed content must refresh the card');
    assert.equal(review.card.payload.change.newText, '更新');
  } finally { review.destroy(); }
});
