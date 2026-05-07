'use strict';

const BASE_CHARS_PER_CREDIT = 800;
const MAX_BILLABLE_CHARS = 12_000;
const MIN_CREDIT_CHARGE = 0.5;
const CREDIT_STEP = 0.5;
const EXPLAIN_BILLING_RATIO = 0.5;

function normalizeBillableChars(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.ceil(numeric);
}

function roundUpToStep(value, step = CREDIT_STEP) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.ceil(value / step) * step;
}

function calculateCreditCharge({ billableChars, modelCredits = 1 } = {}) {
  const chars = normalizeBillableChars(billableChars);
  const credits = Number(modelCredits) || 0;
  if (chars <= 0 || credits <= 0) return 0;
  const rawCharge = (chars / BASE_CHARS_PER_CREDIT) * credits;
  return Math.max(MIN_CREDIT_CHARGE, roundUpToStep(rawCharge));
}

function isBillableTextTooLong(chars) {
  return normalizeBillableChars(chars) > MAX_BILLABLE_CHARS;
}

function getCreditPolicy() {
  return {
    baseCharsPerCredit: BASE_CHARS_PER_CREDIT,
    maxBillableChars: MAX_BILLABLE_CHARS,
    minCreditCharge: MIN_CREDIT_CHARGE,
    creditStep: CREDIT_STEP,
    explainBillingRatio: EXPLAIN_BILLING_RATIO,
    shortcutSequenceSupported: false,
  };
}

module.exports = {
  BASE_CHARS_PER_CREDIT,
  MAX_BILLABLE_CHARS,
  MIN_CREDIT_CHARGE,
  CREDIT_STEP,
  EXPLAIN_BILLING_RATIO,
  normalizeBillableChars,
  roundUpToStep,
  calculateCreditCharge,
  isBillableTextTooLong,
  getCreditPolicy,
};