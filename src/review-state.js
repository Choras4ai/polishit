'use strict';

function normalizeReviewChange(change) {
  if (!change || !['replace', 'delete', 'insert'].includes(change.type)) return null;
  const { id, originalStart, oldText = '', newText = '' } = change;
  if (!Number.isSafeInteger(id) || !Number.isSafeInteger(originalStart) || originalStart < 0
    || typeof oldText !== 'string' || typeof newText !== 'string') return null;
  const originalEnd = change.originalEnd ?? originalStart + oldText.length;
  if (!Number.isSafeInteger(originalEnd) || originalEnd !== originalStart + oldText.length) return null;
  if ((change.type === 'insert' && oldText) || (change.type === 'delete' && newText)) return null;
  return { id, type: change.type, originalStart, originalEnd, oldText, newText };
}

function isReviewChangeApplicable(session, change) {
  if (!normalizeReviewChange(change) || change.originalEnd > session.originalText.length
    || change.originalStart > session.originalText.length
    || session.originalText.slice(change.originalStart, change.originalEnd) !== change.oldText) return false;
  for (const other of session.appliedChanges.values()) {
    if (other.id === change.id) continue;
    if (change.originalStart === other.originalStart
      || (change.originalStart < other.originalEnd && other.originalStart < change.originalEnd)) return false;
  }
  return true;
}

async function restoreReplacement(record, { applyTextEdit, copyText }) {
  if (!record?.originalText) return { ok: false, error: '没有可恢复的原文。' };
  const context = record.selectionContext;
  if (!context) {
    copyText(record.originalText);
    return { ok: true, mode: 'copied' };
  }
  const range = { location: context.selectionRange.location, length: record.replacedText.length };
  const result = await applyTextEdit({ ...context, expectedText: record.replacedText,
    selectionRange: range, targetRange: range }, record.originalText, { restoreClipboard: true });
  return result?.ok
    ? { ok: true, mode: 'restored' }
    : {
      ok: false,
      sourceMayHaveChanged: Boolean(result?.sourceMayHaveChanged),
      error: result?.error || '原文位置已变化，停止恢复。',
    };
}

module.exports = { normalizeReviewChange, isReviewChangeApplicable, restoreReplacement };
