'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateChatRequest } = require('../server/services/chat-request');
const messages = [{ role: 'user', content: '这是一段文本。' }];
test('invalid billing values cannot create a free request', () => {
  for (const billableChars of [-1, 0, Infinity, NaN, '1', {}, 1.2]) {
    assert.throws(() => validateChatRequest({ messages, options: { billableChars } }), { status: 400 });
  }
});
test('unsupported content and oversized messages are rejected before upstream use', () => {
  for (const body of [{ messages: [null] }, { messages: [{ role: 'user', content: [{ image_url: 'https://example.test' }] }] }, { messages, options: [] }, { messages: [{ role: 'user', content: 'x'.repeat(64001) }] }]) {
    assert.throws(() => validateChatRequest(body), { status: 400 });
  }
});
test('valid text and zero temperature remain supported', () => {
  const parsed = validateChatRequest({ messages, options: { temperature: 0 } });
  assert.equal(parsed.inputUnits, messages[0].content.length);
  assert.equal(parsed.billableChars, parsed.inputUnits);
});
