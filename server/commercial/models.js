'use strict';

/**
 * Available models for credits users.
 * All models are proxied through SiliconFlow's OpenAI-compatible API.
 *
 * Pricing (¥9.9 / 300 credits):
 * - 每次润色约 800 input + 1000 output tokens
 * - Qwen3-8B: 免费，成本 ¥0 → 100% 利润
 * - DS-V3.2 / Kimi-K2.5: ~¥0.0096/次 × 300 = ¥2.88 → 利润 70.9%
 * - Qwen3.5-397B: ~¥0.0082/次 × 150 = ¥1.23 → 利润 87.6%
 * - GLM-5.1: ~¥0.0288/次 × 100 = ¥2.88 → 利润 70.9%
 */
const MEMBERSHIP_MODELS = [
  // ── 免费 (0 积分) ──
  {
    id: 'qwen3-8b',
    name: 'Qwen3-8B',
    provider: '通义千问',
    model: 'Qwen/Qwen3-8B',
    credits: 0.5,
    description: '极速模型，适合快速草稿润色',
    badge: '极速',
    tier: '基础',
    inputPrice: 0,
    outputPrice: 0,
  },
  // ── 1 积分 ──
  {
    id: 'kimi-k2.6',
    name: 'Kimi-K2.6',
    provider: 'Moonshot',
    model: 'Pro/moonshotai/Kimi-K2.6',
    credits: 1,
    description: 'Moonshot 最新旗舰，原生多模态智能体',
    badge: '新',
    tier: '标准',
    inputPrice: 0.002,
    outputPrice: 0.008,
  },
  {
    id: 'kimi-k2.5',
    name: 'Kimi-K2.5',
    provider: 'Moonshot',
    model: 'Pro/moonshotai/Kimi-K2.5',
    credits: 1,
    description: 'Moonshot 旗舰，中文理解力强',
    badge: '',
    tier: '标准',
    inputPrice: 0.002,
    outputPrice: 0.008,
  },
  {
    id: 'glm-4.7',
    name: 'GLM-4.7',
    provider: '智谱',
    model: 'Pro/zai-org/GLM-4.7',
    credits: 1,
    description: '智谱新一代，快速高效',
    badge: '',
    tier: '标准',
    inputPrice: 0.002,
    outputPrice: 0.008,
  },
  {
    id: 'deepseek-v3-671b',
    name: 'DeepSeek-V3',
    provider: 'DeepSeek',
    model: 'Pro/deepseek-ai/DeepSeek-V3',
    credits: 1,
    description: 'DeepSeek 671B MoE，性价比高',
    badge: '',
    tier: '标准',
    inputPrice: 0.002,
    outputPrice: 0.008,
  },
  // ── 2 积分 ──
  {
    id: 'deepseek-v3.2',
    name: 'DeepSeek-V3.2',
    provider: 'DeepSeek',
    model: 'Pro/deepseek-ai/DeepSeek-V3.2',
    credits: 2,
    description: 'DeepSeek 最新旗舰，中文润色效果出色',
    badge: '',
    tier: '高级',
    inputPrice: 0.002,
    outputPrice: 0.008,
  },
  {
    id: 'qwen3.5-397b',
    name: 'Qwen3.5-397B',
    provider: '通义千问',
    model: 'Qwen/Qwen3.5-397B-A17B',
    credits: 2,
    description: '阿里旗舰 397B MoE，效果出色',
    badge: '',
    tier: '高级',
    inputPrice: 0.0012,
    outputPrice: 0.0072,
  },
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek-V4-Flash',
    provider: 'DeepSeek',
    model: 'deepseek-ai/DeepSeek-V4-Flash',
    credits: 2,
    description: 'DeepSeek-V4 系列预览版 MoE，284B 总参/13B 激活，1M 上下文',
    badge: '新',
    tier: '高级',
    inputPrice: 0.002,
    outputPrice: 0.008,
  },
  // ── 3 积分 ──
  {
    id: 'glm-5.1',
    name: 'GLM-5.1',
    provider: '智谱',
    model: 'Pro/zai-org/GLM-5.1',
    credits: 3,
    description: '智谱最强旗舰 754B MoE，效果最佳',
    badge: '旗舰',
    tier: '旗舰',
    inputPrice: 0.006,
    outputPrice: 0.024,
  },
  {
    id: 'minimax-m2.5',
    name: 'MiniMax-M2.5',
    provider: 'MiniMax',
    model: 'Pro/MiniMaxAI/MiniMax-M2.5',
    credits: 3,
    description: 'MiniMax 最新大语言模型',
    badge: '',
    tier: '旗舰',
    inputPrice: 0.006,
    outputPrice: 0.024,
  },
];

const DEFAULT_MODEL_ID = 'kimi-k2.5';

function getModelById(modelId) {
  return MEMBERSHIP_MODELS.find(m => m.id === modelId) || MEMBERSHIP_MODELS[0];
}

function getModelList() {
  return MEMBERSHIP_MODELS.map(m => ({
    id: m.id,
    name: m.name,
    provider: m.provider,
    credits: m.credits,
    description: m.description,
    badge: m.badge,
    tier: m.tier || '',
  }));
}

module.exports = {
  MEMBERSHIP_MODELS,
  DEFAULT_MODEL_ID,
  getModelById,
  getModelList,
};
