'use strict';

const COMMERCIAL_AVAILABLE = process.env.RUNSHI_COMMERCIAL_AVAILABLE !== '0';

function getDisabledMembership() {
  return {
    active: false,
    status: 'disabled',
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
  };
}

function getDisabledTrial() {
  return {
    total: 0,
    used: 0,
    remaining: 0,
  };
}

function getDisabledCommercialState() {
  return {
    available: false,
    enabled: false,
    backendUrl: '',
    loggedIn: false,
    userId: null,
    phone: '',
    displayName: '',
    sessionExpiresAt: '',
    smsProvider: 'mock',
    paymentProviders: [],
    paymentMode: 'disabled',
    preferredSource: 'direct',
    trial: getDisabledTrial(),
    membership: getDisabledMembership(),
    availablePlans: [],
    creditBalance: 0,
    creditGranted: 0,
    creditUsed: 0,
  };
}

module.exports = {
  COMMERCIAL_AVAILABLE,
  getDisabledCommercialState,
  getDisabledMembership,
  getDisabledTrial,
};
