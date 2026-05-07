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
    && cfg.wechatPay.apiV3Key,
  );

  return {
    ready,
    appId: cfg.wechatPay.appId,
    mchId: cfg.wechatPay.mchId,
    serialNo: cfg.wechatPay.serialNo,
    privateKey,
    platformPublicKey,
    apiV3Key: cfg.wechatPay.apiV3Key,
    notifyUrl: `${cfg.publicBaseUrl}${cfg.wechatPay.notifyPath}`,
  };
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
    amount: {
      total: Number(order.amount_cents || 0),
      currency: 'CNY',
    },
  });

  const response = await fetch(`https://api.mch.weixin.qq.com${requestPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': buildAuthorization(conf, 'POST', requestPath, body),
    },
    body,
    signal: AbortSignal.timeout(20_000),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.code_url) {
    const err = new Error(payload.message || `微信支付下单失败 (${response.status})`);
    err.status = 502;
    throw err;
  }

  return {
    checkoutCodeUrl: payload.code_url,
    payload,
  };
}

function verifyCallbackSignature(conf, headers, rawBody) {
  const timestamp = headers['wechatpay-timestamp'];
  const nonce = headers['wechatpay-nonce'];
  const signature = headers['wechatpay-signature'];
  if (!timestamp || !nonce || !signature) {
    const err = new Error('微信支付回调缺少签名头。');
    err.status = 400;
    throw err;
  }

  // Replay protection: reject callbacks older than 5 minutes
  const callbackTime = Number(timestamp) * 1000;
  if (!Number.isFinite(callbackTime) || Math.abs(Date.now() - callbackTime) > 5 * 60 * 1000) {
    const err = new Error('微信支付回调时间戳过期。');
    err.status = 400;
    throw err;
  }

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${timestamp}\n${nonce}\n${rawBody}\n`);
  verifier.end();
  const valid = verifier.verify(conf.platformPublicKey, signature, 'base64');
  if (!valid) {
    const err = new Error('微信支付回调验签失败。');
    err.status = 400;
    throw err;
  }
}

function decryptResource(conf, resource) {
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

  verifyCallbackSignature(conf, headers, rawBody);
  const payload = JSON.parse(rawBody || '{}');
  const resource = decryptResource(conf, payload.resource || {});

  return {
    orderId: resource.out_trade_no,
    providerTradeNo: resource.transaction_id || '',
    amountCents: Number(resource.amount?.total || 0),
    tradeStatus: resource.trade_state || '',
    raw: payload,
    resource,
    paid: resource.trade_state === 'SUCCESS',
  };
}

module.exports = {
  createCheckout,
  getWechatConfig,
  verifyAndParseCallback,
};
