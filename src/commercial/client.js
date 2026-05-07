'use strict';

const {
  COMMERCIAL_AVAILABLE,
  getDisabledCommercialState,
  getDisabledMembership,
  getDisabledTrial,
} = require('./feature');

class CommercialClient {
  constructor(configStore) {
    this.config = configStore;
    this.available = COMMERCIAL_AVAILABLE;
  }

  _getBaseUrl() {
    const raw = this.config.get('commercial.backendUrl') || 'http://127.0.0.1:8787';
    return String(raw).trim().replace(/\/+$/, '');
  }

  _getToken() {
    return String(this.config.get('commercial.authToken') || '').trim();
  }

  _normalizeAccount(payload = {}) {
    const trial = {
      ...getDisabledTrial(),
      ...(payload.trial || {}),
    };
    const payloadMembership = payload.membership || {};
    const rawMembership = {
      ...getDisabledMembership(),
      ...payloadMembership,
    };
    const creditsTotal = Number(
      payloadMembership.creditsTotal
      ?? payloadMembership.monthlyQuota
      ?? rawMembership.creditsTotal
      ?? rawMembership.monthlyQuota
      ?? 0,
    );
    const creditsUsed = Number(
      payloadMembership.creditsUsed
      ?? payloadMembership.monthlyUsed
      ?? rawMembership.creditsUsed
      ?? rawMembership.monthlyUsed
      ?? 0,
    );
    const creditsRemaining = Number(
      payloadMembership.creditsRemaining
      ?? payloadMembership.monthlyRemaining
      ?? rawMembership.creditsRemaining
      ?? rawMembership.monthlyRemaining
      ?? Math.max(0, creditsTotal - creditsUsed),
    );
    const membership = {
      ...rawMembership,
      creditsTotal,
      creditsUsed,
      creditsRemaining,
      monthlyQuota: creditsTotal,
      monthlyUsed: creditsUsed,
      monthlyRemaining: creditsRemaining,
    };
    const effectiveBalance = membership.active
      ? Number(membership.creditsRemaining || 0)
      : Number(trial.remaining || 0);
    const effectiveGranted = membership.active
      ? Number(membership.creditsTotal || 0)
      : Number(trial.total || 0);
    const effectiveUsed = membership.active
      ? Number(membership.creditsUsed || 0)
      : Number(trial.used || 0);
    const monthlyRemaining = Number(membership.creditsRemaining || 0);
    const monthlyUsed = Number(membership.creditsUsed || 0);
    const monthlyQuota = Number(membership.creditsTotal || 0);

    return {
      loggedIn: Boolean(payload.loggedIn),
      userId: payload.userId || null,
      phone: payload.phone || '',
      displayName: payload.displayName || '',
      sessionExpiresAt: payload.sessionExpiresAt || '',
      smsProvider: payload.smsProvider || 'mock',
      paymentProviders: payload.paymentProviders || [],
      paymentMode: payload.paymentMode || 'mock',
      preferredSource: payload.preferredSource || this.config.get('commercial.preferredSource') || 'hosted',
      trial,
      membership,
      availablePlans: payload.availablePlans || [],
      creditPolicy: payload.creditPolicy || null,
      // 兼容现有界面逻辑
      creditBalance: Number(payload.creditBalance ?? payload.totalAvailable ?? effectiveBalance),
      creditGranted: Number(payload.creditGranted ?? effectiveGranted),
      creditUsed: Number(payload.creditUsed ?? effectiveUsed),
      freeCredits: Number(payload.freeCredits || 0),
      totalAvailable: Number(payload.totalAvailable ?? (effectiveBalance + Number(payload.freeCredits || 0))),
      email: payload.email || '',
      monthlyRemaining,
      monthlyUsed,
      monthlyQuota,
    };
  }

  _setAccountState(payload) {
    this.config.set('commercial.account', this._normalizeAccount(payload));
  }

  _clearSession() {
    this.config.set('commercial.authToken', '');
    this._setAccountState(getDisabledCommercialState());
  }

  async _request(path, options = {}) {
    if (!this.available) {
      return getDisabledCommercialState();
    }

    const url = `${this._getBaseUrl()}${path}`;
    const headers = { 'Content-Type': 'application/json', ...(options.extraHeaders || {}) };
    if (options.auth) {
      const token = this._getToken();
      if (!token) {
        const err = new Error('请先登录商业账户。');
        err.status = 401;
        throw err;
      }
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(options.timeout || 15000),
    }).catch((fetchErr) => {
      // Localize network errors
      if (fetchErr.name === 'AbortError' || fetchErr.name === 'TimeoutError') {
        throw new Error('请求超时，请检查网络连接后重试。');
      }
      if (fetchErr.message?.includes('fetch failed') || fetchErr.message?.includes('ECONNREFUSED') || fetchErr.message?.includes('network')) {
        throw new Error('无法连接服务器，请检查网络设置或稍后重试。');
      }
      throw new Error(`网络请求失败：${fetchErr.message}`);
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      const err = new Error(payload.error || `请求失败 (${response.status})`);
      err.status = response.status;
      throw err;
    }
    return payload;
  }

  async getStatus({ refresh = false } = {}) {
    if (!this.available) {
      return getDisabledCommercialState();
    }

    const account = this._normalizeAccount(this.config.get('commercial.account') || {});
    const status = {
      available: true,
      enabled: this.config.get('commercial.enabled') !== false,
      backendUrl: this._getBaseUrl(),
      preferredSource: this.config.get('commercial.preferredSource') || 'hosted',
      loggedIn: Boolean(account.loggedIn && this._getToken()),
      ...account,
    };

    if (!refresh || !status.loggedIn) {
      return status;
    }

    try {
      const [profile, plans] = await Promise.all([
        this._request('/api/auth/me', { auth: true }),
        this._request('/api/membership/plans', { auth: true }),
      ]);
      const merged = this._normalizeAccount({
        ...profile.user,
        availablePlans: plans.plans || [],
        creditPolicy: plans.creditPolicy || profile.user?.creditPolicy || null,
      });
      this._setAccountState(merged);
      return {
        available: true,
        enabled: status.enabled,
        backendUrl: status.backendUrl,
        preferredSource: status.preferredSource,
        ...merged,
      };
    } catch (err) {
      if (err.status === 401) {
        this._clearSession();
        return {
          ...getDisabledCommercialState(),
          available: true,
          enabled: status.enabled,
          backendUrl: status.backendUrl,
          error: err.message,
        };
      }
      throw err;
    }
  }

  async saveSettings(settings = {}) {
    if (!this.available) return getDisabledCommercialState();
    if (typeof settings.enabled === 'boolean') {
      this.config.set('commercial.enabled', settings.enabled);
    }
    if (typeof settings.backendUrl === 'string' && settings.backendUrl.trim()) {
      this.config.set('commercial.backendUrl', settings.backendUrl.trim());
    }
    if (typeof settings.preferredSource === 'string') {
      this.config.set('commercial.preferredSource', settings.preferredSource === 'direct' ? 'direct' : 'hosted');
    }
    return this.getStatus();
  }

  async testBackend() {
    if (!this.available) return getDisabledCommercialState();
    return this._request('/api/health');
  }

  async getPlans() {
    if (!this.available) return [];
    const payload = await this._request('/api/membership/plans');
    return payload.plans || [];
  }

  async getModels() {
    if (!this.available) return [];
    const payload = await this._request('/api/models');
    return payload.models || [];
  }

  async sendCode(phone) {
    return this._request('/api/auth/send-code', {
      method: 'POST',
      body: { phone },
    });
  }

  async login(phone, code) {
    const payload = await this._request('/api/auth/login', {
      method: 'POST',
      body: { phone, code },
    });
    this.config.set('commercial.authToken', payload.token);
    this._setAccountState(payload.user);
    return {
      available: true,
      enabled: this.config.get('commercial.enabled') !== false,
      backendUrl: this._getBaseUrl(),
      ...this._normalizeAccount(payload.user),
    };
  }

  _getDeviceToken() {
    return String(this.config.get('commercial.deviceToken') || '').trim();
  }

  async register(email, password) {
    const headers = {};
    const deviceToken = this._getDeviceToken();
    if (deviceToken) headers['X-Device-Token'] = deviceToken;

    const payload = await this._request('/api/auth/register', {
      method: 'POST',
      body: { email, password },
      extraHeaders: headers,
    });
    this.config.set('commercial.authToken', payload.token);
    this._setAccountState(payload.user);
    return {
      available: true,
      enabled: this.config.get('commercial.enabled') !== false,
      backendUrl: this._getBaseUrl(),
      ...this._normalizeAccount(payload.user),
    };
  }

  async loginEmail(email, password) {
    const headers = {};
    const deviceToken = this._getDeviceToken();
    if (deviceToken) headers['X-Device-Token'] = deviceToken;

    const payload = await this._request('/api/auth/login-email', {
      method: 'POST',
      body: { email, password },
      extraHeaders: headers,
    });
    this.config.set('commercial.authToken', payload.token);
    this._setAccountState(payload.user);
    return {
      available: true,
      enabled: this.config.get('commercial.enabled') !== false,
      backendUrl: this._getBaseUrl(),
      ...this._normalizeAccount(payload.user),
    };
  }

  async subscribe(planId) {
    const payload = await this._request('/api/membership/subscribe', {
      method: 'POST',
      auth: true,
      body: { planId },
    });
    this._setAccountState(payload.user);
    return {
      available: true,
      enabled: this.config.get('commercial.enabled') !== false,
      backendUrl: this._getBaseUrl(),
      preferredSource: this.config.get('commercial.preferredSource') || 'hosted',
      ...this._normalizeAccount(payload.user),
      order: payload.order || null,
      notice: payload.notice || '',
    };
  }

  async createOrder(provider, planId) {
    const payload = await this._request('/api/pay/create-order', {
      method: 'POST',
      auth: true,
      body: { provider, planId },
    });
    if (payload.user) {
      this._setAccountState(payload.user);
    }
    return payload;
  }

  async getOrder(orderId) {
    if (!this.available) return null;
    return this._request(`/api/pay/orders/${encodeURIComponent(orderId)}`, { auth: true });
  }

  async releaseLock() {
    return this._request('/api/ai/release-lock', { method: 'POST', auth: true });
  }

  async checkin() {
    const payload = await this._request('/api/checkin', { method: 'POST', auth: true });
    return payload;
  }

  async getCheckinStatus() {
    return this._request('/api/checkin/status', { auth: true });
  }

  async logout() {
    try {
      if (this._getToken()) {
        await this._request('/api/auth/logout', { method: 'POST', auth: true });
      }
    } finally {
      this._clearSession();
    }
    return this.getStatus();
  }

  clearSession() {
    this._clearSession();
  }
}

module.exports = CommercialClient;
