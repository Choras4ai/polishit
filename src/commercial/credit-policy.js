'use strict';

const BASE_CHARS_PER_CREDIT = 800;
const MAX_BILLABLE_CHARS = 12_000;
const MIN_CREDIT_CHARGE = 0.5;
const CREDIT_STEP = 0.5;
const EXPLAIN_BILLING_RATIO = 0.5;
const MIN_OUTPUT_TOKENS = 256;
const MAX_OUTPUT_TOKENS = 4096;
const OUTPUT_TOKENS_PER_BILLABLE_CHAR = 2;

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

function calculateMaxOutputTokens({ billableChars, requestedMaxTokens } = {}) {
  const chars = normalizeBillableChars(billableChars);
  const proportionalCap = Math.max(
    MIN_OUTPUT_TOKENS,
    Math.ceil(chars * OUTPUT_TOKENS_PER_BILLABLE_CHAR),
  );
  const requested = Number(requestedMaxTokens);
  const effectiveCap = Number.isFinite(requested) && requested > 0
    ? Math.min(proportionalCap, Math.ceil(requested))
    : proportionalCap;
  return Math.min(MAX_OUTPUT_TOKENS, effectiveCap);
}

function getCreditPolicy() {
  return {
    baseCharsPerCredit: BASE_CHARS_PER_CREDIT,
    maxBillableChars: MAX_BILLABLE_CHARS,
    minCreditCharge: MIN_CREDIT_CHARGE,
    creditStep: CREDIT_STEP,
    explainBillingRatio: EXPLAIN_BILLING_RATIO,
    minOutputTokens: MIN_OUTPUT_TOKENS,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    outputTokensPerBillableChar: OUTPUT_TOKENS_PER_BILLABLE_CHAR,
    shortcutSequenceSupported: false,
  };
}

module.exports = {
  BASE_CHARS_PER_CREDIT,
  MAX_BILLABLE_CHARS,
  MIN_CREDIT_CHARGE,
  CREDIT_STEP,
  EXPLAIN_BILLING_RATIO,
  MIN_OUTPUT_TOKENS,
  MAX_OUTPUT_TOKENS,
  OUTPUT_TOKENS_PER_BILLABLE_CHAR,
  normalizeBillableChars,
  roundUpToStep,
  calculateCreditCharge,
  isBillableTextTooLong,
  calculateMaxOutputTokens,
  getCreditPolicy,
};
