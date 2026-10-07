'use strict';

const crypto = require('crypto');

const SCRYPT_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function safeEqual(left, right) {
  return crypto.timingSafeEqual(digest(left), digest(right));
}

function hashAdminPassword(password, salt = crypto.randomBytes(16)) {
  if (typeof password !== 'string' || password.length < 12) {
    throw new Error('管理员密码至少需要 12 个字符');
  }
  const derived = crypto.scryptSync(password, salt, 64, SCRYPT_PARAMS);
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

function verifyAdminPassword(password, encoded) {
  try {
    const [algorithm, n, r, p, salt, expected] = String(encoded || '').split('$');
    if (algorithm !== 'scrypt' || !n || !r || !p || !salt || !expected) return false;
    const derived = crypto.scryptSync(String(password || ''), Buffer.from(salt, 'base64url'), 64, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT_PARAMS.maxmem,
    });
    const expectedBuffer = Buffer.from(expected, 'base64url');
    return derived.length === expectedBuffer.length && crypto.timingSafeEqual(derived, expectedBuffer);
  } catch (_) {
    return false;
  }
}

function verifyAdminCredentials({ username, password, expectedUsername, passwordHash, legacyPassword }) {
  const usernameOk = safeEqual(username || '', expectedUsername || 'admin');
  const passwordOk = passwordHash
    ? verifyAdminPassword(password, passwordHash)
    : safeEqual(password || '', legacyPassword || '');
  return Boolean(usernameOk && passwordOk && (passwordHash || legacyPassword));
}

module.exports = {
  hashAdminPassword,
  safeEqual,
  verifyAdminCredentials,
  verifyAdminPassword,
};
