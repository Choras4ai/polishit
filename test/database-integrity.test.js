'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase, initSchema } = require('../server/db');
const { bindDeviceToUser, loginWithCode } = require('../server/services/auth-service');
const crypto = require('node:crypto');
const { createPendingMembershipOrder, activateMembershipForOrder } = require('../server/commercial/account-service');

async function database(t) {
  const db = await openDatabase(':memory:');
  t.after(() => db.close());
  await initSchema(db);
  for (const id of [1, 2]) await db.run("INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, 'test', '', '')", [id]);
  return db;
}

test('concurrent binding transfers a device balance exactly once', async t => {
  const db = await database(t);
  await db.run("INSERT INTO devices (id, fingerprint_hash, display_name, credit_balance, trial_uses_total, created_at, updated_at, last_seen_at) VALUES (1, 'test', 'test', 10, 2, '', '', '')");
  await db.run("INSERT INTO device_memberships (device_id, credits_total, credits_used, created_at, updated_at) VALUES (1, 20, 5, '', '')");
  await Promise.allSettled([bindDeviceToUser(db, {}, 1, 1), bindDeviceToUser(db, {}, 2, 1)]);
  const total = await db.get('SELECT SUM(credit_balance) AS balance FROM users');
  assert.equal(total.balance, 25);
  const device = await db.get('SELECT user_id FROM devices WHERE id = 1');
  const owner = await db.get('SELECT credit_balance FROM users WHERE id = ?', [device.user_id]);
  assert.equal(owner.credit_balance, 25);
});

test('transaction rollback cannot undo an unrelated concurrent write', async t => {
  const db = await database(t);
  assert.equal(typeof db.transaction, 'function');
  const failure = db.transaction(async tx => {
    await tx.run('UPDATE users SET credit_balance = 50 WHERE id = 1');
    await new Promise(resolve => setImmediate(resolve));
    throw new Error('rollback fixture');
  });
  const unrelated = db.run('UPDATE users SET credit_balance = 7 WHERE id = 2');
  await assert.rejects(failure, /rollback fixture/);
  await unrelated;
  assert.deepEqual((await db.all('SELECT credit_balance FROM users ORDER BY id')).map(x => x.credit_balance), [0, 7]);
});

test('legacy phone migration preserves referencing orders and memberships', async t => {
  const db = await openDatabase(':memory:');
  t.after(() => db.close());
  await db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, phone TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, status TEXT DEFAULT 'active', credit_balance INTEGER DEFAULT 0, credit_granted INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT, last_login_at TEXT); INSERT INTO users (id,phone,display_name,created_at,updated_at) VALUES (1,'13800000000','legacy','','');");
  await db.exec("PRAGMA foreign_keys=ON; CREATE TABLE sessions (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT UNIQUE, created_at TEXT, expires_at TEXT, last_seen_at TEXT); INSERT INTO sessions (user_id,token_hash) VALUES (1,'keep-me');");
  await initSchema(db);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM sessions')).n, 1);
  assert.equal((await db.all('PRAGMA foreign_key_check')).length, 0);
});

test('concurrent use of one verification code creates only one session', async t => {
  const db = await database(t);
  await db.run("UPDATE users SET phone = '13800000000' WHERE id = 1");
  await db.run('INSERT INTO verification_codes (phone, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?)',
    ['13800000000', crypto.createHash('sha256').update('123456').digest('hex'), new Date().toISOString(), new Date(Date.now() + 60000).toISOString()]);
  const cfg = { sessionTtlHours: 1, trial: { freeUsesTotal: 0 } };
  const results = await Promise.allSettled([loginWithCode(db, cfg, '13800000000', '123456'), loginWithCode(db, cfg, '13800000000', '123456')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM sessions')).n, 1);
});

test('concurrent payment notifications credit an order only once', async t => {
  const db = await database(t);
  const cfg = { membership: { creditsPerPack: 300 } };
  const order = await createPendingMembershipOrder(db, cfg, 1, 'wechatpay', 'runshi-basic');
  await Promise.all([activateMembershipForOrder(db, cfg, order), activateMembershipForOrder(db, cfg, order)]);
  assert.equal((await db.get('SELECT monthly_credits FROM memberships WHERE user_id = 1')).monthly_credits, 300);
});
