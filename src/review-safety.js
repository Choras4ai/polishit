'use strict';

function normalizeProtectedTerms(value = []) {
  const terms = typeof value === 'string' ? value.split(/\r?\n/) : value;
  if (!Array.isArray(terms) || terms.length > 200 || terms.some(t => typeof t !== 'string' || t.length > 120)) {
    throw new Error('保护词最多 200 个，每个不超过 120 字符。');
  }
  return [...new Set(terms.map(t => t.trim()).filter(Boolean))];
}

function canonicalReviewChange(changes, candidate) {
  const found = changes.find(c => c.id === candidate?.id && c.type !== 'equal' &&
    ['type', 'originalStart', 'originalEnd'].every(k => c[k] === candidate[k]) &&
    (c.oldText || '') === (candidate.oldText || '') && ((c.newText || '') === (candidate.newText || '')
      || (c.type !== 'delete' && Array.isArray(c.alternatives) && c.alternatives.includes(candidate.newText))));
  return found ? { ...found, newText: candidate.newText || '' } : null;
}

function analyzeReviewSafety(original, changes, terms = []) {
  const protectedRanges = [];
  for (const term of normalizeProtectedTerms(terms)) {
    for (let at = original.indexOf(term); at !== -1; at = original.indexOf(term, at + 1)) {
      protectedRanges.push({ start: at, end: at + term.length, label: `保护词「${term}」` });
    }
  }
  const numberPattern = /10\.\d{4,9}\/[^\s]+|\[\d+(?:[–,\-]\d+)*\]|[+-]?\d+(?:[.,]\d+)*(?:\s*(?:%|％|mg|kg|mm|cm|mL|ml|μg|ug|岁|年|月|天))?/g;
  const claimPattern = /可能|或许|未必|相关|导致|显著|没有|不能|尚未|否认|排除|不|无|未|\b(?:may|might|not|never|no|associated|causes?|significant)\b/gi;
  const sensitiveRanges = [];
  for (const pattern of [numberPattern, claimPattern]) {
    for (const match of original.matchAll(pattern)) sensitiveRanges.push({ start: match.index, end: match.index + match[0].length, label: match[0] });
  }
  const intersects = (c, r) => c.originalStart === c.originalEnd
    ? c.originalStart > r.start && c.originalStart < r.end
    : c.originalStart < r.end && c.originalEnd > r.start;
  return changes.map(change => {
    if (change.type === 'equal') return { ...change };
    const locked = protectedRanges.filter(r => intersects(change, r));
    const sensitive = sensitiveRanges.filter(r => intersects(change, r));
    const left = original.slice(Math.max(0, change.originalStart - 128), change.originalStart);
    const inserted = change.newText || '';
    const neighborhood = left + inserted + original.slice(change.originalEnd, change.originalEnd + 128);
    const projected = { originalStart: left.length, originalEnd: left.length + inserted.length };
    let addedRisk = false;
    for (const pattern of [numberPattern, claimPattern]) {
      pattern.lastIndex = 0;
      if (inserted && [...neighborhood.matchAll(pattern)].some(m => intersects(projected, { start: m.index, end: m.index + m[0].length }))) addedRisk = true;
    }
    const warnings = [...new Set(locked.map(r => `${r.label}被修改，不能直接接受。`))];
    if (sensitive.length || addedRisk) warnings.push('涉及数值、引文或论断限定变化，请核对原意；此提示不代表已判定事实错误。');
    return { ...change, reviewSafety: { blocked: locked.length > 0,
      requiresConfirmation: sensitive.length > 0 || addedRisk, warnings } };
  });
}

module.exports = { normalizeProtectedTerms, analyzeReviewSafety, canonicalReviewChange };
