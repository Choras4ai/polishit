'use strict';

function estimateMessageUnits(messages) {
  let total = 0;
  for (const message of messages || []) {
    const content = message?.content;
    if (typeof content === 'string') {
      total += content.length;
    } else if (Array.isArray(content)) {
      total += content
        .map(item => (typeof item?.text === 'string' ? item.text.length : 0))
        .reduce((sum, value) => sum + value, 0);
    }
  }
  return total;
}

async function consumeCredits(db, userId, units, meta) {
  const safeUnits = Math.max(0, Math.ceil(Number(units) || 0));
  if (safeUnits <= 0) return;

  const result = await db.run(
    'UPDATE users SET credit_balance = credit_balance - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND credit_balance >= ?',
    [safeUnits, userId, safeUnits],
  );
  if (!result.changes) {
    const err = new Error('积分余额不足。');
    err.status = 402;
    throw err;
  }

  await db.run(
    `INSERT INTO usage_logs (user_id, kind, units, meta_json, created_at)
     VALUES (?, 'ai_chat', ?, ?, CURRENT_TIMESTAMP)`,
    [userId, safeUnits, JSON.stringify(meta || {})],
  );
}

async function getAccountSnapshot(db, userId) {
  return db.get(
    'SELECT id, phone, display_name, credit_balance, credit_granted FROM users WHERE id = ?',
    [userId],
  );
}

module.exports = {
  estimateMessageUnits,
  consumeCredits,
  getAccountSnapshot,
};
