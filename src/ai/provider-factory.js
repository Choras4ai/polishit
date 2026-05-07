'use strict';

const OpenAIProvider = require('./openai-provider');
const OllamaProvider = require('./ollama-provider');
const AnthropicProvider = require('./anthropic-provider');
const ProxyProvider = require('./proxy-provider');
const { PRESETS } = require('./presets');

/**
 * Create an AI provider based on current config.
 * Resolves preset → provider type → concrete instance.
 */
function createProvider(providerConfig, commercialConfig = null) {
  if (commercialConfig?.enabled && commercialConfig?.backendUrl && commercialConfig?.authToken) {
    return new ProxyProvider({
      backendUrl: commercialConfig.backendUrl,
      authToken: commercialConfig.authToken,
      selectedModel: commercialConfig.selectedModel || '',
      onUnauthorized: commercialConfig.onUnauthorized,
    });
  }

  const presetId = providerConfig?.preset || 'custom';
  const preset = PRESETS[presetId];
  const providerType = preset?.providerType || providerConfig?.type || 'openai';
  const isCustomPreset = !preset || presetId === 'custom';

  const apiKey = providerConfig?.apiKey || '';
  if (!apiKey && presetId !== 'ollama') {
    throw new Error('请先在设置 → API 配置中填写 API Key。');
  }

  const apiUrl = isCustomPreset
    ? (providerConfig?.apiUrl || preset?.apiUrl || '')
    : (preset?.apiUrl || providerConfig?.apiUrl || '');
  const model = isCustomPreset
    ? (providerConfig?.model || preset?.model || '')
    : (preset?.model || providerConfig?.model || '');

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
