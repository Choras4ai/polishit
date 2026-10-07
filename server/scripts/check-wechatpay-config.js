'use strict';

const crypto = require('crypto');
const config = require('../config');
const { getWechatConfig } = require('../commercial/payments/wechatpay');

const conf = getWechatConfig(config);
const checks = [];

function check(label, ok, detail, level = 'error') {
  checks.push({ label, ok: Boolean(ok), detail, level });
}

function canParsePrivateKey(value) {
  try {
    crypto.createPrivateKey(value);
    return true;
  } catch (_) {
    return false;
  }
}

function canParsePublicKey(value) {
  try {
    crypto.createPublicKey(value);
    return true;
  } catch (_) {
    return false;
  }
}

let publicUrl;
try {
  publicUrl = new URL(config.publicBaseUrl);
} catch (_) {
  publicUrl = null;
}

check('Native 支付模式', config.paymentMode === 'online', 'RUNSHI_PAYMENT_MODE=online');
check(
  '启用微信通道',
  config.paymentProviders.includes('wechatpay'),
  'RUNSHI_PAYMENT_PROVIDERS=wechatpay',
);
check('AppID', /^wx[0-9a-z]{16}$/i.test(conf.appId), '必须是已与商户号绑定的 AppID');
check('商户号', /^\d{8,12}$/.test(conf.mchId), '请配置 RUNSHI_WECHATPAY_MCH_ID');
check('商户 API 证书序列号', /^[0-9A-F]+$/i.test(conf.serialNo), '序列号必须与商户私钥所属证书一致');
check('商户 API 证书私钥', Boolean(conf.privateKey) && canParsePrivateKey(conf.privateKey), '需要 apiclient_key.pem，不是 apiclient_cert.pem');
check('微信支付公钥', Boolean(conf.platformPublicKey) && canParsePublicKey(conf.platformPublicKey), '在商户平台「API安全」中下载');
check('微信支付公钥 ID', /^PUB_KEY_ID_[0-9A-Z]+$/i.test(conf.publicKeyId), '请配置与公钥配套的 PUB_KEY_ID_...');
check('APIv3 密钥', Buffer.byteLength(conf.apiV3Key || '', 'utf8') === 32, '必须恰好 32 个字符');
check('公网 HTTPS 地址', publicUrl?.protocol === 'https:' && Boolean(publicUrl.hostname), 'RUNSHI_PUBLIC_BASE_URL=https://你的域名');
check('回调路径', /^\/[^\s]*$/.test(config.wechatPay.notifyPath), '必须是以 / 开头的路径');

for (const item of checks) {
  const icon = item.ok ? '✓' : (item.level === 'warning' ? '!' : '✗');
  console.log(`${icon} ${item.label}${item.ok ? '' : ` — ${item.detail}`}`);
}

const failures = checks.filter(item => !item.ok && item.level === 'error');
console.log(failures.length === 0
  ? '\n微信支付本地配置检查通过。'
  : `\n微信支付配置尚有 ${failures.length} 项需处理。`);

process.exitCode = failures.length === 0 ? 0 : 1;
