'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BASE_CHARS_PER_CREDIT,
  MAX_BILLABLE_CHARS,
  calculateCreditCharge,
  isBillableTextTooLong,
} = require('../src/commercial/credit-policy');

test('base policy uses 800 chars per credit', () => {
  assert.equal(BASE_CHARS_PER_CREDIT, 800);
});

test('standard model charges 1 credit for 800 chars', () => {
  assert.equal(
    calculateCreditCharge({ billableChars: 800, modelCredits: 1 }),
    1,
  );
});

test('premium model charges by multiplier and rounds to half credit', () => {
  assert.equal(
    calculateCreditCharge({ billableChars: 1200, modelCredits: 2 }),
    3,
  );
});

test('billable text over max is rejected', () => {
  assert.equal(isBillableTextTooLong(MAX_BILLABLE_CHARS), false);
  assert.equal(isBillableTextTooLong(MAX_BILLABLE_CHARS + 1), true);
});