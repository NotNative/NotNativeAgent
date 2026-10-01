// SPDX-License-Identifier: Apache-2.0
/** Read-only per-file diff preview for the Changes rail and Git workbench. */
import { useEffect, useState, type ReactNode } from 'react';
import { fetchGitDiff, type GitStatus } from '../../lib/git/api.ts';
import { fileDiffFromPatch, isBinaryPatch, LARGE_DIFF_CHANGED_LINES, type FileDiffMetadata } from '../../lib/git/diff-model.ts';
import { DiffViewer } from '../diff/DiffViewer.tsx';
import { useI18n } from '../../lib/i18n/context.tsx';

const MAX_PREVIEW_PATCH_CHARS = 1_000_000;
type Preview = { state: 'loading' } | { state: 'error' } | { state: 'empty' }
  | { state: 'binary' } | { state: 'large' } | { state: 'ready'; diff: FileDiffMetadata };

export function GitFilePreview({ directory, path, staged, revision, onClose }: {
  directory: string; path: string; staged: boolean; revision: GitStatus | null; onClose: () => void;
}): ReactNode {
  const { t } = useI18n();
  const [preview, setPreview] = useState<Preview>({ state: 'loading' });
  const [renderLarge, setRenderLarge] = useState(false);
  useEffect(() => {
    let current = true;
    setPreview({ state: 'loading' });
    setRenderLarge(false);
    void fetchGitDiff(directory, path, { staged, contextLines: 3 }).then((response) => {
      if (!current) return;
      const patch = response?.diff;
      if (typeof patch !== 'string') { setPreview({ state: 'error' }); return; }
      if (!patch) { setPreview({ state: 'empty' }); return; }
      if (isBinaryPatch(patch)) { setPreview({ state: 'binary' }); return; }
      if (patch.length > MAX_PREVIEW_PATCH_CHARS) { setPreview({ state: 'large' }); return; }
      try { setPreview({ state: 'ready', diff: fileDiffFromPatch(path, patch, 3) }); }
      catch { setPreview({ state: 'error' }); }
    }).catch(() => { if (current) setPreview({ state: 'error' }); });
    return () => { current = false; };
  }, [directory, path, staged, revision]);
  const tooManyLines = preview.state === 'ready'
    && preview.diff.insertionCount + preview.diff.deletionCount > LARGE_DIFF_CHANGED_LINES;
  return <section className="min-w-0 rounded-lg border border-border/60 bg-card/40" data-testid="git-file-preview"
    data-path={path} data-scope={staged ? 'staged' : 'working'}>
    <header className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
      <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={path}>{path}</span>
      <span className="text-[10px] text-muted-foreground">{staged ? t('gitUi.staged') : t('gitUi.working')}</span>
      <button type="button" aria-label={t('gitUi.closeDiffPreview')} className="text-xs text-muted-foreground hover:text-foreground" onClick={onClose}>×</button>
    </header>
    <div className="max-h-[45vh] overflow-auto p-2 text-xs" data-testid="git-file-preview-body">
      {preview.state === 'loading' ? <div role="status">{t('gitUi.loadingDiff')}</div> : null}
      {preview.state === 'error' ? <div role="status">{t('gitUi.diffUnavailable')}</div> : null}
      {preview.state === 'empty' ? <div role="status">{t('gitUi.noTextualDiff')}</div> : null}
      {preview.state === 'binary' ? <div role="status">{t('gitUi.binaryNoDiff')}</div> : null}
      {preview.state === 'large' || tooManyLines && !renderLarge ? <div><div role="status">{t('gitUi.largeDiffPaused')} </div>
         {preview.state === 'ready' ? <button type="button" className="ml-2 text-primary underline" onClick={() => setRenderLarge(true)}>{t('gitUi.renderAnyway')}</button> : null}
      </div> : null}
      {preview.state === 'ready' && (!tooManyLines || renderLarge) ? <DiffViewer fileName={path} fileDiff={preview.diff}
        renderSideBySide={false} wrapLines /> : null}
    </div>
  </section>;
}
