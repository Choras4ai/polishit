import { createServer } from "node:http";
import { createHash, createHmac, createSign, randomBytes, timingSafeEqual, verify as verifyRsa } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  createAdminSession,
  safeUsernameMatch,
  verifyAdminSession,
  verifyPassword,
} from "./admin-auth.mjs";

import { productFor, validTransaction } from "./products.mjs";
const PORT = Number(process.env.APP_PORT ?? 3100);
const SITE_ORIGIN = (process.env.SITE_ORIGIN ?? "https://course.runshi.top").replace(/\/$/, "");
const HERE = fileURLToPath(new URL(".", import.meta.url));
const STATIC_ROOT = resolve(process.env.STATIC_ROOT ?? join(HERE, "site"));
const DB_PATH = resolve(process.env.DB_PATH ?? "/var/lib/statistics-course-pay/orders.sqlite");
const ADMIN_COOKIE = "__Host-course_admin";
const ADMIN_SESSION_MAX_AGE = 8 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;

const requiredEnv = [
  "WECHATPAY_MCH_ID",
  "WECHATPAY_APP_ID",
  "WECHATPAY_APP_SECRET",
  "WECHATPAY_MERCHANT_SERIAL_NO",
  "WECHATPAY_MERCHANT_PRIVATE_KEY_PATH",
  "WECHATPAY_API_V3_KEY",
  "WECHATPAY_PUBLIC_KEY_ID",
  "WECHATPAY_PUBLIC_KEY_PATH",
  "WECHATPAY_NOTIFY_URL",
  "OAUTH_COOKIE_SECRET",
];

function paymentConfig() {
  const missing = requiredEnv.filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`支付配置尚未完成：${missing.join(", ")}`);
  if (process.env.WECHATPAY_API_V3_KEY.length !== 32) throw new Error("APIv3 密钥必须为 32 位");
  return {
    mchId: process.env.WECHATPAY_MCH_ID,
    appId: process.env.WECHATPAY_APP_ID,
    appSecret: process.env.WECHATPAY_APP_SECRET,
    merchantSerial: process.env.WECHATPAY_MERCHANT_SERIAL_NO,
    merchantPrivateKey: readFileSync(process.env.WECHATPAY_MERCHANT_PRIVATE_KEY_PATH, "utf8"),
    apiV3Key: process.env.WECHATPAY_API_V3_KEY,
    publicKeyId: process.env.WECHATPAY_PUBLIC_KEY_ID,
    publicKey: readFileSync(process.env.WECHATPAY_PUBLIC_KEY_PATH, "utf8"),
    notifyUrl: process.env.WECHATPAY_NOTIFY_URL,
    cookieSecret: process.env.OAUTH_COOKIE_SECRET,
  };
}

mkdirSync(resolve(DB_PATH, ".."), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    out_trade_no TEXT NOT NULL UNIQUE,
    openid TEXT NOT NULL,
    description TEXT NOT NULL,
    amount INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    transaction_id TEXT,
    paid_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);
`);
if (!db.prepare("PRAGMA table_info(orders)").all().some(column => column.name === "product_id")) {
  db.exec("ALTER TABLE orders ADD COLUMN product_id TEXT NOT NULL DEFAULT 'statistics'");
}
try { chmodSync(DB_PATH, 0o600); } catch {}

const insertOrder = db.prepare(`
  INSERT INTO orders (id, out_trade_no, openid, description, amount, product_id)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const failOrder = db.prepare("UPDATE orders SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'pending'");
const getOrderStatus = db.prepare("SELECT status FROM orders WHERE id = ? AND openid = ?");
const getOrderByTradeNo = db.prepare("SELECT * FROM orders WHERE out_trade_no = ?");
const markPaid = db.prepare(`
  UPDATE orders SET status = 'paid', transaction_id = ?, paid_at = ?, updated_at = ?
  WHERE id = ? AND status <> 'paid'
`);
const orderSummary = db.prepare(`
  SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid,
    SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
    COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0) AS revenue
  FROM orders
`);

const loginAttempts = new Map();

const securityHeaders = {
  "Content-Security-Policy": "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(self)",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};
function securityHeadersForStatic(filePath, body) {
  if (extname(filePath) !== ".html") return securityHeaders;
  const source = body.toString("utf8");
  const scriptHashes = [...source.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(([, script]) => `'sha256-${createHash("sha256").update(script).digest("base64")}'`);
  return {
    ...securityHeaders,
    "Content-Security-Policy":
      "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; " +
      "form-action 'self'; img-src 'self' data:; style-src 'self'; " +
      `script-src 'self' ${scriptHashes.join(" ")}; script-src-attr 'none'`,
  };
}

function randomString(bytes = 24) {
  return randomBytes(bytes).toString("base64url");
}

function json(res, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...securityHeaders,
    ...extraHeaders,
  });
  res.end(body);
}

function redirect(res, location, cookies = []) {
  const headers = { Location: location, "Cache-Control": "no-store", ...securityHeaders };
  if (cookies.length) headers["Set-Cookie"] = cookies;
  res.writeHead(302, headers);
  res.end();
}

function adminConfig() {
  const username = process.env.ADMIN_USERNAME;
  const passwordHash = process.env.ADMIN_PASSWORD_HASH;
  const sessionSecret = process.env.ADMIN_SESSION_SECRET;
  if (!username || !passwordHash || !sessionSecret || sessionSecret.length < 32) {
    throw new Error("管理后台尚未完成安全配置");
  }
  return { username, passwordHash, sessionSecret };
}

function requestIp(req) {
  const forwarded = req.headers["x-real-ip"];
  return (Array.isArray(forwarded) ? forwarded[0] : forwarded) || req.socket.remoteAddress || "unknown";
}

function isSameOrigin(req) {
  const origin = req.headers.origin;
  return !origin || origin === SITE_ORIGIN;
}

function loginRateStatus(ip, now = Date.now()) {
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.startedAt >= LOGIN_WINDOW_MS) {
    loginAttempts.delete(ip);
    return { blocked: false, retryAfter: 0 };
  }
  return {
    blocked: entry.count >= LOGIN_MAX_ATTEMPTS,
    retryAfter: Math.max(1, Math.ceil((LOGIN_WINDOW_MS - (now - entry.startedAt)) / 1000)),
  };
}

function recordLoginFailure(ip, now = Date.now()) {
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.startedAt >= LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, startedAt: now });
  } else {
    entry.count += 1;
  }
}

function clearLoginFailures(ip) {
  loginAttempts.delete(ip);
}

function adminSession(req) {
  try {
    const config = adminConfig();
    return verifyAdminSession(parseCookies(req)[ADMIN_COOKIE], config.sessionSecret);
  } catch {
    return null;
  }
}

function requireAdmin(req, res) {
  const session = adminSession(req);
  if (!session) {
    json(res, 401, { error: "请先登录管理后台" });
    return null;
  }
  return session;
}

function adminSessionCookie(value, maxAge = ADMIN_SESSION_MAX_AGE) {
  return `${ADMIN_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

function maskOpenid(value) {
  if (!value) return null;
  if (value.length <= 10) return "••••••";
  return `${value.slice(0, 5)}••••••${value.slice(-4)}`;
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, "\\$&");
}

async function handleAdminLogin(req, res) {
  if (!isSameOrigin(req)) return json(res, 403, { error: "请求来源无效" });
  const ip = requestIp(req);
  const rate = loginRateStatus(ip);
  if (rate.blocked) {
    return json(res, 429, { error: "登录尝试过多，请稍后再试" }, { "Retry-After": String(rate.retryAfter) });
  }
  try {
    const config = adminConfig();
    const body = JSON.parse(await readBody(req, 8_192));
    const usernameOk = safeUsernameMatch(body.username ?? "", config.username);
    const passwordOk = verifyPassword(body.password ?? "", config.passwordHash);
    if (!usernameOk || !passwordOk) {
      recordLoginFailure(ip);
      console.warn(`[admin] login failed ip=${ip}`);
      return json(res, 401, { error: "账号或密码不正确" });
    }
    clearLoginFailures(ip);
    const csrf = randomString(24);
    const token = createAdminSession(config.username, config.sessionSecret, csrf);
    console.info(`[admin] login succeeded user=${config.username} ip=${ip}`);
    return json(res, 200, { username: config.username, csrf }, { "Set-Cookie": adminSessionCookie(token) });
  } catch (error) {
    const message = error instanceof Error && error.message.includes("尚未") ? error.message : "登录服务暂时不可用";
    return json(res, 503, { error: message });
  }
}

function handleAdminSession(req, res) {
  const session = requireAdmin(req, res);
  if (!session) return;
  return json(res, 200, { username: session.sub, csrf: session.csrf, expiresAt: session.exp });
}

function handleAdminLogout(req, res) {
  const session = requireAdmin(req, res);
  if (!session) return;
  if (!isSameOrigin(req) || req.headers["x-csrf-token"] !== session.csrf) {
    return json(res, 403, { error: "安全校验失败" });
  }
  console.info(`[admin] logout user=${session.sub} ip=${requestIp(req)}`);
  return json(res, 200, { ok: true }, { "Set-Cookie": adminSessionCookie("", 0) });
}

function handleAdminOrders(req, url, res) {
  if (!requireAdmin(req, res)) return;
  const requestedPage = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
  const requestedPageSize = Number.parseInt(url.searchParams.get("pageSize") ?? "20", 10);
  const page = Number.isFinite(requestedPage) ? Math.max(1, requestedPage) : 1;
  const pageSize = Number.isFinite(requestedPageSize) ? Math.min(100, Math.max(1, requestedPageSize)) : 20;
  const statusParam = url.searchParams.get("status") ?? "all";
  const status = ["paid", "pending", "failed"].includes(statusParam) ? statusParam : "all";
  const query = (url.searchParams.get("q") ?? "").trim().slice(0, 80);
  const clauses = [];
  const params = [];
  if (status !== "all") {
    clauses.push("status = ?");
    params.push(status);
  }
  if (query) {
    clauses.push("(out_trade_no LIKE ? ESCAPE '\\' OR transaction_id LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')");
    const pattern = `%${escapeLike(query)}%`;
    params.push(pattern, pattern, pattern);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const count = db.prepare(`SELECT COUNT(*) AS total FROM orders ${where}`).get(...params).total;
  const totalPages = Math.max(1, Math.ceil(count / pageSize));
  const safePage = Math.min(page, totalPages);
  const rows = db.prepare(`
    SELECT id, out_trade_no, openid, description, amount, status, transaction_id, paid_at, created_at, updated_at
    FROM orders ${where}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, (safePage - 1) * pageSize);
  const summary = orderSummary.get();
  return json(res, 200, {
    summary,
    orders: rows.map((row) => ({
      id: row.id,
      outTradeNo: row.out_trade_no,
      openidMasked: maskOpenid(row.openid),
      description: row.description,
      amount: row.amount,
      status: row.status,
      transactionId: row.transaction_id,
      paidAt: row.paid_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    pagination: { page: safePage, pageSize, total: count, totalPages },
  });
}

function parseCookies(req) {
  const result = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key) result[key] = decodeURIComponent(rest.join("="));
  }
  return result;
}

function signCookie(value, secret) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function verifySignedCookie(signedValue, secret) {
  if (!signedValue) return null;
  const separator = signedValue.lastIndexOf(".");
  if (separator < 1) return null;
  const value = signedValue.slice(0, separator);
  const actual = Buffer.from(signedValue.slice(separator + 1));
  const expected = Buffer.from(signCookie(value, secret));
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? value : null;
}

function rsaSign(message, privateKey) {
  return createSign("RSA-SHA256").update(message).end().sign(privateKey, "base64");
}

function headerValue(headers, name) {
  if (typeof headers.get === "function") return headers.get(name);
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function verifyWechatSignature(body, headers, publicKey, expectedKeyId) {
  const timestamp = headerValue(headers, "Wechatpay-Timestamp");
  const nonce = headerValue(headers, "Wechatpay-Nonce");
  const signature = headerValue(headers, "Wechatpay-Signature");
  const keyId = headerValue(headers, "Wechatpay-Serial");
  if (!timestamp || !nonce || !signature || keyId !== expectedKeyId) return false;
  return verifyRsa(
    "RSA-SHA256",
    Buffer.from(`${timestamp}\n${nonce}\n${body}\n`),
    publicKey,
    Buffer.from(signature, "base64"),
  );
}

async function createWechatJsapiOrder(openid, outTradeNo, product) {
  const config = paymentConfig();
  const apiPath = "/v3/pay/transactions/jsapi";
  const requestBody = JSON.stringify({
    appid: config.appId,
    mchid: config.mchId,
    description: product.description,
    out_trade_no: outTradeNo,
    notify_url: config.notifyUrl,
    amount: { total: product.amount, currency: "CNY" },
    payer: { openid },
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomString();
  const signature = rsaSign(`POST\n${apiPath}\n${timestamp}\n${nonce}\n${requestBody}\n`, config.merchantPrivateKey);
  const authorization =
    `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchId}",nonce_str="${nonce}",` +
    `timestamp="${timestamp}",serial_no="${config.merchantSerial}",signature="${signature}"`;
  const response = await fetch(`https://api.mch.weixin.qq.com${apiPath}`, {
    method: "POST",
    headers: { Authorization: authorization, Accept: "application/json", "Content-Type": "application/json" },
    body: requestBody,
  });
  const responseBody = await response.text();
  if (!verifyWechatSignature(responseBody, response.headers, config.publicKey, config.publicKeyId)) {
    throw new Error("微信支付响应验签失败");
  }
  if (!response.ok) {
    let detail = "微信支付下单失败";
    try { detail = JSON.parse(responseBody).message ?? detail; } catch {}
    throw new Error(detail);
  }
  const prepayId = JSON.parse(responseBody).prepay_id;
  if (!prepayId) throw new Error("微信支付未返回 prepay_id");
  const payTimestamp = Math.floor(Date.now() / 1000).toString();
  const payNonce = randomString();
  const packageValue = `prepay_id=${prepayId}`;
  const paySign = rsaSign(`${config.appId}\n${payTimestamp}\n${payNonce}\n${packageValue}\n`, config.merchantPrivateKey);
  return { appId: config.appId, timeStamp: payTimestamp, nonceStr: payNonce, package: packageValue, signType: "RSA", paySign };
}

function decryptNotification(resource, apiV3Key) {
  const ciphertext = Buffer.from(resource.ciphertext, "base64");
  const authTag = ciphertext.subarray(ciphertext.length - 16);
  const encrypted = ciphertext.subarray(0, ciphertext.length - 16);
  const { createDecipheriv } = awaitImportCrypto;
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(apiV3Key), Buffer.from(resource.nonce));
  decipher.setAAD(Buffer.from(resource.associated_data ?? ""));
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

// Kept outside request handlers so cryptographic primitives are initialized once.
const awaitImportCrypto = await import("node:crypto");

async function readBody(req, limit = 1_048_576) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("请求内容过大");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function handleCreateOrder(req, res) {
  try {
    let input;
    try { const raw = await readBody(req, 4096); input = raw ? JSON.parse(raw) : {}; }
    catch { return json(res, 400, { error: "订单请求格式无效" }); }
    const product = input && typeof input === 'object' && !Array.isArray(input) ? productFor(input.productId) : null;
    if (!product) return json(res, 400, { error: "课程不存在" });
    const config = paymentConfig();
    const origin = req.headers.origin;
    if (origin && origin !== SITE_ORIGIN) return json(res, 403, { error: "请求来源无效" });
    const openid = verifySignedCookie(parseCookies(req).wx_openid, config.cookieSecret);
    if (!openid) return json(res, 401, { oauthUrl: `/api/wechat/oauth/start?product=${product.id}` });
    const id = crypto.randomUUID();
    const outTradeNo = `SC${Date.now()}${randomBytes(5).toString("hex")}`;
    insertOrder.run(id, outTradeNo, openid, product.description, product.amount, product.id);
    try {
      const payment = await createWechatJsapiOrder(openid, outTradeNo, product);
      return json(res, 200, { orderId: id, payment });
    } catch (error) {
      failOrder.run(new Date().toISOString(), id);
      throw error;
    }
  } catch (error) {
    return json(res, 503, { error: error instanceof Error ? error.message : "订单服务暂时不可用" });
  }
}

function handleOrderStatus(req, url, res) {
  const openid = verifySignedCookie(parseCookies(req).wx_openid, paymentConfig().cookieSecret);
  if (!openid) return json(res, 401, { error: "请先通过微信授权" });
  const orderId = url.searchParams.get("orderId");
  if (!orderId) return json(res, 400, { error: "缺少订单号" });
  const order = getOrderStatus.get(orderId, openid);
  return order ? json(res, 200, order) : json(res, 404, { error: "订单不存在" });
}

function handleOauthStart(url, res) {
  try {
    const config = paymentConfig();
    const product = productFor(url.searchParams.get("product") ?? "statistics");
    if (!product) return json(res, 400, { error: "课程不存在" });
    const nonce = randomString(18);
    const state = `${nonce}.${product.id}.${signCookie(`${nonce}.${product.id}`, config.cookieSecret)}`;
    const callback = `${SITE_ORIGIN}/api/wechat/oauth/callback`;
    const authorize = new URL("https://open.weixin.qq.com/connect/oauth2/authorize");
    authorize.searchParams.set("appid", config.appId);
    authorize.searchParams.set("redirect_uri", callback);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", "snsapi_base");
    authorize.searchParams.set("state", state);
    redirect(res, `${authorize}#wechat_redirect`, [
      `wx_oauth_state=${state}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
    ]);
  } catch (error) {
    json(res, 503, { error: error instanceof Error ? error.message : "微信授权配置尚未完成" });
  }
}

async function handleOauthCallback(req, url, res) {
  try {
    const config = paymentConfig();
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const verifiedState = verifySignedCookie(state, config.cookieSecret);
    const product = verifiedState ? productFor(verifiedState.split(".")[1]) : null;
    if (!code || !state || !product || state !== parseCookies(req).wx_oauth_state) {
      return json(res, 400, { error: "微信授权校验失败，请返回课程页重试" });
    }
    const tokenUrl = new URL("https://api.weixin.qq.com/sns/oauth2/access_token");
    tokenUrl.searchParams.set("appid", config.appId);
    tokenUrl.searchParams.set("secret", config.appSecret);
    tokenUrl.searchParams.set("code", code);
    tokenUrl.searchParams.set("grant_type", "authorization_code");
    const response = await fetch(tokenUrl);
    const result = await response.json();
    if (!response.ok || !result.openid) throw new Error(result.errmsg ?? "未能获取微信用户标识");
    const signature = signCookie(result.openid, config.cookieSecret);
    redirect(res, `${SITE_ORIGIN}${product.path}?payment=ready`, [
      `wx_openid=${encodeURIComponent(`${result.openid}.${signature}`)}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`,
      "wx_oauth_state=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
    ]);
  } catch (error) {
    json(res, 502, { error: error instanceof Error ? error.message : "微信授权失败" });
  }
}

async function handleNotification(req, res) {
  try {
    const config = paymentConfig();
    const body = await readBody(req);
    if (!verifyWechatSignature(body, req.headers, config.publicKey, config.publicKeyId)) {
      return json(res, 401, { code: "FAIL", message: "签名校验失败" });
    }
    const notification = JSON.parse(body);
    if (!notification.resource) return json(res, 400, { code: "FAIL", message: "通知内容不完整" });
    const transaction = JSON.parse(decryptNotification(notification.resource, config.apiV3Key));
    if (notification.event_type !== "TRANSACTION.SUCCESS") return json(res, 400, { code: "FAIL", message: "通知类型无效" });
    const order = getOrderByTradeNo.get(transaction.out_trade_no ?? "");
    if (!order || !validTransaction(transaction, order, config)) {
      return json(res, 400, { code: "FAIL", message: "订单信息校验失败" });
    }
    markPaid.run(
      transaction.transaction_id ?? null,
      transaction.success_time ?? new Date().toISOString(),
      new Date().toISOString(),
      order.id,
    );
    return json(res, 200, { code: "SUCCESS", message: "成功" });
  } catch {
    return json(res, 500, { code: "FAIL", message: "回调处理失败" });
  }
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

function serveStatic(pathname, res) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safePath = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = resolve(join(STATIC_ROOT, safePath));
  if (!filePath.startsWith(`${STATIC_ROOT}/`) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    return json(res, 404, { error: "页面不存在" });
  }
  const body = readFileSync(filePath);
  const immutable = filePath.includes(`${join("", "assets")}/`);
  res.writeHead(200, {
    "Content-Type": mimeTypes[extname(filePath)] ?? "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    ...securityHeadersForStatic(filePath, body),
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", SITE_ORIGIN);
    if (req.method === "POST" && url.pathname === "/api/admin/login") return handleAdminLogin(req, res);
    if (req.method === "GET" && url.pathname === "/api/admin/session") return handleAdminSession(req, res);
    if (req.method === "POST" && url.pathname === "/api/admin/logout") return handleAdminLogout(req, res);
    if (req.method === "GET" && url.pathname === "/api/admin/orders") return handleAdminOrders(req, url, res);
    if (req.method === "POST" && url.pathname === "/api/orders") return handleCreateOrder(req, res);
    if (req.method === "GET" && url.pathname === "/api/orders") return handleOrderStatus(req, url, res);
    if (req.method === "GET" && url.pathname === "/api/wechat/oauth/start") return handleOauthStart(url, res);
    if (req.method === "GET" && url.pathname === "/api/wechat/oauth/callback") return handleOauthCallback(req, url, res);
    if (req.method === "POST" && ["/api/wechat/notify", "/api/pay/callback/wechat"].includes(url.pathname)) {
      return handleNotification(req, res);
    }
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "不支持的请求方式" });
    if (url.pathname === "/ai" || url.pathname === "/ai/") return serveStatic("/ai/index.html", res);
    if (url.pathname === "/ai/article" || url.pathname === "/ai/article/") return serveStatic("/ai/article.html", res);
    const pathname = url.pathname === "/admin" || url.pathname === "/admin/" ? "/admin/index.html" : url.pathname;
    return serveStatic(pathname, res);
  } catch {
    return json(res, 500, { error: "服务暂时不可用" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`statistics-course-pay listening on 127.0.0.1:${PORT}`);
});
