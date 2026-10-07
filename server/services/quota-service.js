'use strict';
const { consumeCredits, consumeTrialUse, refundCredits, refundTrialUse, buildCommercialAccount } = require('../commercial/account-service');
const { consumeDeviceBalance, consumeDeviceTrial, consumeDeviceCredits, refundDeviceBalance, refundDeviceTrial, refundDeviceCredits, buildDeviceAccount } = require('./device-service');
// Consume from users.credit_balance (check-in / free credits)
async function consumeUserCreditBalance(db, userId, credits, meta) {
  const safeCredits = Math.max(0.5, Math.round((Number(credits) || 1) * 2) / 2);
  const result = await db.run(
    'UPDATE users SET credit_balance = credit_balance - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND credit_balance >= ?',
    [safeCredits, userId, safeCredits],
  );
  if (!result.changes) {
    const err = new Error('积分余额不足。');
    err.status = 402;
    throw err;
  }
  await db.run(
    `INSERT INTO usage_logs (user_id, kind, units, meta_json, created_at)
     VALUES (?, 'credit_balance', ?, ?, CURRENT_TIMESTAMP)`,
    [userId, safeCredits, JSON.stringify(meta || {})],
  );
}

async function refundUserCreditBalance(db, userId, credits, meta) {
  const safeCredits = Math.max(0.5, Math.round((Number(credits) || 1) * 2) / 2);
  await db.run(
    'UPDATE users SET credit_balance = credit_balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [safeCredits, userId],
  );
  await db.run(
    `INSERT INTO usage_logs (user_id, kind, units, meta_json, created_at)
     VALUES (?, 'credit_balance_refund', ?, ?, CURRENT_TIMESTAMP)`,
    [userId, safeCredits, JSON.stringify(meta || {})],
  );
}

async function reserveQuotaForRequest({ db, config, authMode, deviceId, userId, billingMode, creditsToConsume, meta }) {
  const refunds = [];
  await db.transaction(async tx => {
    if (billingMode === 'none') return;
    const device = authMode === 'device';
    const id = device ? deviceId : userId;
    const account = device
      ? await buildDeviceAccount(tx, config, id)
      : await buildCommercialAccount(tx, config, id);
    if (billingMode === 'credits') {
      if (!Number.isFinite(creditsToConsume) || creditsToConsume <= 0 || creditsToConsume % 0.5 !== 0) {
        throw Object.assign(new Error('积分扣费参数无效。'), { status: 400 });
      }
      const memberCredits = Math.min(creditsToConsume, account.membership.active ? account.membership.creditsRemaining : 0);
      const balanceCredits = creditsToConsume - memberCredits;
      if (memberCredits > 0) {
        await (device ? consumeDeviceCredits : consumeCredits)(tx, config, id, memberCredits, meta);
        refunds.push(connection => (device ? refundDeviceCredits : refundCredits)(connection, config, id, memberCredits, meta));
      }
      if (balanceCredits > 0) {
        if (device) {
          await consumeDeviceBalance(tx, config, id, balanceCredits, meta);
          refunds.push(connection => refundDeviceBalance(connection, config, id, balanceCredits, meta));
        } else {
          await consumeUserCreditBalance(tx, id, balanceCredits, meta);
          refunds.push(connection => refundUserCreditBalance(connection, id, balanceCredits, meta));
        }
      }
    } else if (billingMode === 'trial' && !account.membership.active) {
      await (device ? consumeDeviceTrial : consumeTrialUse)(tx, config, id, meta);
      refunds.push(connection => (device ? refundDeviceTrial : refundTrialUse)(connection, config, id, meta));
    } else {
      throw Object.assign(new Error('当前账户无法使用试用额度。'), { status: 402 });
    }
  });
  let refundPromise;
  return () => {
    if (!refundPromise) {
      refundPromise = db.transaction(async tx => {
        if (authMode === 'device') {
          const owner = await tx.get('SELECT user_id FROM devices WHERE id = ?', [deviceId]);
          if (owner?.user_id) {
            const refundMeta = { ...meta, transferredDeviceId: deviceId };
            if (billingMode === 'credits') {
              await refundUserCreditBalance(tx, owner.user_id, creditsToConsume, refundMeta);
            } else if (billingMode === 'trial') {
              await tx.run('UPDATE users SET trial_uses_total = trial_uses_total + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [owner.user_id]);
              await tx.run("INSERT INTO usage_logs (user_id, device_id, kind, units, meta_json, created_at) VALUES (?, ?, 'trial_ai_chat_refund', 1, ?, CURRENT_TIMESTAMP)", [owner.user_id, deviceId, JSON.stringify(refundMeta)]);
            }
            return;
          }
        }
        for (const refund of refunds) await refund(tx);
      }).catch(error => { refundPromise = undefined; throw error; });
    }
    return refundPromise;
  };
}
module.exports = { reserveQuotaForRequest };
