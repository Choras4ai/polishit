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

module.exports = {
  listPaymentMethods,
};
