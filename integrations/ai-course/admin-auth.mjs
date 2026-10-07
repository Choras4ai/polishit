import { createHmac, scryptSync, timingSafeEqual } from "node:crypto";

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function safeEqual(left, right) {
  const leftDigest = createHmac("sha256", "constant-time-compare").update(String(left)).digest();
  const rightDigest = createHmac("sha256", "constant-time-compare").update(String(right)).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function hashPassword(password, salt) {
  if (typeof password !== "string" || password.length < 12) {
    throw new Error("管理员密码至少需要 12 个字符");
  }
  const params = { N: 16384, r: 8, p: 1 };
  const derived = scryptSync(password, salt, 64, { ...params, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export function verifyPassword(password, encoded) {
  try {
    const [algorithm, n, r, p, salt, expected] = String(encoded).split("$");
    if (algorithm !== "scrypt" || !n || !r || !p || !salt || !expected) return false;
    const derived = scryptSync(String(password), Buffer.from(salt, "base64url"), 64, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    });
    const expectedBuffer = Buffer.from(expected, "base64url");
    return derived.length === expectedBuffer.length && timingSafeEqual(derived, expectedBuffer);
  } catch {
    return false;
  }
}

function sessionSignature(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createAdminSession(username, secret, csrf, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({
    sub: username,
    iat: now,
    exp: now + SESSION_TTL_MS,
    csrf,
  })).toString("base64url");
  return `${payload}.${sessionSignature(payload, secret)}`;
}

export function verifyAdminSession(token, secret, now = Date.now()) {
  if (!token || !secret) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const actual = token.slice(dot + 1);
  if (!safeEqual(actual, sessionSignature(payload, secret))) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (
      typeof session.sub !== "string" ||
      typeof session.csrf !== "string" ||
      typeof session.iat !== "number" ||
      typeof session.exp !== "number" ||
      session.exp <= now ||
      session.iat > now + 60_000
    ) return null;
    return session;
  } catch {
    return null;
  }
}

export function safeUsernameMatch(actual, expected) {
  return safeEqual(String(actual), String(expected));
}
