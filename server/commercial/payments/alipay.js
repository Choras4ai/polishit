'use strict';

const path = require('path');
const { AlipaySdk } = require('alipay-sdk');
const { readConfigText } = require('./utils');

function getAlipayConfig(cfg) {
  const rootDir = path.join(__dirname, '..', '..');
  const privateKey = readConfigText(rootDir, cfg.alipay.privateKey, cfg.alipay.privateKeyPath);
  const alipayPublicKey = readConfigText(rootDir, cfg.alipay.publicKey, cfg.alipay.publicKeyPath);
  const ready = Boolean(cfg.alipay.appId && privateKey && alipayPublicKey);

  return {
    ready,
    appId: cfg.alipay.appId,
    privateKey,
    alipayPublicKey,
    gateway: cfg.alipay.gateway,
    notifyUrl: `${cfg.publicBaseUrl}${cfg.alipay.notifyPath}`,
    returnUrl: `${cfg.publicBaseUrl}${cfg.alipay.returnPath}`,
  };
}

function createSdk(cfg) {
  const conf = getAlipayConfig(cfg);
  if (!conf.ready) {
    const err = new Error('支付宝支付尚未配置 appId / privateKey / alipayPublicKey。');
    err.status = 503;
    throw err;
  }

  return new AlipaySdk({
    appId: conf.appId,
    privateKey: conf.privateKey,
    alipayPublicKey: conf.alipayPublicKey,
    gateway: conf.gateway,
  });
}

async function createCheckout(cfg, order) {
  const sdk = createSdk(cfg);
  const payUrl = await sdk.pageExecute('alipay.trade.page.pay', 'GET', {
    notifyUrl: `${cfg.publicBaseUrl}${cfg.alipay.notifyPath}`,
    returnUrl: `${cfg.publicBaseUrl}${cfg.alipay.returnPath}`,
    bizContent: {
      outTradeNo: order.id,
      productCode: 'FAST_INSTANT_TRADE_PAY',
      totalAmount: (Number(order.amount_cents || 0) / 100).toFixed(2),
      subject: `${order.plan_name} ${order.plan_id}`,
      body: '润石 PoliShit 会员开通',
    },
  });

  return {
    checkoutUrl: payUrl,
    payload: {
      notifyUrl: `${cfg.publicBaseUrl}${cfg.alipay.notifyPath}`,
      returnUrl: `${cfg.publicBaseUrl}${cfg.alipay.returnPath}`,
    },
  };
}

async function verifyAndParseCallback(cfg, body) {
  const sdk = createSdk(cfg);
  const verified = await sdk.checkNotifySignV2(body);
  if (!verified) {
    const err = new Error('支付宝回调验签失败。');
    err.status = 400;
    throw err;
  }

  return {
    orderId: body.out_trade_no,
    providerTradeNo: body.trade_no || '',
    tradeStatus: body.trade_status || '',
    amountCents: Math.round(Number(body.total_amount || 0) * 100),
    raw: body,
    paid: ['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(body.trade_status),
  };
}

module.exports = {
  createCheckout,
  getAlipayConfig,
  verifyAndParseCallback,
};
