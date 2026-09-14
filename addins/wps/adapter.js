(function (global) {
  'use strict';

  function app() {
    return global.Application || global.wps;
  }

  function normalized(value) {
    return String(value || '').replace(/\r\n?/g, '\n').replace(/[\u200B-\u200D\uFEFF]/g, '');
  }

  function getSelection() {
    const application = app();
    if (!application || !application.Selection) {
      throw new Error('未检测到 WPS 文字编辑器，请从 WPS 加载项中打开润石。');
    }
    return application.Selection;
  }

  function getDocument() {
    const document = app()?.ActiveDocument;
    if (!document || typeof document.Range !== 'function') {
      throw new Error('WPS 当前文档不可编辑。');
    }
    return document;
  }

  function replacementFor(change) {
    return change.type === 'delete' ? '' : String(change.newText || '');
  }

  function commentFor(change) {
    if (change.type === 'replace') return `润石建议：将「${change.oldText}」改为「${change.newText}」。`;
    if (change.type === 'delete') return `润石建议：删除「${change.oldText}」。`;
    return `润石建议：在此处补充「${change.newText}」。`;
  }

  function verifySnapshot(snapshot) {
    const document = getDocument();
    if (snapshot.documentId && snapshot.documentId !== String(document.FullName || document.Name || '')) {
      throw new Error('当前文档已切换，请重新选择文字并分析。');
    }
    const range = document.Range(snapshot.start, snapshot.end);
    if (normalized(range.Text) !== normalized(snapshot.text)) {
      throw new Error('原选区已发生变化。请重新选择文字并分析，避免覆盖刚才的编辑。');
    }
    return { document, range };
  }

  function addComment(document, range, text) {
    if (!document.Comments || typeof document.Comments.Add !== 'function') {
      throw new Error('当前 WPS 版本不支持 JS 批注接口。');
    }
    try {
      document.Comments.Add(range, text);
    } catch (_) {
      document.Comments.Add({ Range: range, Text: text });
    }
  }

  global.RunShiHost = {
    ready() {
      return Promise.resolve().then(() => {
        getSelection();
        return 'WPS 文字';
      });
    },

    capabilities() {
      const document = getDocument();
      return {
        canWriteBack: true,
        canAnnotate: Boolean(document.Comments && typeof document.Comments.Add === 'function'),
        canTrackRevisions: 'TrackRevisions' in document,
      };
    },

    captureSelection() {
      const selection = getSelection();
      return Promise.resolve({
        text: String(selection.Text || ''),
        start: Number(selection.Start),
        end: Number(selection.End),
        host: 'wps',
        documentId: String(getDocument().FullName || getDocument().Name || ''),
      });
    },

    annotateSuggestions(snapshot, changes) {
      return Promise.resolve().then(() => {
        const { document, range: wholeRange } = verifySnapshot(snapshot);
        let annotated = 0;
        let unresolved = 0;
        for (const change of changes) {
          const start = snapshot.start + Number(change.originalStart || 0);
          const end = snapshot.start + Number(change.originalEnd || change.originalStart || 0);
          const target = end > start ? document.Range(start, end) : wholeRange;
          try {
            addComment(document, target, commentFor(change));
            annotated += 1;
          } catch (_) {
            unresolved += 1;
          }
        }
        return { ok: true, annotated, unresolved, summaryIncluded: false };
      });
    },

    applyAcceptedChanges(snapshot, changes, finalText) {
      return Promise.resolve().then(() => {
        const { document } = verifySnapshot(snapshot);
        const previousTracking = Boolean(document.TrackRevisions);
        const ordered = [...changes].sort((a, b) => Number(b.originalStart) - Number(a.originalStart));
        for (const change of ordered) {
          const start = snapshot.start + Number(change.originalStart);
          const end = snapshot.start + Number(change.originalEnd);
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
            || start < snapshot.start || end < start || end > snapshot.end) {
            throw new Error('修订范围无效，请重新选择文字并分析。');
          }
          if (normalized(document.Range(start, end).Text) !== normalized(String(change.oldText || ''))) {
            throw new Error('部分原文已发生变化，本次没有开始写入。请重新分析。');
          }
        }
        document.TrackRevisions = true;
        const applied = [];
        try {
          for (const change of ordered) {
            const start = snapshot.start + Number(change.originalStart);
            const end = snapshot.start + Number(change.originalEnd);
            document.Range(start, end).Text = replacementFor(change);
            applied.push(change);
          }
        } catch (error) {
          let rollbackComplete = true;
          // Changes were applied from the end of the selection toward the
          // start. Undo them in the opposite order so length-changing edits
          // restore all later offsets before those later ranges are read.
          for (const change of [...applied].reverse()) {
            const start = snapshot.start + Number(change.originalStart);
            const replacement = replacementFor(change);
            try {
              const current = document.Range(start, start + replacement.length);
              if (normalized(current.Text) !== normalized(replacement)) {
                rollbackComplete = false;
                continue;
              }
              current.Text = String(change.oldText || '');
            } catch (_) {
              rollbackComplete = false;
            }
          }
          if (!rollbackComplete) {
            throw new Error('部分修订已写入但未能全部恢复，请先检查文档并重新分析。');
          }
          throw new Error(`写入失败，已恢复本次修改：${error.message}`);
        } finally {
          document.TrackRevisions = previousTracking;
        }
        const updated = document.Range(snapshot.start, snapshot.start + finalText.length);
        if (typeof updated.Select === 'function') updated.Select();
        return { ok: true, tracked: true };
      });
    },

    replaceSelection(snapshot, replacement) {
      return Promise.resolve().then(() => {
        const { range } = verifySnapshot(snapshot);
        range.Text = replacement;
        if (typeof range.Select === 'function') range.Select();
        return { ok: true, tracked: false };
      });
    },
  };
})(window);
