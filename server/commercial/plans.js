'use strict';

const { getModelList } = require('./models');
const { BASE_CHARS_PER_CREDIT, MAX_BILLABLE_CHARS } = require('../../src/commercial/credit-policy');

function formatPrice(priceCents) {
  return `${(Number(priceCents) / 100).toFixed(1).replace(/\.0$/, '')}`;
}

function getMembershipPlans(cfg) {
  const models = getModelList();
  return [
    {
      planId: 'runshi-basic',
      planName: '基础积分包',
      priceCents: 990,
      priceLabel: '9.9 / 300 积分',
      creditsPerPack: 300,
      monthlyQuota: 0,
      models,
      description: `¥9.9 购买 300 基础积分；单轮约 ${BASE_CHARS_PER_CREDIT} 字 / 基础积分，按模型倍率与成本保护线计费，单次最多 ${MAX_BILLABLE_CHARS} 字。`,
    },
    {
      planId: 'runshi-pro',
      planName: '进阶积分包',
      priceCents: 2990,
      priceLabel: '29.9 / 1000 积分',
      creditsPerPack: 1000,
      monthlyQuota: 0,
      models,
      description: `¥29.9 购买 1000 基础积分；按 ${BASE_CHARS_PER_CREDIT} 字 / 基础积分、模型倍率与成本保护线计费。`,
    },
  ];
}

function getMembershipPlan(cfg, planId) {
  const plans = getMembershipPlans(cfg);
  return plans.find((plan) => plan.planId === planId) || null;
}

module.exports = {
  getMembershipPlan,
  getMembershipPlans,
};
