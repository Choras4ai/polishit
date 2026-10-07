'use strict';

const crypto = require('crypto');
const { breaker } = require('./middleware/circuit-breaker');
const { costGuard } = require('./middleware/cost-guard');
const { requestQueue } = require('./middleware/request-queue');
const { verifyAdminCredentials, safeEqual } = require('./services/admin-auth-service');

// In-memory admin sessions (simple — resets on server restart)
const adminSessions = new Map();

// Login attempt rate limiting
const loginAttempts = new Map(); // ip -> { count, lastAttempt }
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Mount admin routes on the Express app.
 * Cookie-based login with password protection.
 */
function mountAdmin(app, db, config) {
  const secureCookie = String(config.publicBaseUrl || '').startsWith('https://');
  const cookieName = secureCookie ? '__Host-runshi_admin' : 'runshi_admin';
  const cookieOptions = `Path=/; HttpOnly; SameSite=Strict${secureCookie ? '; Secure' : ''}`;
  const configured = () => Boolean(config.adminPasswordHash || config.adminPassword);

  app.use('/admin', (req, res, next) => {
    res.locals.nonce = crypto.randomBytes(18).toString('base64');
    res.set({
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${res.locals.nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-Robots-Tag': 'noindex, nofollow',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('Origin');
      if (req.get('Sec-Fetch-Site') === 'cross-site' || (origin && origin !== new URL(config.publicBaseUrl).origin)) {
        return res.status(403).json({ ok: false, error: '请求来源无效' });
      }
    }
    next();
  });

  function parseCookies(req) {
    const raw = req.headers.cookie || '';
    const cookies = {};
    raw.split(';').forEach(pair => {
      const [k, ...v] = pair.trim().split('=');
      if (k) {
        try { cookies[k.trim()] = decodeURIComponent(v.join('=')); } catch (_) {}
      }
    });
    return cookies;
  }

  function adminAuth(req, res, next) {
    if (!configured()) {
      res.status(503).type('html').send('<h1 style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:40px;">管理后台未配置密码，已禁用。</h1>');
      return;
    }

    // Check cookie session
    const cookies = parseCookies(req);
    const sessionId = cookies[cookieName];
    if (sessionId && adminSessions.has(sessionId)) {
      const session = adminSessions.get(sessionId);
      if (session.expiresAt > Date.now()) {
        req.adminSession = session;
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !safeEqual(req.get('X-CSRF-Token') || req.body?._csrf || '', session.csrfToken)) {
          return res.status(403).json({ ok: false, error: 'CSRF 校验失败，请刷新管理页面' });
        }
        return next();
      }
      adminSessions.delete(sessionId);
    }

    if (req.path.startsWith('/admin/api/')) return res.status(401).json({ ok: false, error: '请重新登录管理后台' });
    res.redirect('/admin/login');
  }

  // ── Login page ──
  app.get('/admin/login', (_req, res) => {
    if (!configured()) {
      res.status(503).type('html').send('<h1 style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:40px;">管理后台未配置密码，已禁用。</h1>');
      return;
    }
    res.type('html').send(renderLoginPage());
  });

  app.post('/admin/login', (req, res) => {
    if (!configured()) return res.status(503).send('管理后台未配置密码，已禁用。');

    // Rate limit login attempts
    const ip = req.ip || req.socket.remoteAddress;
    const attempts = loginAttempts.get(ip) || { count: 0, lastAttempt: 0 };
    if (attempts.count >= MAX_LOGIN_ATTEMPTS && Date.now() - attempts.lastAttempt < LOGIN_LOCKOUT_MS) {
      const remaining = Math.ceil((LOGIN_LOCKOUT_MS - (Date.now() - attempts.lastAttempt)) / 60000);
      return res.type('html').send(renderLoginPage(`尝试次数过多，请 ${remaining} 分钟后再试`));
    }

    if (!verifyAdminCredentials({
      username: req.body?.username,
      password: req.body?.password,
      expectedUsername: config.adminUsername || 'runshi_admin',
      passwordHash: config.adminPasswordHash,
      legacyPassword: config.adminPassword,
    })) {
      attempts.count += 1;
      attempts.lastAttempt = Date.now();
      loginAttempts.set(ip, attempts);
      return res.type('html').send(renderLoginPage('密码错误，请重试'));
    }

    // Reset attempts on success
    loginAttempts.delete(ip);

    const sessionId = generateSessionId();
    adminSessions.set(sessionId, { expiresAt: Date.now() + 24 * 60 * 60 * 1000, csrfToken: generateSessionId() });

    // Clean old sessions
    for (const [id, s] of adminSessions) {
      if (s.expiresAt <= Date.now()) adminSessions.delete(id);
    }

    res.setHeader('Set-Cookie', `${cookieName}=${sessionId}; ${cookieOptions}; Max-Age=86400`);
    res.redirect('/admin');
  });

  app.post('/admin/logout', adminAuth, (req, res) => {
    const cookies = parseCookies(req);
    if (cookies[cookieName]) adminSessions.delete(cookies[cookieName]);
    res.setHeader('Set-Cookie', `${cookieName}=; ${cookieOptions}; Max-Age=0`);
    res.redirect('/admin/login');
  });

  // ── Admin Dashboard ──
  app.get('/admin', adminAuth, async (req, res) => {
    try {
      const stats = await getStats(db);
      res.type('html').send(renderAdminPage(stats, res.locals.nonce, req.adminSession.csrfToken));
    } catch (err) {
      console.error('[admin] dashboard render failed:', err);
      res.status(500).type('html').send('<h1 style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:40px;">管理后台加载失败，请查看服务器日志。</h1>');
    }
  });

  // ── API: device list ──
  app.get('/admin/api/devices', adminAuth, async (req, res, next) => {
    try {
      const { page, limit, offset, query, likeQuery, status } = getListParams(req, {
        maxLimit: 100,
        statuses: ['active', 'disabled'],
      });
      const where = [];
      const params = [];

      if (status) {
        where.push('d.status = ?');
        params.push(status);
      }
      if (query) {
        where.push(`(
          CAST(d.id AS TEXT) = ? OR
          d.display_name LIKE ? OR
          d.hostname LIKE ? OR
          d.platform LIKE ? OR
          IFNULL(u.email, '') LIKE ? OR
          IFNULL(u.display_name, '') LIKE ?
        )`);
        params.push(query, likeQuery, likeQuery, likeQuery, likeQuery, likeQuery);
      }

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = await db.get(
        `SELECT COUNT(*) AS cnt
           FROM devices d
           LEFT JOIN users u ON u.id = d.user_id
           ${whereSql}`,
        params,
      );
      const devices = await db.all(
        `SELECT d.*, dm.credits_total, dm.credits_used, dm.status AS membership_status,
                u.id AS user_id, u.email AS user_email, u.display_name AS user_display_name
           FROM devices d
           LEFT JOIN device_memberships dm ON dm.device_id = d.id
           LEFT JOIN users u ON u.id = d.user_id
           ${whereSql}
          ORDER BY d.last_seen_at DESC
          LIMIT ? OFFSET ?`,
        params.concat([limit, offset]),
      );

      res.json({ ok: true, total: total.cnt, page, limit, query, status, devices });
    } catch (err) {
      next(err);
    }
  });

  // ── API: user list ──
  app.get('/admin/api/users', adminAuth, async (req, res, next) => {
    try {
      const { page, limit, offset, query, likeQuery, status } = getListParams(req, {
        maxLimit: 100,
        statuses: ['active', 'disabled'],
      });
      const where = [];
      const params = [];

      if (status) {
        where.push('u.status = ?');
        params.push(status);
      }
      if (query) {
        where.push(`(
          CAST(u.id AS TEXT) = ? OR
          IFNULL(u.email, '') LIKE ? OR
          IFNULL(u.phone, '') LIKE ? OR
          IFNULL(u.display_name, '') LIKE ?
        )`);
        params.push(query, likeQuery, likeQuery, likeQuery);
      }

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = await db.get(
        `SELECT COUNT(*) AS cnt
           FROM users u
           ${whereSql}`,
        params,
      );
      const users = await db.all(
        `SELECT u.*, m.plan_name, m.status AS membership_status,
                m.monthly_credits, m.monthly_credits_used,
                COUNT(o.id) AS order_count,
                COALESCE(SUM(CASE WHEN o.status = 'paid' THEN o.amount_cents ELSE 0 END), 0) AS total_paid_cents
           FROM users u
           LEFT JOIN memberships m ON m.user_id = u.id
           LEFT JOIN orders o ON o.user_id = u.id
           ${whereSql}
          GROUP BY u.id
          ORDER BY u.updated_at DESC
          LIMIT ? OFFSET ?`,
        params.concat([limit, offset]),
      );

      res.json({ ok: true, total: total.cnt, page, limit, query, status, users });
    } catch (err) {
      next(err);
    }
  });

  // ── API: orders ──
  app.get('/admin/api/orders', adminAuth, async (req, res, next) => {
    try {
      const { page, limit, offset, query, likeQuery, status } = getListParams(req, {
        maxLimit: 100,
        statuses: ['created', 'pending', 'paid', 'failed', 'cancelled'],
      });
      const where = [];
      const params = [];

      if (status) {
        where.push('o.status = ?');
        params.push(status);
      }
      if (query) {
        where.push(`(
          o.id LIKE ? OR
          IFNULL(o.external_order_id, '') LIKE ? OR
          IFNULL(o.provider_trade_no, '') LIKE ? OR
          IFNULL(u.email, '') LIKE ? OR
          IFNULL(u.display_name, '') LIKE ? OR
          o.provider LIKE ?
        )`);
        params.push(likeQuery, likeQuery, likeQuery, likeQuery, likeQuery, likeQuery);
      }

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = await db.get(
        `SELECT COUNT(*) AS cnt
           FROM orders o
           LEFT JOIN users u ON u.id = o.user_id
           ${whereSql}`,
        params,
      );
      const orders = await db.all(
        `SELECT o.*, u.email AS user_email, u.display_name AS user_display_name
           FROM orders o
           LEFT JOIN users u ON u.id = o.user_id
           ${whereSql}
          ORDER BY o.created_at DESC
          LIMIT ? OFFSET ?`,
        params.concat([limit, offset]),
      );

      res.json({ ok: true, total: total.cnt, page, limit, query, status, orders });
    } catch (err) {
      next(err);
    }
  });

  // ── API: usage logs ──
  app.get('/admin/api/usage', adminAuth, async (req, res, next) => {
    try {
      const { page, limit, offset, query, likeQuery } = getListParams(req, { maxLimit: 200 });
      const kind = String(req.query.kind || '').trim().slice(0, 60);
      const where = [];
      const params = [];

      if (kind) {
        where.push('ul.kind = ?');
        params.push(kind);
      }
      if (query) {
        where.push(`(
          CAST(ul.id AS TEXT) = ? OR
          ul.kind LIKE ? OR
          IFNULL(u.email, '') LIKE ? OR
          IFNULL(u.display_name, '') LIKE ? OR
          IFNULL(d.display_name, '') LIKE ? OR
          IFNULL(d.hostname, '') LIKE ?
        )`);
        params.push(query, likeQuery, likeQuery, likeQuery, likeQuery, likeQuery);
      }

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = await db.get(
        `SELECT COUNT(*) AS cnt
           FROM usage_logs ul
           LEFT JOIN users u ON u.id = ul.user_id
           LEFT JOIN devices d ON d.id = ul.device_id
           ${whereSql}`,
        params,
      );
      const logs = await db.all(
        `SELECT ul.*, u.email AS user_email, u.display_name AS user_display_name,
                d.display_name AS device_display_name, d.hostname AS device_hostname
           FROM usage_logs ul
           LEFT JOIN users u ON u.id = ul.user_id
           LEFT JOIN devices d ON d.id = ul.device_id
           ${whereSql}
          ORDER BY ul.id DESC
          LIMIT ? OFFSET ?`,
        params.concat([limit, offset]),
      );
      res.json({ ok: true, total: total.cnt, page, limit, query, kind, logs });
    } catch (err) {
      next(err);
    }
  });

  // ── API: system status ──
  app.get('/admin/api/status', adminAuth, async (_req, res) => {
    const stats = await getStats(db);
    res.json({ ok: true, ...stats });
  });

  // ── API: change user status ──
  app.post('/admin/api/users/:id/status', adminAuth, async (req, res, next) => {
    try {
      const userId = Number(req.params.id);
      const status = normalizeManagedStatus(req.body?.status);
      const result = await db.run(
        `UPDATE users SET status = ?, updated_at = datetime('now') WHERE id = ?`,
        [status, userId],
      );
      if (!result.changes) {
        return res.status(404).json({ ok: false, error: '用户不存在' });
      }
      if (status !== 'active') {
        await db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
      }
      res.json({ ok: true, status });
    } catch (err) {
      next(err);
    }
  });

  // ── API: change device status ──
  app.post('/admin/api/devices/:id/status', adminAuth, async (req, res, next) => {
    try {
      const deviceId = Number(req.params.id);
      const status = normalizeManagedStatus(req.body?.status);
      const result = await db.run(
        `UPDATE devices SET status = ?, updated_at = datetime('now') WHERE id = ?`,
        [status, deviceId],
      );
      if (!result.changes) {
        return res.status(404).json({ ok: false, error: '设备不存在' });
      }
      if (status !== 'active') {
        await db.run('DELETE FROM device_tokens WHERE device_id = ?', [deviceId]);
      }
      res.json({ ok: true, status });
    } catch (err) {
      next(err);
    }
  });

  // ── API: adjust device credits ──
  app.post('/admin/api/devices/:id/credits', adminAuth, async (req, res, next) => {
    try {
      const deviceId = Number(req.params.id);
      const amount = Number(req.body?.amount);
      if (!Number.isFinite(amount) || amount === 0) {
        return res.status(400).json({ ok: false, error: 'amount 必须为非零数字' });
      }

      if (amount > 0) {
        // Add credits
        const { addDeviceCredits } = require('./services/device-service');
        await addDeviceCredits(db, config, deviceId, amount);
      } else {
        // Subtract credits (admin override)
        await db.run(
          `UPDATE device_memberships
              SET credits_used = MIN(credits_total, credits_used + ?),
                  updated_at = datetime('now')
            WHERE device_id = ?`,
          [Math.abs(amount), deviceId],
        );
      }

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // ── API: adjust device trial ──
  app.post('/admin/api/devices/:id/trial', adminAuth, async (req, res, next) => {
    try {
      const deviceId = Number(req.params.id);
      const total = Number(req.body?.total);
      if (!Number.isFinite(total) || total < 0) {
        return res.status(400).json({ ok: false, error: 'total 必须为非负数字' });
      }
      await db.run(
        'UPDATE devices SET trial_uses_total = ?, updated_at = datetime(\'now\') WHERE id = ?',
        [total, deviceId],
      );
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // ── API: adjust user credits (credit_balance) ──
  app.post('/admin/api/users/:id/credits', adminAuth, async (req, res, next) => {
    try {
      const userId = Number(req.params.id);
      const amount = Number(req.body?.amount);
      if (!Number.isFinite(amount) || amount === 0) {
        return res.status(400).json({ ok: false, error: 'amount 必须为非零数字' });
      }

      const user = await db.get('SELECT id, credit_balance FROM users WHERE id = ?', [userId]);
      if (!user) {
        return res.status(404).json({ ok: false, error: '用户不存在' });
      }

      const safeAmount = Math.max(0.5, Math.round(Math.abs(amount) * 2) / 2);
      const appliedAmount = amount > 0 ? safeAmount : -safeAmount;

      if (appliedAmount > 0) {
        await db.run(
          `UPDATE users SET credit_balance = credit_balance + ?, updated_at = datetime('now') WHERE id = ?`,
          [appliedAmount, userId],
        );
      } else {
        await db.run(
          `UPDATE users SET credit_balance = MAX(0, credit_balance + ?), updated_at = datetime('now') WHERE id = ?`,
          [appliedAmount, userId],
        );
      }

      const updatedUser = await db.get('SELECT credit_balance FROM users WHERE id = ?', [userId]);
      await db.run(
        `INSERT INTO usage_logs (user_id, kind, units, meta_json, created_at)
         VALUES (?, 'admin_credit_adjust', ?, ?, datetime('now'))`,
        [userId, safeAmount, JSON.stringify({ amount: appliedAmount })],
      );

      res.json({ ok: true, creditBalance: updatedUser?.credit_balance || 0 });
    } catch (err) {
      next(err);
    }
  });

  // ── API: reset user password ──
  app.post('/admin/api/users/:id/reset-password', adminAuth, async (req, res, next) => {
    try {
      const userId = Number(req.params.id);
      const newPassword = req.body?.password;
      if (!newPassword || newPassword.length < 6) {
        return res.status(400).json({ ok: false, error: '密码至少6位' });
      }
      const { resetPassword } = require('./services/auth-service');
      await resetPassword(db, config, userId, newPassword);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });
}

async function getStats(db) {
  const deviceCount = await db.get('SELECT COUNT(*) AS cnt FROM devices');
  const userCount = await db.get('SELECT COUNT(*) AS cnt FROM users');
  const todayStart = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
  const todayUsage = await db.get(
    'SELECT COUNT(*) AS cnt FROM usage_logs WHERE created_at >= ?',
    [todayStart],
  );
  const totalUsage = await db.get('SELECT COUNT(*) AS cnt FROM usage_logs');
  const activeDevices = await db.get(
    `SELECT COUNT(*) AS cnt FROM devices WHERE last_seen_at >= datetime('now', '-7 days')`,
  );
  const paidDevices = await db.get(
    `SELECT COUNT(*) AS cnt FROM device_memberships WHERE status = 'active' AND credits_total > credits_used`,
  );

  return {
    deviceCount: deviceCount.cnt,
    userCount: userCount.cnt,
    activeDevices7d: activeDevices.cnt,
    paidDevices: paidDevices.cnt,
    todayUsage: todayUsage.cnt,
    totalUsage: totalUsage.cnt,
    circuitBreaker: breaker.getStatus(),
    costControl: costGuard.getStatus(),
    requestQueue: requestQueue.getStatus(),
  };
}

function getListParams(req, options = {}) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const maxLimit = Math.max(1, Number(options.maxLimit) || 100);
  const limit = Math.min(maxLimit, Math.max(1, Number(req.query.limit) || 50));
  const query = String(req.query.q || '').trim().slice(0, 100);
  let status = String(req.query.status || '').trim().slice(0, 40);
  if (Array.isArray(options.statuses) && status && !options.statuses.includes(status)) {
    status = '';
  }
  return {
    page,
    limit,
    offset: (page - 1) * limit,
    query,
    likeQuery: `%${query}%`,
    status,
  };
}

function normalizeManagedStatus(value) {
  const status = String(value || '').trim();
  if (status !== 'active' && status !== 'disabled') {
    const err = new Error('status 仅支持 active 或 disabled');
    err.status = 400;
    throw err;
  }
  return status;
}

function renderAdminPage(stats, nonce, csrfToken) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>润石管理后台</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f5f7; color: #1d1d1f; }
    .header { background: #1d1d1f; color: #fff; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    .header h1 { font-size: 20px; font-weight: 600; }
    .container { max-width: 1280px; margin: 24px auto; padding: 0 16px; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card { background: #fff; border-radius: 14px; padding: 20px; border: 1px solid #e5e5ea; }
    .card .label { font-size: 13px; color: #86868b; margin-bottom: 4px; }
    .card .value { font-size: 28px; font-weight: 700; }
    .card .sub { font-size: 12px; color: #86868b; margin-top: 4px; }
    .section { background: #fff; border-radius: 14px; border: 1px solid #e5e5ea; margin-bottom: 20px; overflow: hidden; }
    .section-header { padding: 16px 20px; border-bottom: 1px solid #e5e5ea; display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
    .section-header h2 { font-size: 17px; font-weight: 600; }
    .tabs { display: flex; gap: 8px; flex-wrap: wrap; }
    .tab { padding: 6px 14px; border-radius: 8px; border: 1px solid #e5e5ea; background: #fff; cursor: pointer; font-size: 13px; }
    .tab.active { background: #007aff; color: #fff; border-color: #007aff; }
    .toolbar { display: flex; gap: 10px; padding: 14px 20px; border-bottom: 1px solid #f0f0f0; flex-wrap: wrap; align-items: center; }
    .toolbar input, .toolbar select { min-width: 170px; padding: 8px 10px; border: 1px solid #d7d7dc; border-radius: 8px; font-size: 13px; background: #fff; }
    .toolbar .summary { margin-left: auto; color: #86868b; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; padding: 10px 16px; background: #fafafa; color: #86868b; font-weight: 500; border-bottom: 1px solid #e5e5ea; }
    td { padding: 10px 16px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
    tr:hover { background: #fafafa; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; }
    .badge-green { background: #d4edda; color: #155724; }
    .badge-gray { background: #e9ecef; color: #6c757d; }
    .badge-orange { background: #fff3cd; color: #856404; }
    .badge-red { background: #f8d7da; color: #721c24; }
    .status-bar { display: flex; gap: 16px; padding: 16px 20px; flex-wrap: wrap; }
    .status-item { display: flex; align-items: center; gap: 6px; font-size: 13px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; }
    .dot-green { background: #34c759; }
    .dot-red { background: #ff3b30; }
    .dot-orange { background: #ff9500; }
    .btn { padding: 4px 10px; border-radius: 6px; border: 1px solid #e5e5ea; background: #fff; cursor: pointer; font-size: 12px; }
    .btn:hover { background: #f0f0f0; }
    .btn-primary { background: #007aff; color: #fff; border-color: #007aff; }
    .btn-primary:hover { background: #006ae6; }
    .btn-danger { background: #fff5f5; color: #b42318; border-color: #f3c4c4; }
    .btn-danger:hover { background: #fee4e2; }
    .empty { text-align: center; padding: 40px; color: #86868b; }
    .progress-bar { height: 6px; background: #e5e5ea; border-radius: 3px; overflow: hidden; }
    .progress-fill { height: 100%; border-radius: 3px; transition: width 0.3s; }
    .muted { color: #86868b; font-size: 12px; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
    .actions { display: flex; gap: 6px; flex-wrap: wrap; }
  </style>
</head>
<body>
  <div class="header">
    <h1>润石 PoliShit 管理后台</h1>
    <form method="POST" action="/admin/logout"><input type="hidden" name="_csrf" value="${csrfToken}"><button type="submit" class="btn">退出登录</button></form>
  </div>
  <div class="container">
    <div class="cards">
      <div class="card">
        <div class="label">设备总数</div>
        <div class="value" id="stat-devices">${stats.deviceCount}</div>
        <div class="sub">7日活跃: ${stats.activeDevices7d}</div>
      </div>
      <div class="card">
        <div class="label">付费设备</div>
        <div class="value" id="stat-paid">${stats.paidDevices}</div>
        <div class="sub">有可用积分</div>
      </div>
      <div class="card">
        <div class="label">今日调用</div>
        <div class="value" id="stat-today">${stats.todayUsage}</div>
        <div class="sub">累计: ${stats.totalUsage}</div>
      </div>
      <div class="card">
        <div class="label">日成本</div>
        <div class="value">¥${stats.costControl.dailyCost}</div>
        <div class="sub">
          <div class="progress-bar" style="margin-top:4px;">
            <div class="progress-fill" style="width:${Math.min(100, stats.costControl.dailyPercent)}%; background:${stats.costControl.dailyPercent > 80 ? '#ff3b30' : '#34c759'};"></div>
          </div>
          ${stats.costControl.dailyPercent}% / ¥${stats.costControl.dailyLimit}
        </div>
      </div>
      <div class="card">
        <div class="label">月成本</div>
        <div class="value">¥${stats.costControl.monthlyCost}</div>
        <div class="sub">
          <div class="progress-bar" style="margin-top:4px;">
            <div class="progress-fill" style="width:${Math.min(100, stats.costControl.monthlyPercent)}%; background:${stats.costControl.monthlyPercent > 80 ? '#ff3b30' : '#34c759'};"></div>
          </div>
          ${stats.costControl.monthlyPercent}% / ¥${stats.costControl.monthlyLimit}
        </div>
      </div>
      <div class="card">
        <div class="label">熔断器</div>
        <div class="value" style="font-size:20px;">
          <span class="dot ${stats.circuitBreaker.state === 'closed' ? 'dot-green' : stats.circuitBreaker.state === 'open' ? 'dot-red' : 'dot-orange'}"></span>
          ${stats.circuitBreaker.state === 'closed' ? '正常' : stats.circuitBreaker.state === 'open' ? '熔断中' : '恢复探测'}
        </div>
        <div class="sub">失败率: ${stats.circuitBreaker.failureRate}% | 延迟: ${stats.circuitBreaker.avgLatencyMs}ms</div>
      </div>
    </div>

    <div class="section">
      <div class="status-bar">
        <div class="status-item">
          <span class="dot dot-green"></span> 请求队列: ${stats.requestQueue.running}/${stats.requestQueue.maxConcurrent} 并发, ${stats.requestQueue.queued} 排队
        </div>
        <div class="status-item">
          <span class="dot ${stats.circuitBreaker.state === 'closed' ? 'dot-green' : 'dot-red'}"></span>
          熔断器: ${stats.circuitBreaker.totalRequests} 请求, ${stats.circuitBreaker.failures} 失败
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-header">
        <h2>运营控制台</h2>
        <div class="tabs">
          <button class="tab active" data-tab="devices">设备</button>
          <button class="tab" data-tab="users">用户</button>
          <button class="tab" data-tab="orders">订单</button>
          <button class="tab" data-tab="usage">日志</button>
        </div>
      </div>
      <div class="toolbar">
        <input id="search-input" type="search" placeholder="搜索">
        <select id="status-filter"></select>
        <select id="kind-filter" style="display:none;"></select>
        <button class="btn btn-primary" data-action="applyFilters">查询</button>
        <button class="btn" data-action="resetFilters">重置</button>
        <button class="btn" data-action="loadCurrentTab">刷新</button>
        <div class="summary" id="table-summary">正在加载...</div>
      </div>
      <div id="table-container">
        <table id="data-table">
          <thead id="table-head"></thead>
          <tbody id="table-body"></tbody>
        </table>
        <div id="table-empty" class="empty" style="display:none;">暂无数据</div>
      </div>
    </div>
  </div>

  <meta name="csrf-token" content="${csrfToken}">
  <script nonce="${nonce}">
    let currentTab = 'devices';
    let currentPage = 1;
    const filters = { q: '', status: '', kind: '' };
    const statusOptionsByTab = {
      devices: [['', '全部状态'], ['active', '启用'], ['disabled', '停用']],
      users: [['', '全部状态'], ['active', '启用'], ['disabled', '停用']],
      orders: [['', '全部状态'], ['created', '待支付'], ['pending', '处理中'], ['paid', '已支付'], ['failed', '失败'], ['cancelled', '已取消']],
      usage: [],
    };
    const kindOptions = [
      ['', '全部类型'],
      ['admin_credit_adjust', '管理员调账'],
      ['trial_ai_chat', '试用调用'],
      ['device_credit_balance', '设备积分扣减'],
      ['membership_credit', '会员积分扣减'],
      ['refund', '退款/返还'],
    ];

    async function requestJson(path, options = {}) {
      const res = await fetch(path, { ...options, headers: { ...options.headers, 'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]').content } });
      const data = await res.json().catch(() => ({ ok: false, error: '返回不是有效 JSON' }));
      if (!res.ok || !data.ok) {
        throw new Error(data.error || ('请求失败: ' + res.status));
      }
      return data;
    }

    function updateFilterControls() {
      const statusEl = document.getElementById('status-filter');
      const kindEl = document.getElementById('kind-filter');
      const searchEl = document.getElementById('search-input');
      const options = statusOptionsByTab[currentTab] || [];

      if (currentTab === 'usage') {
        statusEl.style.display = 'none';
        kindEl.style.display = '';
        kindEl.innerHTML = kindOptions.map(function(item) {
          return '<option value="' + item[0] + '">' + item[1] + '</option>';
        }).join('');
        kindEl.value = filters.kind;
        searchEl.placeholder = '搜索日志类型、邮箱、设备名';
      } else {
        statusEl.style.display = '';
        kindEl.style.display = 'none';
        statusEl.innerHTML = options.map(function(item) {
          return '<option value="' + item[0] + '">' + item[1] + '</option>';
        }).join('');
        statusEl.value = filters.status;
        searchEl.placeholder = currentTab === 'orders'
          ? '搜索订单号、外部单号、邮箱'
          : currentTab === 'users'
            ? '搜索用户 ID、邮箱、手机号、昵称'
            : '搜索设备 ID、设备名、绑定账号';
      }
      searchEl.value = filters.q;
    }

    function applyFilters() {
      filters.q = document.getElementById('search-input').value.trim();
      filters.status = document.getElementById('status-filter').style.display === 'none'
        ? ''
        : document.getElementById('status-filter').value;
      filters.kind = document.getElementById('kind-filter').style.display === 'none'
        ? ''
        : document.getElementById('kind-filter').value;
      currentPage = 1;
      loadCurrentTab();
    }

    function resetFilters() {
      filters.q = '';
      filters.status = '';
      filters.kind = '';
      currentPage = 1;
      updateFilterControls();
      loadCurrentTab();
    }

    function loadCurrentTab() {
      return loadTab(currentTab, false);
    }

    function renderEmptyState(isEmpty, message) {
      const emptyEl = document.getElementById('table-empty');
      emptyEl.textContent = message || '暂无数据';
      emptyEl.style.display = isEmpty ? '' : 'none';
    }

    function renderStatusBadge(status) {
      if (status === 'active') return '<span class="badge badge-green">启用</span>';
      if (status === 'disabled') return '<span class="badge badge-red">停用</span>';
      return '<span class="badge badge-gray">' + esc(status || '-') + '</span>';
    }

    function renderOrderBadge(status) {
      if (status === 'paid') return '<span class="badge badge-green">已支付</span>';
      if (status === 'pending' || status === 'created') return '<span class="badge badge-orange">' + esc(status) + '</span>';
      if (status === 'failed' || status === 'cancelled') return '<span class="badge badge-red">' + esc(status) + '</span>';
      return '<span class="badge badge-gray">' + esc(status || '-') + '</span>';
    }

    function buildParams() {
      const params = new URLSearchParams({ page: String(currentPage), limit: currentTab === 'usage' ? '100' : '50' });
      if (filters.q) params.set('q', filters.q);
      if (currentTab === 'usage') {
        if (filters.kind) params.set('kind', filters.kind);
      } else if (filters.status) {
        params.set('status', filters.status);
      }
      return params;
    }

    async function loadTab(tab, resetPage) {
      currentTab = tab;
      if (resetPage !== false) currentPage = 1;
      document.querySelectorAll('.tab').forEach(function(node) {
        node.classList.toggle('active', node.dataset.tab === tab);
      });
      updateFilterControls();

      const headEl = document.getElementById('table-head');
      const bodyEl = document.getElementById('table-body');
      const summaryEl = document.getElementById('table-summary');
      summaryEl.textContent = '加载中...';

      try {
        if (tab === 'devices') {
          const data = await requestJson('/admin/api/devices?' + buildParams().toString());
          headEl.innerHTML = '<tr><th>ID</th><th>设备</th><th>绑定账号</th><th>平台</th><th>状态</th><th>试用</th><th>会员积分</th><th>设备积分</th><th>最近活跃</th><th>操作</th></tr>';
          renderEmptyState(data.devices.length === 0);
          summaryEl.textContent = '设备 ' + data.total + ' 台';
          bodyEl.innerHTML = data.devices.map(function(d) {
            const creditsTotal = Number(d.credits_total || 0);
            const creditsUsed = Number(d.credits_used || 0);
            const creditsRemain = Math.max(0, creditsTotal - creditsUsed);
            const accountText = d.user_email || d.user_display_name
              ? esc((d.user_email || '') + (d.user_display_name ? ' / ' + d.user_display_name : ''))
              : '<span class="muted">未绑定</span>';
            const trialRemain = Math.max(0, Number(d.trial_uses_total || 0) - Number(d.trial_uses_used || 0));
            return '<tr>' +
              '<td>' + d.id + '</td>' +
              '<td><div>' + esc(d.display_name) + '</div><div class="muted">' + esc(d.hostname || '-') + '</div></td>' +
              '<td>' + accountText + '</td>' +
              '<td>' + esc(d.platform) + '</td>' +
              '<td>' + renderStatusBadge(d.status) + '</td>' +
              '<td>' + trialRemain + '/' + Number(d.trial_uses_total || 0) + '</td>' +
              '<td><span class="badge ' + (creditsRemain > 0 ? 'badge-green' : 'badge-gray') + '">' + creditsRemain + '/' + creditsTotal + '</span></td>' +
              '<td>' + Number(d.credit_balance || 0) + '</td>' +
              '<td>' + timeAgo(d.last_seen_at) + '</td>' +
              '<td><div class="actions">' +
                '<button class="btn" data-action="adjustDeviceCredits" data-id="' + d.id + '">调积分</button>' +
                '<button class="btn" data-action="setDeviceTrial" data-id="' + d.id + '" data-total="' + Number(d.trial_uses_total || 0) + '">试用额</button>' +
                '<button class="btn ' + (d.status === 'active' ? 'btn-danger' : '') + '" data-action="toggleDeviceStatus" data-id="' + d.id + '" data-status="' + esc(d.status) + '">' + (d.status === 'active' ? '停用' : '启用') + '</button>' +
              '</div></td>' +
            '</tr>';
          }).join('');
          return;
        }

        if (tab === 'users') {
          const data = await requestJson('/admin/api/users?' + buildParams().toString());
          headEl.innerHTML = '<tr><th>ID</th><th>账号</th><th>昵称</th><th>状态</th><th>签到积分</th><th>会员积分</th><th>订单</th><th>最近登录</th><th>更新时间</th><th>操作</th></tr>';
          renderEmptyState(data.users.length === 0);
          summaryEl.textContent = '用户 ' + data.total + ' 个';
          bodyEl.innerHTML = data.users.map(function(u) {
            const creditsTotal = Number(u.monthly_credits || 0);
            const creditsUsed = Number(u.monthly_credits_used || 0);
            const creditsRemain = Math.max(0, creditsTotal - creditsUsed);
            const account = esc(u.email || u.phone || '-');
            return '<tr>' +
              '<td>' + u.id + '</td>' +
              '<td><div>' + account + '</div><div class="muted">' + esc(u.phone || '') + '</div></td>' +
              '<td>' + esc(u.display_name) + '</td>' +
              '<td>' + renderStatusBadge(u.status) + '</td>' +
              '<td>' + Number(u.credit_balance || 0) + '</td>' +
              '<td>' + (u.membership_status === 'active' ? '<span class="badge badge-green">' + creditsRemain + '/' + creditsTotal + '</span>' : '<span class="badge badge-gray">无</span>') + '</td>' +
              '<td>' + Number(u.order_count || 0) + '<div class="muted">¥' + ((Number(u.total_paid_cents || 0)) / 100).toFixed(2) + '</div></td>' +
              '<td>' + timeAgo(u.last_login_at) + '</td>' +
              '<td>' + timeAgo(u.updated_at) + '</td>' +
              '<td><div class="actions">' +
                '<button class="btn" data-action="adjustUserCredits" data-id="' + u.id + '">调积分</button>' +
                '<button class="btn" data-action="resetPw" data-id="' + u.id + '">重置密码</button>' +
                '<button class="btn ' + (u.status === 'active' ? 'btn-danger' : '') + '" data-action="toggleUserStatus" data-id="' + u.id + '" data-status="' + esc(u.status) + '">' + (u.status === 'active' ? '停用' : '启用') + '</button>' +
              '</div></td>' +
            '</tr>';
          }).join('');
          return;
        }

        if (tab === 'orders') {
          const data = await requestJson('/admin/api/orders?' + buildParams().toString());
          headEl.innerHTML = '<tr><th>订单号</th><th>用户</th><th>渠道</th><th>状态</th><th>金额</th><th>积分</th><th>外部单号</th><th>创建时间</th></tr>';
          renderEmptyState(data.orders.length === 0);
          summaryEl.textContent = '订单 ' + data.total + ' 笔';
          bodyEl.innerHTML = data.orders.map(function(o) {
            return '<tr>' +
              '<td><span class="mono">' + esc(o.id) + '</span></td>' +
              '<td><div>' + esc(o.user_email || '-') + '</div><div class="muted">' + esc(o.user_display_name || '') + '</div></td>' +
              '<td>' + esc(o.provider) + '</td>' +
              '<td>' + renderOrderBadge(o.status) + '</td>' +
              '<td>¥' + ((Number(o.amount_cents || 0)) / 100).toFixed(2) + '</td>' +
              '<td>' + Number(o.credits || 0) + '</td>' +
              '<td><span class="mono">' + esc(o.provider_trade_no || o.external_order_id || '-') + '</span></td>' +
              '<td>' + timeAgo(o.created_at) + '</td>' +
            '</tr>';
          }).join('');
          return;
        }

        const data = await requestJson('/admin/api/usage?' + buildParams().toString());
        headEl.innerHTML = '<tr><th>ID</th><th>身份</th><th>类型</th><th>消耗</th><th>详情</th><th>时间</th></tr>';
        renderEmptyState(data.logs.length === 0);
        summaryEl.textContent = '日志 ' + data.total + ' 条';
        bodyEl.innerHTML = data.logs.map(function(log) {
          let meta = {};
          try { meta = JSON.parse(log.meta_json || '{}'); } catch (_) {}
          const identity = log.user_id
            ? (log.user_email || ('用户#' + log.user_id))
            : (log.device_display_name || ('设备#' + log.device_id));
          const detail = meta.model || meta.task || meta.reason || JSON.stringify(meta || {});
          return '<tr>' +
            '<td>' + log.id + '</td>' +
            '<td><div>' + esc(identity || '-') + '</div><div class="muted">' + esc(log.device_hostname || '') + '</div></td>' +
            '<td><span class="badge ' + (String(log.kind || '').includes('trial') ? 'badge-orange' : 'badge-green') + '">' + esc(log.kind) + '</span></td>' +
            '<td>' + Number(log.units || 0) + '</td>' +
            '<td style="max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="' + esc(JSON.stringify(meta)) + '">' + esc(detail) + '</td>' +
            '<td>' + timeAgo(log.created_at) + '</td>' +
          '</tr>';
        }).join('');
      } catch (err) {
        headEl.innerHTML = '';
        bodyEl.innerHTML = '';
        renderEmptyState(true, err.message);
        document.getElementById('table-summary').textContent = '加载失败';
      }
    }

    async function adjustDeviceCredits(deviceId) {
      const input = prompt('请输入设备 #' + deviceId + ' 的积分调整数量（正数增加，负数扣除）：');
      if (input === null) return;
      const amount = Number(input);
      if (!amount || !Number.isFinite(amount)) return alert('请输入有效的非零数字');
      try {
        await requestJson('/admin/api/devices/' + deviceId + '/credits', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount }),
        });
        loadCurrentTab();
      } catch (err) {
        alert('调整失败：' + err.message);
      }
    }

    async function setDeviceTrial(deviceId, currentTotal) {
      const input = prompt('请输入设备 #' + deviceId + ' 的试用总额度：', String(currentTotal || 0));
      if (input === null) return;
      const total = Number(input);
      if (!Number.isFinite(total) || total < 0) return alert('请输入非负数字');
      try {
        await requestJson('/admin/api/devices/' + deviceId + '/trial', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ total }),
        });
        loadCurrentTab();
      } catch (err) {
        alert('设置失败：' + err.message);
      }
    }

    async function toggleDeviceStatus(deviceId, currentStatus) {
      const target = currentStatus === 'active' ? 'disabled' : 'active';
      if (!confirm('确认将设备 #' + deviceId + ' 设置为 ' + (target === 'active' ? '启用' : '停用') + ' 吗？')) return;
      try {
        await requestJson('/admin/api/devices/' + deviceId + '/status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: target }),
        });
        loadCurrentTab();
      } catch (err) {
        alert('操作失败：' + err.message);
      }
    }

    async function adjustUserCredits(userId) {
      const input = prompt('请输入用户 #' + userId + ' 的积分调整数量（正数增加，负数扣除）：');
      if (input === null) return;
      const amount = Number(input);
      if (!amount || !Number.isFinite(amount)) return alert('请输入有效的非零数字');
      try {
        const data = await requestJson('/admin/api/users/' + userId + '/credits', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount }),
        });
        alert('积分已调整，当前余额：' + data.creditBalance);
        loadTab('users', false);
      } catch (err) {
        alert('调整失败：' + err.message);
      }
    }

    async function resetPw(userId) {
      const newPw = prompt('请输入用户 #' + userId + ' 的新密码（至少6位）：');
      if (!newPw || newPw.length < 6) {
        if (newPw !== null) alert('密码至少6位');
        return;
      }
      try {
        await requestJson('/admin/api/users/' + userId + '/reset-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: newPw }),
        });
        alert('密码已重置，用户需重新登录');
      } catch (err) {
        alert('重置失败：' + err.message);
      }
    }

    async function toggleUserStatus(userId, currentStatus) {
      const target = currentStatus === 'active' ? 'disabled' : 'active';
      if (!confirm('确认将用户 #' + userId + ' 设置为 ' + (target === 'active' ? '启用' : '停用') + ' 吗？停用后会立即踢下线。')) return;
      try {
        await requestJson('/admin/api/users/' + userId + '/status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: target }),
        });
        loadTab('users', false);
      } catch (err) {
        alert('操作失败：' + err.message);
      }
    }

    function esc(value) {
      const d = document.createElement('div');
      d.textContent = String(value || '');
      return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function timeAgo(iso) {
      if (!iso) return '-';
      const diff = Date.now() - new Date(iso).getTime();
      if (diff < 60000) return '刚刚';
      if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
      if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
      return Math.floor(diff / 86400000) + '天前';
    }

    setInterval(async function() {
      try {
        const data = await requestJson('/admin/api/status');
        document.getElementById('stat-devices').textContent = data.deviceCount;
        document.getElementById('stat-paid').textContent = data.paidDevices;
        document.getElementById('stat-today').textContent = data.todayUsage;
      } catch (_) {}
    }, 30000);

    document.addEventListener('click', function(event) {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.dataset.tab) return loadTab(button.dataset.tab);
      const actions = { applyFilters, resetFilters, loadCurrentTab, adjustDeviceCredits, adjustUserCredits, resetPw, setDeviceTrial, toggleDeviceStatus, toggleUserStatus };
      const action = actions[button.dataset.action];
      if (Object.hasOwn(actions, button.dataset.action)) action(Number(button.dataset.id), button.dataset.status ?? Number(button.dataset.total));
    });
    loadTab('devices');
  </script>
</body>
</html>`;
}

function renderLoginPage(error = '') {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>管理后台 · 登录</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f5f7; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .login-card { background: #fff; border-radius: 14px; border: 1px solid #e5e5ea; padding: 40px 32px; width: 360px; text-align: center; }
    .login-card h1 { font-size: 22px; margin-bottom: 8px; }
    .login-card p { font-size: 14px; color: #86868b; margin-bottom: 24px; }
    .login-card input { width: 100%; padding: 10px 14px; border: 1px solid #e5e5ea; border-radius: 8px; font-size: 15px; margin-bottom: 16px; }
    .login-card input:focus { outline: none; border-color: #007aff; }
    .login-card button { width: 100%; padding: 10px; border: none; border-radius: 8px; background: #007aff; color: #fff; font-size: 15px; cursor: pointer; }
    .login-card button:hover { background: #006ae6; }
    .error { color: #ff3b30; font-size: 13px; margin-bottom: 12px; }
  </style>
</head>
<body>
  <form class="login-card" method="POST" action="/admin/login">
    <h1>润石管理后台</h1>
    <p>请输入管理员账号和密码</p>
    ${error ? `<div class="error">${error}</div>` : ''}
    <input type="text" name="username" placeholder="管理员账号" autocomplete="username" aria-label="管理员账号" autofocus required>
    <input type="password" name="password" placeholder="管理密码" autocomplete="current-password" aria-label="管理密码" required>
    <button type="submit">登录</button>
  </form>
</body>
</html>`;
}

module.exports = { mountAdmin };
