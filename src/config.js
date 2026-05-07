'use strict';

const Store = require('electron-store');
const { COMMERCIAL_AVAILABLE } = require('./commercial/feature');

const DEFAULTS = {
  provider: {
    preset: 'together',
    apiUrl: '',
    apiKey: '',
    model: '',
  },
  shortcut: 'CommandOrControl+Alt+V',
  pipeline: {
    mode: 'single',
    temperature: 0.3,
    task: 'polish',
    genre: 'academic',
    customPrompts: {
      polish: '',
      deai: '',
    },
  },
  ui: {
    theme: 'system',
    floatingToolbarEnabled: true,
  },
  commercial: {
    available: COMMERCIAL_AVAILABLE,
    enabled: COMMERCIAL_AVAILABLE,
    backendUrl: '',
    authToken: '',
    paymentMode: 'manual',
    preferredSource: COMMERCIAL_AVAILABLE ? 'hosted' : 'direct',
    account: {
      loggedIn: false,
      userId: null,
      phone: '',
      displayName: '',
      sessionExpiresAt: '',
      smsProvider: 'mock',
      paymentProviders: [],
      paymentMode: 'manual',
      trial: {
        total: COMMERCIAL_AVAILABLE ? 10 : 0,
        used: 0,
        remaining: COMMERCIAL_AVAILABLE ? 10 : 0,
      },
      membership: {
        active: false,
        status: COMMERCIAL_AVAILABLE ? 'inactive' : 'disabled',
        planId: '',
        planName: '',
        priceCents: 0,
        priceLabel: '',
        currentPeriodStart: '',
        currentPeriodEnd: '',
        creditsTotal: 0,
        creditsUsed: 0,
        creditsRemaining: 0,
        monthlyQuota: 0,
        monthlyUsed: 0,
        monthlyRemaining: 0,
      },
      availablePlans: [],
      creditBalance: 0,
      creditGranted: 0,
      creditUsed: 0,
    },
  },
  updates: {
    source: '',
    skippedVersion: '',
    lastCheckedAt: '',
    latestVersion: '',
    latestName: '',
    hasUpdate: false,
    publishedAt: '',
    downloadUrl: '',
    releasePageUrl: '',
    releaseNotes: '',
    lastError: '',
  },
  onboarding: {
    completed: false,
  },
};

class ConfigStore {
  constructor() {
    this.store = new Store({
      name: 'chinese-polish-config',
      defaults: DEFAULTS,
    });
  }

  get(key) {
    return this.store.get(key);
  }

  set(key, value) {
    this.store.set(key, value);
  }

  getAll() {
    return this.store.store;
  }

  reset() {
    this.store.clear();
  }
}

module.exports = ConfigStore;
