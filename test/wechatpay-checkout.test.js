'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const wechatpay = require('../server/commercial/payments/wechatpay');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });

function signedHeaders(rawBody, overrides = {}) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = 'response-nonce';
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${timestamp}\n${nonce}\n${rawBody}\n`);
  signer.end();
  return {
    'wechatpay-timestamp': timestamp,
    'wechatpay-nonce': nonce,
    'wechatpay-signature': signer.sign(pem, 'base64'),
    'wechatpay-serial': 'PUB_KEY_ID_TEST',
    ...overrides,
  };
}

function buildCallback(resourceOverrides = {}) {
  const apiV3Key = 'x'.repeat(32);
  const nonce = '0123456789ab';
  const associatedData = 'transaction';
  const resource = {
    mchid: '1900000000',
    appid: 'wx1234567890123456',
    out_trade_no: 'ord_callback',
    transaction_id: '4200000000001',
    trade_state: 'SUCCESS',
    amount: { total: 990, currency: 'CNY' },
    ...resourceOverrides,
  };
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(apiV3Key), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(associatedData));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(resource), 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString('base64');
  const body = JSON.stringify({
    event_type: 'TRANSACTION.SUCCESS',
    resource: {
      algorithm: 'AEAD_AES_256_GCM',
      original_type: 'transaction',
      ciphertext: encrypted,
      nonce,
      associated_data: associatedData,
    },
  });
  return { body, headers: signedHeaders(body) };
}

function buildConfig() {
  return {
    publicBaseUrl: 'https://www.runshi.top',
    wechatPay: {
      appId: 'wx1234567890123456',
      mchId: '1900000000',
      serialNo: 'A'.repeat(40),
      privateKey: pem,
      privateKeyPath: '',
      platformPublicKey: publicPem,
      platformPublicKeyPath: '',
      publicKeyId: 'PUB_KEY_ID_TEST',
      apiV3Key: 'x'.repeat(32),
      notifyPath: '/api/pay/callback/wechat',
    },
  };
}

test('createCheckout surfaces WeChat business errors instead of signature errors', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(
    JSON.stringify({ code: 'APPID_MCHID_NOT_MATCH', message: 'appid和mch_id不匹配' }),
    { status: 400, headers: { 'request-id': 'req-abc' } },
  );
  try {
    await assert.rejects(
      wechatpay.createCheckout(buildConfig(), { id: 'ord_test', amount_cents: 990 }),
      (err) => {
        assert.match(err.message, /APPID_MCHID_NOT_MATCH/);
        assert.match(err.message, /req-abc/);
        assert.equal(err.status, 502);
        assert.equal(err.wechatCode, 'APPID_MCHID_NOT_MATCH');
        return true;
      },
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('createCheckout rejects unsigned success responses', async () => {
  const originalFetch = global.fetch;
  // 200 应答但没有微信签名头 → 必须拒绝（防伪造）
  global.fetch = async () => new Response(
    JSON.stringify({ code_url: 'weixin://wxpay/bizpayurl?pr=fake' }),
    { status: 200 },
  );
  try {
    await assert.rejects(
      wechatpay.createCheckout(buildConfig(), { id: 'ord_test2', amount_cents: 990 }),
      /缺少签名头/,
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('createCheckout verifies a signed response and limits order lifetime', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(request.notify_url, 'https://www.runshi.top/api/pay/callback/wechat');
    const expiresAt = Date.parse(request.time_expire);
    assert.ok(expiresAt > Date.now() + 28 * 60 * 1000);
    assert.ok(expiresAt < Date.now() + 31 * 60 * 1000);
    const rawBody = JSON.stringify({ code_url: 'weixin://wxpay/bizpayurl?pr=valid' });
    return new Response(rawBody, { status: 200, headers: signedHeaders(rawBody) });
  };
  try {
    const result = await wechatpay.createCheckout(
      buildConfig(),
      { id: 'ord_valid', amount_cents: 990 },
    );
    assert.equal(result.checkoutCodeUrl, 'weixin://wxpay/bizpayurl?pr=valid');
  } finally {
    global.fetch = originalFetch;
  }
});

test('queryOrder verifies merchant identity, currency and payment state', async () => {
  const originalFetch = global.fetch;
  const rawBody = JSON.stringify({
    mchid: '1900000000',
    appid: 'wx1234567890123456',
    out_trade_no: 'ord_query',
    transaction_id: '4200000000002',
    trade_state: 'SUCCESS',
    amount: { total: 990, currency: 'CNY' },
  });
  global.fetch = async (url, options) => {
    assert.match(String(url), /out-trade-no\/ord_query\?mchid=1900000000$/);
    assert.equal(options.method, 'GET');
    return new Response(rawBody, { status: 200, headers: signedHeaders(rawBody) });
  };
  try {
    const result = await wechatpay.queryOrder(buildConfig(), 'ord_query');
    assert.equal(result.found, true);
    assert.equal(result.paid, true);
    assert.equal(result.amountCents, 990);
  } finally {
    global.fetch = originalFetch;
  }
});

test('callback accepts a signed encrypted transaction for this merchant', () => {
  const callback = buildCallback();
  const parsed = wechatpay.verifyAndParseCallback(
    buildConfig(),
    callback.headers,
    callback.body,
  );
  assert.equal(parsed.paid, true);
  assert.equal(parsed.orderId, 'ord_callback');
  assert.equal(parsed.providerTradeNo, '4200000000001');
  assert.equal(parsed.amountCents, 990);
});

test('callback rejects another merchant, another AppID or another currency', () => {
  for (const overrides of [
    { mchid: '1900000001' },
    { appid: 'wx0000000000000000' },
    { amount: { total: 990, currency: 'USD' } },
  ]) {
    const callback = buildCallback(overrides);
    assert.throws(
      () => wechatpay.verifyAndParseCallback(buildConfig(), callback.headers, callback.body),
      (err) => err?.status === 400,
    );
  }
});

test('callback rejects tampering before decrypting or crediting', () => {
  const callback = buildCallback();
  const tampered = callback.body.replace('TRANSACTION.SUCCESS', 'TRANSACTION.SUCCESX');
  assert.throws(
    () => wechatpay.verifyAndParseCallback(buildConfig(), callback.headers, tampered),
    /\u9a8c\u7b7e\u5931\u8d25/,
  );
});

test('createCheckout fails fast when config is incomplete', async () => {
  const cfg = buildConfig();
  cfg.wechatPay.mchId = '';
  await assert.rejects(
    wechatpay.createCheckout(cfg, { id: 'ord_test3', amount_cents: 990 }),
    (err) => err.status === 503,
  );
});
