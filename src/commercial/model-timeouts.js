'use strict';

const DEFAULT_CHAT_TIMEOUT_MS = 60_000;
const LARGE_MODEL_CHAT_TIMEOUT_MS = 180_000;
const PROXY_TIMEOUT_BUFFER_MS = 30_000;

const LARGE_MODEL_IDS = new Set([
  'qwen3.5-397b',
  'glm-5.1',
  'minimax-m2.5',
]);

const LARGE_MODEL_PATTERNS = [
  /Qwen\/Qwen3\.5-397B-A17B/i,
  /GLM-5\.1/i,
  /MiniMax-M2\.5/i,
];

function normalizeTimeoutMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.round(numeric);
}

function isLongRunningModel({ model = '', modelId = '' } = {}) {
  if (LARGE_MODEL_IDS.has(String(modelId || '').trim())) {
    return true;
  }

  const modelName = String(model || '').trim();
  return LARGE_MODEL_PATTERNS.some((pattern) => pattern.test(modelName));
}

function getChatTimeoutMs({ model = '', modelId = '', requestedTimeoutMs } = {}) {
  const requested = normalizeTimeoutMs(requestedTimeoutMs);
  if (requested > 0) return requested;
  return isLongRunningModel({ model, modelId })
    ? LARGE_MODEL_CHAT_TIMEOUT_MS
    : DEFAULT_CHAT_TIMEOUT_MS;
}

function getProxyTimeoutMs({ model = '', modelId = '', requestedTimeoutMs } = {}) {
  return getChatTimeoutMs({ model, modelId, requestedTimeoutMs }) + PROXY_TIMEOUT_BUFFER_MS;
}

module.exports = {
  DEFAULT_CHAT_TIMEOUT_MS,
  LARGE_MODEL_CHAT_TIMEOUT_MS,
  PROXY_TIMEOUT_BUFFER_MS,
  getChatTimeoutMs,
  getProxyTimeoutMs,
  isLongRunningModel,
};