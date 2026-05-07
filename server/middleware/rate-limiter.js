'use strict';

/**
 * In-memory sliding window rate limiter.
 * Supports per-device, per-IP, and global QPS limiting.
 * No Redis needed for single-instance deployment.
 *
 * ⚠️ 横向扩展备注: 多实例部署时需改用 Redis-backed 限流
 *    推荐方案: ioredis + Lua sliding window 或 @upstash/ratelimit
 */

class SlidingWindowCounter {
  constructor() {
    // key -> { timestamps: number[], lastCleanup: number }
    this.buckets = new Map();
    // Cleanup stale entries every 5 minutes
    this.cleanupInterval = setInterval(() => this._globalCleanup(), 5 * 60 * 1000);
    this.cleanupInterval.unref();
  }

  /**
   * Check if a request is allowed and record it.
   * @param {string} key - Unique key (deviceId, IP, 'global')
   * @param {number} limit - Max requests allowed in the window
   * @param {number} windowMs - Window size in milliseconds
   * @returns {{ allowed: boolean, remaining: number, retryAfterMs: number }}
   */
  check(key, limit, windowMs) {
    const now = Date.now();
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = { timestamps: [], lastCleanup: now };
      this.buckets.set(key, bucket);
    }

    // Remove expired timestamps
    const cutoff = now - windowMs;
    bucket.timestamps = bucket.timestamps.filter(t => t > cutoff);
    bucket.lastCleanup = now;

    if (bucket.timestamps.length >= limit) {
      const oldestInWindow = bucket.timestamps[0];
      const retryAfterMs = oldestInWindow + windowMs - now;
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(0, retryAfterMs),
      };
    }

    bucket.timestamps.push(now);
    return {
      allowed: true,
      remaining: limit - bucket.timestamps.length,
      retryAfterMs: 0,
    };
  }

  /**
   * Get current count without incrementing.
   */
  peek(key, windowMs) {
    const bucket = this.buckets.get(key);
    if (!bucket) return 0;
    const cutoff = Date.now() - windowMs;
    return bucket.timestamps.filter(t => t > cutoff).length;
  }

  _globalCleanup() {
    const cutoff = Date.now() - 10 * 60 * 1000; // Remove buckets inactive > 10min
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastCleanup < cutoff) {
        this.buckets.delete(key);
      }
    }
  }

  destroy() {
    clearInterval(this.cleanupInterval);
    this.buckets.clear();
  }
}

const counter = new SlidingWindowCounter();

/**
 * Create rate-limiting Express middleware.
 *
 * @param {object} cfg - Rate limit config from server config
 * @returns {Function} Express middleware
 */
function createRateLimiter(cfg) {
  const perDevicePerMinute = cfg.rateLimit?.perDevicePerMinute || 20;
  const perDevicePerDay = cfg.rateLimit?.perDevicePerDay || 500;
  const globalQps = cfg.rateLimit?.globalQps || 400;

  return function rateLimiter(req, res, next) {
    // Identify requester: device ID from auth, or IP fallback
    const deviceId = req.deviceId || null;
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const identity = deviceId ? `device:${deviceId}` : `ip:${ip}`;

    // 1. Global QPS check (1-second window)
    const globalResult = counter.check('global:qps', globalQps, 1000);
    if (!globalResult.allowed) {
      res.set('Retry-After', String(Math.ceil(globalResult.retryAfterMs / 1000)));
      res.status(429).json({
        ok: false,
        error: '系统繁忙，请稍后重试。',
        retryAfterMs: globalResult.retryAfterMs,
      });
      return;
    }

    // 2. Per-device/IP per-minute check
    const minuteResult = counter.check(`${identity}:min`, perDevicePerMinute, 60 * 1000);
    if (!minuteResult.allowed) {
      res.set('Retry-After', String(Math.ceil(minuteResult.retryAfterMs / 1000)));
      res.status(429).json({
        ok: false,
        error: `请求过于频繁，请在 ${Math.ceil(minuteResult.retryAfterMs / 1000)} 秒后重试。`,
        retryAfterMs: minuteResult.retryAfterMs,
      });
      return;
    }

    // 3. Per-device/IP per-day check
    const dayResult = counter.check(`${identity}:day`, perDevicePerDay, 24 * 60 * 60 * 1000);
    if (!dayResult.allowed) {
      res.status(429).json({
        ok: false,
        error: '今日调用次数已达上限，请明日再试。',
        retryAfterMs: dayResult.retryAfterMs,
      });
      return;
    }

    // Attach rate info to response headers
    res.set('X-RateLimit-Remaining', String(minuteResult.remaining));
    next();
  };
}

module.exports = { createRateLimiter, SlidingWindowCounter, counter };
