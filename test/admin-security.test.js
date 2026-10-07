'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  hashAdminPassword,
  verifyAdminCredentials,
  verifyAdminPassword,
} = require('../server/services/admin-auth-service');

test('admin credentials use scrypt and constant-time comparisons', () => {
  const password = 'A-strong-production-admin-password';
  const hash = hashAdminPassword(password, crypto.randomBytes(16));
  assert.match(hash, /^scrypt\$16384\$8\$1\$/);
  assert.equal(verifyAdminPassword(password, hash), true);
  assert.equal(verifyAdminPassword('incorrect-password', hash), false);
  assert.equal(verifyAdminCredentials({
    username: 'runshi_admin',
    password,
    expectedUsername: 'runshi_admin',
    passwordHash: hash,
  }), true);
  assert.equal(verifyAdminCredentials({
    username: 'attacker',
    password,
    expectedUsername: 'runshi_admin',
    passwordHash: hash,
  }), false);
});

test('admin surface requires CSRF and strict browser protections', () => {
  const admin = fs.readFileSync(path.join(__dirname, '..', 'server', 'admin.js'), 'utf8');
  const nginx = fs.readFileSync(path.join(__dirname, '..', 'server', 'deploy', 'nginx-runshi.conf'), 'utf8');
  assert.match(admin, /__Host-runshi_admin/);
  assert.match(admin, /X-CSRF-Token/);
  assert.match(admin, /Content-Security-Policy/);
  assert.match(admin, /X-Robots-Tag/);
  assert.doesNotMatch(admin, /onclick=/);
  assert.match(nginx, /location \^~ \/admin\//);
  assert.match(nginx, /Strict-Transport-Security/);
});
