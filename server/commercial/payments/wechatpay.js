'use strict';

const crypto = require('crypto');
const path = require('path');
const { readConfigText } = require('./utils');

function getWechatConfig(cfg) {
  const rootDir = path.join(__dirname, '..', '..');
  const privateKey = readConfigText(rootDir, cfg.wechatPay.privateKey, cfg.wechatPay.privateKeyPath);
  const platformPublicKey = readConfigText(
    rootDir,
    cfg.wechatPay.platformPublicKey,
    cfg.wechatPay.platformPublicKeyPath,
  );
  const ready = Boolean(
    cfg.wechatPay.appId
    && cfg.wechatPay.mchId
    && cfg.wechatPay.serialNo
    && privateKey
    && platformPublicKey
    && cfg.wechatPay.publicKeyId
    && cfg.wechatPay.apiV3Key,
  );

  return {
    ready,
    appId: cfg.wechatPay.appId,
    mchId: cfg.wechatPay.mchId,
    serialNo: cfg.wechatPay.serialNo,
    privateKey,
    platformPublicKey,
    publicKeyId: cfg.wechatPay.publicKeyId,
    apiV3Key: cfg.wechatPay.apiV3Key,
    notifyUrl: `${cfg.publicBaseUrl}${cfg.wechatPay.notifyPath}`,
  };
}

function getHeader(headers, name) {
  if (headers && typeof headers.get === 'function') return headers.get(name) || '';
  const wanted = name.toLowerCase();
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === wanted);
  return entry ? String(entry[1] || '') : '';
}

function buildAuthorization(cfg, method, requestPath, body) {
  const nonceStr = crypto.randomBytes(16).toString('hex');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const message = `${method}\n${requestPath}\n${timestamp}\n${nonceStr}\n${body}\n`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(message);
  signer.end();
  const signature = signer.sign(cfg.privateKey, 'base64');
  return `WECHATPAY2-SHA256-RSA2048 mchid="${cfg.mchId}",nonce_str="${nonceStr}",signature="${signature}",timestamp="${timestamp}",serial_no="${cfg.serialNo}"`;
}

function parseJsonBody(rawBody) {
  try {
    return JSON.parse(rawBody || '{}');
  } catch (_) {
    const err = new Error('微信支付应答不是有效 JSON。');
    err.status = 502;
    throw err;
  }
}

function buildWechatApiError(response, rawBody, action) {
  const payload = parseJsonBody(rawBody);
  const requestId = getHeader(response.headers, 'request-id');
  const suffix = requestId ? `，Request-ID: ${requestId}` : '';
  const codePart = payload.code ? `[${payload.code}] ` : '';
  const err = new Error(`微信支付${action}失败：${codePart}${payload.message || `HTTP ${response.status}`}${suffix}`);
  err.status = 502;
  err.requestId = requestId;
  err.wechatCode = payload.code || '';
  return err;
}

async function requestWechatpay(conf, method, requestPath, body = '') {
  const response = await fetch(`https://api.mch.weixin.qq.com${requestPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': buildAuthorization(conf, method, requestPath, body),
    },
    body: body || undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const rawBody = await response.text();
  return { response, rawBody };
}

function validateTransaction(conf, resource) {
  if (resource.mchid !== conf.mchId || resource.appid !== conf.appId) {
    const err = new Error('微信支付交易的商户号或 AppID 与本系统不匹配。');
    err.status = 400;
    throw err;
  }
  if (!resource.out_trade_no || !resource.transaction_id) {
    const err = new Error('微信支付交易缺少必需订单字段。');
    err.status = 400;
    throw err;
  }
  if (resource.amount?.currency !== 'CNY') {
    const err = new Error('微信支付交易币种不匹配。');
    err.status = 400;
    throw err;
  }
}

function buildTransactionResult(resource, raw) {
  return {
    orderId: resource.out_trade_no,
    providerTradeNo: resource.transaction_id || '',
    amountCents: Number(resource.amount?.total || 0),
    tradeStatus: resource.trade_state || '',
    raw,
    resource,
    paid: resource.trade_state === 'SUCCESS',
  };
}

async function createCheckout(cfg, order) {
  const conf = getWechatConfig(cfg);
  if (!conf.ready) {
    const err = new Error('微信支付尚未配置 mchId / appId / serialNo / key。');
    err.status = 503;
    throw err;
  }

  const requestPath = '/v3/pay/transactions/native';
  const body = JSON.stringify({
    mchid: conf.mchId,
    appid: conf.appId,
    description: '润石 PoliShit 会员开通',
    out_trade_no: order.id,
    notify_url: conf.notifyUrl,
    time_expire: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    amount: {
      total: Number(order.amount_cents || 0),
      currency: 'CNY',
    },
  });

  const { response, rawBody } = await requestWechatpay(conf, 'POST', requestPath, body);

  // 先解析业务错误再验签：微信的错误应答（如 appid 与 mchid 不匹配、商户号无效）
  // 可能不携带完整签名头，若先验签会把真正的配置错误掩盖成「缺少签名头」。
  if (!response.ok) {
    if (getHeader(response.headers, 'wechatpay-signature')) {
      verifyWechatpaySignature(conf, response.headers, rawBody, 'response');
    }
    throw buildWechatApiError(response, rawBody, '下单');
  }

  verifyWechatpaySignature(conf, response.headers, rawBody, 'response');
  const payload = parseJsonBody(rawBody);
  if (!payload.code_url) {
    const requestId = getHeader(response.headers, 'request-id');
    const err = new Error(`微信支付应答缺少 code_url${requestId ? `，Request-ID: ${requestId}` : ''}`);
    err.status = 502;
    err.requestId = requestId;
    throw err;
  }

  return {
    checkoutCodeUrl: payload.code_url,
    payload,
  };
}

async function queryOrder(cfg, orderId) {
  const conf = getWechatConfig(cfg);
  if (!conf.ready) {
    const err = new Error('微信支付查单配置不完整。');
    err.status = 503;
    throw err;
  }

  const requestPath = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderId)}?mchid=${encodeURIComponent(conf.mchId)}`;
  const { response, rawBody } = await requestWechatpay(conf, 'GET', requestPath);
  if (response.status === 404) {
    if (getHeader(response.headers, 'wechatpay-signature')) {
      verifyWechatpaySignature(conf, response.headers, rawBody, 'response');
    }
    return { found: false, paid: false };
  }
  if (!response.ok) {
    if (getHeader(response.headers, 'wechatpay-signature')) {
      verifyWechatpaySignature(conf, response.headers, rawBody, 'response');
    }
    throw buildWechatApiError(response, rawBody, '查单');
  }

  verifyWechatpaySignature(conf, response.headers, rawBody, 'response');
  const resource = parseJsonBody(rawBody);
  validateTransaction(conf, resource);
  return { found: true, ...buildTransactionResult(resource, resource) };
}

function verifyWechatpaySignature(conf, headers, rawBody, source = 'callback') {
  const timestamp = getHeader(headers, 'wechatpay-timestamp');
  const nonce = getHeader(headers, 'wechatpay-nonce');
  const signature = getHeader(headers, 'wechatpay-signature');
  const serial = getHeader(headers, 'wechatpay-serial');
  if (!timestamp || !nonce || !signature) {
    const err = new Error(`微信支付${source === 'response' ? '应答' : '回调'}缺少签名头。`);
    err.status = 400;
    throw err;
  }

  if (conf.publicKeyId && serial !== conf.publicKeyId) {
    const err = new Error('微信支付签名公钥 ID 与配置不匹配。');
    err.status = 400;
    throw err;
  }

  // Replay protection: reject callbacks older than 5 minutes
  const callbackTime = Number(timestamp) * 1000;
  if (!Number.isFinite(callbackTime) || Math.abs(Date.now() - callbackTime) > 5 * 60 * 1000) {
    const err = new Error(`微信支付${source === 'response' ? '应答' : '回调'}时间戳过期。`);
    err.status = 400;
    throw err;
  }

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${timestamp}\n${nonce}\n${rawBody}\n`);
  verifier.end();
  const valid = verifier.verify(conf.platformPublicKey, signature, 'base64');
  if (!valid) {
    const err = new Error(`微信支付${source === 'response' ? '应答' : '回调'}验签失败。`);
    err.status = 400;
    throw err;
  }
}

function decryptResource(conf, resource) {
  if (resource.algorithm !== 'AEAD_AES_256_GCM') {
    const err = new Error('微信支付回调加密算法不受支持。');
    err.status = 400;
    throw err;
  }
  const ciphertext = Buffer.from(resource.ciphertext || '', 'base64');
  const nonce = Buffer.from(resource.nonce || '', 'utf8');
  const associatedData = Buffer.from(resource.associated_data || '', 'utf8');
  const data = ciphertext.subarray(0, ciphertext.length - 16);
  const authTag = ciphertext.subarray(ciphertext.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(conf.apiV3Key, 'utf8'), nonce);
  if (associatedData.length > 0) {
    decipher.setAAD(associatedData);
  }
  decipher.setAuthTag(authTag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

function verifyAndParseCallback(cfg, headers, rawBody) {
  const conf = getWechatConfig(cfg);
  if (!conf.ready) {
    const err = new Error('微信支付回调配置不完整。');
    err.status = 503;
    throw err;
  }

  verifyWechatpaySignature(conf, headers, rawBody, 'callback');
  const payload = parseJsonBody(rawBody);
  if (payload.event_type !== 'TRANSACTION.SUCCESS' || payload.resource?.original_type !== 'transaction') {
    const err = new Error('微信支付回调事件类型不受支持。');
    err.status = 400;
    throw err;
  }
  const resource = decryptResource(conf, payload.resource || {});
  validateTransaction(conf, resource);
  if (resource.trade_state !== 'SUCCESS') {
    const err = new Error('微信支付成功回调的交易状态不是 SUCCESS。');
    err.status = 400;
    throw err;
  }
  return buildTransactionResult(resource, payload);
}

module.exports = {
  createCheckout,
  getWechatConfig,
  queryOrder,
  verifyWechatpaySignature,
  verifyAndParseCallback,
};
