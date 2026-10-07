'use strict';

/**
 * 微信支付在线探测：真实调用微信支付 API，逐层验证配置是否正确。
 *
 * 用法：
 *   npm run payment:probe            # 只做只读探测（订单查询，不产生任何订单）
 *   npm run payment:probe -- --create-order   # 创建并立即关闭一笔 ¥0.01 测试订单
 *
 * 探测层次：
 *   1. 本地配置完整性（复用 check 脚本逻辑）
 *   2. 商户认证链路：私钥签名 + 证书序列号 + 商户号 是否被微信接受
 *   3. AppID 绑定 + Native 产品开通（仅 --create-order 时）
 *   4. 微信支付公钥/公钥ID 能否正确验证微信应答签名
 */

const crypto = require('crypto');
const config = require('../config');
const { getWechatConfig } = require('../commercial/payments/wechatpay');

const conf = getWechatConfig(config);

function sign(method, requestPath, body) {
  const nonceStr = crypto.randomBytes(16).toString('hex');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const message = `${method}\n${requestPath}\n${timestamp}\n${nonceStr}\n${body}\n`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(message);
  signer.end();
  const signature = signer.sign(conf.privateKey, 'base64');
  return `WECHATPAY2-SHA256-RSA2048 mchid="${conf.mchId}",nonce_str="${nonceStr}",signature="${signature}",timestamp="${timestamp}",serial_no="${conf.serialNo}"`;
}

async function callWechat(method, requestPath, bodyObj) {
  const body = bodyObj ? JSON.stringify(bodyObj) : '';
  const response = await fetch(`https://api.mch.weixin.qq.com${requestPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': sign(method, requestPath, body),
    },
    body: body || undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const rawBody = await response.text();
  let payload = {};
  try { payload = JSON.parse(rawBody || '{}'); } catch (_) { /* ignore */ }
  return { status: response.status, headers: response.headers, rawBody, payload };
}

function verifyResponseSignature(headers, rawBody) {
  const timestamp = headers.get('wechatpay-timestamp') || '';
  const nonce = headers.get('wechatpay-nonce') || '';
  const signature = headers.get('wechatpay-signature') || '';
  const serial = headers.get('wechatpay-serial') || '';
  if (!timestamp || !nonce || !signature) {
    return { ok: false, reason: '应答缺少签名头（错误应答可忽略）' };
  }
  if (conf.publicKeyId && serial !== conf.publicKeyId) {
    return { ok: false, reason: `应答序列号 ${serial} 与配置的公钥 ID ${conf.publicKeyId} 不一致 — 公钥 ID 配错或商户为平台证书模式` };
  }
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${timestamp}\n${nonce}\n${rawBody}\n`);
  verifier.end();
  const valid = verifier.verify(conf.platformPublicKey, signature, 'base64');
  return valid
    ? { ok: true }
    : { ok: false, reason: '验签失败 — 下载的微信支付公钥 pem 与该商户不匹配' };
}

const DIAGNOSIS = {
  SIGN_ERROR: '签名错误 → 检查：① 私钥是否是 apiclient_key.pem；② 序列号是否与该证书配套；③ 商户号是否正确',
  MCH_NOT_EXIST: '商户号不存在 → RUNSHI_WECHATPAY_MCH_ID 填错，或新商户号还未完成开户',
  APPID_MCHID_NOT_MATCH: 'AppID 与商户号未绑定 → 商户平台「产品中心 → AppID 账号管理」里关联并确认授权',
  NO_AUTH: '无权限 → Native 支付产品未开通，去商户平台「产品中心」开通 Native 支付',
  PARAM_ERROR: '参数错误 → 查看下方 message 详情',
  INVALID_REQUEST: '请求无效 → 查看下方 message 详情（常见：AppID 与商户号绑定关系）',
};

function explain(payload) {
  const hint = DIAGNOSIS[payload.code];
  return hint ? `\n   诊断：${hint}` : '';
}

async function main() {
  console.log('══════════ 微信支付在线探测 ══════════\n');

  // ── 第 1 层：本地配置 ──
  console.log('[1/4] 本地配置完整性');
  const missing = [];
  if (!/^wx[0-9a-z]{16}$/i.test(conf.appId)) missing.push('AppID 格式（wx + 16 位）');
  if (!/^\d{8,12}$/.test(conf.mchId)) missing.push('商户号（8-12 位数字）');
  if (!/^[0-9A-F]{40}$/i.test(conf.serialNo)) missing.push('证书序列号（40 位十六进制）');
  if (!conf.privateKey) missing.push('商户私钥 apiclient_key.pem');
  if (!conf.platformPublicKey) missing.push('微信支付公钥 pub_key.pem');
  if (Buffer.byteLength(conf.apiV3Key || '', 'utf8') !== 32) missing.push('APIv3 密钥（恰好 32 字符）');
  try { crypto.createPrivateKey(conf.privateKey); } catch (_) { missing.push('私钥无法解析（是否误用了 apiclient_cert.pem？）'); }
  try { crypto.createPublicKey(conf.platformPublicKey); } catch (_) { missing.push('微信支付公钥无法解析'); }

  if (missing.length) {
    console.log('  ✗ 本地配置不完整，先修复以下项后再探测：');
    missing.forEach((item) => console.log(`    - ${item}`));
    process.exitCode = 1;
    return;
  }
  console.log('  ✓ 本地配置完整\n');

  // ── 第 2 层：商户认证链路（只读探测，查询一笔不存在的订单）──
  console.log('[2/4] 商户认证链路（私钥 + 序列号 + 商户号）');
  const probeId = `probe_${Date.now()}`;
  const queryPath = `/v3/pay/transactions/out-trade-no/${probeId}?mchid=${conf.mchId}`;
  let auth;
  try {
    auth = await callWechat('GET', queryPath);
  } catch (err) {
    console.log(`  ✗ 网络请求失败：${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (auth.status === 404) {
    console.log('  ✓ 微信已接受商户身份（查询不存在的订单返回 404 即认证通过）\n');
  } else if (auth.status === 401) {
    console.log(`  ✗ 认证被拒 [${auth.payload.code}] ${auth.payload.message || ''}${explain(auth.payload)}\n`);
    process.exitCode = 1;
    return;
  } else {
    console.log(`  ✗ 非预期应答 HTTP ${auth.status} [${auth.payload.code}] ${auth.payload.message || ''}${explain(auth.payload)}\n`);
    process.exitCode = 1;
    return;
  }

  // ── 第 3 层：应答验签（微信支付公钥 + 公钥 ID）──
  console.log('[3/4] 应答验签（微信支付公钥 / 公钥 ID）');
  const sigResult = verifyResponseSignature(auth.headers, auth.rawBody);
  if (sigResult.ok) {
    console.log('  ✓ 应答验签通过，公钥与公钥 ID 配置正确\n');
  } else {
    console.log(`  ✗ ${sigResult.reason}\n`);
    process.exitCode = 1;
    return;
  }

  // ── 第 4 层：下单链路（可选，验证 AppID 绑定 + Native 开通）──
  const createOrder = process.argv.includes('--create-order');
  if (!createOrder) {
    console.log('[4/4] 下单链路（跳过）');
    console.log('  · 运行 `npm run payment:probe -- --create-order` 可创建并立即关闭一笔 ¥0.01 测试订单，');
    console.log('    用于验证 AppID 绑定与 Native 产品开通，不展示可支付二维码。');
    return;
  }

  console.log('[4/4] 创建 ¥0.01 Native 测试订单');
  const orderPath = '/v3/pay/transactions/native';
  const order = await callWechat('POST', orderPath, {
    mchid: conf.mchId,
    appid: conf.appId,
    description: '润石支付链路探测（可忽略）',
    out_trade_no: probeId,
    notify_url: conf.notifyUrl,
    amount: { total: 1, currency: 'CNY' },
  });

  if (order.status === 200 && order.payload.code_url) {
    console.log('  ✓ 下单成功！AppID 绑定与 Native 产品均正常');
    const orderSig = verifyResponseSignature(order.headers, order.rawBody);
    if (!orderSig.ok) {
      console.log(`  ✗ 下单应答验签失败：${orderSig.reason}`);
      process.exitCode = 1;
      return;
    }
    console.log('  ✓ 下单应答验签通过');

    const closePath = `/v3/pay/transactions/out-trade-no/${probeId}/close`;
    const close = await callWechat('POST', closePath, { mchid: conf.mchId });
    if (close.status !== 204) {
      console.log(`  ✗ 测试订单关闭失败 HTTP ${close.status} [${close.payload.code || ''}] ${close.payload.message || ''}`);
      process.exitCode = 1;
      return;
    }
    const closeSig = verifyResponseSignature(close.headers, close.rawBody);
    if (!closeSig.ok) {
      console.log(`  ✗ 关单应答验签失败：${closeSig.reason}`);
      process.exitCode = 1;
      return;
    }
    console.log('  ✓ 测试订单已立即关闭，不可扫码误付');
  } else {
    console.log(`  ✗ 下单失败 HTTP ${order.status} [${order.payload.code}] ${order.payload.message || ''}${explain(order.payload)}`);
    process.exitCode = 1;
  }

  console.log('\n提示：全链路最后一步（支付回调）需要公网验证 —');
  console.log(`  回调地址 = ${conf.notifyUrl}`);
  console.log('  确认 Nginx 已将该路径反代到本服务，并用真实小额支付验证积分到账。');
}

main().catch((err) => {
  console.error('探测失败：', err.message);
  process.exitCode = 1;
});
