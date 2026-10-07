'use strict';

const path = require('node:path');

function validRect(rect) {
  return rect && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key]))
    && rect.width > 0 && rect.height > 0 && rect.width < 20000 && rect.height < 4000;
}

function cardBounds(rect, area) {
  const width = Math.min(360, area.width - 16), height = Math.min(240, area.height - 16);
  const x = Math.max(area.x + 8, Math.min(rect.x, area.x + area.width - width - 8));
  let y = rect.y + rect.height + 8;
  if (y + height > area.y + area.height - 8) y = rect.y - height - 8;
  return { x: Math.round(x), y: Math.round(Math.max(area.y + 8, y)), width, height };
}

// The overlay never contains editable source text. Only the main process's
// current, verified review can supply ranges or authorize a single change.
class SourceReview {
  constructor({ geometry, getState, apply, onDecision, onStatus, openResult, electron = require('electron') }) {
    this.electron = electron;
    Object.assign(this, { geometry, getState, apply, onDecision, onStatus, openResult });
    this.running = false; this.epoch = 0; this.rects = []; this.lastGeometry = 0;
    this.overlay = null; this.card = null; this.hoverId = null; this.busy = false;
  }

  async windows() {
    if (this.overlay && !this.overlay.isDestroyed()) return;
    const options = { show: false, frame: false, transparent: true, hasShadow: false,
      alwaysOnTop: true, skipTaskbar: true, focusable: false, acceptFirstMouse: true,
      resizable: false, minimizable: false, maximizable: false,
      ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
      webPreferences: { preload: path.join(__dirname, 'renderer/source-review/preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true } };
    this.overlay = new this.electron.BrowserWindow({ ...options, width: 1, height: 1 });
    this.card = new this.electron.BrowserWindow({ ...options, width: 360, height: 320 });
    this.overlay.setIgnoreMouseEvents(true, { forward: true });
    for (const win of [this.overlay, this.card]) {
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', e => e.preventDefault());
    }
    await Promise.all([
      this.overlay.loadFile(path.join(__dirname, 'renderer/source-review/index.html'), { query: { view: 'marks' } }),
      this.card.loadFile(path.join(__dirname, 'renderer/source-review/index.html'), { query: { view: 'card' } }),
    ]);
  }

  async start(token) {
    this.stop();
    if (!token || this.getState()?.token !== token) return { ok: false, error: '这组修订已经过期，请重新分析。' };
    const epoch = this.epoch;
    this.token = token;
    await this.windows();
    if (epoch !== this.epoch) return { ok: false, error: '原文浮窗已取消。' };
    this.running = true;
    const result = await this.refresh();
    if (!result?.ok) { this.stop(); return result || { ok: false, error: '当前编辑器无法提供原文位置。' }; }
    this.geometryTimer = setInterval(() => this.refresh(), 350);
    this.pointerTimer = setInterval(() => this.pointer(), 70);
    this.onStatus({ running: true, token, message: '原文浮窗已开启。移到下划线查看建议；返回结果窗可停止。' });
    return { ok: true };
  }

  hide() {
    this.rects = []; this.hoverId = null; this.hoverLine = 0;
    if (this.overlay && !this.overlay.isDestroyed()) this.overlay.hide();
    if (this.card && !this.card.isDestroyed()) this.card.hide();
  }

  stop() {
    const wasRunning = this.running;
    this.running = false; this.epoch++;
    clearInterval(this.geometryTimer); clearInterval(this.pointerTimer);
    this.hide();
    if (wasRunning) this.onStatus({ token: this.token, running: false });
  }

  invalidate() { this.epoch++; this.hide(); }
  setWriting(value) { this.writing = value; if (value) this.invalidate(); }

  destroy() {
    this.stop();
    for (const win of [this.overlay, this.card]) if (win && !win.isDestroyed()) win.destroy();
    this.overlay = this.card = null;
  }

  async refresh() {
    if (!this.running || this.pending || this.busy || this.writing) return;
    const state = this.getState(), epoch = this.epoch;
    if (!state || state.token !== this.token || state.uncertain) { this.stop(); return { ok: false, error: '原文会话已变化，请重新分析。' }; }
    this.pending = true;
    try {
      const result = await this.geometry(state.request);
      if (!this.running || this.epoch !== epoch || this.getState()?.token !== state.token) return;
      if (!result?.ok) {
        this.hide();
        this.onStatus({ running: true, token: this.token, message: result?.error || '原文暂不可定位；已隐藏浮窗。切回原应用后重新定位。' });
        return result;
      }
      const ids = new Set(state.changes.map(c => c.id));
      this.rects = (result.rects || []).filter(r => ids.has(r.id) && validRect(r)).map(r => ({ ...r,
        ...(result.coordinateSpace === 'physical' ? this.electron.screen.screenToDipRect(null, r) : {}) }));
      if (!this.rects.length) { this.hide(); return { ok: false, error: '当前可见原文中没有可定位的待处理修订。' }; }
      this.lastGeometry = Date.now();
      const left = Math.floor(Math.min(...this.rects.map(r => r.x))) - 2;
      const top = Math.floor(Math.min(...this.rects.map(r => r.y))) - 2;
      const right = Math.ceil(Math.max(...this.rects.map(r => r.x + r.width))) + 2;
      const bottom = Math.ceil(Math.max(...this.rects.map(r => r.y + r.height))) + 3;
      this.overlay.setBounds({ x: left, y: top, width: right - left, height: bottom - top });
      this.overlay.webContents.send('source-review:render', { view: 'marks', rects: this.rects.map(r => ({ ...r,
        x: r.x - left, y: r.y - top, errorType: state.changes.find(c => c.id === r.id)?.errorType })) });
      this.overlay.showInactive();
      if (this.hoverId != null) {
        const lines = this.rects.filter(r => r.id === this.hoverId);
        const point = this.electron.screen.getCursorScreenPoint();
        const bounds = this.card.getBounds();
        const inCard = this.card.isVisible() && point.x >= bounds.x - 10 && point.x <= bounds.x + bounds.width + 10
          && point.y >= bounds.y - 10 && point.y <= bounds.y + bounds.height + 10;
        const pointedLine = !inCard && lines.find(r => point.x >= r.x - 2 && point.x <= r.x + r.width + 2
          && point.y >= r.y - 2 && point.y <= r.y + r.height + 2);
        const anchor = pointedLine || lines[Math.min(this.hoverLine, lines.length - 1)];
        if (!anchor) { this.card.hide(); this.hoverId = null; }
        else this.showCard(anchor, state);
      }
      return { ok: true };
    } catch (error) {
      if (this.epoch === epoch) this.hide();
      return { ok: false, error: error.message || '原文定位失败。' };
    } finally { this.pending = false; }
  }

  showCard(rect, state) {
    const change = state.changes.find(c => c.id === rect.id);
    if (!change) return;
    const area = this.electron.screen.getDisplayNearestPoint({ x: Math.round(rect.x), y: Math.round(rect.y) }).workArea;
    this.hoverId = rect.id;
    this.hoverLine = this.rects.filter(r => r.id === rect.id).indexOf(rect);
    this.card.setBounds(cardBounds(rect, area));
    this.card.webContents.send('source-review:render', { view: 'card', token: this.token, change });
    this.card.showInactive();
  }

  pointer() {
    if (!this.running || this.busy) return;
    const state = this.getState();
    if (!state || state.token !== this.token || state.uncertain) return this.stop();
    if (Date.now() - this.lastGeometry > 1800) return this.hide();
    const point = this.electron.screen.getCursorScreenPoint();
    const inside = (r, pad = 0) => point.x >= r.x - pad && point.x <= r.x + r.width + pad
      && point.y >= r.y - pad && point.y <= r.y + r.height + pad;
    if (this.card?.isVisible() && inside(this.card.getBounds(), 10)) { this.leaveAt = 0; return; }
    const rect = this.rects.find(r => inside(r, 2));
    if (rect) {
      this.leaveAt = 0;
      const line = this.rects.filter(r => r.id === rect.id).indexOf(rect);
      if (rect.id !== this.hoverId || line !== this.hoverLine) this.showCard(rect, state);
    } else if (this.hoverId != null) {
      if (!this.leaveAt) this.leaveAt = Date.now();
      if (Date.now() - this.leaveAt > 250) { this.card.hide(); this.hoverId = null; }
    }
  }

  async action(sender, payload) {
    if (!this.card || sender !== this.card.webContents) return { ok: false, error: '无效的浮窗请求。' };
    const state = this.getState();
    if (!this.running || this.busy || payload?.token !== this.token || state?.token !== this.token
      || state.uncertain || payload.id !== this.hoverId) return { ok: false, error: '修订已变化，请重新打开建议。' };
    if (payload.action === 'results') { this.stop(); this.openResult(); return { ok: true }; }
    if (payload.action === 'close') { this.card.hide(); this.hoverId = null; return { ok: true }; }
    if (!['accept', 'ignore'].includes(payload.action)) return { ok: false, error: '无效操作。' };
    const change = state.changes.find(c => c.id === payload.id);
    if (!change) return { ok: false, error: '这条修订已经处理。' };
    this.busy = true; this.epoch++; this.hide();
    try {
      // The apply callback rechecks the token inside the shared source edit lock.
      const result = await this.apply(change, payload.action, state.token);
      if (this.getState()?.token !== state.token) return { ok: false, error: '修订会话已变化。' };
      this.onDecision({ ...result, token: state.token, id: change.id,
        status: payload.action === 'accept' ? 'accepted' : 'rejected' });
      if (!result?.ok) { this.stop(); this.openResult(); }
      else if (!this.getState()?.changes.length) { this.stop(); this.openResult(); }
      return result;
    } catch (error) {
      this.stop(); this.openResult();
      return { ok: false, error: error.message };
    } finally {
      this.busy = false;
      if (this.running) this.refresh();
    }
  }
}

module.exports = { SourceReview, validRect, cardBounds };
