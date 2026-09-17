// SPDX-License-Identifier: Apache-2.0
/**
 * FilesView editor stage (doc 06 sections 2/3, P6-1 subset): pane rendering
 * for text/preview/image/binary + the floating pane action buttons; text
 * editing rides the textarea host carrying the inline-comment contract.
 * Extracted from FilesView so the file stays under the 500-line gate cap.
 */
import { type ReactNode } from 'react';
import { useI18n } from '../I18nProvider.tsx';
import { rawAssetUrl } from '../../lib/files/api.ts';

export type PaneKind = 'text' | 'image' | 'binary';

export function EditorStage({
  directory, selectedPath, paneKind, binaryDetected, loading, error, draft, setDraft, wrapLines, textareaRef, onGoToLine,
  viewMode, onViewMode,
}: {
  directory: string;
  selectedPath: string | null;
  paneKind: PaneKind;
  binaryDetected: boolean;
  loading: boolean;
  error: string | null;
  draft: string;
  setDraft: (draft: string) => void;
  wrapLines: boolean;
  textareaRef: { current: HTMLTextAreaElement | null };
  onGoToLine: () => void;
  viewMode: 'view' | 'edit';
  onViewMode: (mode: 'view' | 'edit') => void;
}): ReactNode {
  const { t } = useI18n();
  if (selectedPath === null) {
    return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">{t('filesView.editor.empty')}</div>;
  }
  if (loading) {
    return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">{t('filesView.editor.loading')}</div>;
  }
  if (error !== null) {
    return <div className="flex flex-1 items-center justify-center px-6 text-sm text-status-error">{error}</div>;
  }
  if (paneKind === 'image') {
    return (
      <div className="flex flex-1 items-center justify-center overflow-auto p-4">
        <img src={rawAssetUrl(directory, selectedPath)} alt={t('filesView.editor.image')} className="max-h-[70vh] rounded border border-border/50" />
      </div>
    );
  }
  if (paneKind === 'binary' || binaryDetected) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
        <div className="text-sm font-medium text-foreground">{t('filesView.editor.binaryTitle')}</div>
        <div className="max-w-md text-xs text-muted-foreground">{t('filesView.editor.binaryDescription')}</div>
        <a className="rounded bg-primary/20 px-3 py-1 text-xs text-primary" href={rawAssetUrl(directory, selectedPath, true)} download>
          {t('filesView.editor.saveFile')}
        </a>
      </div>
    );
  }
  return (
    <div className="relative min-h-0 flex-1">
      {viewMode === 'view' ? (
        <pre className="h-full w-full overflow-auto p-3 font-mono text-xs text-foreground" style={{ whiteSpace: wrapLines ? 'pre-wrap' : 'pre' }}>
          {draft}
        </pre>
      ) : (
        <textarea
          ref={textareaRef}
          className="h-full w-full resize-none bg-transparent p-3 font-mono text-xs text-foreground outline-none"
          style={{ whiteSpace: wrapLines ? 'pre-wrap' : 'pre', overflow: wrapLines ? 'auto' : 'scroll' }}
          value={draft}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
        />
      )}
      <button type="button" className="absolute right-3 top-2 rounded border border-border/50 bg-card/70 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground" onClick={onGoToLine} title="Go to line">⌗</button>
      <button type="button" className="absolute right-12 top-2 rounded border border-border/50 bg-card/70 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => onViewMode(viewMode === 'view' ? 'edit' : 'view')} title={viewMode === 'view' ? 'Switch to edit' : 'Switch to preview'}>
        {viewMode === 'view' ? '✎' : '👁'}
      </button>
    </div>
  );
}
