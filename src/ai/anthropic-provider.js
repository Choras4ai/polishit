'use strict';

const BaseProvider = require('./base-provider');

class AnthropicProvider extends BaseProvider {
  constructor(config) {
    super(config);
    this.apiUrl = (config.apiUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.model = config.model || 'claude-sonnet-4-20250514';

    if (!this.apiKey) {
      throw new Error('Anthropic API Key 未配置，请在设置中填写。');
    }
  }

  async chat(messages, options = {}) {
    const url = `${this.apiUrl}/v1/messages`;

    // Convert OpenAI-style messages to Anthropic format
    let system = '';
    const anthropicMessages = [];
    for (const msg of messages) {
      if (msg.role === 'system') {
        system += (system ? '\n' : '') + msg.content;
      } else {
        anthropicMessages.push({ role: msg.role, content: msg.content });
      }
    }

    const body = {
      model: this.model,
      max_tokens: options.maxTokens || 4096,
      messages: anthropicMessages,
    };
    if (system) body.system = system;
    if (options.temperature != null) body.temperature = options.temperature;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`Anthropic 请求失败 (${response.status}): ${errBody || response.statusText}`);
    }

    const data = await response.json();
    if (data.stop_reason === 'max_tokens' && options.requireComplete !== false) {
      throw new Error('模型输出达到长度上限，结果可能不完整。请缩短选区后重试。');
    }
    const textBlock = data.content?.find(b => b.type === 'text');
    if (!textBlock?.text) {
      throw new Error('Anthropic 返回数据格式异常');
    }
    return textBlock.text;
  }

  async testConnection() {
    await this.chat(
      [{ role: 'user', content: '你好' }],
      { maxTokens: 10, temperature: 0, requireComplete: false },
    );
    return true;
  }
}

module.exports = AnthropicProvider;
