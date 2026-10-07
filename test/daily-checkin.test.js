'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  BUSINESS_TIME_ZONE,
  DAILY_CHECKIN_CREDITS,
  getBusinessDate,
} = require('../server/utils/business-date');

test('daily check-in uses one credit and the Asia/Shanghai natural day', () => {
  assert.equal(BUSINESS_TIME_ZONE, 'Asia/Shanghai');
  assert.equal(DAILY_CHECKIN_CREDITS, 1);
  assert.equal(getBusinessDate('2026-07-30T15:59:59.000Z'), '2026-07-30');
  assert.equal(getBusinessDate('2026-07-30T16:00:00.000Z'), '2026-07-31');
});

test('daily check-in UI has no seven-day or streak presentation', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'src/renderer/settings/index.html'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'src/renderer/settings/script.js'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');

  assert.doesNotMatch(html, /checkin-week|checkin-day|data-day=/);
  assert.doesNotMatch(script, /checkedDays|currentStreak|querySelectorAll\('\.checkin-day'\)/);
  assert.doesNotMatch(server, /This week's checkin history|weekAgo|currentStreak/);
  assert.match(html, /每个自然日可领取 1 积分/);
});
