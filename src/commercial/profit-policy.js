'use strict';

const { roundUpToStep } = require('./credit-policy');

// The 1000-credit pack has the lowest revenue per credit, so it is the safe
// denominator for every pack. A 1% payment-fee reserve and 20% upstream-price
// buffer are included before enforcing a 55% contribution-margin floor.
const LOWEST_PACK_REVENUE_PER_CREDIT_YUAN = 29.9 / 1000;
const PAYMENT_FEE_RATE_BUFFER = 0.01;
const UPSTREAM_PRICE_BUFFER = 1.20;
const TARGET_CONTRIBUTION_MARGIN = 0.55;
const INPUT_TEMPLATE_TOKEN_RESERVE = 128;
const TOKENS_PER_MESSAGE_RESERVE = 64;

function estimateInputTokenCeiling(messages) {
  const safeMessages = Array.isArray(messages) ? messages : [];
  const serialized = JSON.stringify(safeMessages);
  // Modern tokenizers cannot produce more byte-fallback tokens than the UTF-8
  // payload bytes. Template reserves cover role markers and chat wrappers.
  return Buffer.byteLength(serialized, 'utf8')
    + INPUT_TEMPLATE_TOKEN_RESERVE
    + safeMessages.length * TOKENS_PER_MESSAGE_RESERVE;
}

function estimateUpstreamCostCeiling({ messages, maxOutputTokens, model } = {}) {
  const inputPrice = Math.max(0, Number(model?.inputPricePerMTokens) || 0);
  const outputPrice = Math.max(0, Number(model?.outputPricePerMTokens) || 0);
  const inputTokens = estimateInputTokenCeiling(messages);
  const outputTokens = Math.max(0, Math.ceil(Number(maxOutputTokens) || 0));
  return ((inputTokens * inputPrice) + (outputTokens * outputPrice)) / 1_000_000;
}

function calculateProfitProtectedCreditCharge({
  messages,
  maxOutputTokens,
  model,
  baseCredits = 0,
} = {}) {
  const upstreamCostCeiling = estimateUpstreamCostCeiling({ messages, maxOutputTokens, model });
  const guardedUpstreamCost = upstreamCostCeiling * UPSTREAM_PRICE_BUFFER;
  const aiCostAllowancePerCredit = LOWEST_PACK_REVENUE_PER_CREDIT_YUAN
    * (1 - TARGET_CONTRIBUTION_MARGIN - PAYMENT_FEE_RATE_BUFFER);
  const protectedCredits = guardedUpstreamCost > 0
    ? roundUpToStep(guardedUpstreamCost / aiCostAllowancePerCredit)
    : 0;
  const credits = Math.max(Number(baseCredits) || 0, protectedCredits);
  const grossRevenue = credits * LOWEST_PACK_REVENUE_PER_CREDIT_YUAN;
  const guardedContributionMargin = grossRevenue > 0
    ? 1 - ((guardedUpstreamCost + grossRevenue * PAYMENT_FEE_RATE_BUFFER) / grossRevenue)
    : 1;

  return {
    credits,
    upstreamCostCeiling,
    guardedUpstreamCost,
    guardedContributionMargin,
    targetContributionMargin: TARGET_CONTRIBUTION_MARGIN,
  };
}

function getProfitPolicy() {
  return {
    lowestPackRevenuePerCreditYuan: LOWEST_PACK_REVENUE_PER_CREDIT_YUAN,
    paymentFeeRateBuffer: PAYMENT_FEE_RATE_BUFFER,
    upstreamPriceBuffer: UPSTREAM_PRICE_BUFFER,
    targetContributionMargin: TARGET_CONTRIBUTION_MARGIN,
  };
}

module.exports = {
  LOWEST_PACK_REVENUE_PER_CREDIT_YUAN,
  PAYMENT_FEE_RATE_BUFFER,
  UPSTREAM_PRICE_BUFFER,
  TARGET_CONTRIBUTION_MARGIN,
  estimateInputTokenCeiling,
  estimateUpstreamCostCeiling,
  calculateProfitProtectedCreditCharge,
  getProfitPolicy,
};
