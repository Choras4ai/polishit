'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENV_FILES = [
  path.join(ROOT, '.env'),
  path.join(__dirname, '.env'),
];
if (process.env.RUNSHI_LOAD_DOTENV !== '0') {
  const envFile = ENV_FILES.find(filePath => fs.existsSync(filePath));
  if (envFile) require('dotenv').config({ path: envFile, quiet: true });
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function booleanFromEnv(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

const host = process.env.RUNSHI_SERVER_HOST || '127.0.0.1';
const isProduction = process.env.NODE_ENV === 'production' || !['127.0.0.1', 'localhost', '::1'].includes(host);

module.exports = {
  isProduction,
  host: process.env.RUNSHI_SERVER_HOST || '127.0.0.1',
  trustProxy: process.env.RUNSHI_TRUST_PROXY || 'loopback',
  port: numberFromEnv('RUNSHI_SERVER_PORT', 8787),
  adminUsername: process.env.RUNSHI_ADMIN_USERNAME || 'runshi_admin',
  adminPasswordHash: process.env.RUNSHI_ADMIN_PASSWORD_HASH || '',
  // Kept only for local/backward compatibility. Production should use the scrypt hash above.
  adminPassword: process.env.RUNSHI_ADMIN_PASSWORD || '',
  dbPath: process.env.RUNSHI_SERVER_DB || path.join(ROOT, 'data', 'commercial.sqlite3'),
  publicBaseUrl: (process.env.RUNSHI_PUBLIC_BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, ''),
  allowedOrigins: (process.env.RUNSHI_ALLOWED_ORIGINS || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean),
  smsProvider: process.env.RUNSHI_SMS_PROVIDER || (isProduction ? 'disabled' : 'mock'),
  universalTestCode: process.env.RUNSHI_TEST_CODE || '',
  codeTtlMinutes: numberFromEnv('RUNSHI_CODE_TTL_MINUTES', 5),
  resendCooldownSeconds: numberFromEnv('RUNSHI_CODE_RESEND_SECONDS', 60),
  sessionTtlHours: numberFromEnv('RUNSHI_SESSION_TTL_HOURS', 24 * 30),
  initialCredits: numberFromEnv('RUNSHI_INITIAL_CREDITS', 5),
  trial: {
    freeUsesTotal: numberFromEnv('RUNSHI_TRIAL_FREE_USES', 0),
  },
  paymentMode: process.env.RUNSHI_PAYMENT_MODE || (isProduction ? 'online' : 'manual'),
  membership: {
    defaultPlanId: process.env.RUNSHI_MEMBERSHIP_PLAN_ID || 'runshi-basic',
    planName: process.env.RUNSHI_MEMBERSHIP_PLAN_NAME || '基础积分包',
    priceCents: numberFromEnv('RUNSHI_MEMBERSHIP_PRICE_CENTS', 990),
    monthlyQuota: numberFromEnv('RUNSHI_MEMBERSHIP_MONTHLY_QUOTA', 500000),
    creditsPerPack: numberFromEnv('RUNSHI_CREDITS_PER_PACK', 300),
  },
  siliconflow: {
    apiKey: process.env.RUNSHI_SILICONFLOW_API_KEY || '',
    apiUrl: process.env.RUNSHI_SILICONFLOW_API_URL || 'https://api.siliconflow.cn/v1',
  },
  deviceTokenTtlDays: numberFromEnv('RUNSHI_DEVICE_TOKEN_TTL_DAYS', 365),
  rateLimit: {
    perDevicePerMinute: numberFromEnv('RUNSHI_RATE_DEVICE_PER_MIN', 20),
    perDevicePerDay: numberFromEnv('RUNSHI_RATE_DEVICE_PER_DAY', 500),
    globalQps: numberFromEnv('RUNSHI_RATE_GLOBAL_QPS', 400),
  },
  circuitBreaker: {
    failureThreshold: numberFromEnv('RUNSHI_CB_FAILURE_THRESHOLD', 0.1),
    latencyThreshold: numberFromEnv('RUNSHI_CB_LATENCY_THRESHOLD', 5000),
    openDurationMs: numberFromEnv('RUNSHI_CB_OPEN_DURATION_MS', 60000),
  },
  costControl: {
    dailyLimitYuan: numberFromEnv('RUNSHI_COST_DAILY_LIMIT', 500),
    monthlyLimitYuan: numberFromEnv('RUNSHI_COST_MONTHLY_LIMIT', 10000),
    degradeAtPercent: numberFromEnv('RUNSHI_COST_DEGRADE_PERCENT', 80),
  },
  requestQueue: {
    maxConcurrent: numberFromEnv('RUNSHI_QUEUE_MAX_CONCURRENT', 50),
    maxQueued: numberFromEnv('RUNSHI_QUEUE_MAX_QUEUED', 200),
    queueTimeoutMs: numberFromEnv('RUNSHI_QUEUE_TIMEOUT_MS', 30000),
  },
  degradedModel: {
    id: 'qwen3-8b',
    model: process.env.RUNSHI_DEGRADED_MODEL || 'Qwen/Qwen3-8B',
    inputPrice: 0,
    outputPrice: 0,
  },
  wechatPay: {
    appId: process.env.RUNSHI_WECHATPAY_APP_ID || '',
    mchId: process.env.RUNSHI_WECHATPAY_MCH_ID || '',
    serialNo: process.env.RUNSHI_WECHATPAY_SERIAL_NO || '',
    privateKey: process.env.RUNSHI_WECHATPAY_PRIVATE_KEY || '',
    privateKeyPath: process.env.RUNSHI_WECHATPAY_PRIVATE_KEY_PATH || '',
    platformPublicKey: process.env.RUNSHI_WECHATPAY_PLATFORM_PUBLIC_KEY || '',
    platformPublicKeyPath: process.env.RUNSHI_WECHATPAY_PLATFORM_PUBLIC_KEY_PATH || '',
    publicKeyId: process.env.RUNSHI_WECHATPAY_PUBLIC_KEY_ID || '',
    apiV3Key: process.env.RUNSHI_WECHATPAY_API_V3_KEY || '',
    notifyPath: process.env.RUNSHI_WECHATPAY_NOTIFY_PATH || '/api/pay/callback/wechat',
  },
  alipay: {
    appId: process.env.RUNSHI_ALIPAY_APP_ID || '',
    privateKey: process.env.RUNSHI_ALIPAY_PRIVATE_KEY || '',
    privateKeyPath: process.env.RUNSHI_ALIPAY_PRIVATE_KEY_PATH || '',
    publicKey: process.env.RUNSHI_ALIPAY_PUBLIC_KEY || '',
    publicKeyPath: process.env.RUNSHI_ALIPAY_PUBLIC_KEY_PATH || '',
    gateway: process.env.RUNSHI_ALIPAY_GATEWAY || 'https://openapi.alipay.com/gateway.do',
    notifyPath: process.env.RUNSHI_ALIPAY_NOTIFY_PATH || '/api/pay/callback/alipay',
    returnPath: process.env.RUNSHI_ALIPAY_RETURN_PATH || '/pay/alipay/return',
  },
  upstream: {
    preset: process.env.RUNSHI_UPSTREAM_PRESET || 'together',
    providerType: process.env.RUNSHI_UPSTREAM_PROVIDER || 'openai',
    apiUrl: process.env.RUNSHI_UPSTREAM_API_URL || '',
    apiKey: process.env.RUNSHI_UPSTREAM_API_KEY || '',
    model: process.env.RUNSHI_UPSTREAM_MODEL || '',
  },
  allowBuiltinUpstreamKeys: booleanFromEnv('RUNSHI_ALLOW_BUILTIN_UPSTREAM_KEYS', false),
  paymentProviders: (process.env.RUNSHI_PAYMENT_PROVIDERS || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean),
};
