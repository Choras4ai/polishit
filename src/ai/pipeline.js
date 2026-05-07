'use strict';

const DiffEngine = require('../diff');
const { EXPLAIN_BILLING_RATIO } = require('../commercial/credit-policy');

function normalizeModelOutputText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, '')
    .replace(/[\u00A0\u2007\u202F]/g, ' ');
}

// ── Language detection ──
function detectLanguage(text) {
  if (!text) return 'zh';
  // Count Chinese characters (CJK Unified Ideographs + extensions)
  const chineseChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const totalAlphaNum = (text.match(/[a-zA-Z0-9\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  if (totalAlphaNum === 0) return 'zh';
  // If any meaningful Chinese presence, treat as Chinese
  return chineseChars / totalAlphaNum >= 0.1 ? 'zh' : 'en';
}

// ── Genre-specific instructions (concise) ──
const GENRE_RULES = {
  academic: {
    label: 'academic',
    polishRule: `体裁：学术。保留术语、论证结构、引用格式。不增强或减弱论断（如"相关"→"导致"禁止）。保持正式学术语体。`,
    deaiRule: `体裁：学术。保留术语、论证结构、引用、hedging语言。保持正式语体，不口语化，不插入主观评论。`,
  },
  business: {
    label: 'business',
    polishRule: `体裁：商务。保持正式简洁，保留事实/数据/专业术语，优先清晰简洁。`,
    deaiRule: `体裁：商务。保持专业语体，不插入口语表达，保留事实和数据。`,
  },
  casual: {
    label: 'casual',
    polishRule: `体裁：随笔/创意。允许适度表达优化，尊重作者个人声音，修正明显错误但不过度正式化。`,
    deaiRule: `体裁：随笔/创意。尊重作者个人声音，允许更灵活的表达变化。`,
  },
};

// ── 中文润色 Prompts（精简版，保留硬约束）──
const ZH_POLISH_PROMPTS = {
  singlePolish: `你是资深中文编辑。以最小改动修正错误，原文可接受则保留。

修改优先级（按序，无必要则停）：
1. 错别字、语病（主谓搭配、成分残缺/冗余、语序）
2. 标点（GB/T 15834）
3. 指代不明、逻辑断裂
4. 明显冗余

{genre_rule}

禁止：添加原文没有的信息/观点/因果；增强或减弱论断；改动专有名词/引文/数据/术语；整句改写。

直接输出润色后的完整文本，无任何解释或标注。`,

  grammarCheck: `你是中文语法校对员。仅修正确定性语法和标点错误，不做其他修改。

范围：语法（搭配、成分、语序）、标点、错别字、量词/助词/介词。

{genre_rule}

禁止：修改文风/用词偏好/句式；润色；替换术语。有争议保留原文。

直接输出修正后的完整文本。`,

  styleEnhance: `你是中文文体顾问。在已语法正确的文本上优化表达精准度（第二轮，不再改语法）。

范围：替换冗长/模糊表述；修正不自然搭配；平滑生硬过渡；删除无修辞价值的重复。

{genre_rule}

禁止：改变语体/情感基调；增减论断；添加过渡词；替换术语。做最小改动。

直接输出优化后的完整文本。`,
};

// ── English Polish Prompts (concise) ──
const EN_POLISH_PROMPTS = {
  singlePolish: `You are a senior scientific editor. Apply MINIMUM edits. Leave acceptable text as-is.

Edit priority (stop when unnecessary):
1. Grammar, subject-verb agreement, articles, prepositions, dangling modifiers
2. Punctuation (serial comma, hyphens, en-dash)
3. Clarity: ambiguous antecedents, unclear causation
4. Conciseness: remove wordiness, prefer active voice

{genre_rule}

NEVER: add info/opinions/causation; strengthen or weaken claims; change proper nouns, quotes, data, domain terms; rewrite whole sentences.

Output the polished full text directly. No explanations, labels, or prefixes.`,

  grammarCheck: `You are a meticulous English proofreader. Fix ONLY definite grammar/punctuation errors.

Scope: subject-verb agreement, tenses, modifiers, parallelism, commas/semicolons/hyphens, spelling, articles, prepositions.

{genre_rule}

NEVER: modify style/word choice/structure; "polish" or "optimize"; replace domain terms. Keep debatable usage as-is.

Output the corrected full text directly.`,

  styleEnhance: `You are a scientific style consultant. On grammar-correct text, improve readability (SECOND PASS — do NOT re-fix grammar).

Scope: replace wordy/vague expressions (prefer active voice); fix unnatural collocations; smooth jarring transitions; remove clear redundancy.

{genre_rule}

NEVER: change register; strengthen/weaken claims; add discourse markers; replace domain terms. Minimum change.

Output the optimized full text directly.`,
};

// ── 中文去模板化 Prompts ──
const ZH_DEAI_PROMPTS = {
  deTemplate: `你是学术改写专家，消除AI生成文本的模板化痕迹。

改写目标：
1. 替换/删除"首先…其次…最后…""此外""综上所述"等套路连接词
2. 打破句长单调节奏
3. 变化重复的段首结构
4. 删除"值得注意的是""发挥重要作用"等空洞套话
5. 用领域内自然同义词替换反复出现的连接词/形容词

{genre_rule}

禁止：制造错误；插入原文没有的观点；改变事实/数据/专有名词/引用/论证结构；增减论断；降低质量。

直接输出改写后的完整文本，无解释。`,

  finalCheck: `你是去模板化文本的终审校对员。文本已改写，只检查：

1. 连续2+段相同开头结构？变化一段。
2. 近距离内3+模板化连接词？替换一两个。
3. 连续4+句长度几乎相同？拆分或合并一句。

无上述问题则原样返回。

{genre_rule}

禁止：大规模改写；改变含义/事实/结构；添加新内容。

直接输出文本。`,
};

// ── English De-template Prompts ──
const EN_DEAI_PROMPTS = {
  deTemplate: `You are an academic rewriter removing formulaic AI-writing patterns.

Targets:
1. Replace/remove stock transitions ("Firstly…Secondly…", "Moreover", "In conclusion", "It is important to note")
2. Break monotonous sentence-length rhythm
3. Vary repetitive paragraph openings
4. Remove hollow phrases ("It is worth noting that", "plays an important role")
5. Replace repeated connectors/adjectives with domain-appropriate synonyms

{genre_rule}

NEVER: fabricate errors; insert subjective commentary; change facts/data/proper nouns/citations/argument structure; add info or strengthen claims; lower quality.

Output the rewritten full text directly. No explanations or labels.`,

  finalCheck: `Final proofreader for de-templated text. Check ONLY:

1. 2+ consecutive paragraphs with same opening pattern? Vary one.
2. 3+ stock connectors in close proximity? Replace one or two.
3. 4+ sentences with nearly identical length? Split or merge one.

If none exist, return text UNCHANGED.

{genre_rule}

NEVER: large-scale rewriting; change meaning/facts/structure; add content.

Output text directly.`,
};

// ── Explain Prompts (concise) ──
const ZH_EXPLAIN_PROMPT = `对比原文和修改后文本，找出关键修改并给出简要理由。

原文：{original}

修改后：{polished}

返回纯JSON数组（无代码块）：
[{{"original":"原文片段","modified":"修改后片段","alternatives":[],"reason":"简要理由","type":"类别"}}]

- original/modified: 5-15字定位上下文
- alternatives: 有明显更优方案时给1-2个，否则[]
- type: grammar / punctuation / wording / style / logic / detemplate
- 长文本(≥500字)跳过纯标点修改

无修改返回[]。不虚构理由。`;

const EN_EXPLAIN_PROMPT = `Compare original and revised text. Identify KEY modifications with concise reasons.

Original: {original}

Revised: {polished}

Return as plain JSON array (NO code blocks):
[{{"original":"original snippet","modified":"modified snippet","alternatives":[],"reason":"concise reason","type":"category"}}]

- original/modified: 5-15 chars/words of context
- alternatives: 1-2 only if clearly superior, else []
- type: grammar / punctuation / wording / style / logic / detemplate
- Long text (≥500 chars): skip trivial punctuation changes

If no changes, return []. Do NOT fabricate reasons.`;

class AgentPipeline {
  constructor(provider, config) {
    this.provider = provider;
    this.config = config;
  }

  _getGenre() {
    return this.config.get('pipeline.genre') || 'academic';
  }

  _getGenreRule(task) {
    const genre = this._getGenre();
    const rules = GENRE_RULES[genre] || GENRE_RULES.academic;
    return task === 'deai' ? rules.deaiRule : rules.polishRule;
  }

  _injectGenre(prompt, task) {
    return prompt.replace('{genre_rule}', this._getGenreRule(task));
  }

  _getCustomPrompt(task) {
    const prompt = this.config.get(`pipeline.customPrompts.${task}`);
    return typeof prompt === 'string' ? prompt.trim() : '';
  }

  _withCustomPrompt(basePrompt, task) {
    let prompt = this._injectGenre(basePrompt, task);
    const customPrompt = this._getCustomPrompt(task);
    if (!customPrompt) return prompt;
    return `${prompt}

# 用户额外要求
以下偏好由当前用户指定。请在不违反上述约束的前提下尽量满足：
${customPrompt}`;
  }

  /**
   * Sanitize AI output: detect when the model returns advice/instructions
   * instead of the actual rewritten text, and fall back to original.
   */
  _sanitizeOutput(output, original) {
    const trimmed = normalizeModelOutputText(output).trim();
    if (!trimmed) return original;

    // Detect obvious "advice" patterns (model didn't follow instructions)
    const advicePatterns = [
      /^(以下|下面|这里)是/,           // "以下是..."
      /^(好的|当然|没问题)[，,。！]/,    // "好的，..."
      /在这个基础上/,
      /你可以考虑以下/,
      /\*\*.*?\*\*/,                    // markdown bold
      /^\d+\.\s+\*\*/m,               // numbered list with bold
      /通过这些方法/,
      /需要谨慎实施/,
      /以下几点/,
    ];

    let adviceScore = 0;
    for (const pattern of advicePatterns) {
      if (pattern.test(trimmed)) adviceScore++;
    }

    // If 3+ advice patterns detected, the model clearly didn't rewrite
    if (adviceScore >= 3) {
      return original;
    }

    // If output is much longer than input (>3x), likely contains explanation
    if (trimmed.length > original.length * 3) {
      // Try to extract just the first paragraph as the actual rewrite
      const firstPara = trimmed.split(/\n\n/)[0].trim();
      if (firstPara.length >= original.length * 0.5 && firstPara.length <= original.length * 2) {
        return firstPara;
      }
      return original;
    }

    return trimmed;
  }

  async process(text, onProgress, taskOverride) {
    const rawTask = taskOverride || this.config.get('pipeline.task') || 'polish';
    const task = rawTask === 'deai' ? 'deai' : 'polish';
    const mode = this.config.get('pipeline.mode') || 'single';
    const temperature = this.config.get('pipeline.temperature') || 0.3;
    const lang = detectLanguage(text);

    let polishedText;
    if (task === 'deai') {
      polishedText = await this._deAI(text, temperature, mode, onProgress, lang);
    } else if (mode === 'multi') {
      polishedText = await this._multiAgent(text, temperature, onProgress, lang);
    } else {
      polishedText = await this._singleAgent(text, temperature, onProgress, lang);
    }

    // Sanitize: detect when model returns advice instead of rewritten text
    polishedText = this._sanitizeOutput(polishedText, text);

    // Compute diff and generate explanations in parallel
    onProgress({ stage: '正在分析修改...', percent: 70 });
    const diff = DiffEngine.compute(text, polishedText);

    if (!diff.hasChanges) {
      onProgress({ stage: '完成', percent: 100 });
      return { polishedText, diff, explanations: [], task };
    }

    // Return result immediately; explanations will be fetched async
    onProgress({ stage: '完成', percent: 95 });

    // Skip AI explain for tiny texts (< 30 chars) — diff highlighting alone is clear enough
    // Skip explain if too many changes (>20) — meaningful explain is impractical
    const changeCount = diff.changes.filter(c => c.type !== 'equal').length;
    if (text.length < 30 || changeCount > 20) {
      return { polishedText, diff, explanations: [], task };
    }

    // Attach a lazy explain function for the caller to use asynchronously
    const self = this;
    const explainPromise = (async () => {
      try {
        const explanations = await self._explain(text, polishedText, lang);
        self._mapExplanations(diff.changes, explanations);
        return explanations;
      } catch (_) {
        return [];
      }
    })();

    return { polishedText, diff, explanations: [], task, explainPromise };
  }

  _getPolishPrompts(lang) {
    return lang === 'en' ? EN_POLISH_PROMPTS : ZH_POLISH_PROMPTS;
  }

  _getDeaiPrompts(lang) {
    return lang === 'en' ? EN_DEAI_PROMPTS : ZH_DEAI_PROMPTS;
  }

  _getExplainPrompt(lang) {
    return lang === 'en' ? EN_EXPLAIN_PROMPT : ZH_EXPLAIN_PROMPT;
  }

  // Estimate max_tokens needed based on input length (1.3x buffer + 200 baseline)
  _estimateMaxTokens(text) {
    // For Chinese: ~1 char = ~1.5 tokens. For English: ~1 word = ~1.3 tokens, ~4 chars = ~1 token.
    // Use generous estimate: char count × 1.2 + 200 buffer, capped.
    const len = (text || '').length;
    return Math.min(Math.max(Math.ceil(len * 1.3) + 200, 512), 4096);
  }

  _buildBillingOptions(text, task, stage = 'primary') {
    const safeText = String(text || '');
    const chars = stage === 'explain'
      ? Math.ceil(safeText.length * EXPLAIN_BILLING_RATIO)
      : safeText.length;

    return {
      task,
      billableChars: chars,
      billingStage: stage,
    };
  }

  async _singleAgent(text, temperature, onProgress, lang) {
    onProgress({ stage: '正在润色文本...', percent: 30 });
    const prompts = this._getPolishPrompts(lang);
    const suffix = lang === 'en'
      ? '\n\n[IMPORTANT: Output the polished text directly. Do NOT output any explanations, suggestions, or markdown formatting.]'
      : '\n\n[重要提醒：请直接输出润色后的文本，不要输出任何解释、建议或markdown格式。]';
    const result = await this.provider.chat(
      [
        { role: 'system', content: this._withCustomPrompt(prompts.singlePolish, 'polish') },
        { role: 'user', content: text + suffix },
      ],
      {
        temperature,
        maxTokens: this._estimateMaxTokens(text),
        ...this._buildBillingOptions(text, 'polish'),
      },
    );
    return result.trim();
  }

  async _multiAgent(text, temperature, onProgress, lang) {
    onProgress({ stage: '语法检查中...', percent: 20 });
    const prompts = this._getPolishPrompts(lang);
    const maxTokens = this._estimateMaxTokens(text);
    const grammarFixed = await this.provider.chat(
      [
        { role: 'system', content: this._withCustomPrompt(prompts.grammarCheck, 'polish') },
        { role: 'user', content: text },
      ],
      {
        temperature: 0.15,
        maxTokens,
        ...this._buildBillingOptions(text, 'polish'),
      },
    );

    onProgress({ stage: '风格优化中...', percent: 45 });
    const styleEnhanced = await this.provider.chat(
      [
        { role: 'system', content: this._withCustomPrompt(prompts.styleEnhance, 'polish') },
        { role: 'user', content: grammarFixed.trim() },
      ],
      {
        temperature,
        maxTokens,
        ...this._buildBillingOptions(grammarFixed.trim(), 'polish'),
      },
    );

    return styleEnhanced.trim();
  }

  async _deAI(text, temperature, mode, onProgress, lang) {
    onProgress({ stage: '正在进行去模板化改写...', percent: 25 });
    const prompts = this._getDeaiPrompts(lang);
    const maxTokens = this._estimateMaxTokens(text);
    const suffix = lang === 'en'
      ? '\n\n[IMPORTANT: Output the rewritten text directly. Do NOT output any suggestions, explanations, numbered lists, or markdown formatting.]'
      : '\n\n[重要提醒：请直接输出改写后的文本，不要输出任何建议、解释、编号列表或markdown格式。]';
    const firstPass = await this.provider.chat(
      [
        { role: 'system', content: this._withCustomPrompt(prompts.deTemplate, 'deai') },
        { role: 'user', content: text + suffix },
      ],
      {
        temperature: Math.max(temperature, 0.5),
        maxTokens,
        ...this._buildBillingOptions(text, 'deai'),
      },
    );

    if (mode === 'multi') {
      onProgress({ stage: '最终审校中...', percent: 50 });
      const secondPass = await this.provider.chat(
        [
          { role: 'system', content: this._withCustomPrompt(prompts.finalCheck, 'deai') },
          { role: 'user', content: firstPass.trim() },
        ],
        {
          temperature: 0.2,
          maxTokens,
          ...this._buildBillingOptions(firstPass.trim(), 'deai'),
        },
      );
      return secondPass.trim();
    }

    return firstPass.trim();
  }

  async _explain(original, polished, lang) {
    const prompt = this._getExplainPrompt(lang)
      .replace('{original}', original)
      .replace('{polished}', polished);

    // Explain output is small JSON — cap at 1500 tokens max
    const response = await this.provider.chat(
      [
        { role: 'system', content: 'You are an editorial reviewer. Output strict JSON, no code blocks.' },
        { role: 'user', content: prompt },
      ],
      {
        temperature: 0.1,
        maxTokens: 1500,
        ...this._buildBillingOptions(
          original.length >= polished.length ? original : polished,
          'polish',
          'explain',
        ),
      },
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

module.exports = { AgentPipeline, detectLanguage, normalizeModelOutputText };
