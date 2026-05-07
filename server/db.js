'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

function openDatabase(filename) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const db = new sqlite3.Database(filename, (err) => {
      if (err) {
        reject(err);
        return;
      }

      resolve({
        raw: db,
        run(sql, params = []) {
          return new Promise((res, rej) => {
            db.run(sql, params, function onRun(runErr) {
              if (runErr) {
                rej(runErr);
                return;
              }
              res({ lastID: this.lastID, changes: this.changes });
            });
          });
        },
        get(sql, params = []) {
          return new Promise((res, rej) => {
            db.get(sql, params, (getErr, row) => {
              if (getErr) {
                rej(getErr);
                return;
              }
              res(row || null);
            });
          });
        },
        all(sql, params = []) {
          return new Promise((res, rej) => {
            db.all(sql, params, (allErr, rows) => {
              if (allErr) {
                rej(allErr);
                return;
              }
              res(rows || []);
            });
          });
        },
        exec(sql) {
          return new Promise((res, rej) => {
            db.exec(sql, (execErr) => {
              if (execErr) {
                rej(execErr);
                return;
              }
              res();
            });
          });
        },
        close() {
          return new Promise((res, rej) => {
            db.close((closeErr) => {
              if (closeErr) {
                rej(closeErr);
                return;
              }
              res();
            });
          });
        },
      });
    });
  });
}

async function initSchema(db) {
  await db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE,
      password_hash TEXT,
      phone TEXT UNIQUE,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      credit_balance INTEGER NOT NULL DEFAULT 0,
      credit_granted INTEGER NOT NULL DEFAULT 0,
      trial_uses_total INTEGER NOT NULL DEFAULT 10,
      trial_uses_used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS verification_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      device_id INTEGER,
      kind TEXT NOT NULL,
      units INTEGER NOT NULL,
      meta_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fingerprint_hash TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'unknown',
      hostname TEXT NOT NULL DEFAULT '',
      credit_balance INTEGER NOT NULL DEFAULT 0,
      credit_granted INTEGER NOT NULL DEFAULT 0,
      trial_uses_total INTEGER NOT NULL DEFAULT 10,
      trial_uses_used INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS device_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS device_memberships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id INTEGER NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      credits_total INTEGER NOT NULL DEFAULT 0,
      credits_used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      credits INTEGER NOT NULL,
      external_order_id TEXT,
      provider_trade_no TEXT,
      checkout_url TEXT,
      checkout_code_url TEXT,
      payload_json TEXT,
      paid_meta_json TEXT,
      created_at TEXT NOT NULL,
      paid_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS memberships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      plan_id TEXT NOT NULL,
      plan_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'inactive',
      price_cents INTEGER NOT NULL DEFAULT 0,
      current_period_start TEXT,
      current_period_end TEXT,
      monthly_quota INTEGER NOT NULL DEFAULT 0,
      monthly_used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  await ensureColumn(db, 'usage_logs', 'device_id', 'INTEGER');
  await ensureColumn(db, 'orders', 'device_id', 'INTEGER');

  // Migrate usage_logs: make user_id nullable by recreating table if needed
  await migrateUsageLogsNullable(db);

  await ensureColumn(db, 'orders', 'plan_id', 'TEXT');
  await ensureColumn(db, 'orders', 'plan_name', 'TEXT');
  await ensureColumn(db, 'orders', 'period_start', 'TEXT');
  await ensureColumn(db, 'orders', 'period_end', 'TEXT');
  await ensureColumn(db, 'users', 'trial_uses_total', 'INTEGER NOT NULL DEFAULT 10');
  await ensureColumn(db, 'users', 'trial_uses_used', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(db, 'orders', 'provider_trade_no', 'TEXT');
  await ensureColumn(db, 'orders', 'checkout_url', 'TEXT');
  await ensureColumn(db, 'orders', 'checkout_code_url', 'TEXT');
  await ensureColumn(db, 'orders', 'payload_json', 'TEXT');
  await ensureColumn(db, 'orders', 'paid_meta_json', 'TEXT');
  await ensureColumn(db, 'memberships', 'monthly_credits', 'INTEGER NOT NULL DEFAULT 300');
  await ensureColumn(db, 'memberships', 'monthly_credits_used', 'INTEGER NOT NULL DEFAULT 0');

  // Email/password auth migration
  await ensureColumn(db, 'users', 'email', 'TEXT');
  await ensureColumn(db, 'users', 'password_hash', 'TEXT');
  // Device → User binding
  await ensureColumn(db, 'devices', 'user_id', 'INTEGER');
  // Make phone nullable (email users don't need phone)
  await migrateUsersPhoneNullable(db);

  // Daily check-in table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS checkins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      checkin_date TEXT NOT NULL,
      streak_day INTEGER NOT NULL DEFAULT 1,
      credits_awarded INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, checkin_date)
    );
  `);
}

async function ensureColumn(db, tableName, columnName, definition) {
  // Validate identifiers to prevent SQL injection
  if (!/^[a-z_]+$/i.test(tableName) || !/^[a-z_]+$/i.test(columnName)) {
    throw new Error(`Invalid table/column name: ${tableName}.${columnName}`);
  }
  const columns = await db.all(`PRAGMA table_info(${tableName})`);
  if (columns.some((column) => column.name === columnName)) {
    return;
  }
  await db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

async function migrateUsageLogsNullable(db) {
  // Check if user_id in usage_logs is NOT NULL — if so, recreate table with nullable user_id
  const columns = await db.all('PRAGMA table_info(usage_logs)');
  const userIdCol = columns.find(c => c.name === 'user_id');
  if (!userIdCol || !userIdCol.notnull) return; // Already nullable or doesn't exist

  await db.exec(`
    CREATE TABLE IF NOT EXISTS usage_logs_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      device_id INTEGER,
      kind TEXT NOT NULL,
      units INTEGER NOT NULL,
      meta_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    INSERT INTO usage_logs_new (id, user_id, device_id, kind, units, meta_json, created_at)
      SELECT id, user_id, device_id, kind, units, meta_json, created_at FROM usage_logs;
    DROP TABLE usage_logs;
    ALTER TABLE usage_logs_new RENAME TO usage_logs;
  `);
  console.log('[db] migrated usage_logs: user_id is now nullable');
}

async function migrateUsersPhoneNullable(db) {
  const columns = await db.all('PRAGMA table_info(users)');
  const phoneCol = columns.find(c => c.name === 'phone');
  if (!phoneCol || !phoneCol.notnull) return;

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE,
      password_hash TEXT,
      phone TEXT UNIQUE,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      credit_balance INTEGER NOT NULL DEFAULT 0,
      credit_granted INTEGER NOT NULL DEFAULT 0,
      trial_uses_total INTEGER NOT NULL DEFAULT 10,
      trial_uses_used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT
    );
    INSERT INTO users_new (id, email, password_hash, phone, display_name, status, credit_balance, credit_granted, trial_uses_total, trial_uses_used, created_at, updated_at, last_login_at)
      SELECT id, email, password_hash, phone, display_name, status, credit_balance, credit_granted, trial_uses_total, trial_uses_used, created_at, updated_at, last_login_at FROM users;
    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;
  `);
  console.log('[db] migrated users: phone is now nullable, email column added');
}

module.exports = { openDatabase, initSchema };
