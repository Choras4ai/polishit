'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const CommercialClient = require('../src/commercial/client');

function createStore(seed = {}) {
  const values = {
    'commercial.enabled': true,
    ...seed,
  };
  return {
    get(key) {
      return values[key];
    },
    set(key, value) {
      values[key] = value;
    },
  };
}

test('commercial client normalizes credit-based membership fields', () => {
  const client = new CommercialClient(createStore());
  const normalized = client._normalizeAccount({
    loggedIn: true,
    membership: {
      active: true,
      creditsTotal: 300,
      creditsUsed: 66,
      creditsRemaining: 234,
    },
    freeCredits: 5,
    totalAvailable: 239,
  });

  assert.equal(normalized.membership.creditsTotal, 300);
  assert.equal(normalized.membership.monthlyQuota, 300);
  assert.equal(normalized.membership.creditsRemaining, 234);
  assert.equal(normalized.monthlyRemaining, 234);
  assert.equal(normalized.creditBalance, 239);
});

test('commercial client still accepts legacy monthly membership payloads', () => {
  const client = new CommercialClient(createStore());
  const normalized = client._normalizeAccount({
    loggedIn: true,
    membership: {
      active: true,
      monthlyQuota: 500000,
      monthlyUsed: 1200,
      monthlyRemaining: 498800,
    },
  });

  assert.equal(normalized.membership.creditsTotal, 500000);
  assert.equal(normalized.membership.creditsUsed, 1200);
  assert.equal(normalized.membership.creditsRemaining, 498800);
});
