(function (global) {
  'use strict';
  let activeBookmarkName = '';

  function normalized(value) {
    return String(value || '').replace(/\r\n?/g, '\n').replace(/[\u200B-\u200D\uFEFF]/g, '');
  }

  function assertWordReady(info) {
    if (!info || info.host !== Office.HostType.Word) {
      throw new Error('请在 Microsoft Word 中打开润石文档助手。');
    }
    return 'Microsoft Word';
  }

  function supportsReviewApi() {
    return Boolean(Office.context?.requirements?.isSetSupported?.('WordApi', '1.4'));
  }

  function createBookmarkName() {
    return `_RunShi_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`.slice(0, 40);
  }

  function releaseBookmark(document, name) {
    if (!name || typeof document.deleteBookmark !== 'function') return;
    document.deleteBookmark(name);
    if (activeBookmarkName === name) activeBookmarkName = '';
  }

  function replacementFor(change) {
    if (change.type === 'delete') return '';
    return String(change.newText || '');
  }

  function opinionLabel(change) {
    if (change.category || change.kind) return String(change.category || change.kind);
    if (change.type === 'delete') return '语句问题';
    if (change.type === 'insert') return '表达补充';
    return '用词精确';
  }

  function reasonFor(change) {
    if (change.reason) return String(change.reason);
    if (change.type === 'delete') return '删除冗余或影响句子连贯性的内容；请确认没有删掉必要限定。';
    if (change.type === 'insert') return '补充上下文所需的信息；请确认新增内容符合你的事实和专业语境。';
    return '调整表达的准确性和流畅度；专业名词、判断强度和原意仍需由你最终确认。';
  }

  function commentFor(change) {
    const action = change.type === 'replace'
      ? `将「${change.oldText}」改为「${change.newText}」`
      : change.type === 'delete'
        ? `删除「${change.oldText}」`
        : `在此处补充「${change.newText}」`;
    return `润石建议 · ${opinionLabel(change)}\n${action}。\n修订理由：${reasonFor(change)}\n请悬停查看后，在右侧面板接受或忽略。`;
  }

  function summaryFor(changes) {
    const lines = changes.slice(0, 20).map((change, index) => `${index + 1}. ${commentFor(change).replace('润石建议：', '')}`);
    if (changes.length > 20) lines.push(`其余 ${changes.length - 20} 处请在润石建议面板查看。`);
    return `润石修订汇总（${changes.length} 处）\n${lines.join('\n')}`;
  }

  function composeFinalText(source, changes) {
    let output = String(source || '');
    const ordered = [...changes].sort((a, b) => Number(b.originalStart) - Number(a.originalStart));
    for (const change of ordered) {
      const start = Number(change.originalStart);
      const end = Number(change.originalEnd);
      const oldText = String(change.oldText || '');
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || start < 0 || end < start || end > output.length
        || output.slice(start, end) !== oldText) {
        throw new Error('修订范围与原文不一致，请重新选择文字并分析。');
      }
      output = output.slice(0, start) + replacementFor(change) + output.slice(end);
    }
    return output;
  }

  function occurrenceAt(text, needle, expectedStart) {
    let occurrence = -1;
    let offset = -1;
    do {
      offset = text.indexOf(needle, offset + 1);
      occurrence += 1;
    } while (offset >= 0 && offset < expectedStart);
    return offset === expectedStart ? occurrence : -1;
  }

  async function verifySelection(context, snapshot) {
    if ((snapshot.hostDocument && snapshot.hostDocument !== Office.context.document)
      || (snapshot.documentUrl != null && snapshot.documentUrl !== String(Office.context.document?.url || ''))) {
      throw new Error('当前文档已切换，请重新选择文字并分析。');
    }
    if (!snapshot.bookmarkName || typeof context.document.getBookmarkRangeOrNullObject !== 'function') {
      throw new Error('当前 Word 版本无法建立稳定的原文定位标记；为避免改错位置，本次仅保留面板建议。');
    }
    const range = context.document.getBookmarkRangeOrNullObject(snapshot.bookmarkName);
    range.load('text,isNullObject');
    await context.sync();
    if (range.isNullObject) {
      throw new Error('原文定位标记已失效，请重新选择文字并分析。');
    }
    if (normalized(range.text) !== normalized(snapshot.text)) {
      throw new Error('当前选区已发生变化。请重新选择文字并分析，避免覆盖刚才的编辑。');
    }
    return range;
  }

  global.RunShiHost = {
    ready() {
      return Office.onReady().then(assertWordReady);
    },

    capabilities() {
      const review = supportsReviewApi();
      return { canWriteBack: review, canAnnotate: review, canTrackRevisions: review };
    },

    captureSelection() {
      return Word.run(async (context) => {
        const range = context.document.getSelection();
        range.load('text');
        await context.sync();
        let bookmarkName = '';
        if (supportsReviewApi() && typeof range.insertBookmark === 'function'
          && typeof context.document.getBookmarkRangeOrNullObject === 'function') {
          releaseBookmark(context.document, activeBookmarkName);
          bookmarkName = createBookmarkName();
          range.insertBookmark(bookmarkName);
          await context.sync();
          activeBookmarkName = bookmarkName;
        }
        return { text: range.text, host: 'word', hostDocument: Office.context.document,
          documentUrl: String(Office.context.document?.url || ''), bookmarkName };
      });
    },

    annotateSuggestions(snapshot, changes) {
      if (!supportsReviewApi()) {
        return Promise.resolve({ ok: false, error: '当前 Word 版本不支持原文批注（需 WordApi 1.4+）。' });
      }
      return Word.run(async (context) => {
        const selection = await verifySelection(context, snapshot);
        const searchable = [];
        for (const change of changes) {
          const oldText = String(change.oldText || '');
          if (!oldText) continue;
          const results = selection.search(oldText, { matchCase: true, matchWholeWord: false });
          results.load('items/text');
          searchable.push({ change, oldText, results });
        }
        await context.sync();

        let annotated = 0;
        let unresolved = 0;
        for (const entry of searchable) {
          const start = Number(entry.change.originalStart);
          let occurrence = -1;
          let offset = -1;
          if (Number.isSafeInteger(start) && start >= 0) {
            do {
              offset = snapshot.text.indexOf(entry.oldText, offset + 1);
              occurrence++;
            } while (offset >= 0 && offset < start);
          }
          const target = offset === start ? entry.results.items[occurrence] : null;
          if (!target || normalized(target.text) !== normalized(entry.oldText)) {
            unresolved += 1;
            continue;
          }
          if (target.font) target.font.highlightColor = 'E8F2ED';
          target.insertComment(commentFor(entry.change));
          annotated += 1;
        }

        const insertions = changes.filter(change => !String(change.oldText || ''));
        if (insertions.length || unresolved) {
          selection.insertComment(summaryFor(changes));
          annotated += 1;
        }
        await context.sync();
        return { ok: true, annotated, unresolved: unresolved + insertions.length,
          summaryIncluded: Boolean(insertions.length || unresolved) };
      });
    },

    applyAcceptedChanges(snapshot, changes, finalText) {
      return Word.run(async (context) => {
        const range = await verifySelection(context, snapshot);
        if (!supportsReviewApi()) {
          throw new Error('当前 Word 版本不支持安全的原生修订写回，请复制结果后手动粘贴。');
        }

        if (composeFinalText(snapshot.text, changes) !== String(finalText || '')) {
          throw new Error('已选修订与最终文本不一致，本次没有写入。请重新分析。');
        }

        // Resolve every target against the untouched bookmark before queuing
        // edits. This keeps untouched runs, styles, fields and links intact.
        const prepared = [];
        const ordered = [...changes].sort((a, b) => Number(b.originalStart) - Number(a.originalStart));
        for (const change of ordered) {
          const oldText = String(change.oldText || '');
          const start = Number(change.originalStart);
          if (!oldText && start === snapshot.text.length) {
            prepared.push({ change, atEnd: true, target: range });
            continue;
          }
          const searchText = oldText || snapshot.text.slice(start, Math.min(snapshot.text.length, start + 24));
          if (!searchText) throw new Error('无法定位空白修订，请重新选择文字并分析。');
          const results = range.search(searchText, { matchCase: true, matchWholeWord: false });
          results.load('items/text');
          prepared.push({ change, searchText, results, atEnd: false });
        }
        await context.sync();

        for (const entry of prepared) {
          if (entry.atEnd) continue;
          const start = Number(entry.change.originalStart);
          const occurrence = occurrenceAt(snapshot.text, entry.searchText, start);
          const target = occurrence >= 0 ? entry.results.items[occurrence] : null;
          if (!target || normalized(target.text) !== normalized(entry.searchText)) {
            throw new Error('有一处修订无法唯一定位，本次没有开始写入。请重新分析。');
          }
          entry.target = target;
        }

        const document = context.document;
        document.load('changeTrackingMode');
        await context.sync();
        const previousMode = document.changeTrackingMode;
        let committed = false;
        try {
          document.changeTrackingMode = Word.ChangeTrackingMode.trackAll;
          await context.sync();
          for (const entry of prepared) {
            const replacement = replacementFor(entry.change);
            if (entry.atEnd) {
              entry.target.insertText(replacement, Word.InsertLocation.end);
            } else if (!String(entry.change.oldText || '')) {
              entry.target.insertText(replacement, Word.InsertLocation.before);
            } else {
              entry.target.insertText(replacement, Word.InsertLocation.replace);
            }
          }
          await context.sync();
          committed = true;
        } catch (error) {
          throw new Error(`写入过程中出现错误，Word 可能已应用部分修订。请先在“审阅”中检查，不要重复提交：${error.message}`);
        } finally {
          document.changeTrackingMode = previousMode;
          if (committed) releaseBookmark(document, snapshot.bookmarkName);
          await context.sync();
        }
        return { ok: true, tracked: true, granular: true };
      });
    },

    replaceSelection(snapshot, replacement) {
      return Word.run(async (context) => {
        const range = await verifySelection(context, snapshot);
        if (!supportsReviewApi()) {
          throw new Error('当前 Word 版本不支持安全写回，请复制结果后手动粘贴。');
        }
        range.insertText(replacement, Word.InsertLocation.replace);
        releaseBookmark(context.document, snapshot.bookmarkName);
        await context.sync();
        return { ok: true, tracked: false };
      });
    },
  };
})(window);
