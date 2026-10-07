'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

// One short-lived STA process per request. User text travels only over stdin,
// never through PowerShell source, command-line arguments, or the clipboard.
class WindowsReviewHelper {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.spawn = options.spawn || spawn;
    this.scriptPath = options.scriptPath || path.join(__dirname, '..', 'scripts', 'windows_review.ps1')
      .replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
    this.timeoutMs = options.timeoutMs || 6000;
    this.busy = false;
  }

  probe() { return this._request({ action: 'probe' }); }

  reviewGeometry(request) {
    if (!validContext(request) || !Array.isArray(request.ranges) || request.ranges.length > 80 ||
        request.ranges.some(range => !validRange(range) || !Number.isSafeInteger(range.id) ||
          range.id < 0 || !inside(range, request.selectionRange)) ||
        request.ranges.reduce((sum, range) => sum + range.length, 0) > 2000) {
      return Promise.resolve({ ok: false, reason: 'invalid-request' });
    }
    return this._request({ ...request, action: 'geometry' });
  }

  applyEdit(request, replacement, options = {}) {
    const targetRange = options.targetRange || request?.targetRange;
    if (!validContext(request) || !validRange(targetRange) || !inside(targetRange, request.selectionRange) ||
        typeof replacement !== 'string' || replacement.length > 20000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(replacement)) {
      return Promise.resolve({ ok: false, reason: 'invalid-request', sourceMayHaveChanged: false });
    }
    return this._request({ ...request, action: 'apply', targetRange, replacement });
  }

  _request(payload) {
    if (this.platform !== 'win32') return Promise.resolve({ ok: false, reason: 'unsupported-platform' });
    if (this.busy && this.busyAction === 'geometry' && payload.action === 'apply') {
      return this.idle.then(() => this._request(payload));
    }
    if (this.busy) return Promise.resolve({ ok: false, reason: 'busy', sourceMayHaveChanged: false });
    this.busy = true;
    this.busyAction = payload.action;
    let release;
    this.idle = new Promise(resolve => { release = resolve; });
    return new Promise(resolve => {
      let child;
      let timer;
      let output = '';
      let finished = false;
      let dispatched = false;
      const fail = reason => ({ ok: false, reason, sourceMayHaveChanged: payload.action === 'apply' && dispatched });
      const finish = result => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.busy = false;
        release();
        if (!result.ok && !result.error) result.error = `Word 原文定位或写回不可用（${result.reason || 'unknown'}）。请确认原窗口、原文未变化；含表格、域或已开启修订的文档请使用加载项批阅。`;
        resolve(result);
      };
      try {
        child = this.spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA',
          '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath], {
          windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
        });
        timer = setTimeout(() => {
          child.kill();
          finish(fail('timeout'));
        }, this.timeoutMs);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => {
          output += chunk;
          if (output.length > 1024 * 1024) {
            child.kill();
            finish(fail('response-too-large'));
          }
        });
        // Drain stderr without logging potentially sensitive document content.
        child.stderr.on('data', () => {});
        child.on('error', () => finish(fail('helper-unavailable')));
        child.stdin.on('error', () => finish(fail('helper-input-failed')));
        child.on('close', code => {
          if (finished) return;
          if (code !== 0) return finish(fail('helper-failed'));
          try {
            const result = JSON.parse(output.replace(/^\uFEFF/u, '').trim());
            if (!result || typeof result.ok !== 'boolean') throw new Error('protocol');
            if (result.ok && !validResponse(payload, result)) throw new Error('protocol');
            finish(result);
          } catch { finish(fail('invalid-response')); }
        });
        dispatched = true;
        child.stdin.end(JSON.stringify(payload), 'utf8');
      } catch { finish(fail('helper-unavailable')); }
    });
  }
}

function validRange(range) {
  return !!range && Number.isSafeInteger(range.location) && range.location >= 0 &&
    Number.isSafeInteger(range.length) && range.length >= 0 &&
    Number.isSafeInteger(range.location + range.length);
}

function inside(range, selection) {
  return range.location >= selection.location && range.location + range.length <= selection.location + selection.length;
}

function validContext(request) {
  return !!request && request.bundleIdentifier === 'win32.word' && validRange(request.selectionRange) &&
    typeof request.expectedText === 'string' && request.expectedText.length > 0 && request.expectedText.length <= 20000 &&
    request.selectionRange.length === request.expectedText.length &&
    Number.isSafeInteger(request.frontmostPid) && request.frontmostPid > 0 &&
    Number.isSafeInteger(request.windowHandle) && request.windowHandle > 0 &&
    typeof request.documentId === 'string' && request.documentId.length > 0 && request.documentId.length <= 8192;
}

function validResponse(request, result) {
  if (request.action === 'geometry') {
    const ids = new Set(request.ranges.map(range => range.id));
    return result.coordinateSpace === 'physical' && Array.isArray(result.rects) && result.rects.length <= 2000 &&
      result.rects.every(rect => ids.has(rect.id) && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key])) &&
        rect.width > 0 && rect.height > 0);
  }
  if (request.action === 'probe') return result.supportsRangeEditing === true && validContext({ ...result, expectedText: result.text });
  const offset = request.targetRange.location - request.selectionRange.location;
  const expected = request.expectedText.slice(0, offset) + request.replacement +
    request.expectedText.slice(offset + request.targetRange.length);
  return result.verified === true && result.text === expected && result.expectedText === expected &&
    result.selectionRange?.location === request.selectionRange.location && result.selectionRange?.length === expected.length &&
    result.frontmostPid === request.frontmostPid && result.windowHandle === request.windowHandle &&
    result.bundleIdentifier === request.bundleIdentifier && typeof result.documentId === 'string' && result.documentId.length > 0;
}

module.exports = WindowsReviewHelper;
