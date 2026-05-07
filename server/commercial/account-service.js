'use strict';

const crypto = require('crypto');
const { getMembershipPlan, getMembershipPlans } = require('./plans');
const { getCreditPolicy } = require('../../src/commercial/credit-policy');

function nowIso() {
  return new Date().toISOString();
}

function buildInactiveMembership(status = 'inactive') {
  return {
    active: false,
    status,
    planId: '',
    planName: '',
    priceCents: 0,
    priceLabel: '',
    creditsTotal: 0,
    creditsUsed: 0,
    creditsRemaining: 0,
  };
}

function buildTrialPayload(user) {
  const total = Math.max(0, Number(user.trial_uses_total || 0));
  const used = Math.max(0, Number(user.trial_uses_used || 0));
  return {
    total,
    used,
    remaining: Math.max(0, total - used),
  };
}

async function getMembershipRecord(db, userId) {
  return db.get(
    `SELECT *
       FROM memberships
      WHERE user_id = ?
      LIMIT 1`,
    [userId],
  );
}

function serializeMembership(record, cfg) {
  if (!record) {
    return buildInactiveMembership();
  }

  const plan = getMembershipPlan(cfg, record.plan_id);
  const creditsTotal = Math.max(0, Number(record.monthly_credits || 0));
  const creditsUsed = Math.max(0, Number(record.monthly_credits_used || 0));
  const active = record.status === 'active' && creditsTotal > creditsUsed;

  return {
    active,
    status: active ? 'active' : (record.status || 'inactive'),
    planId: record.plan_id || '',
    planName: record.plan_name || plan?.planName || '',
    priceCents: Number(record.price_cents || plan?.priceCents || 0),
    priceLabel: plan?.priceLabel || '',
    creditsTotal,
    creditsUsed,
    creditsRemaining: Math.max(0, creditsTotal - creditsUsed),
  };
}

async function getUserSnapshot(db, userId) {
  return db.get(
    `SELECT
        id,
        phone,
        email,
        display_name,
        credit_balance,
        trial_uses_total,
        trial_uses_used
       FROM users
      WHERE id = ?
      LIMIT 1`,
    [userId],
  );
}

function buildOrderPayload(order) {
  if (!order) return null;
  return {
    id: order.id,
    provider: order.provider,
    status: order.status,
    amountCents: Number(order.amount_cents || 0),
    planId: order.plan_id || '',
    planName: order.plan_name || '',
    checkoutUrl: order.checkout_url || '',
    checkoutCodeUrl: order.checkout_code_url || '',
    paidAt: order.paid_at || '',
    createdAt: order.created_at || '',
    providerTradeNo: order.provider_trade_no || '',
  };
}

async function buildCommercialAccount(db, cfg, userId, extra = {}) {
  const user = await getUserSnapshot(db, userId);
  if (!user) {
    const err = new Error('账户不存在。');
    err.status = 404;
    throw err;
  }

  const trial = buildTrialPayload(user);
  const membership = serializeMembership(await getMembershipRecord(db, userId), cfg);
  const freeCredits = Math.max(0, Number(user.credit_balance || 0));
  const totalAvailable = (membership.active ? membership.creditsRemaining : 0) + freeCredits + (membership.active ? 0 : trial.remaining);

  return {
    loggedIn: true,
    userId: user.id,
    email: user.email || '',
    phone: user.phone,
    displayName: user.display_name,
    sessionExpiresAt: extra.sessionExpiresAt || '',
    smsProvider: extra.smsProvider || cfg.smsProvider,
    paymentProviders: extra.paymentProviders || cfg.paymentProviders,
    paymentMode: cfg.paymentMode,
    trial,
    membership,
    freeCredits,
    totalAvailable,
    availablePlans: getMembershipPlans(cfg),
    creditPolicy: getCreditPolicy(),
    creditBalance: totalAvailable,
    creditGranted: (membership.active ? membership.creditsTotal : trial.total) + freeCredits,
    creditUsed: (membership.active ? membership.creditsUsed : trial.used),
  };
}

async function insertOrder(db, payload) {
  await db.run(
    `INSERT INTO orders (
      id, user_id, provider, status, amount_cents, credits, plan_id, plan_name,
      provider_trade_no, checkout_url, checkout_code_url, payload_json,
      period_start, period_end, created_at, paid_at, paid_meta_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payload.id,
      payload.userId,
      payload.provider,
      payload.status,
      payload.amountCents,
      payload.credits,
      payload.planId,
      payload.planName,
      payload.providerTradeNo || '',
      payload.checkoutUrl || '',
      payload.checkoutCodeUrl || '',
      JSON.stringify(payload.payload || {}),
      payload.periodStart || null,
      payload.periodEnd || null,
      payload.createdAt,
      payload.paidAt || null,
      JSON.stringify(payload.paidMeta || {}),
    ],
  );
}

async function getOrderById(db, orderId) {
  return db.get(
    `SELECT *
       FROM orders
      WHERE id = ?
      LIMIT 1`,
    [orderId],
  );
}

async function getOrderByIdForUser(db, orderId, userId) {
  return db.get(
    `SELECT *
       FROM orders
      WHERE id = ?
        AND user_id = ?
      LIMIT 1`,
    [orderId, userId],
  );
}

async function activateMembershipForOrder(db, cfg, order, options = {}) {
  if (!order) {
    const err = new Error('订单不存在。');
    err.status = 404;
    throw err;
  }

  if (order.status === 'paid' && order.paid_at) {
    return {
      order: buildOrderPayload(order),
      account: await buildCommercialAccount(db, cfg, order.user_id),
    };
  }

  const paidAt = options.paidAt || nowIso();
  const paidMeta = JSON.stringify(options.paidMeta || {});
  const periodStart = order.period_start || paidAt;
  const plan = getMembershipPlan(cfg, order.plan_id);
  const creditsToAdd = Math.max(
    0,
    Number(plan?.creditsPerPack || order.credits || cfg.membership.creditsPerPack || 0),
  );

  if (creditsToAdd <= 0) {
    const err = new Error('订单积分配置无效，无法完成入账。');
    err.status = 500;
    throw err;
  }

  let freshOrder;
  await db.exec('BEGIN IMMEDIATE TRANSACTION');
  try {
    const markPaid = await db.run(
      `UPDATE orders
          SET status = 'paid',
              provider_trade_no = ?,
              paid_at = ?,
              period_start = ?,
              paid_meta_json = ?
        WHERE id = ?
          AND NOT (status = 'paid' AND paid_at IS NOT NULL)`,
      [
        options.providerTradeNo || order.provider_trade_no || '',
        paidAt,
        periodStart,
        paidMeta,
        order.id,
      ],
    );

    if (markPaid.changes) {
      await db.run(
        `INSERT INTO memberships (
          user_id, plan_id, plan_name, status, price_cents,
          monthly_credits, monthly_credits_used,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          plan_id = excluded.plan_id,
          plan_name = excluded.plan_name,
          status = 'active',
          price_cents = excluded.price_cents,
          monthly_credits = monthly_credits + ?,
          updated_at = excluded.updated_at`,
        [
          order.user_id,
          order.plan_id,
          order.plan_name,
          'active',
          Number(order.amount_cents || 0),
          creditsToAdd,
          paidAt,
          paidAt,
          creditsToAdd,
        ],
      );
    }

    freshOrder = await getOrderById(db, order.id);
    await db.exec('COMMIT');
  } catch (err) {
    await db.exec('ROLLBACK');
    throw err;
  }

  return {
    order: buildOrderPayload(freshOrder),
    account: await buildCommercialAccount(db, cfg, order.user_id),
  };
}

async function createPendingMembershipOrder(db, cfg, userId, provider, planId, checkout = {}) {
  const plan = getMembershipPlan(cfg, planId);
  if (!plan) {
    const err = new Error('未找到可充值的积分包。');
    err.status = 400;
    throw err;
  }

  const orderId = `ord_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const createdAt = nowIso();

  await insertOrder(db, {
    id: orderId,
    userId,
    provider,
    status: checkout.status || 'pending',
    amountCents: plan.priceCents,
    credits: Number(plan.creditsPerPack || 0),
    planId: plan.planId,
    planName: plan.planName,
    checkoutUrl: checkout.checkoutUrl || '',
    checkoutCodeUrl: checkout.checkoutCodeUrl || '',
    providerTradeNo: checkout.providerTradeNo || '',
    payload: checkout.payload || {},
    createdAt,
  });

  return getOrderById(db, orderId);
}

async function subscribeMembership(db, cfg, userId, planId) {
  const plan = getMembershipPlan(cfg, planId);
  if (!plan) {
    const err = new Error('未找到可充值的积分包。');
    err.status = 400;
    throw err;
  }

  const pending = await createPendingMembershipOrder(db, cfg, userId, cfg.paymentMode, plan.planId, {
    status: 'paid',
  });
  const activated = await activateMembershipForOrder(db, cfg, pending, {
    paidAt: nowIso(),
    providerTradeNo: pending.id,
    paidMeta: { source: 'manual' },
  });

  return {
    order: activated.order,
    notice: cfg.paymentMode === 'manual'
      ? '当前为直充积分流程，后续可替换为正式支付回调。'
      : '',
    account: activated.account,
  };
}

async function consumeTrialUse(db, cfg, userId, meta) {
  const updatedAt = nowIso();
  const result = await db.run(
    `UPDATE users
        SET trial_uses_used = trial_uses_used + 1,
            updated_at = ?
      WHERE id = ?
        AND trial_uses_used < trial_uses_total`,
    [updatedAt, userId],
  );
  if (!result.changes) {
    const err = new Error('免费次数已用完，请充值积分，或前往 API 配置页自行填写模型。');
    err.status = 402;
    throw err;
  }

  await db.run(
    `INSERT INTO usage_logs (user_id, kind, units, meta_json, created_at)
     VALUES (?, 'trial_ai_chat', 1, ?, ?)`,
    [userId, JSON.stringify(meta || {}), updatedAt],
  );

  return buildCommercialAccount(db, cfg, userId);
}

async function consumeMembershipQuota(db, cfg, userId, units, meta) {
  const safeUnits = Math.max(0, Math.ceil(Number(units) || 0));
  if (safeUnits <= 0) {
    return buildCommercialAccount(db, cfg, userId);
  }

  const membership = serializeMembership(await getMembershipRecord(db, userId), cfg);
  if (!membership.active) {
    const err = new Error('当前账号无可用积分，请先充值。');
    err.status = 402;
    throw err;
  }

  const updatedAt = nowIso();
  const result = await db.run(
    `UPDATE memberships
        SET monthly_credits_used = monthly_credits_used + ?,
            updated_at = ?
      WHERE user_id = ?
        AND status = 'active'
        AND (monthly_credits_used + ?) <= monthly_credits`,
    [safeUnits, updatedAt, userId, safeUnits],
  );

  if (!result.changes) {
    const err = new Error('扣费失败，请重试。');
    err.status = 402;
    throw err;
  }

  await db.run(
    `INSERT INTO usage_logs (user_id, kind, units, meta_json, created_at)
     VALUES (?, 'membership_ai_chat', ?, ?, ?)`,
    [userId, safeUnits, JSON.stringify(meta || {}), updatedAt],
  );

  return buildCommercialAccount(db, cfg, userId);
}

async function refundTrialUse(db, cfg, userId, meta) {
  const updatedAt = nowIso();
  await db.run(
    `UPDATE users
        SET trial_uses_used = MAX(0, trial_uses_used - 1),
            updated_at = ?
      WHERE id = ?`,
    [updatedAt, userId],
  );

  await db.run(
    `INSERT INTO usage_logs (user_id, kind, units, meta_json, created_at)
     VALUES (?, 'trial_ai_chat_refund', 1, ?, ?)`,
    [userId, JSON.stringify(meta || {}), updatedAt],
  );

  return buildCommercialAccount(db, cfg, userId);
}

async function consumeCredits(db, cfg, userId, credits, meta) {
  const safeCredits = Math.max(0.5, Math.round((Number(credits) || 1) * 2) / 2); // support 0.5 increments

  const membership = serializeMembership(await getMembershipRecord(db, userId), cfg);
  if (!membership.active) {
    const err = new Error('当前账号无可用积分，请先充值后再使用。');
    err.status = 402;
    throw err;
  }
  if (membership.creditsRemaining < safeCredits) {
    const err = new Error(`积分不足（剩余 ${membership.creditsRemaining}，需要 ${safeCredits}），请充值。`);
    err.status = 402;
    throw err;
  }

  const updatedAt = nowIso();
  const result = await db.run(
    `UPDATE memberships
        SET monthly_credits_used = monthly_credits_used + ?,
            updated_at = ?
      WHERE user_id = ?
        AND status = 'active'
        AND (monthly_credits_used + ?) <= monthly_credits`,
    [safeCredits, updatedAt, userId, safeCredits],
  );

  if (!result.changes) {
    const err = new Error('积分不足，请充值。');
    err.status = 402;
    throw err;
  }

  await db.run(
    `INSERT INTO usage_logs (user_id, kind, units, meta_json, created_at)
     VALUES (?, 'membership_credits', ?, ?, ?)`,
    [userId, safeCredits, JSON.stringify(meta || {}), updatedAt],
  );

  return buildCommercialAccount(db, cfg, userId);
}

async function refundCredits(db, cfg, userId, credits, meta) {
  const safeCredits = Math.max(0.5, Math.round((Number(credits) || 1) * 2) / 2);
  const updatedAt = nowIso();

  await db.run(
    `UPDATE memberships
        SET monthly_credits_used = MAX(0, monthly_credits_used - ?),
            updated_at = ?
      WHERE user_id = ?`,
    [safeCredits, updatedAt, userId],
  );

  await db.run(
    `INSERT INTO usage_logs (user_id, kind, units, meta_json, created_at)
     VALUES (?, 'membership_credits_refund', ?, ?, ?)`,
    [userId, safeCredits, JSON.stringify(meta || {}), updatedAt],
  );

  return buildCommercialAccount(db, cfg, userId);
}

async function refundMembershipQuota(db, cfg, userId, units, meta) {
  const safeUnits = Math.max(0, Math.ceil(Number(units) || 0));
  if (safeUnits <= 0) {
    return buildCommercialAccount(db, cfg, userId);
  }

  const updatedAt = nowIso();
  await db.run(
    `UPDATE memberships
        SET monthly_credits_used = MAX(0, monthly_credits_used - ?),
            updated_at = ?
      WHERE user_id = ?`,
    [safeUnits, updatedAt, userId],
  );

  await db.run(
    `INSERT INTO usage_logs (user_id, kind, units, meta_json, created_at)
     VALUES (?, 'membership_ai_chat_refund', ?, ?, ?)`,
    [userId, safeUnits, JSON.stringify(meta || {}), updatedAt],
  );

  return buildCommercialAccount(db, cfg, userId);
}

async function consumeHostedQuota(db, cfg, userId, units, meta) {
  const account = await buildCommercialAccount(db, cfg, userId);
  if (account.membership.active) {
    return consumeMembershipQuota(db, cfg, userId, units, meta);
  }
  if (account.trial.remaining > 0) {
    return consumeTrialUse(db, cfg, userId, meta);
  }

  const err = new Error('免费次数已用完，请充值积分，或前往 API 配置页自行填写模型。');
  err.status = 402;
  throw err;
}

module.exports = {
  activateMembershipForOrder,
  buildCommercialAccount,
  buildOrderPayload,
  consumeCredits,
  consumeHostedQuota,
  consumeMembershipQuota,
  consumeTrialUse,
  createPendingMembershipOrder,
  getMembershipPlans,
  getOrderById,
  getOrderByIdForUser,
  refundCredits,
  refundMembershipQuota,
  refundTrialUse,
  subscribeMembership,
};
