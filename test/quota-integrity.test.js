'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase, initSchema } = require('../server/db');
const { registerDevice, getDeviceByToken, buildDeviceAccount } = require('../server/services/device-service');
const { reserveQuotaForRequest } = require('../server/services/quota-service');
const { bindDeviceToUser } = require('../server/services/auth-service');
const config = { trial: { freeUsesTotal: 0 }, initialCredits: 1, deviceTokenTtlDays: 1 };
async function fixture(t) {
  const db = await openDatabase(':memory:'); t.after(() => db.close()); await initSchema(db);
  const { device, token } = await registerDevice(db, config, 'test-device');
  await db.run("INSERT INTO device_memberships (device_id, credits_total, credits_used, created_at, updated_at) VALUES (?, 1, 0, '', '')", [device.id]);
  return { db, deviceId: device.id, token };
}
test('mixed credit sources pay together and refund once to the original sources', async t => {
  const { db, deviceId } = await fixture(t);
  const deviceAccount = await buildDeviceAccount(db, config, deviceId);
  const refund = await reserveQuotaForRequest({ db, config, deviceId, deviceAccount, authMode: 'device', billingMode: 'credits', creditsToConsume: 1.5 });
  assert.equal((await buildDeviceAccount(db, config, deviceId)).totalAvailable, 0.5);
  await Promise.all([refund(), refund()]);
  const restored = await buildDeviceAccount(db, config, deviceId);
  assert.equal(restored.membership.creditsRemaining, 1); assert.equal(restored.freeCredits, 1);
});
test('a failed usage log write rolls back the debit', async t => {
  const { db, deviceId } = await fixture(t);
  const deviceAccount = await buildDeviceAccount(db, config, deviceId);
  await db.exec("CREATE TRIGGER reject_usage BEFORE INSERT ON usage_logs BEGIN SELECT RAISE(ABORT, 'log fixture'); END;");
  await assert.rejects(reserveQuotaForRequest({ db, config, deviceId, deviceAccount, authMode: 'device', billingMode: 'credits', creditsToConsume: 1 }), /log fixture/);
  assert.equal((await buildDeviceAccount(db, config, deviceId)).totalAvailable, 2);
});
test('disabled device tokens cannot authenticate', async t => {
  const { db, deviceId, token } = await fixture(t);
  await db.run("UPDATE devices SET status = 'disabled' WHERE id = ?", [deviceId]);
  await assert.rejects(getDeviceByToken(db, `Bearer ${token}`), { status: 401 });
});

test('refund follows credits transferred to a user while upstream work is pending', async t => {
  const { db, deviceId } = await fixture(t);
  await db.run("INSERT INTO users (id, display_name, created_at, updated_at) VALUES (1, 'fixture', '', '')");
  const refund = await reserveQuotaForRequest({ db, config, deviceId, authMode: 'device', billingMode: 'credits', creditsToConsume: 1.5 });
  await bindDeviceToUser(db, config, 1, deviceId);
  await refund();
  assert.equal((await db.get('SELECT credit_balance FROM users WHERE id = 1')).credit_balance, 2);
  assert.equal((await buildDeviceAccount(db, config, deviceId)).totalAvailable, 0);
});
