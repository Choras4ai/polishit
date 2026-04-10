'use strict';

const OpenAIProvider = require('./openai-provider');
const OllamaProvider = require('./ollama-provider');
const AnthropicProvider = require('./anthropic-provider');
const { PRESETS } = require('./presets');
const { getBuiltinKey, getSiliconFlowKey } = require('./builtin-key');

/**
 * Create an AI provider based on current config.
 * Resolves preset → provider type → concrete instance.
 */
function createProvider(providerConfig) {
  const presetId = providerConfig?.preset || 'custom';
  const preset = PRESETS[presetId];
  const providerType = preset?.providerType || providerConfig?.type || 'openai';

  // Resolve API key: built-in for Together AI / SiliconFlow, user-provided for others
  let apiKey = providerConfig?.apiKey || '';
  if (presetId === 'together' && !apiKey) {
    apiKey = getBuiltinKey();
  } else if (presetId === 'siliconflow' && !apiKey) {
    apiKey = getSiliconFlowKey();
  }

  const apiUrl = providerConfig?.apiUrl || preset?.apiUrl || '';
  const model = providerConfig?.model || preset?.model || '';

  switch (providerType) {
    case 'openai':
      return new OpenAIProvider({ apiUrl, apiKey, model });
    case 'anthropic':
      return new AnthropicProvider({ apiUrl, apiKey, model });
    case 'ollama':
      return new OllamaProvider({ apiUrl, model });
    default:
      throw new Error(`不支持的 AI 服务类型: ${providerType}`);
  }
}

module.exports = { createProvider };
