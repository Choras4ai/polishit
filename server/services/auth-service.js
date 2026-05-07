'use strict';

const crypto = require('crypto');

function nowIso() {
  return new Date().toISOString();
}

function addMinutes(base, minutes) {
  return new Date(base.getTime() + minutes * 60 * 1000).toISOString();
}

function addHours(base, hours) {
  return new Date(base.getTime() + hours * 60 * 60 * 1000).toISOString();
}

function hashValue(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function randomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ---------- Password hashing (scrypt, no native deps) ----------

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(password, salt, 64, (err, derived) => {
      if (err) return reject(err);
      resolve(`${salt}:${derived.toString('hex')}`);
    });
  });
}

function verifyPassword(password, stored) {
  return new Promise((resolve, reject) => {
    const [salt, hash] = stored.split(':');
    crypto.scrypt(password, salt, 64, (err, derived) => {
      if (err) return reject(err);
      resolve(crypto.timingSafeEqual(Buffer.from(hash, 'hex'), derived));
    });
  });
}

// ---------- Email validation ----------

function assertEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 255) {
    const err = new Error('请输入有效的邮箱地址。');
    err.status = 400;
    throw err;
  }
  return normalized;
}

function assertPassword(password) {
  const pwd = String(password || '');
  if (pwd.length < 6 || pwd.length > 128) {
    const err = new Error('密码长度需要 6-128 位。');
    err.status = 400;
    throw err;
  }
  return pwd;
}

function normalizePhone(phone) {
  return String(phone || '').replace(/\D+/g, '');
}

function assertPhone(phone) {
  const normalized = normalizePhone(phone);
  if (!/^1\d{10}$/.test(normalized)) {
    const err = new Error('请输入有效的中国大陆手机号。');
    err.status = 400;
    throw err;
  }
  return normalized;
}

function buildAccountPayload(user, extra = {}) {
  const creditGranted = Number(user.credit_granted || 0);
  const creditBalance = Number(user.credit_balance || 0);
  const userId = Number(user.user_id || user.id || 0) || null;
  const trialTotal = Math.max(0, Number(user.trial_uses_total || 0));
  const trialUsed = Math.max(0, Number(user.trial_uses_used || 0));
  return {
    loggedIn: true,
    userId,
    email: user.email || '',
    phone: user.phone || '',
    displayName: user.display_name,
    trial: {
      total: trialTotal,
      used: trialUsed,
      remaining: Math.max(0, trialTotal - trialUsed),
    },
    creditBalance,
    creditGranted,
    creditUsed: Math.max(0, creditGranted - creditBalance),
    sessionExpiresAt: extra.sessionExpiresAt || '',
    smsProvider: extra.smsProvider || 'mock',
    paymentProviders: extra.paymentProviders || [],
  };
}

async function issueVerificationCode(db, cfg, rawPhone) {
  const phone = assertPhone(rawPhone);
  const latest = await db.get(
    `SELECT created_at
       FROM verification_codes
      WHERE phone = ?
      ORDER BY id DESC
      LIMIT 1`,
    [phone],
  );

  if (latest) {
    const lastTime = Date.parse(latest.created_at);
    if (Number.isFinite(lastTime)) {
      const elapsedSeconds = Math.floor((Date.now() - lastTime) / 1000);
      if (elapsedSeconds < cfg.resendCooldownSeconds) {
        const err = new Error(`请在 ${cfg.resendCooldownSeconds - elapsedSeconds} 秒后再试。`);
        err.status = 429;
        throw err;
      }
    }
  }

  const code = cfg.smsProvider === 'mock'
    ? (cfg.universalTestCode || randomCode())
    : randomCode();
  const now = new Date();
  await db.run(
    `INSERT INTO verification_codes (phone, code_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?)`,
    [phone, hashValue(code), now.toISOString(), addMinutes(now, cfg.codeTtlMinutes)],
  );

  if (cfg.smsProvider === 'mock') {
    console.log(`[runshi-auth] mock code for ${phone}: ${code}`);
  }

  return {
    phone,
    expiresInSeconds: cfg.codeTtlMinutes * 60,
    resendInSeconds: cfg.resendCooldownSeconds,
    devCode: cfg.smsProvider === 'mock' ? code : undefined,
  };
}

async function loginWithCode(db, cfg, rawPhone, code, metadata = {}) {
  const phone = assertPhone(rawPhone);
  const normalizedCode = String(code || '').trim();
  if (!/^\d{6}$/.test(normalizedCode)) {
    const err = new Error('请输入 6 位验证码。');
    err.status = 400;
    throw err;
  }

  const record = await db.get(
    `SELECT *
       FROM verification_codes
      WHERE phone = ?
        AND consumed_at IS NULL
      ORDER BY id DESC
      LIMIT 1`,
    [phone],
  );

  if (!record) {
    const err = new Error('请先获取验证码。');
    err.status = 400;
    throw err;
  }

  if (Date.parse(record.expires_at) < Date.now()) {
    const err = new Error('验证码已过期，请重新获取。');
    err.status = 400;
    throw err;
  }

  if (record.code_hash !== hashValue(normalizedCode)) {
    const err = new Error('验证码错误。');
    err.status = 400;
    throw err;
  }

  const now = new Date();
  await db.run(
    'UPDATE verification_codes SET consumed_at = ? WHERE id = ?',
    [now.toISOString(), record.id],
  );

  let user = await db.get('SELECT * FROM users WHERE phone = ?', [phone]);
  if (!user) {
    const displayName = `润石用户${phone.slice(-4)}`;
    const createdAt = now.toISOString();
    const inserted = await db.run(
      `INSERT INTO users (
        phone, display_name, credit_balance, credit_granted, trial_uses_total, trial_uses_used, created_at, updated_at, last_login_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        phone,
        displayName,
        cfg.initialCredits,
        cfg.initialCredits,
        cfg.trial.freeUsesTotal,
        0,
        createdAt,
        createdAt,
        createdAt,
      ],
    );
    user = await db.get('SELECT * FROM users WHERE id = ?', [inserted.lastID]);
    if (cfg.trial.freeUsesTotal > 0) {
      await db.run(
        `INSERT INTO usage_logs (user_id, kind, units, meta_json, created_at)
         VALUES (?, 'trial_grant', ?, ?, ?)`,
        [
          user.id,
          cfg.trial.freeUsesTotal,
          JSON.stringify({ reason: 'new_user_trial' }),
          createdAt,
        ],
      );
    }
  } else {
    await db.run(
      'UPDATE users SET updated_at = ?, last_login_at = ? WHERE id = ?',
      [now.toISOString(), now.toISOString(), user.id],
    );
    user = await db.get('SELECT * FROM users WHERE id = ?', [user.id]);
  }

  const token = randomToken();
  const expiresAt = addHours(now, cfg.sessionTtlHours);
  await db.run(
    `INSERT INTO sessions (user_id, token_hash, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)`,
    [user.id, hashValue(token), now.toISOString(), expiresAt, now.toISOString()],
  );

  return {
    token,
    user: buildAccountPayload(user, {
      sessionExpiresAt: expiresAt,
      smsProvider: cfg.smsProvider,
      paymentProviders: metadata.paymentProviders || [],
    }),
  };
}

async function getSessionUser(db, cfg, authHeader, metadata = {}) {
  const rawToken = String(authHeader || '').replace(/^Bearer\s+/i, '').trim();
  if (!rawToken) {
    const err = new Error('请先登录商业账户。');
    err.status = 401;
    throw err;
  }

  const session = await db.get(
    `SELECT
        s.id,
        s.user_id,
        s.expires_at,
        s.last_seen_at,
        u.phone,
        u.display_name,
        u.credit_balance,
        u.credit_granted,
        u.trial_uses_total,
        u.trial_uses_used,
        u.status
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
      LIMIT 1`,
    [hashValue(rawToken)],
  );

  if (!session || session.status !== 'active') {
    const err = new Error('登录已失效，请重新登录。');
    err.status = 401;
    throw err;
  }

  if (Date.parse(session.expires_at) < Date.now()) {
    await db.run('DELETE FROM sessions WHERE id = ?', [session.id]);
    const err = new Error('登录已过期，请重新登录。');
    err.status = 401;
    throw err;
  }

  await db.run(
    'UPDATE sessions SET last_seen_at = ? WHERE id = ?',
    [nowIso(), session.id],
  );

  return {
    sessionId: session.id,
    token: rawToken,
    account: buildAccountPayload(session, {
      sessionExpiresAt: session.expires_at,
      smsProvider: cfg.smsProvider,
      paymentProviders: metadata.paymentProviders || [],
    }),
  };
}

async function revokeSession(db, authHeader) {
  const rawToken = String(authHeader || '').replace(/^Bearer\s+/i, '').trim();
  if (!rawToken) return;
  await db.run('DELETE FROM sessions WHERE token_hash = ?', [hashValue(rawToken)]);
}

// ---------- Email + Password auth ----------

async function registerWithEmail(db, cfg, rawEmail, rawPassword, metadata = {}) {
  const email = assertEmail(rawEmail);
  const password = assertPassword(rawPassword);

  const existing = await db.get('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) {
    const err = new Error('该邮箱已注册，请直接登录。');
    err.status = 409;
    throw err;
  }

  const passwordHash = await hashPassword(password);
  const now = new Date();
  const displayName = email.split('@')[0];
  const createdAt = now.toISOString();

  const inserted = await db.run(
    `INSERT INTO users (
      email, password_hash, display_name, credit_balance, credit_granted,
      trial_uses_total, trial_uses_used, created_at, updated_at, last_login_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      email, passwordHash, displayName,
      cfg.initialCredits, cfg.initialCredits,
      cfg.trial.freeUsesTotal, 0,
      createdAt, createdAt, createdAt,
    ],
  );

  const user = await db.get('SELECT * FROM users WHERE id = ?', [inserted.lastID]);

  if (cfg.trial.freeUsesTotal > 0) {
    await db.run(
      `INSERT INTO usage_logs (user_id, kind, units, meta_json, created_at)
       VALUES (?, 'trial_grant', ?, ?, ?)`,
      [user.id, cfg.trial.freeUsesTotal, JSON.stringify({ reason: 'new_user_trial' }), createdAt],
    );
  }

  // Issue session token
  const token = randomToken();
  const expiresAt = addHours(now, cfg.sessionTtlHours);
  await db.run(
    `INSERT INTO sessions (user_id, token_hash, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)`,
    [user.id, hashValue(token), createdAt, expiresAt, createdAt],
  );

  return {
    token,
    user: buildAccountPayload(user, {
      sessionExpiresAt: expiresAt,
      paymentProviders: metadata.paymentProviders || [],
    }),
  };
}

async function loginWithPassword(db, cfg, rawEmail, rawPassword, metadata = {}) {
  const email = assertEmail(rawEmail);
  const password = assertPassword(rawPassword);

  const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
  if (!user || !user.password_hash) {
    const err = new Error('邮箱或密码错误。');
    err.status = 401;
    throw err;
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    const err = new Error('邮箱或密码错误。');
    err.status = 401;
    throw err;
  }

  const now = new Date();
  await db.run(
    'UPDATE users SET updated_at = ?, last_login_at = ? WHERE id = ?',
    [now.toISOString(), now.toISOString(), user.id],
  );

  const token = randomToken();
  const expiresAt = addHours(now, cfg.sessionTtlHours);
  await db.run(
    `INSERT INTO sessions (user_id, token_hash, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)`,
    [user.id, hashValue(token), now.toISOString(), expiresAt, now.toISOString()],
  );

  const updatedUser = await db.get('SELECT * FROM users WHERE id = ?', [user.id]);
  return {
    token,
    user: buildAccountPayload(updatedUser, {
      sessionExpiresAt: expiresAt,
      paymentProviders: metadata.paymentProviders || [],
    }),
  };
}

// ---------- Device → User binding ----------

async function bindDeviceToUser(db, cfg, userId, deviceId) {
  const updatedAt = nowIso();
  const device = await db.get(
    `SELECT id, user_id, credit_balance, credit_granted,
            trial_uses_total, trial_uses_used
       FROM devices
      WHERE id = ?`,
    [deviceId],
  );
  if (!device) {
    const err = new Error('设备不存在。');
    err.status = 404;
    throw err;
  }

  if (device.user_id && Number(device.user_id) !== Number(userId)) {
    const err = new Error('该设备已绑定到其他账户。');
    err.status = 409;
    throw err;
  }

  if (Number(device.user_id) === Number(userId)) {
    return;
  }

  const dm = await db.get(
    'SELECT credits_total, credits_used FROM device_memberships WHERE device_id = ?',
    [deviceId],
  );
  const remainingBalance = Math.max(0, Number(device.credit_balance || 0));
  const remainingCredits = dm
    ? Math.max(0, Number(dm.credits_total || 0) - Number(dm.credits_used || 0))
    : 0;
  const remainingTrial = Math.max(0, Number(device.trial_uses_total || 0) - Number(device.trial_uses_used || 0));

  await db.run(
    `UPDATE devices
        SET user_id = ?,
            credit_balance = 0,
            trial_uses_used = trial_uses_total,
            updated_at = ?
      WHERE id = ?
        AND user_id IS NULL`,
    [userId, updatedAt, deviceId],
  );

  if (remainingBalance > 0) {
    await db.run(
      'UPDATE users SET credit_balance = credit_balance + ?, credit_granted = credit_granted + ?, updated_at = ? WHERE id = ?',
      [remainingBalance, remainingBalance, updatedAt, userId],
    );
  }

  if (remainingCredits > 0) {
    await db.run(
      'UPDATE users SET credit_balance = credit_balance + ?, credit_granted = credit_granted + ?, updated_at = ? WHERE id = ?',
      [remainingCredits, remainingCredits, updatedAt, userId],
    );
    await db.run(
      `UPDATE device_memberships
          SET credits_used = credits_total,
              status = 'transferred',
              updated_at = ?
        WHERE device_id = ?`,
      [updatedAt, deviceId],
    );
  }

  if (remainingTrial > 0) {
    await db.run(
      'UPDATE users SET trial_uses_total = trial_uses_total + ?, updated_at = ? WHERE id = ?',
      [remainingTrial, updatedAt, userId],
    );
  }
}

/**
 * Admin resets a user's password by user ID.
 */
async function resetPassword(db, _cfg, userId, newPassword) {
  const password = assertPassword(newPassword);
  const user = await db.get('SELECT id FROM users WHERE id = ?', [userId]);
  if (!user) {
    const err = new Error('用户不存在');
    err.status = 404;
    throw err;
  }
  const passwordHash = await hashPassword(password);
  await db.run(
    'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?',
    [passwordHash, nowIso(), userId],
  );
  // Revoke all existing sessions so user must re-login
  await db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
}

module.exports = {
  assertPhone,
  assertEmail,
  buildAccountPayload,
  issueVerificationCode,
  loginWithCode,
  registerWithEmail,
  loginWithPassword,
  resetPassword,
  getSessionUser,
  revokeSession,
  bindDeviceToUser,
};
