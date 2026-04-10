'use strict';

/**
 * Character-level diff engine optimized for Chinese text.
 * Uses LCS-based algorithm with common prefix/suffix trimming.
 */
class DiffEngine {
  /**
   * Compute diff between original and modified text.
   * @param {string} oldText
   * @param {string} newText
   * @returns {{ changes: Array, hasChanges: boolean }}
   */
  static compute(oldText, newText) {
    if (oldText === newText) {
      return { changes: [], hasChanges: false };
    }

    const oldChars = Array.from(oldText);
    const newChars = Array.from(newText);

    // Trim common prefix and suffix to reduce problem size
    const { prefix, oldMiddle, newMiddle, suffix } = DiffEngine._trimCommon(oldChars, newChars);

    let ops = [];

    if (prefix.length > 0) {
      ops.push(...prefix.map(ch => ({ type: 'equal', value: ch })));
    }

    if (oldMiddle.length === 0) {
      ops.push(...newMiddle.map(ch => ({ type: 'insert', value: ch })));
    } else if (newMiddle.length === 0) {
      ops.push(...oldMiddle.map(ch => ({ type: 'delete', value: ch })));
    } else if (oldMiddle.length * newMiddle.length > 9_000_000) {
      // Fallback to line-level diff for very large texts
      ops.push(...DiffEngine._lineLevelDiff(oldMiddle.join(''), newMiddle.join('')));
    } else {
      ops.push(...DiffEngine._lcsDiff(oldMiddle, newMiddle));
    }

    if (suffix.length > 0) {
      ops.push(...suffix.map(ch => ({ type: 'equal', value: ch })));
    }

    const groups = DiffEngine._groupOps(ops);
    const changes = DiffEngine._buildChanges(groups);

    return {
      changes,
      hasChanges: changes.some(c => c.type !== 'equal'),
    };
  }

  /**
   * Compute final text after user accepts/rejects changes.
   * @param {Array} changes
   * @returns {string}
   */
  static applyChanges(changes) {
    let result = '';
    for (const c of changes) {
      switch (c.type) {
        case 'equal':
          result += c.text;
          break;
        case 'replace':
          result += c.status === 'accepted' ? c.newText : c.oldText;
          break;
        case 'delete':
          if (c.status !== 'accepted') result += c.oldText;
          break;
        case 'insert':
          if (c.status === 'accepted') result += c.newText;
          break;
      }
    }
    return result;
  }

  // ── Private helpers ──

  static _trimCommon(a, b) {
    let prefixLen = 0;
    const minLen = Math.min(a.length, b.length);
    while (prefixLen < minLen && a[prefixLen] === b[prefixLen]) {
      prefixLen++;
    }
    let suffixLen = 0;
    while (
      suffixLen < minLen - prefixLen &&
      a[a.length - 1 - suffixLen] === b[b.length - 1 - suffixLen]
    ) {
      suffixLen++;
    }
    return {
      prefix: a.slice(0, prefixLen),
      oldMiddle: a.slice(prefixLen, a.length - suffixLen),
      newMiddle: b.slice(prefixLen, b.length - suffixLen),
      suffix: suffixLen > 0 ? a.slice(a.length - suffixLen) : [],
    };
  }

  static _lcsDiff(a, b) {
    const m = a.length;
    const n = b.length;

    const dp = new Array(m + 1);
    for (let i = 0; i <= m; i++) {
      dp[i] = new Uint32Array(n + 1);
    }
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (a[i - 1] === b[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }

    const ops = [];
    let i = m, j = n;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
        ops.push({ type: 'equal', value: a[i - 1] });
        i--; j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        ops.push({ type: 'insert', value: b[j - 1] });
        j--;
      } else {
        ops.push({ type: 'delete', value: a[i - 1] });
        i--;
      }
    }
    return ops.reverse();
  }

  static _lineLevelDiff(oldText, newText) {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    const lineOps = DiffEngine._lcsDiff(oldLines, newLines);

    const charOps = [];
    for (const op of lineOps) {
      const chars = Array.from(op.value);
      for (const ch of chars) {
        charOps.push({ type: op.type, value: ch });
      }
      // Add newline with same type
      charOps.push({ type: op.type, value: '\n' });
    }
    // Remove trailing newline
    if (charOps.length > 0) charOps.pop();
    return charOps;
  }

  static _groupOps(ops) {
    if (ops.length === 0) return [];
    const groups = [];
    let cur = { type: ops[0].type, text: ops[0].value };

    for (let i = 1; i < ops.length; i++) {
      if (ops[i].type === cur.type) {
        cur.text += ops[i].value;
      } else {
        groups.push(cur);
        cur = { type: ops[i].type, text: ops[i].value };
      }
    }
    groups.push(cur);
    return groups;
  }

  static _buildChanges(groups) {
    const changes = [];
    let id = 0;

    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (g.type === 'equal') {
        changes.push({ id: id++, type: 'equal', text: g.text });
      } else if (g.type === 'delete' && i + 1 < groups.length && groups[i + 1].type === 'insert') {
        changes.push({
          id: id++,
          type: 'replace',
          oldText: g.text,
          newText: groups[i + 1].text,
          status: 'pending',
        });
        i++;
      } else if (g.type === 'delete') {
        changes.push({ id: id++, type: 'delete', oldText: g.text, status: 'pending' });
      } else if (g.type === 'insert') {
        changes.push({ id: id++, type: 'insert', newText: g.text, status: 'pending' });
      }
    }
    return changes;
  }
}

module.exports = DiffEngine;
