'use strict';

const BaseProvider = require('./base-provider');

class OllamaProvider extends BaseProvider {
  constructor(config) {
    super(config);
    this.apiUrl = (config.apiUrl || 'http://localhost:11434').replace(/\/+$/, '');
    this.model = config.model || 'qwen2.5';
  }

  async chat(messages, options = {}) {
    const url = `${this.apiUrl}/api/chat`;
    const body = {
      model: this.model,
      messages,
      stream: false,
      options: {
        temperature: options.temperature ?? 0.3,
        num_predict: options.maxTokens || 4096,
      },
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`Ollama 请求失败 (${response.status}): ${errBody || response.statusText}`);
    }

    const data = await response.json();
    const content = data.message?.content;
    if (!content) {
      throw new Error('Ollama 返回数据格式异常');
    }
    return content;
  }

  async testConnection() {
    const url = `${this.apiUrl}/api/tags`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new Error('无法连接到 Ollama，请确保 Ollama 正在运行。');
    }
    return true;
  }
}

module.exports = OllamaProvider;
