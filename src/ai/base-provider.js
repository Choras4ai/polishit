'use strict';

class BaseProvider {
  constructor(config) {
    this.config = config;
  }

  /**
   * Send chat completion request.
   * @param {Array<{role: string, content: string}>} messages
   * @param {{ temperature?: number, maxTokens?: number }} options
   * @returns {Promise<string>} Assistant response text
   */
  async chat(_messages, _options) {
    throw new Error('chat() must be implemented by subclass');
  }

  /**
   * Test provider connectivity.
   * @returns {Promise<boolean>}
   */
  async testConnection() {
    throw new Error('testConnection() must be implemented by subclass');
  }
}

module.exports = BaseProvider;
