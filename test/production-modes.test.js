'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertPaymentProviderAllowed } = require('../server/commercial/payments');
const { issueVerificationCode, loginWithCode } = require('../server/services/auth-service');
test('production cannot issue manual credits even with manual configured', () => {
  assert.throws(() => assertPaymentProviderAllowed({ isProduction: true, paymentMode: 'manual' }, 'manual'), { status: 403 });
});
test('production never exposes or accepts mock SMS codes', async () => {
  const cfg = { isProduction: true, smsProvider: 'mock' };
  await assert.rejects(issueVerificationCode(null, cfg, '13800000000'), { status: 503 });
  await assert.rejects(loginWithCode(null, cfg, '13800000000', '123456'), { status: 503 });
});
