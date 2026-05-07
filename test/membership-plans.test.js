'use strict';

process.env.RUNSHI_LOAD_DOTENV = '0';

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../server/config');
const { getMembershipPlan, getMembershipPlans } = require('../server/commercial/plans');

test('default membership plan id points to an existing credit pack', () => {
  const plan = getMembershipPlan(config, config.membership.defaultPlanId);

  assert.equal(config.membership.defaultPlanId, 'runshi-basic');
  assert.ok(plan);
  assert.equal(plan.creditsPerPack, 300);
});

test('membership plans expose credit packs instead of monthly quotas', () => {
  const plans = getMembershipPlans(config);

  assert.ok(plans.length >= 2);
  assert.ok(plans.every((plan) => Number(plan.creditsPerPack) > 0));
  assert.ok(plans.every((plan) => Number(plan.monthlyQuota || 0) === 0));
});
