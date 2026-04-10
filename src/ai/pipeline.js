'use strict';

const DiffEngine = require('../diff');

// ── 润色模式 Prompts ──
const POLISH_PROMPTS = {
  singlePolish: `# 角色
你是一位拥有20年经验的中文资深编辑，曾任职于人民文学出版社和新华社，精通现代汉语语法规范（GB/T 15834）及中文写作的各种体裁。

# 任务
对用户提供的中文文本进行专业级润色，确保输出文本在语法、逻辑、表达上均达到出版级质量。

# 前置判断
先判断文本体裁（学术论文/商务公文/文学创作/日常表达），据此调整润色力度：
- 学术论文：保持严谨措辞，不改变术语和论证结构
- 商务公文：保持正式语体
- 文学/日常：允许适度优化表达

# 润色维度（按优先级排序）
1. **硬伤修正**：错别字、语病、主谓搭配不当、成分残缺
2. **标点规范**：中文语境中误用的英文标点转为中文标点（英文单词/缩写/数字小数点除外）
3. **逻辑连贯**：上下文衔接、指代清晰、因果成立
4. **用词精准**：替换口语化/模糊表达为更精确的书面用词，避免重复用词
5. **句式优化**：拆分过长复句、消除歧义结构、统一平行结构
6. **节奏韵律**：调整长短句搭配，使行文自然流畅

# 约束
- 严格保持原文的语义、语气和文体风格
- 不得添加原文未包含的信息或观点
- 不得改变专有名词、引用内容、数据数字、领域术语
- 如原文已足够好，保持原样，不做无意义修改
- 宁可漏改，不可错改

# 输出格式
直接返回润色后的完整文本，不加任何解释、标记、引号或前后缀。`,

  grammarCheck: `# 角色
你是一位严谨的中文语法审校专家，熟悉《现代汉语》语法体系及国标标点符号用法（GB/T 15834）。

# 任务
修正文本中确定无疑的语法错误和标点问题。

# 检查范围
1. 语法错误：主谓不一致、成分残缺/赘余、搭配不当、语序不当
2. 标点符号：漏用/误用标点、中英文标点混用、引号配对
3. 错别字和同音字误用
4. 数量词和助词的规范使用

# 约束
- 不修改写作风格和表达偏好
- 不进行"润色"或"优化"，仅修正硬性错误
- 对于有争议的用法（如顿号vs逗号）保持原文
- 不替换领域专有术语和固定搭配

# 输出格式
直接返回修正后的完整文本，不附加任何说明。`,

  styleEnhance: `# 角色
你是一位中文文学编辑和风格顾问，擅长在保持原意的前提下提升文本的表达质量。

# 任务
在语法正确的基础上，优化文本的可读性和表达精度。

# 优化方向
1. 替换冗余和空泛的表达（如"进行了…的工作"→"开展了…"）
2. 优化词语搭配，使其更地道自然
3. 改善句间衔接和段落过渡
4. 消除不必要的重复表述
5. 调整长短句节奏

# 约束
- 保持原文的语域和语体（口语/书面/正式/非正式）
- 保持原文的情感色彩和语气
- 不替换领域专有术语和固定搭配
- 修改幅度不超过必要程度

# 输出格式
直接返回优化后的完整文本，不附加任何说明。`,
};

// ── 降重模式 Prompts（针对知网CNKI查重算法优化）──
// 知网核心算法：连续13个字符相同即判定重复，同时使用句子级语义相似度(>50%阈值)
const DEDUP_PROMPTS = {
  singleDedup: `# 角色
你是一位学术论文降重专家，深谙知网（CNKI）查重系统的检测机制。

# 知网查重核心规则
- **连续13个中文字符**相同即标红（主要检测手段）
- 句子级语义相似度超过阈值也会标黄
- 段落整体重复比超过阈值会整段标记
- 引用格式正确的内容会被标注为"引用"但仍计入总重复率

# 任务
对用户提供的中文学术文本进行深度改写降重，核心目标：确保任意连续13字不与原文相同，同时保持学术质量。

# 降重策略（综合运用，每句至少3处实质性改动）
1. **同义替换**：关键词替换（"研究"→"探究/考察"、"方法"→"路径/策略"、"结果"→"发现/结论"、"分析"→"剖析/审视"、"表明"→"显示/揭示"、"认为"→"指出/主张"）
2. **句式变换**：主动↔被动、肯定↔双重否定、陈述↔反问、因果倒置
3. **语序打散**：调整定语/状语/补语的位置，拆分重组长句，确保连续词序被打断
4. **概括转述**：用自己的话重新表述同一含义，而非逐词替换
5. **逻辑重组**：改变论述的推进顺序和衔接方式
6. **学术表达升级**：口语化表述→书面学术语体

# 约束
- ⚠️ 严格保持原文的学术含义和论证逻辑
- ⚠️ 专有名词、人名、机构名、数据数值必须保留
- ⚠️ 引用格式如（张三，2020）、[1-3]等不可修改
- ⚠️ 不得添加原文未包含的信息、观点或数据
- ⚠️ 保持段落结构和论证框架不变
- 改写后文本应自然流畅，不能有机器改写痕迹
- 优先保证语义准确性，其次追求低重复率

# 输出格式
直接返回降重改写后的完整文本，不加任何解释、标记或前后缀。`,

  structuralRewrite: `# 角色
你是一位中文学术写作顾问，擅长在保持学术严谨性的前提下对文本进行结构性改写。

# 知网查重提醒
知网检测连续13个字符相同即标红，请重点检查改写后是否仍存在与原文连续13字以上相同的片段。

# 任务
对已经过初步改写的文本进行进一步的结构化调整。

# 改写策略
1. 逐句检查：是否仍有连续13字以上与原文相同，若有则进一步改写
2. 调整句子内部结构：主语提前/后置、状语移位、定语重排
3. 变换表达角度：换一个视角重新描述同一事实
4. 重点关注结论和方法论段落（查重高危区）

# 约束
- 保持学术文体和专业水准
- 不改变事实性内容
- 不增减核心信息

# 输出格式
直接返回调整后的完整文本，不附加任何说明。`,
};

// ── 降AI率模式 Prompts（针对知网AIGC检测算法优化）──
// 知网AIGC检测原理：基于文本困惑度(perplexity)和突发度(burstiness)分析
// AI文本特征：困惑度低（用词可预测）、突发度低（句式均匀）、过渡词模板化
const DEAI_PROMPTS = {
  singleDeAI: `# 角色
你是一位反AI检测改写专家，深入理解知网AIGC检测系统的工作原理。

# 知网AIGC检测核心指标
1. **困惑度(Perplexity)**：AI文本用词高度可预测（困惑度低），人类写作用词更出人意料（困惑度高）
2. **突发度(Burstiness)**：AI文本句子长度和结构高度均匀，人类写作句子长短参差不齐
3. **词汇丰富度**：AI倾向反复使用相同的过渡词和连接词
4. **语法规整度**：AI文本语法过于完美和规范，缺少人类写作的自然波动
5. **信息密度均匀性**：AI每句话信息量接近，人类写作有详有略

# 任务
改写用户提供的文本，使其在保持原意和学术质量的前提下，呈现出更自然的"人类写作"特征，降低被AIGC检测系统标记的概率。

# 改写策略
1. **打破用词可预测性**：
   - 避免"首先…其次…最后…"等AI偏好的过渡模式
   - 将"然而"换成"但话说回来""不过值得注意的是"等更口语化/个性化的衔接
   - 同一含义在不同位置用不同表达，避免机械统一
   - 适当使用低频词汇、行话、专业俚语
   
2. **制造句式参差感（提高突发度）**：
   - 刻意混合长句和短句：一个30+字的复杂句后接一个10字以内的短句
   - 偶尔使用口语化的短评（如"这一点尤为关键。""但这只是一方面。"）
   - 打破AI倾向的"主谓宾"标准句式，偶尔使用倒装、省略、插入语
   
3. **注入个人写作痕迹**：
   - 增加作者视角的评论性语句（"笔者认为""就本研究而言"）
   - 插入带有立场的措辞（"遗憾的是""令人欣慰的是"）
   - 适当使用学术领域的惯用搭配而非通用表达
   
4. **降低信息密度均匀性**：
   - 重要论点展开详述，次要内容一笔带过
   - 允许适当的冗余和重复强调（人类写作自然特征）
   - 在关键处增加解释性旁注

5. **模拟人类写作习惯**：
   - 适当保留一些轻微的不完美（如可替换但不必替换的表述）
   - 使用更人性化的学术表达而非模板化措辞

# 约束
- ⚠️ 严格保持原文的学术含义和核心论点
- ⚠️ 专有名词、数据、引用格式不可修改
- ⚠️ 不得降低文本的学术水准
- ⚠️ 不得添加虚假信息
- 改写后仍需符合学术论文的基本规范
- 不要过度口语化，保持学术底线

# 输出格式
直接返回改写后的完整文本，不加任何解释、标记或前后缀。`,

  humanizePass: `# 角色
你是一位学术写作指导教师，擅长帮学生把"太AI味"的文字改得更像真人写的。

# 任务
对已经过初步改写的文本进行进一步"人性化"调整，重点消除残留的AI写作特征。

# 检查清单
1. 是否还有"首先/其次/最后/此外/综上所述"连续出现？→ 替换或删除部分
2. 句子长度是否过于均匀？→ 故意制造长短不一
3. 是否每段开头都是类似的句式？→ 变化开头方式
4. 过渡是否过于丝滑？→ 人类写作有时过渡比较生硬，这是正常的
5. 是否用了太多四字词语或成语？→ 适当替换为更朴素的表述

# 约束
- 保持学术文体，不能写成大白话
- 保持完整的论证逻辑
- 不改变任何事实性内容

# 输出格式
直接返回调整后的完整文本，不附加任何说明。`,
};

// ── 通用 Explain Prompt ──
const EXPLAIN_PROMPT = `# 任务
对比以下原文和修改稿，找出所有修改之处并给出专业的修改理由，以及可选的替代方案。

# 原文
{original}

# 修改稿
{polished}

# 输出要求
以纯JSON数组格式返回，不使用代码块：
[{"original":"原文片段","modified":"修改后片段","alternatives":["替代方案1"],"reason":"修改理由","type":"错误类型"}]

# 字段说明
- original/modified: 包含5-15个字的上下文，足以精确定位修改位置
- alternatives: 仅在有明显更好替代时提供1-2个建议（数组），无则为空数组 []
- reason: 简明专业的修改理由（如"主谓搭配不当"、"赘余删除"、"打散连续重复词序"、"降低用词可预测性"）
- type: 取值为 grammar(语法) / punctuation(标点) / wording(用词) / style(风格) / logic(逻辑) / dedup(降重) / deai(降AI)

# 约束
- 如无修改返回 []
- 不要遗漏任何一处修改`;

class AgentPipeline {
  constructor(provider, config) {
    this.provider = provider;
    this.config = config;
  }

  async process(text, onProgress, taskOverride) {
    const task = taskOverride || this.config.get('pipeline.task') || 'polish';
    const mode = this.config.get('pipeline.mode') || 'single';
    const temperature = this.config.get('pipeline.temperature') || 0.3;

    let polishedText;
    if (task === 'dedup') {
      polishedText = await this._dedup(text, temperature, mode, onProgress);
    } else if (task === 'deai') {
      polishedText = await this._deAI(text, temperature, mode, onProgress);
    } else if (mode === 'multi') {
      polishedText = await this._multiAgent(text, temperature, onProgress);
    } else {
      polishedText = await this._singleAgent(text, temperature, onProgress);
    }

    // Compute diff
    onProgress({ stage: '正在分析修改...', percent: 70 });
    const diff = DiffEngine.compute(text, polishedText);

    if (!diff.hasChanges) {
      onProgress({ stage: '完成', percent: 100 });
      return { polishedText, diff, explanations: [], task };
    }

    // Generate explanations
    onProgress({ stage: '正在生成修改说明...', percent: 80 });
    let explanations = [];
    try {
      explanations = await this._explain(text, polishedText);
    } catch (_) {
      // Explanations are best-effort
    }

    this._mapExplanations(diff.changes, explanations);
    onProgress({ stage: '完成', percent: 100 });

    return { polishedText, diff, explanations, task };
  }

  async _singleAgent(text, temperature, onProgress) {
    onProgress({ stage: '正在润色文本...', percent: 30 });
    const result = await this.provider.chat(
      [
        { role: 'system', content: POLISH_PROMPTS.singlePolish },
        { role: 'user', content: text },
      ],
      { temperature },
    );
    return result.trim();
  }

  async _multiAgent(text, temperature, onProgress) {
    onProgress({ stage: '语法检查中...', percent: 20 });
    const grammarFixed = await this.provider.chat(
      [
        { role: 'system', content: POLISH_PROMPTS.grammarCheck },
        { role: 'user', content: text },
      ],
      { temperature: 0.15 },
    );

    onProgress({ stage: '风格优化中...', percent: 45 });
    const styleEnhanced = await this.provider.chat(
      [
        { role: 'system', content: POLISH_PROMPTS.styleEnhance },
        { role: 'user', content: grammarFixed.trim() },
      ],
      { temperature },
    );

    return styleEnhanced.trim();
  }

  async _dedup(text, temperature, mode, onProgress) {
    onProgress({ stage: '正在降重改写...', percent: 25 });
    const firstPass = await this.provider.chat(
      [
        { role: 'system', content: DEDUP_PROMPTS.singleDedup },
        { role: 'user', content: text },
      ],
      { temperature: Math.max(temperature, 0.5) },  // 降重需要更高创造性
    );

    if (mode === 'multi') {
      onProgress({ stage: '结构化调整中...', percent: 50 });
      const secondPass = await this.provider.chat(
        [
          { role: 'system', content: DEDUP_PROMPTS.structuralRewrite },
          { role: 'user', content: `# 原文\n${text}\n\n# 初次改写\n${firstPass.trim()}` },
        ],
        { temperature: Math.max(temperature, 0.5) },
      );
      return secondPass.trim();
    }

    return firstPass.trim();
  }

  async _deAI(text, temperature, mode, onProgress) {
    onProgress({ stage: '正在降低AI痕迹...', percent: 25 });
    const firstPass = await this.provider.chat(
      [
        { role: 'system', content: DEAI_PROMPTS.singleDeAI },
        { role: 'user', content: text },
      ],
      { temperature: Math.max(temperature, 0.6) },  // 需要更高创造性以模拟人类
    );

    if (mode === 'multi') {
      onProgress({ stage: '人性化调整中...', percent: 50 });
      const secondPass = await this.provider.chat(
        [
          { role: 'system', content: DEAI_PROMPTS.humanizePass },
          { role: 'user', content: `# 原文\n${text}\n\n# 初次改写\n${firstPass.trim()}` },
        ],
        { temperature: Math.max(temperature, 0.6) },
      );
      return secondPass.trim();
    }

    return firstPass.trim();
  }

  async _explain(original, polished) {
    const prompt = EXPLAIN_PROMPT
      .replace('{original}', original)
      .replace('{polished}', polished);

    const response = await this.provider.chat(
      [
        { role: 'system', content: '你是一位专业的中文编辑审核员。请严格按照要求的JSON格式输出，不要使用代码块。' },
        { role: 'user', content: prompt },
      ],
      { temperature: 0.1 },
    );

    const cleaned = response.trim().replace(/^```json?\s*/i, '').replace(/```\s*$/, '');
    return JSON.parse(cleaned);
  }

  _mapExplanations(changes, explanations) {
    if (!explanations || explanations.length === 0) return;

    const remaining = [...explanations];
    for (const change of changes) {
      if (change.type === 'equal') continue;
      const oldText = change.oldText || '';
      const newText = change.newText || '';

      const idx = remaining.findIndex(exp => {
        const origMatch = oldText.includes(exp.original) || exp.original.includes(oldText);
        const modMatch = newText.includes(exp.modified) || exp.modified.includes(newText);
        return origMatch || modMatch;
      });

      if (idx !== -1) {
        change.reason = remaining[idx].reason;
        change.errorType = remaining[idx].type;
        change.alternatives = remaining[idx].alternatives || [];
        remaining.splice(idx, 1);
      }
    }
  }
}

module.exports = { AgentPipeline };
