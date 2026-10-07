'use strict';

const { getAlipayConfig } = require('./alipay');
const { getWechatConfig } = require('./wechatpay');

function listPaymentMethods(cfg) {
  const declared = new Set((cfg.paymentProviders || []).map((item) => item.trim()).filter(Boolean));
  const alipay = getAlipayConfig(cfg);
  const wechat = getWechatConfig(cfg);
  const includeAll = declared.size === 0;

  const providers = [
    {
      id: 'wechatpay',
      label: '微信支付',
      ready: wechat.ready,
    },
    {
      id: 'alipay',
      label: '支付宝',
      ready: alipay.ready,
    },
  ];

  return providers.filter((provider) => includeAll || declared.has(provider.id));
}

function assertPaymentProviderAllowed(cfg, provider, readyProviderIds = []) {
  if (provider === 'manual') {
    if (cfg.isProduction || cfg.paymentMode !== 'manual') {
      const err = new Error('请通过支付通道充值积分。');
      err.status = 403;
      throw err;
    }
    return;
  }

  if (cfg.paymentMode !== 'online') {
    const err = new Error('在线支付尚未启用。');
    err.status = 403;
    throw err;
  }

  if (!readyProviderIds.includes(provider)) {
    const err = new Error('支付通道不可用或尚未配置。');
    err.status = 503;
    throw err;
  }
}

module.exports = {
  assertPaymentProviderAllowed,
  listPaymentMethods,
};
