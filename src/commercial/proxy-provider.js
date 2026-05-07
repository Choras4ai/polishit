'use strict';

const BaseProvider = require('../ai/base-provider');
const { getProxyTimeoutMs } = require('./model-timeouts');

class ProxyProvider extends BaseProvider {
  constructor(config) {
    super(config);
    this.backendUrl = String(config.backendUrl || '').replace(/\/+$/, '');
    this.authToken = String(config.authToken || '').trim();
    this.selectedModel = String(config.selectedModel || '').trim();
    this.onUnauthorized = typeof config.onUnauthorized === 'function'
      ? config.onUnauthorized
      : null;

    if (!this.backendUrl) {
      throw new Error('商业后端地址未配置，请先在账户页填写。');
    }
    if (!this.authToken) {
      throw new Error('请先登录商业账户。');
    }
  }

  async _request(path, options = {}) {
    const response = await fetch(`${this.backendUrl}${path}`, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.authToken}`,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(options.timeout || 60_000),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      if (response.status === 401 && this.onUnauthorized) {
        this.onUnauthorized();
      }
      const err = new Error(payload.error || `代理请求失败 (${response.status})`);
      err.status = response.status;
      throw err;
    }
    return payload;
  }

  async chat(messages, options = {}) {
    const body = { messages, options, task: options.task || 'polish' };
    if (this.selectedModel) {
      body.model = this.selectedModel;
    }
    const payload = await this._request('/api/ai/chat', {
      method: 'POST',
      body,
      timeout: getProxyTimeoutMs({
        modelId: this.selectedModel,
        requestedTimeoutMs: options.timeoutMs || options.timeout,
      }),
    });
    return payload.content;
  }

  async testConnection() {
    await this._request('/api/auth/me', { timeout: 15_000 });
    return true;
  }
}

module.exports = ProxyProvider;
