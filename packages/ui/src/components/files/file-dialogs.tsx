// SPDX-License-Identifier: Apache-2.0
/**
 * Files dialogs (doc 06 §2.5/§2.7): one shared create/rename/delete dialog
 * with the exact title/description/toast strings, the no-cancel unsaved
 * guard (Save changes / Discard only), and the §3.9 inline go-to-line input
 * (live caret move on typing; Escape/outside closes without buffering).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../I18nProvider.tsx';
import type { I18nKey } from '../../lib/i18n/messages/en.ts';

export type FileDialogMode = 'create-file' | 'create-folder' | 'rename' | 'delete';

export interface FileDialogSpec {
  mode: FileDialogMode;
  targetPath: string;
  targetName: string;
}

const DEFAULT_PATH_LABEL = 'root';

export function FileDialog({
  spec, parentPath, busy, onConfirm, onCancel,
}: {
  spec: FileDialogSpec;
  parentPath: string;
  busy: boolean;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}): ReactNode {
  const { t } = useI18n();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const titleKey = modeTitleKey(spec.mode);
  const description = modeDescription(spec.mode, parentPath === '' ? DEFAULT_PATH_LABEL : parentPath, spec.targetName);
  const isDelete = spec.mode === 'delete';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" data-testid="files-dialog">
      <div className="w-80 rounded-lg border border-border/60 bg-card p-4 shadow-2xl">
        <div className="text-sm font-medium text-foreground">{t(titleKey)}</div>
        <div className="mt-1 text-xs text-muted-foreground">{description}</div>
        {!isDelete ? (
          <input
            className="mt-3 h-8 w-full rounded border border-border/60 bg-interactive-hover/30 px-2 text-xs text-foreground outline-none"
            placeholder={t('filesView.dialog.nameRequired')}
            value={value}
            autoFocus
            onChange={(event) => setValue(event.target.value)}
          />
        ) : null}
        {error !== null ? <div className="mt-2 text-xs text-status-error">{error}</div> : null}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded border border-border/60 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground" onClick={onCancel}>
            {t('filesView.dialog.cancel')}
          </button>
          <button
            type="button"
            disabled={busy}
            className={`rounded px-3 py-1 text-xs ${isDelete ? 'bg-status-error/25 text-status-error' : 'bg-primary/25 text-primary'}`}
            onClick={() => {
              const trimmed = value.trim();
              if (!isDelete && trimmed.length === 0) {
                setError(t('filesView.dialog.nameRequired'));
                return;
              }
              onConfirm(isDelete ? spec.targetName : trimmed);
            }}
          >
            {isDelete ? t('filesView.tree.row.delete') : t('filesView.dialog.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

function modeTitleKey(mode: FileDialogMode): I18nKey {
  return KEY_MAP[mode].title;
}

function modeDescription(mode: FileDialogMode, pathLabel: string, name: string): string {
  const { t } = useI18n();
  const key = KEY_MAP[mode].description;
  return key.length > 0 ? t(key as I18nKey, { path: pathLabel, name }) : '';
}

const KEY_MAP: Record<FileDialogMode, { title: I18nKey; description: string }> = {
  'create-file': { title: 'filesView.dialog.createFileTitle', description: 'filesView.dialog.createFileDescription' },
  'create-folder': { title: 'filesView.dialog.createFolderTitle', description: 'filesView.dialog.createFolderDescription' },
  rename: { title: 'filesView.dialog.renameTitle', description: 'filesView.dialog.renameDescription' },
  delete: { title: 'filesView.dialog.deleteTitle', description: 'filesView.dialog.deleteDescription' },
};

/** §2.7 unsaved guard: intentionally NO cancel path. */
export function UnsavedChangesGuard({ onSave, onDiscard }: { onSave: () => void; onDiscard: () => void }): ReactNode {
  const { t } = useI18n();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" data-testid="unsaved-guard">
      <div className="w-80 rounded-lg border border-border/60 bg-card p-4 shadow-2xl">
        <div className="text-sm font-medium text-foreground">{t('filesView.editor.unsavedTitle')}</div>
        <div className="mt-1 text-xs text-muted-foreground">{t('filesView.editor.unsavedDescription')}</div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded bg-status-success/20 px-3 py-1 text-xs text-status-success" onClick={onSave}>
            {t('filesView.editor.saveChanges')}
          </button>
          <button type="button" className="rounded bg-status-error/20 px-3 py-1 text-xs text-status-error" onClick={onDiscard}>
            {t('filesView.editor.discard')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** §3.9 go-to-line (inline variant): live caret move while typing; Enter
 * commits; Escape/outside closes restoring the initial selection. Textarea
 * host v1 (delta E20: CodeMirror swap keeps this contract). */
export function GoToLineInput({
  value, maxLines, currentLine, initialCaret, onMoveCaret, onCommit, onClose,
}: { value: string;
  maxLines: number;
  currentLine: number;
  initialCaret: number;
  onMoveCaret: (line: number) => void;
  onCommit: (line: number) => void;
  onClose: () => void;
}): ReactNode {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (hostRef.current !== null && !hostRef.current.contains(event.target as Node)) onClose();
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [onClose]);
  return (
    <div ref={hostRef} className="pointer-events-auto absolute right-3 top-2 z-20 flex items-center gap-1 rounded border border-border/60 bg-card px-2 py-1 shadow-lg" data-testid="go-to-line">
      <input
        className="h-6 w-20 bg-transparent text-xs text-foreground outline-none"
        placeholder={t('filesView.goToLine.placeholder')}
        value={draft}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          if (next.length === 0) {
            onMoveCaret(-1); // restore the initial caret
            return;
          }
          const line = Number(next);
          if (!Number.isInteger(line)) return;
          onMoveCaret(Math.max(1, Math.min(maxLines, line)));
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            const line = Number(draft);
            if (Number.isInteger(line)) onCommit(Math.max(1, Math.min(maxLines, line)));
            onClose();
          }
          if (event.key === 'Escape') onClose();
        }}
      />
      <span className="text-[10px] text-muted-foreground">
        {t('filesView.goToLine.range', { current: String(currentLine), max: String(maxLines) })}
      </span>
      <button type="button" className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => {
        const line = Number(draft);
        if (Number.isInteger(line) && line >= 1) onCommit(Math.max(1, Math.min(maxLines, line)));
        onClose();
      }}>
        {t('filesView.goToLine.go')}
      </button>
    </div>
  );
}

export function TabRow({
  openPaths, selected, onSelect, onClose,
}: { openPaths: string[]; selected: string | null; onSelect: (path: string) => void; onClose: (path: string) => void }): ReactNode {
  const { t } = useI18n();
  if (openPaths.length === 0) {
    return <div className="border-b border-border/40 px-3 py-1.5 text-[11px] text-muted-foreground">{t('filesView.editor.selectAFile')}</div>;
  }
  return (
    <div className="flex items-center gap-1 overflow-x-auto border-b border-border/40 px-2 py-1" aria-label={t('filesView.editor.openFiles')}>
      {openPaths.map((path) => {
        const name = path.split(/[\\/]/u).pop() ?? path;
        const active = path === selected;
        return (
          <span
            key={path}
            className={`flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs ${
              active ? 'bg-interactive-selection text-interactive-selection-foreground' : 'text-muted-foreground hover:bg-interactive-hover/40'
            }`}
          >
            <button type="button" className="max-w-56 truncate" onClick={() => onSelect(path)} title={path}>
              {name}
            </button>
            <button type="button" aria-label={t('filesView.editor.closeTab', { name })} className="opacity-60 hover:opacity-100" onClick={() => onClose(path)}>
              ✕
            </button>
          </span>
        );
      })}
    </div>
  );
}


/** §3.9 inline go-to-line host adapter: live caret move while typing, Enter
 * commits, Escape/outside closes restoring the initial caret. */
export function EditorGoToLine({ draft, textareaRef, restoreRef, onClose }: { draft: string; textareaRef: { current: HTMLTextAreaElement | null }; restoreRef: { current: number }; onClose: () => void }): ReactNode {
  const offsetOfLine = (text: string, line: number): number => {
    const lines = text.split('\n');
    const target = Math.max(1, Math.min(lines.length, line));
    return lines.slice(0, target - 1).reduce((sum, row) => sum + row.length + 1, 0);
  };
  return (
    <GoToLineInput
      initialCaret={0}
      value={draft}
      maxLines={(draft.match(/\n/gu) ?? []).length + 1}
      currentLine={(draft.slice(0, textareaRef.current?.selectionStart ?? 0).match(/\n/gu) ?? []).length + 1}
      onMoveCaret={(line) => {
        const element = textareaRef.current;
        if (element === null) return;
        if (line < 0) {
          element.setSelectionRange(restoreRef.current, restoreRef.current);
          element.focus();
          return;
        }
        restoreRef.current = offsetOfLine(draft, line);
        element.setSelectionRange(restoreRef.current, restoreRef.current);
        element.focus();
      }}
      onCommit={(line) => {
        const element = textareaRef.current;
        if (element === null) return;
        const offset = offsetOfLine(draft, line);
        element.setSelectionRange(offset, offset);
        element.focus();
      }}
      onClose={() => {
        const element = textareaRef.current;
        if (element !== null) element.setSelectionRange(restoreRef.current, restoreRef.current);
        onClose();
      }}
    />
  );
}