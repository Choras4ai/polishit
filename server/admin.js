'use strict';

const crypto = require('crypto');
const { breaker } = require('./middleware/circuit-breaker');
const { costGuard } = require('./middleware/cost-guard');
const { requestQueue } = require('./middleware/request-queue');

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

  function parseCookies(req) {
    const raw = req.headers.cookie || '';
    const cookies = {};
    raw.split(';').forEach(pair => {
      const [k, ...v] = pair.trim().split('=');
      if (k) cookies[k.trim()] = decodeURIComponent(v.join('='));
    });
    return cookies;
  }

  function adminAuth(req, res, next) {
    const pw = config.adminPassword;
    if (!pw) {
      res.status(503).type('html').send('<h1 style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:40px;">管理后台未配置密码，已禁用。</h1>');
      return;
    }

    // Check cookie session
    const cookies = parseCookies(req);
    const sessionId = cookies.admin_session;
    if (sessionId && adminSessions.has(sessionId)) {
      const session = adminSessions.get(sessionId);
      if (session.expiresAt > Date.now()) return next();
      adminSessions.delete(sessionId);
    }

    res.redirect('/admin/login');
  }

  // ── Login page ──
  app.get('/admin/login', (_req, res) => {
    if (!config.adminPassword) {
      res.status(503).type('html').send('<h1 style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:40px;">管理后台未配置密码，已禁用。</h1>');
      return;
    }
    res.type('html').send(renderLoginPage());
  });

  app.post('/admin/login', (req, res) => {
    const pw = config.adminPassword;
    if (!pw) return res.redirect('/admin');

    // Rate limit login attempts
    const ip = req.ip || req.socket.remoteAddress;
    const attempts = loginAttempts.get(ip) || { count: 0, lastAttempt: 0 };
    if (attempts.count >= MAX_LOGIN_ATTEMPTS && Date.now() - attempts.lastAttempt < LOGIN_LOCKOUT_MS) {
      const remaining = Math.ceil((LOGIN_LOCKOUT_MS - (Date.now() - attempts.lastAttempt)) / 60000);
      return res.type('html').send(renderLoginPage(`尝试次数过多，请 ${remaining} 分钟后再试`));
    }

    const provided = req.body?.password || '';
    const a = Buffer.from(String(provided));
    const b = Buffer.from(String(pw));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      attempts.count += 1;
      attempts.lastAttempt = Date.now();
      loginAttempts.set(ip, attempts);
      return res.type('html').send(renderLoginPage('密码错误，请重试'));
    }

    // Reset attempts on success
    loginAttempts.delete(ip);

    const sessionId = generateSessionId();
    adminSessions.set(sessionId, { expiresAt: Date.now() + 24 * 60 * 60 * 1000 });

    // Clean old sessions
    for (const [id, s] of adminSessions) {
      if (s.expiresAt <= Date.now()) adminSessions.delete(id);
    }

    res.setHeader('Set-Cookie', `admin_session=${sessionId}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=86400${secureCookie ? '; Secure' : ''}`);
    res.redirect('/admin');
  });

  app.get('/admin/logout', (req, res) => {
    const cookies = parseCookies(req);
    if (cookies.admin_session) adminSessions.delete(cookies.admin_session);
    res.setHeader('Set-Cookie', `admin_session=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0${secureCookie ? '; Secure' : ''}`);
    res.redirect('/admin/login');
  });

  // ── Admin Dashboard ──
  app.get('/admin', adminAuth, async (_req, res) => {
    try {
      const stats = await getStats(db);
      res.type('html').send(renderAdminPage(stats));
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  // ── API: device list ──
  app.get('/admin/api/devices', adminAuth, async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    const total = await db.get('SELECT COUNT(*) AS cnt FROM devices');
    const devices = await db.all(
      `SELECT d.*, dm.credits_total, dm.credits_used, dm.status AS membership_status
       FROM devices d
       LEFT JOIN device_memberships dm ON dm.device_id = d.id
       ORDER BY d.last_seen_at DESC
       LIMIT ? OFFSET ?`,
      [limit, offset],
    );

    res.json({ ok: true, total: total.cnt, page, devices });
  });

  // ── API: user list (legacy) ──
  app.get('/admin/api/users', adminAuth, async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    const total = await db.get('SELECT COUNT(*) AS cnt FROM users');
    const users = await db.all(
      `SELECT u.*, m.plan_name, m.status AS membership_status,
              m.monthly_credits, m.monthly_credits_used
       FROM users u
       LEFT JOIN memberships m ON m.user_id = u.id
       ORDER BY u.updated_at DESC
       LIMIT ? OFFSET ?`,
      [limit, offset],
    );

    res.json({ ok: true, total: total.cnt, page, users });
  });

  // ── API: usage logs ──
  app.get('/admin/api/usage', adminAuth, async (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const logs = await db.all(
      `SELECT * FROM usage_logs ORDER BY id DESC LIMIT ?`,
      [limit],
    );
    res.json({ ok: true, logs });
  });

  // ── API: system status ──
  app.get('/admin/api/status', adminAuth, async (_req, res) => {
    const stats = await getStats(db);
    res.json({ ok: true, ...stats });
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

function renderAdminPage(stats) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>润石管理后台</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f5f7; color: #1d1d1f; }
    .header { background: #1d1d1f; color: #fff; padding: 16px 24px; display: flex; align-items: center; gap: 12px; }
    .header h1 { font-size: 20px; font-weight: 600; }
    .container { max-width: 1200px; margin: 24px auto; padding: 0 16px; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card { background: #fff; border-radius: 14px; padding: 20px; border: 1px solid #e5e5ea; }
    .card .label { font-size: 13px; color: #86868b; margin-bottom: 4px; }
    .card .value { font-size: 28px; font-weight: 700; }
    .card .sub { font-size: 12px; color: #86868b; margin-top: 4px; }
    .section { background: #fff; border-radius: 14px; border: 1px solid #e5e5ea; margin-bottom: 20px; overflow: hidden; }
    .section-header { padding: 16px 20px; border-bottom: 1px solid #e5e5ea; display: flex; justify-content: space-between; align-items: center; }
    .section-header h2 { font-size: 17px; font-weight: 600; }
    .tabs { display: flex; gap: 8px; }
    .tab { padding: 6px 14px; border-radius: 8px; border: 1px solid #e5e5ea; background: #fff; cursor: pointer; font-size: 13px; }
    .tab.active { background: #007aff; color: #fff; border-color: #007aff; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; padding: 10px 16px; background: #fafafa; color: #86868b; font-weight: 500; border-bottom: 1px solid #e5e5ea; }
    td { padding: 10px 16px; border-bottom: 1px solid #f0f0f0; }
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
    .empty { text-align: center; padding: 40px; color: #86868b; }
    .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.3); z-index: 100; justify-content: center; align-items: center; }
    .modal-overlay.show { display: flex; }
    .modal { background: #fff; border-radius: 14px; padding: 24px; min-width: 320px; max-width: 480px; }
    .modal h3 { margin-bottom: 16px; }
    .modal input { width: 100%; padding: 8px 12px; border: 1px solid #e5e5ea; border-radius: 8px; font-size: 14px; margin-bottom: 12px; }
    .modal-actions { display: flex; gap: 8px; justify-content: flex-end; }
    .progress-bar { height: 6px; background: #e5e5ea; border-radius: 3px; overflow: hidden; }
    .progress-fill { height: 100%; border-radius: 3px; transition: width 0.3s; }
  </style>
</head>
<body>
  <div class="header">
    <h1>润石 PoliShit 管理后台</h1>
    <a href="/admin/logout" style="color:#fff; opacity:0.7; font-size:13px; text-decoration:none;">退出登录</a>
  </div>
  <div class="container">
    <!-- Stats Cards -->
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

    <!-- System Status Bar -->
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

    <!-- Device Table -->
    <div class="section">
      <div class="section-header">
        <h2>设备管理</h2>
        <div class="tabs">
          <button class="tab active" onclick="loadTab('devices')">设备</button>
          <button class="tab" onclick="loadTab('users')">用户（旧）</button>
          <button class="tab" onclick="loadTab('usage')">调用日志</button>
        </div>
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

  <!-- Credits Modal -->
  <div class="modal-overlay" id="credits-modal">
    <div class="modal">
      <h3>调整积分</h3>
      <p style="margin-bottom:12px; font-size:13px; color:#86868b;">正数增加积分，负数扣除积分</p>
      <input type="number" id="credits-amount" placeholder="输入积分数量 (如 100 或 -50)">
      <div class="modal-actions">
        <button class="btn" onclick="closeModal()">取消</button>
        <button class="btn btn-primary" onclick="submitCredits()">确认</button>
      </div>
    </div>
  </div>

  <script>
    const pw = new URLSearchParams(location.search).get('pw') || '';
    let currentTab = 'devices';
    let modalDeviceId = null;

    function api(path) {
      return path + (pw ? (path.includes('?') ? '&' : '?') + 'pw=' + encodeURIComponent(pw) : '');
    }

    async function loadTab(tab) {
      currentTab = tab;
      document.querySelectorAll('.tab').forEach((t, i) => {
        t.classList.toggle('active', ['devices','users','usage'][i] === tab);
      });

      const headEl = document.getElementById('table-head');
      const bodyEl = document.getElementById('table-body');
      const emptyEl = document.getElementById('table-empty');

      if (tab === 'devices') {
        const res = await fetch(api('/admin/api/devices'));
        const data = await res.json();
        headEl.innerHTML = '<tr><th>ID</th><th>名称</th><th>平台</th><th>试用</th><th>积分</th><th>状态</th><th>最后活跃</th><th>操作</th></tr>';
        if (data.devices.length === 0) {
          bodyEl.innerHTML = '';
          emptyEl.style.display = '';
          return;
        }
        emptyEl.style.display = 'none';
        bodyEl.innerHTML = data.devices.map(d => {
          const creditsTotal = d.credits_total || 0;
          const creditsUsed = d.credits_used || 0;
          const creditsRemain = Math.max(0, creditsTotal - creditsUsed);
          const hasMembership = d.membership_status === 'active' && creditsRemain > 0;
          return \`<tr>
            <td>\${d.id}</td>
            <td>\${esc(d.display_name)}</td>
            <td>\${esc(d.platform)}</td>
            <td>\${d.trial_uses_used}/\${d.trial_uses_total}</td>
            <td>\${hasMembership ? \`<span class="badge badge-green">\${creditsRemain}/\${creditsTotal}</span>\` : \`<span class="badge badge-gray">0</span>\`}</td>
            <td>\${d.status === 'active' ? '<span class="badge badge-green">活跃</span>' : '<span class="badge badge-gray">' + esc(d.status) + '</span>'}</td>
            <td>\${timeAgo(d.last_seen_at)}</td>
            <td><button class="btn" onclick="openCredits(\${d.id})">调整积分</button></td>
          </tr>\`;
        }).join('');
      } else if (tab === 'users') {
        const res = await fetch(api('/admin/api/users'));
        const data = await res.json();
        headEl.innerHTML = '<tr><th>ID</th><th>邮箱</th><th>昵称</th><th>签到积分</th><th>会员</th><th>会员积分</th><th>更新时间</th><th>操作</th></tr>';
        if (data.users.length === 0) {
          bodyEl.innerHTML = '';
          emptyEl.style.display = '';
          return;
        }
        emptyEl.style.display = 'none';
        bodyEl.innerHTML = data.users.map(u => {
          const creditsTotal = u.monthly_credits || 0;
          const creditsUsed = u.monthly_credits_used || 0;
          return \`<tr>
            <td>\${u.id}</td>
            <td>\${esc(u.email || u.phone || '-')}</td>
            <td>\${esc(u.display_name)}</td>
            <td>\${u.credit_balance || 0}</td>
            <td>\${u.membership_status === 'active' ? '<span class="badge badge-green">活跃</span>' : '<span class="badge badge-gray">无</span>'}</td>
            <td>\${creditsTotal > 0 ? (creditsTotal - creditsUsed) + '/' + creditsTotal : '-'}</td>
            <td>\${timeAgo(u.updated_at)}</td>
            <td><button class="btn" onclick="adjustUserCredits(\${u.id})">调整积分</button> <button class="btn" onclick="resetPw(\${u.id})">重置密码</button></td>
          </tr>\`;
        }).join('');
      } else if (tab === 'usage') {
        const res = await fetch(api('/admin/api/usage?limit=100'));
        const data = await res.json();
        headEl.innerHTML = '<tr><th>ID</th><th>设备/用户</th><th>类型</th><th>消耗</th><th>详情</th><th>时间</th></tr>';
        if (data.logs.length === 0) {
          bodyEl.innerHTML = '';
          emptyEl.style.display = '';
          return;
        }
        emptyEl.style.display = 'none';
        bodyEl.innerHTML = data.logs.map(l => {
          let meta = {};
          try { meta = JSON.parse(l.meta_json || '{}'); } catch(_) {}
          const identity = l.device_id ? '设备#' + l.device_id : (l.user_id ? '用户#' + l.user_id : '-');
          return \`<tr>
            <td>\${l.id}</td>
            <td>\${identity}</td>
            <td><span class="badge \${l.kind.includes('trial') ? 'badge-orange' : 'badge-green'}">\${esc(l.kind)}</span></td>
            <td>\${l.units}</td>
            <td style="max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="\${esc(JSON.stringify(meta))}">\${meta.model || meta.task || '-'}</td>
            <td>\${timeAgo(l.created_at)}</td>
          </tr>\`;
        }).join('');
      }
    }

    function openCredits(deviceId) {
      modalDeviceId = deviceId;
      document.getElementById('credits-amount').value = '';
      document.getElementById('credits-modal').classList.add('show');
    }

    async function adjustUserCredits(userId) {
      const input = prompt('请输入用户 #' + userId + ' 的积分调整数量（正数增加，负数扣除）：');
      if (input === null) return;
      const amount = Number(input);
      if (!amount || !Number.isFinite(amount)) { alert('请输入有效的非零数字'); return; }
      const res = await fetch(api('/admin/api/users/' + userId + '/credits'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount }),
      });
      const data = await res.json();
      if (data.ok) { alert('积分已调整，当前余额：' + data.creditBalance); loadTab('users'); }
      else alert('调整失败：' + (data.error || '未知错误'));
    }

    async function resetPw(userId) {
      const newPw = prompt('请输入用户 #' + userId + ' 的新密码（至少6位）：');
      if (!newPw || newPw.length < 6) { if (newPw !== null) alert('密码至少6位'); return; }
      const res = await fetch(api('/admin/api/users/' + userId + '/reset-password'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: newPw }),
      });
      const data = await res.json();
      if (data.ok) alert('密码已重置，用户需重新登录');
      else alert('重置失败：' + (data.error || '未知错误'));
    }

    function closeModal() {
      document.getElementById('credits-modal').classList.remove('show');
      modalDeviceId = null;
    }

    async function submitCredits() {
      const amount = Number(document.getElementById('credits-amount').value);
      if (!amount) return alert('请输入有效数字');
      await fetch(api('/admin/api/devices/' + modalDeviceId + '/credits'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount }),
      });
      closeModal();
      loadTab('devices');
    }

    function esc(s) {
      const d = document.createElement('div');
      d.textContent = String(s || '');
      return d.innerHTML;
    }

    function timeAgo(iso) {
      if (!iso) return '-';
      const diff = Date.now() - new Date(iso).getTime();
      if (diff < 60000) return '刚刚';
      if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
      if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
      return Math.floor(diff / 86400000) + '天前';
    }

    // Auto-refresh stats every 30s
    setInterval(async () => {
      try {
        const res = await fetch(api('/admin/api/status'));
        const data = await res.json();
        if (data.ok) {
          document.getElementById('stat-devices').textContent = data.deviceCount;
          document.getElementById('stat-paid').textContent = data.paidDevices;
          document.getElementById('stat-today').textContent = data.todayUsage;
        }
      } catch(_) {}
    }, 30000);

    // Load initial tab
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
    <p>请输入管理密码</p>
    ${error ? `<div class="error">${error}</div>` : ''}
    <input type="password" name="password" placeholder="管理密码" autofocus required>
    <button type="submit">登录</button>
  </form>
</body>
</html>`;
}

module.exports = { mountAdmin };
