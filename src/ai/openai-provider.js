'use strict';

const BaseProvider = require('./base-provider');

class OpenAIProvider extends BaseProvider {
  constructor(config) {
    super(config);
    this.apiUrl = (config.apiUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.model = config.model || 'gpt-4o';

    if (!this.apiKey) {
      throw new Error('API Key 未配置，请在设置中填写。');
    }
  }

  async chat(messages, options = {}) {
    const url = `${this.apiUrl}/chat/completions`;
    const body = {
      model: this.model,
      messages,
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens || 4096,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`API 请求失败 (${response.status}): ${errBody || response.statusText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('API 返回数据格式异常');
    }
    return content;
  }

  async testConnection() {
    await this.chat(
      [{ role: 'user', content: '你好' }],
      { maxTokens: 10, temperature: 0 },
    );
    return true;
  }
}

module.exports = OpenAIProvider;
