'use strict';

/**
 * Cost guard — tracks daily/monthly API spend and enforces thresholds.
 *
 * When thresholds are exceeded:
 *   1. Degrade to free model (Qwen3-8B)
 *   2. Block free-tier users (only allow paid)
 *   3. Full stop (emergency)
 *
 * Cost is estimated from token usage × model pricing.
 */

class CostGuard {
  constructor(cfg = {}) {
    this.dailyLimitYuan = cfg.dailyLimitYuan || 500;
    this.monthlyLimitYuan = cfg.monthlyLimitYuan || 10000;
    this.degradeAtPercent = cfg.degradeAtPercent || 80; // Start degrading at 80% of limit
    this.alertWebhookUrl = cfg.alertWebhookUrl || process.env.RUNSHI_COST_ALERT_WEBHOOK || '';

    // In-memory cost tracking (reset on restart, but also persisted to DB)
    this.dailyCost = 0; // in yuan
    this.monthlyCost = 0;
    this.currentDay = this._dayKey();
    this.currentMonth = this._monthKey();
    this._alertSentDaily = false;
    this._alertSentMonthly = false;
  }

  _dayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  _monthKey() {
    return new Date().toISOString().slice(0, 7);
  }

  _checkReset() {
    const day = this._dayKey();
    const month = this._monthKey();
    if (day !== this.currentDay) {
      this.dailyCost = 0;
      this.currentDay = day;
      this._alertSentDaily = false;
    }
    if (month !== this.currentMonth) {
      this.monthlyCost = 0;
      this.currentMonth = month;
      this._alertSentMonthly = false;
    }
  }

  /**
   * Record cost of an API call.
   * @param {number} costYuan - Cost in yuan
   */
  recordCost(costYuan) {
    this._checkReset();
    this.dailyCost += costYuan;
    this.monthlyCost += costYuan;

    // Send alert when cost reaches 80% of limit
    const dailyPercent = (this.dailyCost / this.dailyLimitYuan) * 100;
    const monthlyPercent = (this.monthlyCost / this.monthlyLimitYuan) * 100;
    if (dailyPercent >= 80 && !this._alertSentDaily) {
      this._alertSentDaily = true;
      this._sendAlert(`日成本已达 ¥${this.dailyCost.toFixed(2)}（${dailyPercent.toFixed(0)}%），上限 ¥${this.dailyLimitYuan}`);
    }
    if (monthlyPercent >= 80 && !this._alertSentMonthly) {
      this._alertSentMonthly = true;
      this._sendAlert(`月成本已达 ¥${this.monthlyCost.toFixed(2)}（${monthlyPercent.toFixed(0)}%），上限 ¥${this.monthlyLimitYuan}`);
    }
  }

  /**
   * Send cost alert via webhook (fire-and-forget).
   */
  _sendAlert(message) {
    const url = this.alertWebhookUrl;
    if (!url) {
      console.warn(`[cost-guard] ⚠️ ALERT: ${message} (no webhook configured)`);
      return;
    }
    const body = JSON.stringify({
      msgtype: 'text',
      text: { content: `[润石成本告警] ${message}\n时间: ${new Date().toISOString()}` },
    });
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(5000),
    }).catch((err) => {
      console.error(`[cost-guard] webhook failed: ${err.message}`);
    });
  }

  /**
   * Estimate cost of a call based on input/output tokens and model pricing.
   * @param {number} inputTokens
   * @param {number} outputTokens
   * @param {object} model - Model definition with inputPrice/outputPrice (per 1K tokens, in yuan)
   * @returns {number} Estimated cost in yuan
   */
  estimateCost(inputTokens, outputTokens, model) {
    const inputCost = (inputTokens / 1000) * (model.inputPrice || 0.002);
    const outputCost = (outputTokens / 1000) * (model.outputPrice || 0.003);
    return inputCost + outputCost;
  }

  /**
   * Get current cost control decision.
   * @param {boolean} isPaidUser - Whether the requester is a paid user
   * @returns {{ allowed: boolean, degrade: boolean, reason?: string, fallbackModel?: string }}
   */
  getDecision(isPaidUser = false) {
    this._checkReset();

    const dailyPercent = (this.dailyCost / this.dailyLimitYuan) * 100;
    const monthlyPercent = (this.monthlyCost / this.monthlyLimitYuan) * 100;

    // Emergency stop: over 100% of daily or monthly limit
    if (dailyPercent >= 100 || monthlyPercent >= 100) {
      return {
        allowed: false,
        degrade: true,
        reason: '系统成本已达日/月上限，服务暂停，请稍后再试。',
      };
    }

    // Over 90%: only paid users can proceed, force degraded model
    if (dailyPercent >= 90 || monthlyPercent >= 90) {
      if (!isPaidUser) {
        return {
          allowed: false,
          degrade: true,
          reason: '系统繁忙，免费用户暂时无法使用，请购买积分包。',
        };
      }
      return {
        allowed: true,
        degrade: true,
        reason: '成本接近上限，已自动切换至经济模型。',
        fallbackModel: 'qwen3-8b',
      };
    }

    // Over degradeAtPercent: degrade to cheaper model
    if (dailyPercent >= this.degradeAtPercent || monthlyPercent >= this.degradeAtPercent) {
      return {
        allowed: true,
        degrade: true,
        reason: '流量高峰，已自动切换至经济模型以控制成本。',
        fallbackModel: 'qwen3-8b',
      };
    }

    return { allowed: true, degrade: false };
  }

  getStatus() {
    this._checkReset();
    return {
      dailyCost: Math.round(this.dailyCost * 100) / 100,
      dailyLimit: this.dailyLimitYuan,
      dailyPercent: Math.round((this.dailyCost / this.dailyLimitYuan) * 100),
      monthlyCost: Math.round(this.monthlyCost * 100) / 100,
      monthlyLimit: this.monthlyLimitYuan,
      monthlyPercent: Math.round((this.monthlyCost / this.monthlyLimitYuan) * 100),
    };
  }

  /**
   * Load accumulated costs from database (call on startup).
   */
  async loadFromDb(db) {
    this._checkReset();
    const dayStart = this.currentDay + 'T00:00:00.000Z';
    const monthStart = this.currentMonth + '-01T00:00:00.000Z';

    const dailyRow = await db.get(
      `SELECT COALESCE(SUM(
        CASE WHEN json_extract(meta_json, '$.estimatedCostYuan') IS NOT NULL
             THEN CAST(json_extract(meta_json, '$.estimatedCostYuan') AS REAL)
             ELSE 0 END
      ), 0) AS total
       FROM usage_logs
       WHERE created_at >= ? AND kind IN ('credits_ai_chat', 'trial_ai_chat', 'membership_ai_chat')`,
      [dayStart],
    );

    const monthlyRow = await db.get(
      `SELECT COALESCE(SUM(
        CASE WHEN json_extract(meta_json, '$.estimatedCostYuan') IS NOT NULL
             THEN CAST(json_extract(meta_json, '$.estimatedCostYuan') AS REAL)
             ELSE 0 END
      ), 0) AS total
       FROM usage_logs
       WHERE created_at >= ? AND kind IN ('credits_ai_chat', 'trial_ai_chat', 'membership_ai_chat')`,
      [monthStart],
    );

    this.dailyCost = Number(dailyRow?.total || 0);
    this.monthlyCost = Number(monthlyRow?.total || 0);
    console.log(`[cost-guard] loaded: daily=¥${this.dailyCost.toFixed(2)} monthly=¥${this.monthlyCost.toFixed(2)}`);
  }
}

const costGuard = new CostGuard();

module.exports = { CostGuard, costGuard };
