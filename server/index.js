'use strict';

const express = require('express');
const QRCode = require('qrcode');
const config = require('./config');
const { logger, requestIdMiddleware } = require('./logger');
const { openDatabase, initSchema } = require('./db');
const { getModelList, getModelById } = require('./commercial/models');
const {
  issueVerificationCode,
  loginWithCode,
  registerWithEmail,
  loginWithPassword,
  getSessionUser,
  revokeSession,
  bindDeviceToUser,
} = require('./services/auth-service');
const { estimateMessageUnits } = require('./services/usage-service');
const { resolveUpstreamConfig, resolveModelUpstream, proxyChat } = require('./services/upstream-service');

// Consume from users.credit_balance (check-in / free credits)
async function consumeUserCreditBalance(db, userId, credits, meta) {
  const safeCredits = Math.max(0.5, Math.round((Number(credits) || 1) * 2) / 2);
  const result = await db.run(
    'UPDATE users SET credit_balance = credit_balance - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND credit_balance >= ?',
    [safeCredits, userId, safeCredits],
  );
  if (!result.changes) {
    const err = new Error('积分余额不足。');
    err.status = 402;
    throw err;
  }
  await db.run(
    `INSERT INTO usage_logs (user_id, kind, units, meta_json, created_at)
     VALUES (?, 'credit_balance', ?, ?, CURRENT_TIMESTAMP)`,
    [userId, safeCredits, JSON.stringify(meta || {})],
  );
}

async function refundUserCreditBalance(db, userId, credits, meta) {
  const safeCredits = Math.max(0.5, Math.round((Number(credits) || 1) * 2) / 2);
  await db.run(
    'UPDATE users SET credit_balance = credit_balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [safeCredits, userId],
  );
  await db.run(
    `INSERT INTO usage_logs (user_id, kind, units, meta_json, created_at)
     VALUES (?, 'credit_balance_refund', ?, ?, CURRENT_TIMESTAMP)`,
    [userId, safeCredits, JSON.stringify(meta || {})],
  );
}

const {
  activateMembershipForOrder,
  buildCommercialAccount,
  buildOrderPayload,
  consumeCredits,
  consumeTrialUse,
  createPendingMembershipOrder,
  getMembershipPlans,
  getOrderById,
  getOrderByIdForUser,
  refundCredits,
  refundTrialUse,
  subscribeMembership,
} = require('./commercial/account-service');
const { listPaymentMethods } = require('./commercial/payments');
const alipay = require('./commercial/payments/alipay');
const wechatpay = require('./commercial/payments/wechatpay');

// New modules
const {
  registerDevice,
  getDeviceByToken,
  buildDeviceAccount,
  consumeDeviceBalance,
  consumeDeviceTrial,
  consumeDeviceCredits,
  refundDeviceBalance,
  refundDeviceTrial,
  refundDeviceCredits,
  addDeviceCredits,
} = require('./services/device-service');
const { createRateLimiter, counter } = require('./middleware/rate-limiter');
const { breaker } = require('./middleware/circuit-breaker');
const { costGuard } = require('./middleware/cost-guard');
const { requestQueue } = require('./middleware/request-queue');
const { getChatTimeoutMs } = require('../src/commercial/model-timeouts');
const {
  calculateCreditCharge,
  getCreditPolicy,
  isBillableTextTooLong,
  normalizeBillableChars,
} = require('../src/commercial/credit-policy');
const { mountAdmin } = require('./admin');

function getPaymentProviderIds() {
  return listPaymentMethods(config)
    .filter((provider) => provider.ready)
    .map((provider) => provider.id);
}

function nowIso() {
  return new Date().toISOString();
}

function isLoopbackIp(ip) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(ip || ''));
}

function createBurstGuard({ keyPrefix, limit, windowMs, message, keyFn }) {
  return function burstGuard(req, res, next) {
    const derived = typeof keyFn === 'function'
      ? keyFn(req)
      : (req.ip || req.socket?.remoteAddress || 'unknown');
    const key = `${keyPrefix}:${derived}`;
    const result = counter.check(key, limit, windowMs);
    if (result.allowed) {
      next();
      return;
    }
    res.set('Retry-After', String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
    res.status(429).json({
      ok: false,
      error: message,
      retryAfterMs: result.retryAfterMs,
    });
  };
}

const activeUsageLocks = new Map(); // identity → { timer }
const USAGE_LOCK_TIMEOUT_MS = 30_000; // 30s auto-release safety net

function acquireUsageLock(identity, timeoutMs = USAGE_LOCK_TIMEOUT_MS) {
  if (activeUsageLocks.has(identity)) {
    const err = new Error('当前账户已有任务在处理中，请等待上一条完成后再试。');
    err.status = 429;
    throw err;
  }
  const lockTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Math.round(Number(timeoutMs))
    : USAGE_LOCK_TIMEOUT_MS;
  const timer = setTimeout(() => {
    activeUsageLocks.delete(identity);
    console.warn(`[usage-lock] auto-released stale lock for ${identity}`);
  }, lockTimeoutMs);
  activeUsageLocks.set(identity, { timer });
  return () => {
    const entry = activeUsageLocks.get(identity);
    if (entry) clearTimeout(entry.timer);
    activeUsageLocks.delete(identity);
  };
}

function forceReleaseUsageLock(identity) {
  const entry = activeUsageLocks.get(identity);
  if (entry) {
    clearTimeout(entry.timer);
    activeUsageLocks.delete(identity);
    return true;
  }
  return false;
}

function validatePaidOrder(order, providerId, parsed) {
  if (!order) {
    const err = new Error('订单不存在。');
    err.status = 404;
    throw err;
  }
  if (order.provider !== providerId) {
    const err = new Error('支付通道与订单不匹配。');
    err.status = 400;
    throw err;
  }
  if (Number(order.amount_cents || 0) !== Number(parsed.amountCents || 0)) {
    const err = new Error('支付金额与订单不匹配。');
    err.status = 400;
    throw err;
  }
}

async function reserveQuotaForRequest(params) {
  const {
    db,
    authMode,
    deviceId,
    userId,
    deviceAccount,
    userAccount,
    billingMode,
    creditsToConsume,
    meta,
  } = params;

  if (billingMode === 'none') {
    return async () => {};
  }

  if (authMode === 'device') {
    if (billingMode === 'credits') {
      if (deviceAccount.membership.active && Number(deviceAccount.membership.creditsRemaining || 0) >= creditsToConsume) {
        await consumeDeviceCredits(db, config, deviceId, creditsToConsume, meta);
        return () => refundDeviceCredits(db, config, deviceId, creditsToConsume, meta);
      }
      await consumeDeviceBalance(db, config, deviceId, creditsToConsume, meta);
      return () => refundDeviceBalance(db, config, deviceId, creditsToConsume, meta);
    }
    if (billingMode === 'trial' && !deviceAccount.membership.active) {
      await consumeDeviceTrial(db, config, deviceId, meta);
      return () => refundDeviceTrial(db, config, deviceId, meta);
    }
    return async () => {};
  }

  if (billingMode === 'credits') {
    if (userAccount.membership.active && userAccount.membership.creditsRemaining >= creditsToConsume) {
      await consumeCredits(db, config, userId, creditsToConsume, meta);
      return () => refundCredits(db, config, userId, creditsToConsume, meta);
    }
    await consumeUserCreditBalance(db, userId, creditsToConsume, meta);
    return () => refundUserCreditBalance(db, userId, creditsToConsume, meta);
  }

  if (billingMode === 'trial' && !userAccount.membership.active) {
    await consumeTrialUse(db, config, userId, meta);
    return () => refundTrialUse(db, config, userId, meta);
  }

  return async () => {};
}

async function buildQuotaInfo(db, authMode, deviceId, userId) {
  if (authMode === 'device') {
    const updatedAccount = await buildDeviceAccount(db, config, deviceId, {
      paymentProviders: getPaymentProviderIds(),
    });
    return {
      trial: updatedAccount.trial,
      membership: updatedAccount.membership,
      freeCredits: updatedAccount.freeCredits,
      totalAvailable: updatedAccount.totalAvailable,
    };
  }

  const updatedAccount = await buildCommercialAccount(db, config, userId, {
    paymentProviders: getPaymentProviderIds(),
  });
  return {
    trial: updatedAccount.trial,
    membership: updatedAccount.membership,
    creditBalance: updatedAccount.creditBalance,
    freeCredits: updatedAccount.freeCredits,
    totalAvailable: updatedAccount.totalAvailable,
  };
}

function renderStatusPage(upstream) {
  const providers = listPaymentMethods(config);
  const plans = getMembershipPlans(config);
  const providerRows = providers.length > 0
    ? providers.map((provider) => `<li>${provider.label}: ${provider.ready ? '已配置' : '未配置'}</li>`).join('')
    : '<li>未配置</li>';

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>润石商业后端</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 40px; color: #1d1d1f; }
    .card { max-width: 760px; padding: 24px; border: 1px solid #e5e5ea; border-radius: 14px; background: #fff; }
    h1 { margin: 0 0 12px; font-size: 28px; }
    h2 { margin: 24px 0 8px; font-size: 18px; }
    p, li { line-height: 1.6; color: #3a3a40; }
    code { background: #f5f5f7; padding: 2px 6px; border-radius: 6px; }
    a { color: #007aff; text-decoration: none; }
  </style>
</head>
<body>
  <div class="card">
    <h1>润石 PoliShit 商业后端</h1>
    <p>服务已启动。浏览器能打开这个页面，API 健康检查走 <a href="/api/health"><code>/api/health</code></a>。</p>
    <h2>当前方案</h2>
    <ul>
      <li>新用户初始积分：${config.initialCredits} 分</li>
      <li>默认积分包：${plans[0]?.priceLabel || '9.9 / 300 积分'}</li>
      <li>基础计费：${getCreditPolicy().baseCharsPerCredit} 字 / 1 基础积分</li>
      <li>上游模型：${upstream.source}</li>
      <li>公网回调地址基准：<code>${config.publicBaseUrl}</code></li>
    </ul>
    <h2>支付通道</h2>
    <ul>${providerRows}</ul>
    <h2>回调地址</h2>
    <ul>
      <li>微信支付：<code>${config.publicBaseUrl}${config.wechatPay.notifyPath}</code></li>
      <li>支付宝异步回调：<code>${config.publicBaseUrl}${config.alipay.notifyPath}</code></li>
      <li>支付宝同步返回：<code>${config.publicBaseUrl}${config.alipay.returnPath}</code></li>
    </ul>
    <p>微信/支付宝回调要真正生效，<code>${config.publicBaseUrl}</code> 必须是公网可访问地址，不能继续用 <code>127.0.0.1</code>。</p>
  </div>
</body>
</html>`;
}

function renderCheckoutPage(order, qrDataUrl = '') {
  const statusText = order.status === 'paid' ? '已支付，会员已生效' : '等待支付';
  const payBlock = order.provider === 'wechatpay'
    ? `<div class="qr-wrap">${qrDataUrl ? `<img src="${qrDataUrl}" alt="微信支付二维码">` : '<p>二维码未生成。</p>'}</div>`
    : `<a class="pay-btn" href="${order.checkoutUrl}" target="_blank" rel="noreferrer">前往支付宝支付</a>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>润石会员支付</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 32px; color: #1d1d1f; background: #f5f5f7; }
    .card { max-width: 540px; margin: 0 auto; background: #fff; border: 1px solid #e5e5ea; border-radius: 16px; padding: 24px; }
    h1 { margin: 0 0 8px; font-size: 28px; }
    p { line-height: 1.6; color: #3a3a40; }
    .meta { color: #6e6e73; font-size: 14px; }
    .summary { font-size: 34px; font-weight: 700; margin: 18px 0; }
    .pay-btn { display: inline-block; padding: 12px 18px; background: #1677ff; color: #fff; border-radius: 10px; text-decoration: none; }
    .qr-wrap { margin: 18px 0; text-align: center; }
    .qr-wrap img { width: 240px; height: 240px; }
    .status { margin-top: 18px; padding: 12px; border-radius: 10px; background: #f5f5f7; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${order.planName || '润石会员'}</h1>
    <p class="meta">订单号：${order.id}</p>
    <p class="summary">¥${(Number(order.amountCents || 0) / 100).toFixed(2)}</p>
    <p>${order.provider === 'wechatpay' ? '请使用微信扫码完成支付。' : '点击下方按钮跳转支付宝完成支付。'}</p>
    ${payBlock}
    <div class="status">支付状态：<strong id="status">${statusText}</strong></div>
    <div id="success-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:999;display:none;align-items:center;justify-content:center;">
      <div style="background:#fff;border-radius:20px;padding:48px 36px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.2);">
        <div style="font-size:64px;">✅</div>
        <h2 style="margin:16px 0 8px;">支付成功</h2>
        <p style="color:#6e6e73;">积分已到账，可以关闭此页面。</p>
      </div>
    </div>
    <script>
      const orderId = ${JSON.stringify(order.id)};
      let paid = ${order.status === 'paid' ? 'true' : 'false'};
      function showSuccess() {
        document.getElementById('status').textContent = '已支付，会员已生效';
        const overlay = document.getElementById('success-overlay');
        overlay.style.display = 'flex';
      }
      if (paid) showSuccess();
      async function poll() {
        if (paid) return;
        try {
          const res = await fetch('/api/pay/public/orders/' + encodeURIComponent(orderId));
          const data = await res.json();
          if (data.ok && data.order) {
            if (data.order.status === 'paid') {
              paid = true;
              showSuccess();
            } else {
              document.getElementById('status').textContent = '等待支付';
            }
          }
        } catch (_) {}
      }
      setInterval(poll, 3000);
      poll();
    </script>
  </div>
</body>
</html>`;
}

async function main() {
  const db = await openDatabase(config.dbPath);
  await initSchema(db);

  // Initialize cost guard from DB
  costGuard.dailyLimitYuan = config.costControl.dailyLimitYuan;
  costGuard.monthlyLimitYuan = config.costControl.monthlyLimitYuan;
  costGuard.degradeAtPercent = config.costControl.degradeAtPercent;
  await costGuard.loadFromDb(db);

  // Configure circuit breaker
  breaker.failureThreshold = config.circuitBreaker.failureThreshold;
  breaker.latencyThreshold = config.circuitBreaker.latencyThreshold;
  breaker.openDurationMs = config.circuitBreaker.openDurationMs;

  // Configure request queue
  requestQueue.maxConcurrent = config.requestQueue.maxConcurrent;
  requestQueue.maxQueued = config.requestQueue.maxQueued;
  requestQueue.queueTimeoutMs = config.requestQueue.queueTimeoutMs;

  const app = express();
  app.set('trust proxy', 1);
  const upstream = resolveUpstreamConfig(config);
  const rateLimiter = createRateLimiter(config);
  const deviceRegisterGuard = createBurstGuard({
    keyPrefix: 'device-register',
    limit: 12,
    windowMs: 60 * 60 * 1000,
    message: '设备注册过于频繁，请稍后再试。',
  });
  const authGuard = createBurstGuard({
    keyPrefix: 'auth',
    limit: 20,
    windowMs: 15 * 60 * 1000,
    message: '登录或注册请求过于频繁，请稍后再试。',
  });
  const sendCodeGuard = createBurstGuard({
    keyPrefix: 'send-code',
    limit: 8,
    windowMs: 15 * 60 * 1000,
    message: '验证码请求过于频繁，请稍后再试。',
    keyFn: (req) => `${req.ip || req.socket?.remoteAddress || 'unknown'}:${String(req.body?.phone || '').replace(/\D+/g, '')}`,
  });

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');

    const origin = String(req.headers.origin || '');
    if (origin && config.allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Device-Token');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
    }
    next();
  });

  app.get('/', (_req, res) => {
    res.type('html').send(renderStatusPage(upstream));
  });

  app.get('/pay/alipay/return', (_req, res) => {
    res.type('html').send('<h1 style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:40px;">支付已返回，可以回到润石 PoliShit 刷新会员状态。</h1>');
  });

  app.post('/api/pay/callback/wechat', express.raw({ type: 'application/json' }), async (req, res, next) => {
    try {
      const parsed = wechatpay.verifyAndParseCallback(config, req.headers, req.body.toString('utf8'));
      if (!parsed.paid) {
        res.json({ code: 'SUCCESS', message: '忽略未支付状态' });
        return;
      }
      const order = await getOrderById(db, parsed.orderId);
      if (!order) {
        res.json({ code: 'SUCCESS', message: '订单不存在，已忽略' });
        return;
      }
      validatePaidOrder(order, 'wechatpay', parsed);
      await activateMembershipForOrder(db, config, order, {
        providerTradeNo: parsed.providerTradeNo,
        paidMeta: parsed.resource,
      });
      res.json({ code: 'SUCCESS', message: '成功' });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/pay/callback/alipay', express.urlencoded({ extended: false }), async (req, res, next) => {
    try {
      const parsed = await alipay.verifyAndParseCallback(config, req.body);
      if (!parsed.paid) {
        res.type('text/plain').send('success');
        return;
      }
      const order = await getOrderById(db, parsed.orderId);
      if (!order) {
        res.type('text/plain').send('success');
        return;
      }
      validatePaidOrder(order, 'alipay', parsed);
      await activateMembershipForOrder(db, config, order, {
        providerTradeNo: parsed.providerTradeNo,
        paidMeta: parsed.raw,
      });
      res.type('text/plain').send('success');
    } catch (err) {
      next(err);
    }
  });

  app.use(requestIdMiddleware);
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));

  // Mount admin dashboard
  mountAdmin(app, db, config);

  async function maybeBindAnonymousDeviceToUser(req, userId) {
    const deviceToken = req.headers['x-device-token'];
    if (!deviceToken) return;
    try {
      const deviceResult = await getDeviceByToken(db, deviceToken);
      if (deviceResult?.device && !deviceResult.device.user_id) {
        await bindDeviceToUser(db, config, userId, deviceResult.deviceId);
      }
    } catch (_) {
      // Ignore optional auto-bind failures so login/register remains usable.
    }
  }

  async function buildFreshSessionAccount(userId, sessionExpiresAt = '') {
    return buildCommercialAccount(db, config, userId, {
      sessionExpiresAt,
      paymentProviders: getPaymentProviderIds(),
    });
  }

  // ========== Device auth middleware (optional — extracts deviceId if token present) ==========
  app.use(async (req, _res, next) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const result = await getDeviceByToken(db, authHeader);
        req.deviceId = result.deviceId;
        req.device = result.device;
      } catch (_) {
        // Not a valid device token; might be a user session token — ignore
      }
    }
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'runshi-commercial-server',
      smsProvider: config.smsProvider,
      paymentProviders: listPaymentMethods(config),
      paymentMode: config.paymentMode,
      trialFreeUses: config.trial.freeUsesTotal,
      plans: getMembershipPlans(config),
      publicBaseUrl: config.publicBaseUrl,
      upstreamSource: upstream.source,
      circuitBreaker: breaker.getStatus(),
      costControl: costGuard.getStatus(),
      requestQueue: requestQueue.getStatus(),
    });
  });

  // ========== Device routes (no login required) ==========

  app.post('/api/device/register', deviceRegisterGuard, async (req, res, next) => {
    try {
      const result = await registerDevice(db, config, req.body?.fingerprint, {
        platform: req.body?.platform,
        hostname: req.body?.hostname,
      });
      const account = await buildDeviceAccount(db, config, result.device.id, {
        paymentProviders: getPaymentProviderIds(),
      });
      res.json({
        ok: true,
        token: result.token,
        isNew: result.isNew,
        account,
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/device/me', async (req, res, next) => {
    try {
      if (!req.deviceId) {
        const err = new Error('未绑定设备，请先调用 /api/device/register。');
        err.status = 401;
        throw err;
      }
      const account = await buildDeviceAccount(db, config, req.deviceId, {
        paymentProviders: getPaymentProviderIds(),
      });
      res.json({ ok: true, account });
    } catch (err) {
      next(err);
    }
  });

  // ========== Email auth routes ==========

  app.post('/api/auth/register', authGuard, async (req, res, next) => {
    try {
      const result = await registerWithEmail(
        db, config, req.body?.email, req.body?.password,
        { paymentProviders: getPaymentProviderIds() },
      );
      await maybeBindAnonymousDeviceToUser(req, result.user.userId);
      const user = await buildFreshSessionAccount(result.user.userId, result.user.sessionExpiresAt);

      res.json({ ok: true, token: result.token, user });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/auth/login-email', authGuard, async (req, res, next) => {
    try {
      const result = await loginWithPassword(
        db, config, req.body?.email, req.body?.password,
        { paymentProviders: getPaymentProviderIds() },
      );
      await maybeBindAnonymousDeviceToUser(req, result.user.userId);
      const user = await buildFreshSessionAccount(result.user.userId, result.user.sessionExpiresAt);

      res.json({ ok: true, token: result.token, user });
    } catch (err) {
      next(err);
    }
  });

  // ========== Legacy auth routes (keep for backward compatibility) ==========

  app.post('/api/auth/send-code', sendCodeGuard, async (req, res, next) => {
    try {
      const result = await issueVerificationCode(db, config, req.body?.phone);
      res.json({ ok: true, ...result });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/auth/login', authGuard, async (req, res, next) => {
    try {
      const result = await loginWithCode(
        db,
        config,
        req.body?.phone,
        req.body?.code,
        { paymentProviders: getPaymentProviderIds() },
      );
      await maybeBindAnonymousDeviceToUser(req, result.user.userId);
      const user = await buildFreshSessionAccount(result.user.userId, result.user.sessionExpiresAt);

      res.json({ ok: true, token: result.token, user });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/auth/me', async (req, res, next) => {
    try {
      const session = await getSessionUser(
        db,
        config,
        req.headers.authorization,
        { paymentProviders: getPaymentProviderIds() },
      );
      const user = await buildCommercialAccount(db, config, session.account.userId, {
        sessionExpiresAt: session.account.sessionExpiresAt,
        paymentProviders: getPaymentProviderIds(),
      });
      res.json({ ok: true, user });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/auth/logout', async (req, res, next) => {
    try {
      await revokeSession(db, req.headers.authorization);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // ========== Daily Check-in ==========
  app.post('/api/checkin', async (req, res, next) => {
    try {
      const session = await getSessionUser(db, config, req.headers.authorization);
      const userId = session.account.userId;
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

      // Check if already checked in today
      const existing = await db.get(
        'SELECT id FROM checkins WHERE user_id = ? AND checkin_date = ?',
        [userId, today],
      );
      if (existing) {
        return res.json({ ok: false, error: '今天已经签到过了', alreadyCheckedIn: true });
      }

      const creditsAwarded = 1; // Fixed 1 credit per day

      await db.run(
        'INSERT INTO checkins (user_id, checkin_date, streak_day, credits_awarded, created_at) VALUES (?, ?, ?, ?, ?)',
        [userId, today, 1, creditsAwarded, new Date().toISOString()],
      );

      // Add credits to user
      await db.run(
        'UPDATE users SET credit_balance = credit_balance + ?, updated_at = ? WHERE id = ?',
        [creditsAwarded, new Date().toISOString(), userId],
      );

      // Log it
      await db.run(
        `INSERT INTO usage_logs (user_id, kind, units, meta_json, created_at)
         VALUES (?, 'checkin', ?, ?, ?)`,
        [userId, creditsAwarded, JSON.stringify({ reward: 'daily_checkin' }), new Date().toISOString()],
      );

      res.json({
        ok: true,
        creditsAwarded,
        message: `签到成功！获得 1 积分`,
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/checkin/status', async (req, res, next) => {
    try {
      const session = await getSessionUser(db, config, req.headers.authorization);
      const userId = session.account.userId;
      const today = new Date().toISOString().slice(0, 10);

      const todayCheckin = await db.get(
        'SELECT streak_day, credits_awarded FROM checkins WHERE user_id = ? AND checkin_date = ?',
        [userId, today],
      );

      // This week's checkin history
      const weekAgo = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
      const history = await db.all(
        'SELECT checkin_date, streak_day, credits_awarded FROM checkins WHERE user_id = ? AND checkin_date >= ? ORDER BY checkin_date',
        [userId, weekAgo],
      );

      const checkedDays = history.length;

      res.json({
        ok: true,
        checkedInToday: !!todayCheckin,
        checkedDays,
        currentStreak: checkedDays,
        nextReward: todayCheckin ? null : 1,
        history,
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/membership/plans', (_req, res) => {
    res.json({
      ok: true,
      paymentMode: config.paymentMode,
      trialFreeUses: config.trial.freeUsesTotal,
      plans: getMembershipPlans(config),
      creditPolicy: getCreditPolicy(),
    });
  });

  app.get('/api/models', (_req, res) => {
    res.json({
      ok: true,
      models: getModelList(),
    });
  });

  app.post('/api/membership/subscribe', async (req, res, next) => {
    try {
      // Only allow manual subscribe when paymentMode is 'manual' or from admin/loopback
      if (config.paymentMode !== 'manual' && !isLoopbackIp(req.ip)) {
        const err = new Error('请通过支付通道充值积分。');
        err.status = 403;
        throw err;
      }
      const session = await getSessionUser(
        db,
        config,
        req.headers.authorization,
        { paymentProviders: getPaymentProviderIds() },
      );
      const result = await subscribeMembership(
        db,
        config,
        session.account.userId,
        req.body?.planId || config.membership.defaultPlanId,
      );
      const user = await buildFreshSessionAccount(session.account.userId, session.account.sessionExpiresAt);
      res.json({
        ok: true,
        user,
        order: result.order,
        notice: result.notice,
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/pay/providers', (_req, res) => {
    res.json({
      ok: true,
      providers: listPaymentMethods(config),
      paymentMode: config.paymentMode,
      publicBaseUrl: config.publicBaseUrl,
    });
  });

  app.post('/api/pay/create-order', async (req, res, next) => {
    try {
      const provider = String(req.body?.provider || '').trim();
      const session = await getSessionUser(
        db,
        config,
        req.headers.authorization,
        { paymentProviders: getPaymentProviderIds() },
      );

      if (provider === 'manual') {
        const result = await subscribeMembership(
          db,
          config,
          session.account.userId,
          req.body?.planId || config.membership.defaultPlanId,
        );
        const user = await buildFreshSessionAccount(session.account.userId, session.account.sessionExpiresAt);
        res.json({
          ok: true,
          order: result.order,
          user,
          notice: result.notice,
        });
        return;
      }

      const order = await createPendingMembershipOrder(
        db,
        config,
        session.account.userId,
        provider,
        req.body?.planId || config.membership.defaultPlanId,
      );

      let checkout;
      if (provider === 'alipay') {
        checkout = await alipay.createCheckout(config, order);
      } else if (provider === 'wechatpay') {
        checkout = await wechatpay.createCheckout(config, order);
      } else {
        const err = new Error('不支持的支付通道。');
        err.status = 400;
        throw err;
      }

      await db.run(
        `UPDATE orders
            SET checkout_url = ?,
                checkout_code_url = ?,
                payload_json = ?
          WHERE id = ?`,
        [
          checkout.checkoutUrl || '',
          checkout.checkoutCodeUrl || '',
          JSON.stringify(checkout.payload || {}),
          order.id,
        ],
      );

      const freshOrder = await getOrderById(db, order.id);
      res.json({
        ok: true,
        order: buildOrderPayload(freshOrder),
        checkoutUrl: `${config.publicBaseUrl}/pay/checkout/${freshOrder.id}`,
        notice: provider === 'wechatpay'
          ? '已生成微信支付二维码页面。'
          : '已生成支付宝支付链接。',
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/pay/orders/:id', async (req, res, next) => {
    try {
      const session = await getSessionUser(
        db,
        config,
        req.headers.authorization,
        { paymentProviders: getPaymentProviderIds() },
      );
      const order = await getOrderByIdForUser(db, req.params.id, session.account.userId);
      if (!order) {
        const err = new Error('订单不存在。');
        err.status = 404;
        throw err;
      }
      const user = await buildCommercialAccount(db, config, session.account.userId, {
        sessionExpiresAt: session.account.sessionExpiresAt,
        paymentProviders: getPaymentProviderIds(),
      });
      res.json({
        ok: true,
        order: buildOrderPayload(order),
        user,
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/pay/public/orders/:id', async (req, res, next) => {
    try {
      const order = await getOrderById(db, req.params.id);
      if (!order) {
        const err = new Error('订单不存在。');
        err.status = 404;
        throw err;
      }
      res.json({
        ok: true,
        order: {
          id: order.id,
          status: order.status,
          paidAt: order.paid_at || '',
        },
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/pay/checkout/:id', async (req, res, next) => {
    try {
      const order = await getOrderById(db, req.params.id);
      if (!order) {
        const err = new Error('订单不存在。');
        err.status = 404;
        throw err;
      }
      const payload = buildOrderPayload(order);
      let qrDataUrl = '';
      if (payload.provider === 'wechatpay' && payload.checkoutCodeUrl) {
        qrDataUrl = await QRCode.toDataURL(payload.checkoutCodeUrl, {
          margin: 1,
          width: 280,
        });
      }
      res.type('html').send(renderCheckoutPage(payload, qrDataUrl));
    } catch (err) {
      next(err);
    }
  });

  // ========== Force release usage lock ==========

  app.post('/api/ai/release-lock', async (req, res, next) => {
    try {
      let identity;
      if (req.deviceId) {
        identity = `device:${req.deviceId}`;
      } else {
        const session = await getSessionUser(db, config, req.headers.authorization, {});
        identity = `user:${session.account.userId}`;
      }
      const released = forceReleaseUsageLock(identity);
      res.json({ ok: true, released });
    } catch (err) {
      next(err);
    }
  });

  // ========== AI Chat — with rate limiting, circuit breaker, cost control, request queue ==========

  app.post('/api/ai/chat', rateLimiter, async (req, res, next) => {
    try {
      const messages = Array.isArray(req.body?.messages) ? req.body.messages : null;
      const options = req.body?.options || {};
      const requestedModel = req.body?.model || '';
      if (!messages || messages.length === 0) {
        const err = new Error('messages 不能为空。');
        err.status = 400;
        throw err;
      }

      const inputUnits = estimateMessageUnits(messages);
      const billableChars = normalizeBillableChars(options.billableChars || inputUnits);

      // Determine auth mode: device-based or session-based
      let authMode = 'none';
      let deviceId = null;
      let userId = null;
      let isPaidUser = false;
      let deviceAccount = null;
      let userAccount = null;

      if (req.deviceId) {
        // Device-based auth (no login)
        authMode = 'device';
        deviceId = req.deviceId;
        deviceAccount = await buildDeviceAccount(db, config, deviceId, {
          paymentProviders: getPaymentProviderIds(),
        });
        isPaidUser = deviceAccount.membership.active;
      } else {
        // Try legacy session auth
        try {
          const session = await getSessionUser(
            db, config, req.headers.authorization,
            { paymentProviders: getPaymentProviderIds() },
          );
          authMode = 'session';
          userId = session.account.userId;
          userAccount = await buildCommercialAccount(db, config, userId, {
            sessionExpiresAt: session.account.sessionExpiresAt,
            paymentProviders: getPaymentProviderIds(),
          });
          isPaidUser = userAccount.membership.active;
        } catch (_) {
          const err = new Error('请先注册设备或登录。');
          err.status = 401;
          throw err;
        }
      }

      // ---- Cost control check ----
      const costDecision = costGuard.getDecision(isPaidUser);
      if (!costDecision.allowed) {
        const err = new Error(costDecision.reason);
        err.status = 503;
        throw err;
      }

      // ---- Circuit breaker check ----
      const cbCheck = breaker.canRequest();
      if (!cbCheck.allowed) {
        const err = new Error(cbCheck.reason);
        err.status = 503;
        throw err;
      }

      // ---- Determine upstream model ----
      let chatUpstream;
      let billingMode = 'none';
      let creditsToConsume = 0;
      let modelDef = null;
      let degraded = false;

      if (costDecision.degrade && costDecision.fallbackModel) {
        // Force degraded model
        degraded = true;
        chatUpstream = {
          providerType: 'openai',
          apiUrl: config.siliconflow.apiUrl.replace(/\/+$/, ''),
          apiKey: config.siliconflow.apiKey,
          model: config.degradedModel.model,
          source: 'degraded:cost-control',
          credits: 0, // Free model, no credits charged
        };
        modelDef = config.degradedModel;
      } else if (cbCheck.state === 'half_open') {
        // Use cheapest model for probe
        degraded = true;
        chatUpstream = {
          providerType: 'openai',
          apiUrl: config.siliconflow.apiUrl.replace(/\/+$/, ''),
          apiKey: config.siliconflow.apiKey,
          model: config.degradedModel.model,
          source: 'degraded:circuit-breaker-probe',
          credits: 0,
        };
        modelDef = config.degradedModel;
      } else if (authMode === 'device') {
        const membershipCredits = Number(deviceAccount.membership?.creditsRemaining || 0);
        const freeCredits = Number(deviceAccount.freeCredits || 0);
        const trialRemaining = Number(deviceAccount.trial?.remaining || 0);
        if (requestedModel && config.siliconflow.apiKey) {
          if (isBillableTextTooLong(billableChars)) {
            const err = new Error(`当前托管积分模式单次最多支持 ${getCreditPolicy().maxBillableChars} 字，请分段处理或切换自配 API。`);
            err.status = 400;
            throw err;
          }
          chatUpstream = resolveModelUpstream(config, requestedModel);
          creditsToConsume = calculateCreditCharge({
            billableChars,
            modelCredits: chatUpstream.credits,
          });
          billingMode = creditsToConsume > 0 ? 'credits' : 'none';
          modelDef = getModelById(requestedModel);
          const availableCredits = membershipCredits + freeCredits;
          if (availableCredits < creditsToConsume) {
            const err = new Error(`积分不足（剩余 ${availableCredits}，需要 ${creditsToConsume}），请充值或自配 API。`);
            err.status = 402;
            throw err;
          }
        } else {
          chatUpstream = upstream;
          const standardCharge = calculateCreditCharge({
            billableChars,
            modelCredits: 1,
          });
          const availableCredits = membershipCredits + freeCredits;
          if (availableCredits >= standardCharge && standardCharge > 0) {
            creditsToConsume = standardCharge;
            billingMode = 'credits';
          } else if (!deviceAccount.membership.active && trialRemaining > 0) {
            creditsToConsume = 0;
            billingMode = 'trial';
          } else {
            const err = new Error('积分已用完，请充值或前往 API 配置页自行填写模型。');
            err.status = 402;
            throw err;
          }
        }
      } else {
        // Session-based auth
        const membershipCredits = Number(userAccount.membership?.creditsRemaining || 0);
        const freeCredits = Number(userAccount.freeCredits || 0);
        const trialRemaining = Number(userAccount.trial?.remaining || 0);
        if (requestedModel && config.siliconflow.apiKey) {
          if (isBillableTextTooLong(billableChars)) {
            const err = new Error(`当前托管积分模式单次最多支持 ${getCreditPolicy().maxBillableChars} 字，请分段处理或切换自配 API。`);
            err.status = 400;
            throw err;
          }
          chatUpstream = resolveModelUpstream(config, requestedModel);
          creditsToConsume = calculateCreditCharge({
            billableChars,
            modelCredits: chatUpstream.credits,
          });
          billingMode = creditsToConsume > 0 ? 'credits' : 'none';
          modelDef = getModelById(requestedModel);
          const availableCredits = membershipCredits + freeCredits;
          if (availableCredits < creditsToConsume) {
            const err = new Error(`积分不足（剩余 ${availableCredits}，需要 ${creditsToConsume}），请充值或自配 API。`);
            err.status = 402;
            throw err;
          }
        } else {
          chatUpstream = upstream;
          const standardCharge = calculateCreditCharge({
            billableChars,
            modelCredits: 1,
          });
          const availableCredits = membershipCredits + freeCredits;
          if (availableCredits >= standardCharge && standardCharge > 0) {
            creditsToConsume = standardCharge;
            billingMode = 'credits';
          } else if (!userAccount.membership.active && trialRemaining > 0) {
            creditsToConsume = 0;
            billingMode = 'trial';
          } else {
            const err = new Error('积分已用完，请充值或前往 API 配置页自行填写模型。');
            err.status = 402;
            throw err;
          }
        }
      }

      const usageIdentity = authMode === 'device' ? `device:${deviceId}` : `user:${userId}`;
      const proxyTimeoutMs = getChatTimeoutMs({
        model: chatUpstream.model,
        modelId: chatUpstream.modelId,
        requestedTimeoutMs: options.timeoutMs || options.timeout,
      });
      const lockTimeoutMs = proxyTimeoutMs + (requestQueue.queueTimeoutMs || 30_000) + 15_000;
      const releaseUsageLock = acquireUsageLock(usageIdentity, lockTimeoutMs);
      // ---- Request queue — acquire slot ----
      let release;
      let content;
      let rollbackQuota = async () => {};
      let quotaCommitted = false;
      const startTime = Date.now();
      try {
        const reservationMeta = {
          task: req.body?.task || 'polish',
          billableChars,
          billingMode,
          billingStage: options.billingStage || 'primary',
          inputUnits,
          upstream: chatUpstream.source,
          model: chatUpstream.model,
          credits: billingMode === 'credits' ? creditsToConsume : 0,
          degraded,
        };
        rollbackQuota = await reserveQuotaForRequest({
          db,
          authMode,
          deviceId,
          userId,
          deviceAccount,
          userAccount,
          billingMode,
          creditsToConsume,
          meta: reservationMeta,
        });
        release = await requestQueue.acquire();
        content = await proxyChat(chatUpstream, messages, {
          ...options,
          timeoutMs: proxyTimeoutMs,
        });
        const latencyMs = Date.now() - startTime;
        breaker.recordSuccess(latencyMs);
      } catch (upstreamErr) {
        const latencyMs = Date.now() - startTime;
        breaker.recordFailure(latencyMs);
        if (!quotaCommitted) {
          try {
            await rollbackQuota();
          } catch (refundErr) {
            logger.error({ err: refundErr, requestId: req.id }, 'quota refund failed');
          }
        }
        throw upstreamErr;
      } finally {
        if (typeof release === 'function') {
          release();
        }
        releaseUsageLock();
      }

      // ---- Record cost ----
      const outputUnits = content.length;
      // Rough token estimate: 1 Chinese char ≈ 1.5 tokens, 1 English word ≈ 1 token
      const estInputTokens = Math.ceil(inputUnits * 1.5);
      const estOutputTokens = Math.ceil(outputUnits * 1.5);
      const estimatedCostYuan = modelDef
        ? costGuard.estimateCost(estInputTokens, estOutputTokens, modelDef)
        : 0;
      costGuard.recordCost(estimatedCostYuan);

      const meta = {
        task: req.body?.task || 'polish',
        billableChars,
        billingMode,
        billingStage: options.billingStage || 'primary',
        inputUnits,
        outputUnits,
        totalUnits: inputUnits + outputUnits,
        upstream: chatUpstream.source,
        model: chatUpstream.model,
        credits: billingMode === 'credits' ? creditsToConsume : 0,
        estimatedCostYuan,
        degraded,
      };
      let quotaInfo = {};
      quotaInfo = await buildQuotaInfo(db, authMode, deviceId, userId);
      quotaCommitted = true;

      res.json({
        ok: true,
        content,
        usage: {
          inputUnits,
          outputUnits,
          totalUnits: inputUnits + outputUnits,
          credits: billingMode === 'credits' ? creditsToConsume : 0,
        },
        quota: quotaInfo,
        degraded,
        costInfo: costDecision.reason || undefined,
      });
    } catch (err) {
      next(err);
    }
  });

  app.use((err, _req, res, _next) => {
    const status = Number(err.status) || 500;
    if (status >= 500) {
      (_req.log || logger).error({ err, requestId: _req.id }, 'server error');
    }

    if (_req.path === '/api/pay/callback/alipay') {
      res.status(status).type('text/plain').send('failure');
      return;
    }
    if (_req.path === '/api/pay/callback/wechat') {
      res.status(status).json({ code: 'FAIL', message: err.message || '失败' });
      return;
    }

    const acceptsHtml = String(_req.headers.accept || '').includes('text/html') && !_req.path.startsWith('/api/');
    if (acceptsHtml) {
      res.status(status).type('html').send(`<h1 style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:40px;">${err.message || '服务器内部错误'}</h1>`);
      return;
    }

    res.status(status).json({
      ok: false,
      error: status >= 500 ? '服务器内部错误' : (err.message || '服务器内部错误'),
    });
  });

  const server = app.listen(config.port, config.host, () => {
    logger.info({ host: config.host, port: config.port, db: config.dbPath }, 'server listening');
    logger.info({ sms: config.smsProvider, upstream: upstream.source, payments: getPaymentProviderIds().join(',') || 'none', public: config.publicBaseUrl }, 'server config');
    // Warn if publicBaseUrl is not HTTPS (WeChat Pay requires HTTPS for callbacks)
    if (config.publicBaseUrl && !config.publicBaseUrl.startsWith('https://')) {
      logger.warn('publicBaseUrl is not HTTPS — 微信支付回调要求 HTTPS，生产环境请配置 RUNSHI_PUBLIC_BASE_URL=https://...');
    }
  });

  // 定期清理超过30分钟仍为 pending 的订单
  const pendingCleanupTimer = setInterval(async () => {
    try {
      const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const result = await db.run(
        "UPDATE orders SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE status = 'pending' AND created_at < ?",
        [cutoff],
      );
      if (result.changes > 0) {
        logger.info({ count: result.changes }, 'expired stale pending orders');
      }
    } catch (_e) { /* ignore cleanup errors */ }
  }, 5 * 60 * 1000); // 每5分钟检查一次

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(pendingCleanupTimer);
    logger.info('shutting down gracefully...');
    await new Promise((resolve) => server.close(resolve));
    // Wait for in-flight requests to drain
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await db.close().catch(() => {});
    logger.info('shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, 'boot failed');
  process.exit(1);
});
