'use strict';

/**
 * Curated Chinese-writing catalog, verified against the authenticated .cn
 * /v1/models endpoint and https://www.siliconflow.cn/pricing on 2026-09-15.
 * Do not import every upstream model: code-only, retired and less familiar
 * families stay out of the consumer picker. Prices are CNY per 1M tokens.
 * Flash uses the regular-hours rate as the conservative cost ceiling;
 * the existing profit guard also covers prompt size and output allowance.
 */
const PRICING_VERIFIED_AT = '2026-09-15';
const MEMBERSHIP_MODELS = [
  { id: 'qwen3-8b', name: '通义千问 Qwen3-8B', provider: '通义千问',
    model: 'Qwen/Qwen3-8B', credits: 1, description: '基础文字整理与短句修改', badge: '基础', tier: '基础',
    inputPricePerMTokens: 0, outputPricePerMTokens: 0 },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4-Flash', provider: 'DeepSeek',
    model: 'deepseek-ai/DeepSeek-V4-Flash', credits: 3, description: '日常中文润色与改写', badge: '推荐', tier: '标准',
    inputPricePerMTokens: 3, outputPricePerMTokens: 9 },
  { id: 'qwen3.8-27b', name: '通义千问 Qwen3.8-27B', provider: '通义千问',
    model: 'Qwen/Qwen3.8-27B', credits: 4, description: '中文表达、语句调整与风格改写', badge: '新', tier: '标准',
    inputPricePerMTokens: 3, outputPricePerMTokens: 12 },
  { id: 'deepseek-v3.2', name: 'DeepSeek V3.2', provider: 'DeepSeek',
    model: 'deepseek-ai/DeepSeek-V3.2', credits: 4, description: '通用文字修改与段落梳理', badge: '', tier: '标准',
    inputPricePerMTokens: 4, outputPricePerMTokens: 6 },
  { id: 'kimi-k2.6', name: 'Kimi K2.6 Pro', provider: '月之暗面 Kimi',
    model: 'Pro/moonshotai/Kimi-K2.6', credits: 8, description: '长篇材料梳理与综合改写', badge: '长文', tier: '高级',
    inputPricePerMTokens: 6.5, outputPricePerMTokens: 27 },
  { id: 'glm-5.3', name: '智谱 GLM-5.3', provider: '智谱',
    model: 'zai-org/GLM-5.3', credits: 9, description: '专业表达与复杂文本修改', badge: '新', tier: '高级',
    inputPricePerMTokens: 8, outputPricePerMTokens: 28 },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4-Pro', provider: 'DeepSeek',
    model: 'deepseek-ai/DeepSeek-V4-Pro', credits: 11, description: '复杂语义与高要求专业润色', badge: '', tier: '高级',
    inputPricePerMTokens: 12, outputPricePerMTokens: 24 },
];
const DEFAULT_MODEL_ID = 'deepseek-v4-flash';

function getModelById(modelId) {
  const model = MEMBERSHIP_MODELS.find(m => m.id === (modelId || DEFAULT_MODEL_ID));
  if (model) return model;
  const error = new Error('所选模型已下架或不再提供，请刷新模型列表后重新选择。');
  error.status = 400;
  throw error;
}

function getModelList() {
  return MEMBERSHIP_MODELS.map(m => ({
    id: m.id, name: m.name, provider: m.provider, credits: m.credits,
    description: m.description, badge: m.badge, tier: m.tier,
    pricingVerifiedAt: PRICING_VERIFIED_AT, isDefault: m.id === DEFAULT_MODEL_ID,
  }));
}
module.exports = { MEMBERSHIP_MODELS, DEFAULT_MODEL_ID, PRICING_VERIFIED_AT, getModelById, getModelList };
