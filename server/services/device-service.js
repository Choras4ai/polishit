'use strict';

const crypto = require('crypto');

function nowIso() {
  return new Date().toISOString();
}

function hashValue(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function generateDeviceToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Validate device fingerprint format.
 * Accepts UUIDs, hex strings 16-128 chars, or any non-empty string up to 256 chars.
 */
function assertFingerprint(fingerprint) {
  const fp = String(fingerprint || '').trim();
  if (!fp || fp.length > 256) {
    const err = new Error('设备指纹无效。');
    err.status = 400;
    throw err;
  }
  return fp;
}

/**
 * Register or retrieve a device by fingerprint.
 * No login required — device fingerprint is the identity.
 * Returns { device, token, isNew }.
 */
async function registerDevice(db, cfg, rawFingerprint, meta = {}) {
  const fingerprint = assertFingerprint(rawFingerprint);
  const fpHash = hashValue(fingerprint);
  const now = nowIso();

  let device = await db.get(
    'SELECT * FROM devices WHERE fingerprint_hash = ?',
    [fpHash],
  );

  let isNew = false;

  if (!device) {
    isNew = true;
    const displayName = meta.hostname
      ? `设备-${String(meta.hostname).slice(0, 20)}`
      : `设备-${fpHash.slice(0, 8)}`;

    await db.run(
      `INSERT INTO devices (
        fingerprint_hash, display_name, platform, hostname,
        credit_balance, credit_granted,
        trial_uses_total, trial_uses_used,
        status, created_at, updated_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?, ?)`,
      [
        fpHash,
        displayName,
        String(meta.platform || 'unknown').slice(0, 50),
        String(meta.hostname || '').slice(0, 100),
        cfg.initialCredits || 0,
        cfg.initialCredits || 0,
        cfg.trial.freeUsesTotal,
        now, now, now,
      ],
    );

    device = await db.get(
      'SELECT * FROM devices WHERE fingerprint_hash = ?',
      [fpHash],
    );
  } else {
    await db.run(
      'UPDATE devices SET last_seen_at = ?, updated_at = ? WHERE id = ?',
      [now, now, device.id],
    );
  }

  await db.run('DELETE FROM device_tokens WHERE device_id = ?', [device.id]);

  // Generate a long-lived device token
  const token = generateDeviceToken();
  const expiresAt = new Date(
    Date.now() + (cfg.deviceTokenTtlDays || 365) * 24 * 60 * 60 * 1000,
  ).toISOString();

  await db.run(
    `INSERT INTO device_tokens (device_id, token_hash, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)`,
    [device.id, hashValue(token), now, expiresAt, now],
  );

  return { device, token, isNew };
}

/**
 * Authenticate a request by device token (from Authorization header).
 * Returns { deviceId, device }.
 */
async function getDeviceByToken(db, authHeader) {
  if (!authHeader) {
    const err = new Error('未提供设备令牌。');
    err.status = 401;
    throw err;
  }
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    const err = new Error('设备令牌格式错误。');
    err.status = 401;
    throw err;
  }

  const tokenHash = hashValue(token);
  const now = nowIso();
  const record = await db.get(
    `SELECT dt.*, d.*,
            dt.id AS token_id,
            d.id AS device_id
       FROM device_tokens dt
       JOIN devices d ON d.id = dt.device_id
      WHERE dt.token_hash = ?
        AND dt.expires_at > ?
      LIMIT 1`,
    [tokenHash, now],
  );

  if (!record) {
    const err = new Error('设备令牌无效或已过期。');
    err.status = 401;
    throw err;
  }

  // Update last_seen
  await db.run(
    'UPDATE device_tokens SET last_seen_at = ? WHERE id = ?',
    [now, record.token_id],
  );

  return {
    deviceId: record.device_id,
    device: record,
  };
}

/**
 * Build account snapshot for a device.
 */
async function buildDeviceAccount(db, cfg, deviceId, extra = {}) {
  const device = await db.get('SELECT * FROM devices WHERE id = ?', [deviceId]);
  if (!device) {
    const err = new Error('设备不存在。');
    err.status = 404;
    throw err;
  }

  const membership = await getDeviceMembership(db, cfg, deviceId);
  const trialTotal = Math.max(0, Number(device.trial_uses_total || 0));
  const trialUsed = Math.max(0, Number(device.trial_uses_used || 0));
  const freeCredits = Math.max(0, Number(device.credit_balance || 0));

  return {
    deviceId: device.id,
    displayName: device.display_name,
    platform: device.platform,
    status: device.status,
    trial: {
      total: trialTotal,
      used: trialUsed,
      remaining: Math.max(0, trialTotal - trialUsed),
    },
    membership,
    freeCredits,
    totalAvailable: (membership.active ? membership.creditsRemaining : 0)
      + freeCredits
      + (membership.active ? 0 : Math.max(0, trialTotal - trialUsed)),
    creditBalance: freeCredits,
    paymentProviders: extra.paymentProviders || [],
    paymentMode: cfg.paymentMode,
  };
}

async function getDeviceMembership(db, cfg, deviceId) {
  const record = await db.get(
    'SELECT * FROM device_memberships WHERE device_id = ? LIMIT 1',
    [deviceId],
  );

  if (!record) {
    return {
      active: false,
      creditsTotal: 0,
      creditsUsed: 0,
      creditsRemaining: 0,
    };
  }

  const creditsTotal = Math.max(0, Number(record.credits_total || 0));
  const creditsUsed = Math.max(0, Number(record.credits_used || 0));
  const active = record.status === 'active' && creditsTotal > creditsUsed;

  return {
    active,
    status: active ? 'active' : record.status,
    creditsTotal,
    creditsUsed,
    creditsRemaining: Math.max(0, creditsTotal - creditsUsed),
  };
}

/**
 * Consume trial use for a device.
 */
async function consumeDeviceTrial(db, cfg, deviceId, meta) {
  const updatedAt = nowIso();
  const result = await db.run(
    `UPDATE devices
        SET trial_uses_used = trial_uses_used + 1,
            updated_at = ?
      WHERE id = ?
        AND trial_uses_used < trial_uses_total
        AND status = 'active'`,
    [updatedAt, deviceId],
  );

  if (!result.changes) {
    const err = new Error('免费次数已用完，请购买积分包。');
    err.status = 402;
    throw err;
  }

  await db.run(
    `INSERT INTO usage_logs (user_id, device_id, kind, units, meta_json, created_at)
     VALUES (NULL, ?, 'trial_ai_chat', 1, ?, ?)`,
    [deviceId, JSON.stringify(meta || {}), updatedAt],
  );
}

async function consumeDeviceBalance(db, cfg, deviceId, credits, meta) {
  const safeCredits = Math.max(0.5, Math.round((Number(credits) || 1) * 2) / 2);
  const updatedAt = nowIso();
  const result = await db.run(
    `UPDATE devices
        SET credit_balance = credit_balance - ?,
            updated_at = ?
      WHERE id = ?
        AND credit_balance >= ?
        AND status = 'active'`,
    [safeCredits, updatedAt, deviceId, safeCredits],
  );

  if (!result.changes) {
    const err = new Error('设备积分不足，请充值。');
    err.status = 402;
    throw err;
  }

  await db.run(
    `INSERT INTO usage_logs (user_id, device_id, kind, units, meta_json, created_at)
     VALUES (NULL, ?, 'device_credit_balance', ?, ?, ?)`,
    [deviceId, safeCredits, JSON.stringify(meta || {}), updatedAt],
  );
}

async function refundDeviceTrial(db, cfg, deviceId, meta) {
  const updatedAt = nowIso();
  await db.run(
    `UPDATE devices
        SET trial_uses_used = MAX(0, trial_uses_used - 1),
            updated_at = ?
      WHERE id = ?`,
    [updatedAt, deviceId],
  );
  await db.run(
    `INSERT INTO usage_logs (user_id, device_id, kind, units, meta_json, created_at)
     VALUES (NULL, ?, 'trial_ai_chat_refund', 1, ?, ?)`,
    [deviceId, JSON.stringify(meta || {}), updatedAt],
  );
}

async function refundDeviceBalance(db, cfg, deviceId, credits, meta) {
  const safeCredits = Math.max(0.5, Math.round((Number(credits) || 1) * 2) / 2);
  const updatedAt = nowIso();
  await db.run(
    `UPDATE devices
        SET credit_balance = credit_balance + ?,
            updated_at = ?
      WHERE id = ?`,
    [safeCredits, updatedAt, deviceId],
  );
  await db.run(
    `INSERT INTO usage_logs (user_id, device_id, kind, units, meta_json, created_at)
     VALUES (NULL, ?, 'device_credit_balance_refund', ?, ?, ?)`,
    [deviceId, safeCredits, JSON.stringify(meta || {}), updatedAt],
  );
}

/**
 * Consume credits for a device.
 */
async function consumeDeviceCredits(db, cfg, deviceId, credits, meta) {
  const safeCredits = Math.max(0.5, Math.round((Number(credits) || 1) * 2) / 2);

  const membership = await getDeviceMembership(db, cfg, deviceId);
  if (!membership.active) {
    const err = new Error('无可用积分，请购买积分包。');
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
    `UPDATE device_memberships
        SET credits_used = credits_used + ?,
            updated_at = ?
      WHERE device_id = ?
        AND status = 'active'
        AND (credits_used + ?) <= credits_total`,
    [safeCredits, updatedAt, deviceId, safeCredits],
  );

  if (!result.changes) {
    const err = new Error('积分扣除失败，请重试。');
    err.status = 402;
    throw err;
  }

  await db.run(
    `INSERT INTO usage_logs (user_id, device_id, kind, units, meta_json, created_at)
     VALUES (NULL, ?, 'credits_ai_chat', ?, ?, ?)`,
    [deviceId, safeCredits, JSON.stringify(meta || {}), updatedAt],
  );
}

async function refundDeviceCredits(db, cfg, deviceId, credits, meta) {
  const safeCredits = Math.max(0.5, Math.round((Number(credits) || 1) * 2) / 2);
  const updatedAt = nowIso();
  await db.run(
    `UPDATE device_memberships
        SET credits_used = MAX(0, credits_used - ?),
            updated_at = ?
      WHERE device_id = ?`,
    [safeCredits, updatedAt, deviceId],
  );
  await db.run(
    `INSERT INTO usage_logs (user_id, device_id, kind, units, meta_json, created_at)
     VALUES (NULL, ?, 'credits_ai_chat_refund', ?, ?, ?)`,
    [deviceId, safeCredits, JSON.stringify(meta || {}), updatedAt],
  );
}

/**
 * Add credits to a device (after payment).
 */
async function addDeviceCredits(db, cfg, deviceId, creditsToAdd) {
  const now = nowIso();
  const safeCredits = Math.max(0.5, Math.round((Number(creditsToAdd) || 0) * 2) / 2);

  if (safeCredits <= 0) {
    const err = new Error('增加设备积分失败：积分值无效。');
    err.status = 400;
    throw err;
  }

  await db.run(
    `INSERT INTO device_memberships (device_id, status, credits_total, credits_used, created_at, updated_at)
     VALUES (?, 'active', ?, 0, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET
       status = 'active',
       credits_total = credits_total + ?,
       updated_at = ?`,
    [deviceId, safeCredits, now, now, safeCredits, now],
  );
}

module.exports = {
  registerDevice,
  getDeviceByToken,
  buildDeviceAccount,
  consumeDeviceBalance,
  consumeDeviceTrial,
  refundDeviceTrial,
  refundDeviceBalance,
  consumeDeviceCredits,
  refundDeviceCredits,
  addDeviceCredits,
};
