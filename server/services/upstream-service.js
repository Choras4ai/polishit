'use strict';

const { PRESETS } = require('../../src/ai/presets');
const { getChatTimeoutMs } = require('../../src/commercial/model-timeouts');
const { getModelById } = require('../commercial/models');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

function isRetryableError(err) {
  return err?.name === 'AbortError' || err?.name === 'TimeoutError' || err instanceof TypeError;
}

function assertUpstreamReady(upstream) {
  if (!upstream?.apiUrl || !upstream?.model) {
    const err = new Error('商业后端未配置可用的上游模型。');
    err.status = 503;
    throw err;
  }
  if (upstream.providerType !== 'ollama' && !upstream.apiKey) {
    const err = new Error('商业后端未配置上游 API Key。');
    err.status = 503;
    throw err;
  }
}

function resolveUpstreamConfig(config) {
  if (config.upstream.apiUrl && config.upstream.model) {
    return {
      providerType: config.upstream.providerType || 'openai',
      apiUrl: config.upstream.apiUrl.replace(/\/+$/, ''),
      apiKey: config.upstream.apiKey,
      model: config.upstream.model,
      source: 'env',
    };
  }

  const preset = PRESETS[config.upstream.preset] || PRESETS.together;

  return {
    providerType: preset.providerType || 'openai',
    apiUrl: preset.apiUrl.replace(/\/+$/, ''),
    apiKey: '',
    model: preset.model,
    source: `preset:${preset.id}`,
  };
}

function resolveModelUpstream(config, modelId) {
  const modelDef = getModelById(modelId);
  return {
    providerType: 'openai',
    apiUrl: config.siliconflow.apiUrl.replace(/\/+$/, ''),
    apiKey: config.siliconflow.apiKey,
    model: modelDef.model,
    source: `membership:${modelDef.id}`,
    credits: modelDef.credits,
    modelId: modelDef.id,
  };
}

async function proxyChat(upstream, messages, options = {}) {
  assertUpstreamReady(upstream);

  if (upstream.providerType !== 'openai') {
    throw new Error(`当前商业后端仅实现了 OpenAI 兼容上游，收到 providerType=${upstream.providerType}`);
  }

  const timeoutMs = getChatTimeoutMs({
    model: upstream.model,
    modelId: upstream.modelId,
    requestedTimeoutMs: options.timeoutMs || options.timeout,
  });

  const payload = JSON.stringify({
    model: upstream.model,
    messages,
    temperature: options.temperature ?? 0.3,
    max_tokens: options.maxTokens || 4096,
  });

  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${upstream.apiUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${upstream.apiKey}`,
        },
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const err = new Error(`上游模型请求失败 (${response.status})`);
        err.status = isRetryableStatus(response.status) ? 503 : 502;
        err.retryable = isRetryableStatus(response.status);
        if (attempt < 2 && err.retryable) {
          await sleep(300 * (attempt + 1));
          continue;
        }
        throw err;
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        const err = new Error('上游返回内容为空。');
        err.status = 502;
        throw err;
      }

      return String(content);
    } catch (err) {
      lastError = err;
      if (attempt < 2 && (err.retryable || isRetryableError(err))) {
        await sleep(300 * (attempt + 1));
        continue;
      }
      break;
    }
  }

  const err = new Error(lastError?.message || '上游模型请求失败。');
  err.status = Number(lastError?.status) || 502;
  throw err;
}

module.exports = { assertUpstreamReady, resolveUpstreamConfig, resolveModelUpstream, proxyChat };
