'use strict';
const { estimateMessageUnits } = require('./usage-service');
const { MAX_BILLABLE_CHARS } = require('../../src/commercial/credit-policy');

function validateChatRequest(body) {
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  const messages = body?.messages;
  const options = body?.options ?? {};
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 32) fail('messages 必须包含 1 至 32 条文本消息。');
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('options 必须是对象。');
  for (const message of messages) {
    if (!message || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string') fail('当前接口仅支持 system、user、assistant 角色的纯文本消息。');
  }
  if (!messages.some(message => message.role === 'user' && message.content.trim())) fail('用户文本不能为空。');
  const inputUnits = estimateMessageUnits(messages);
  if (inputUnits > 64000) fail('请求文本过长，请分段处理。');
  if (options.temperature != null && (typeof options.temperature !== 'number' || !Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 2)) fail('temperature 必须介于 0 和 2 之间。');
  if (options.billableChars != null && (typeof options.billableChars !== 'number' || !Number.isSafeInteger(options.billableChars) || options.billableChars <= 0)) fail('计费字数必须是正整数。');
  const billableChars = options.billableChars ?? inputUnits;
  if (billableChars > MAX_BILLABLE_CHARS) fail(`单次计费文本最多 ${MAX_BILLABLE_CHARS} 字，请分段处理。`);
  if (body.model != null && (typeof body.model !== 'string' || body.model.length > 200)) fail('模型参数无效。');
  if (body.task != null && !['polish', 'deai'].includes(body.task)) fail('任务类型无效。');
  return { messages, options, inputUnits, billableChars, requestedModel: body.model || '' };
}
module.exports = { validateChatRequest };
