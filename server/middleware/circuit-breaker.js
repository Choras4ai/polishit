'use strict';

/**
 * Circuit breaker for upstream API calls.
 *
 * States:
 *   CLOSED  → Normal operation, requests pass through
 *   OPEN    → Tripped, all requests rejected immediately
 *   HALF_OPEN → Testing if upstream recovered (allow 1 probe request)
 *
 * Trips when:
 *   - Error rate > failureThreshold (default 10%) in the observation window
 *   - OR average latency > latencyThreshold (default 5000ms)
 *
 * Recovery:
 *   - After openDurationMs (default 60s), moves to HALF_OPEN
 *   - If probe succeeds → CLOSED; if fails → OPEN again
 */

const STATES = { CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half_open' };

class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold ?? 0.1; // 10%
    this.latencyThreshold = options.latencyThreshold ?? 5000; // 5s
    this.windowSize = options.windowSize ?? 20; // Min samples before evaluating
    this.openDurationMs = options.openDurationMs ?? 60 * 1000; // 1 min

    this.state = STATES.CLOSED;
    this.openedAt = 0;
    this.probeInFlight = false;
    this.records = []; // { success: boolean, latencyMs: number, timestamp: number }
    this.observationWindowMs = options.observationWindowMs ?? 60 * 1000;
  }

  /**
   * Check if circuit allows a request.
   * @returns {{ allowed: boolean, state: string, reason?: string }}
   */
  canRequest() {
    if (this.state === STATES.CLOSED) {
      return { allowed: true, state: this.state };
    }

    if (this.state === STATES.OPEN) {
      if (Date.now() - this.openedAt >= this.openDurationMs) {
        this.state = STATES.HALF_OPEN;
        this.probeInFlight = false;
      }
      if (this.state === STATES.OPEN) {
        const waitMs = this.openDurationMs - (Date.now() - this.openedAt);
        return {
          allowed: false,
          state: this.state,
          reason: `系统繁忙，熔断中（${Math.ceil(waitMs / 1000)}s 后恢复）`,
        };
      }
    }

    if (this.state === STATES.HALF_OPEN) {
      if (this.probeInFlight) {
        return {
          allowed: false,
          state: this.state,
          reason: '系统正在探测恢复，请稍后再试。',
        };
      }
      this.probeInFlight = true;
      return { allowed: true, state: this.state, reason: '探测请求' };
    }

    return { allowed: true, state: this.state };
  }

  /**
   * Record a request result.
   */
  recordSuccess(latencyMs) {
    this._addRecord(true, latencyMs);

    if (this.state === STATES.HALF_OPEN) {
      // Probe succeeded → close circuit
      this.state = STATES.CLOSED;
      this.probeInFlight = false;
      this.records = [];
    }
  }

  recordFailure(latencyMs) {
    this._addRecord(false, latencyMs);

    if (this.state === STATES.HALF_OPEN) {
      // Probe failed → reopen
      this.probeInFlight = false;
      this._trip();
      return;
    }

    this._evaluate();
  }

  _addRecord(success, latencyMs) {
    const now = Date.now();
    this.records.push({ success, latencyMs, timestamp: now });

    // Trim old records
    const cutoff = now - this.observationWindowMs;
    this.records = this.records.filter(r => r.timestamp > cutoff);
  }

  _evaluate() {
    if (this.records.length < this.windowSize) return;

    const failures = this.records.filter(r => !r.success).length;
    const failureRate = failures / this.records.length;

    const avgLatency = this.records.reduce((s, r) => s + r.latencyMs, 0) / this.records.length;

    if (failureRate > this.failureThreshold || avgLatency > this.latencyThreshold) {
      this._trip();
    }
  }

  _trip() {
    this.state = STATES.OPEN;
    this.openedAt = Date.now();
    this.probeInFlight = false;
    console.log(`[circuit-breaker] TRIPPED → OPEN (will recover in ${this.openDurationMs / 1000}s)`);
  }

  getStatus() {
    const failures = this.records.filter(r => !r.success).length;
    const failureRate = this.records.length > 0 ? failures / this.records.length : 0;
    const avgLatency = this.records.length > 0
      ? Math.round(this.records.reduce((s, r) => s + r.latencyMs, 0) / this.records.length)
      : 0;

    return {
      state: this.state,
      probeInFlight: this.probeInFlight,
      totalRequests: this.records.length,
      failures,
      failureRate: Math.round(failureRate * 100),
      avgLatencyMs: avgLatency,
    };
  }
}

// Singleton breaker for the main upstream
const breaker = new CircuitBreaker();

module.exports = { CircuitBreaker, breaker, STATES };
