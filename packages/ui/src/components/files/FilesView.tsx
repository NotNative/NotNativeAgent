// SPDX-License-Identifier: Apache-2.0
/** Files editor host (doc 06 §2/§3): tabs, guarded edits, autosave, stat
 * reconciliation, and in-memory recovery when navigation unmounts the view. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { FileTree } from './FileTree.tsx';
import { EditorGoToLine, FileDialog, TabRow, UnsavedChangesGuard } from './file-dialogs.tsx';
import { EditorStage, type PaneKind } from './editor-stage.tsx';
import { AUTO_SAVE_DELAY, LARGE_FILE_CHAR_THRESHOLD, MAX_CONTENT_POLL_BYTES, STAT_POLL_INTERVAL_MS, SAVE_STATUS_LINGER_MS,
  hasFileStatChanged, isBinaryFile, isImageFile, isPdfFile, looksLikeBinaryText, prepareFileEditorContent,
  serializeEditorContent } from '../../lib/files/edit-support.ts';
import { effectiveSelectedPath, useFilesViewTabsStore } from '../../lib/files/tabs-store.ts';
import { forgetDraftLease, inspectDraftLeaseOnDisk, readDraftLease, rememberDraftLease, type DraftStat } from '../../lib/files/draft-leases.ts';
import { createDirectory, deleteEntry, readFileStat, readFileText, renameEntry, writeFileText } from '../../lib/files/api.ts';
import { getRuntimeKey } from '../../lib/runtime-switch.ts';
import { useKeybind } from '../../lib/shortcuts/hooks.ts';
import { effectiveShortcutCombo } from '../../lib/shortcuts/schema.ts';
import { useI18n } from '../I18nProvider.tsx';
import { beginCommentFromSelection, InlineComments } from '../comments/InlineComments.tsx';
import { useInlineCommentController } from '../comments/controller.ts';
import { useActiveSessionKey } from '../comments/useActiveSessionKey.ts';
import { joinPath, parentDirOf, publishWorkspaceHint, saveShortcutDisplay, type DialogSpec } from './file-editor-utils.ts';
import { RecoveredDraftNotice } from './RecoveredDraftNotice.tsx';

type SaveStatus = 'idle' | 'saving' | 'saved';
type Recovery = { path: string; stat: DraftStat | null; autoSaveEnabled: boolean; safety: 'verified' | 'changed' | 'unknown' };

export function FilesView({ directory, visible, mode = 'full' }: { directory: string; visible: boolean; mode?: 'full' | 'editor-only' }): ReactNode {
  const { t } = useI18n();
  const runtimeKey = getRuntimeKey();
  const byRootDoc = useFilesViewTabsStore((state) => state.byRoot[directory]);
  const openPaths = byRootDoc?.openPaths ?? [];
  const storeSelected = byRootDoc?.selectedPath ?? null;
  const selectedPath = useMemo(
    () => (storeSelected !== null && openPaths.includes(storeSelected) ? storeSelected : openPaths[0] ?? null),
    [storeSelected, openPaths],
  );
  const treeEnabled = mode === 'full';

  const [paneKind, setPaneKind] = useState<PaneKind>('text');
  const [draft, setDraft] = useState('');
  const [baseline, setBaseline] = useState('');
  const [lineEnding, setLineEnding] = useState<'\n' | '\r\n'>('\n');
  const [binaryDetected, setBinaryDetected] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(true);
  const [dialog, setDialog] = useState<DialogSpec | null>(null);
  const [guard, setGuard] = useState<{ next: string | null } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileLoading, setLoading] = useState(false);
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [wrapLines, setWrapLines] = useState(true);
  const [showGoToLine, setShowGoToLine] = useState(false);
  const statRef = useRef<{ size: number; mtimeMs: number | null } | null>(null);
  const loadedRef = useRef<string | null>(null);
  const loadedScopeRef = useRef<{ runtime: string; root: string; path: string } | null>(null);
  const nextGuardRef = useRef(false);
  const guardPendingRef = useRef<string | null>(null);
  const loadIdRef = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const goToLineRestoreRef = useRef(0);

  const isDirty = draft !== baseline;

  // §3.3 load pipeline (text v1 + image/binary gating).
  const loadFile = useCallback(async (path: string, discardLease = false): Promise<void> => {
    const loadId = ++loadIdRef.current;
    const previousPath = loadedRef.current;
    const previousScope = loadedScopeRef.current;
    const previousStat = statRef.current;
    setLoading(true);
    setFileError(null);
    if (!discardLease) setRecovery(null);
    statRef.current = null;
    setBinaryDetected(false);
    loadedRef.current = null;
    loadedScopeRef.current = null;
    try {
      const lease = discardLease ? null : readDraftLease(runtimeKey, directory, path);
      if (lease !== null) {
        const safety = await inspectDraftLeaseOnDisk(directory, path, lease);
        if (loadId !== loadIdRef.current || getRuntimeKey() !== runtimeKey) return;
        setPaneKind('text');
        setLineEnding(lease.lineEnding);
        setDraft(lease.draft);
        setBaseline(lease.baseline);
        setAutoSaveEnabled(false);
        setViewMode('edit');
        statRef.current = lease.stat;
        loadedRef.current = path;
        loadedScopeRef.current = { runtime: runtimeKey, root: directory, path };
        setRecovery({ path, stat: lease.stat, autoSaveEnabled: lease.autoSaveEnabled, safety });
        setLoading(false);
        return;
      }
      if (isImageFile(path) && !path.toLowerCase().endsWith('.svg')) {
        setPaneKind('image');
        loadedRef.current = path;
        if (discardLease) { forgetDraftLease(runtimeKey, directory, path); setRecovery(null); }
        setLoading(false);
        return;
      }
      if (isBinaryFile(path) || isPdfFile(path)) {
        setPaneKind('binary');
        loadedRef.current = path;
        if (discardLease) { forgetDraftLease(runtimeKey, directory, path); setRecovery(null); }
        setLoading(false);
        return;
      }
      const content = await readFileText(directory, path, discardLease);
      if (loadId !== loadIdRef.current || getRuntimeKey() !== runtimeKey) return;
      if (looksLikeBinaryText(content)) {
        setBinaryDetected(true);
        setPaneKind('binary');
        loadedRef.current = path;
        if (discardLease) { forgetDraftLease(runtimeKey, directory, path); setRecovery(null); }
        setLoading(false);
        return;
      }
      const prepared = prepareFileEditorContent(content);
      const stat = await readFileStat(directory, path);
      if (loadId !== loadIdRef.current || getRuntimeKey() !== runtimeKey) return;
      setPaneKind('text');
      setLineEnding(prepared.lineEnding);
      setDraft(prepared.draft);
      setBaseline(prepared.draft);
      loadedRef.current = path;
      loadedScopeRef.current = { runtime: runtimeKey, root: directory, path };
      if (stat !== null && stat.isFile) statRef.current = { size: stat.size, mtimeMs: stat.mtimeMs ?? null };
      const initialPreview = content.length > LARGE_FILE_CHAR_THRESHOLD;
      setViewMode(initialPreview ? 'view' : 'edit');
      if (discardLease) { forgetDraftLease(runtimeKey, directory, path); setRecovery(null); }
      setLoading(false);
    } catch (error) {
      if (loadId !== loadIdRef.current || getRuntimeKey() !== runtimeKey) return;
      if (discardLease) {
        loadedRef.current = previousPath;
        loadedScopeRef.current = previousScope;
        statRef.current = previousStat;
        setLoading(false);
        toast.error(error instanceof Error ? error.message : String(error));
        return;
      }
      setLoading(false);
      setFileError(error instanceof Error ? error.message : String(error));
    }
  }, [directory, runtimeKey]);

  // Save dirty text to this app session before navigation unmounts FilesView.
  // A recovered draft stays manual-save until the operator reviews it.
  useEffect(() => {
    const scope = loadedScopeRef.current;
    if (scope === null || paneKind !== 'text' || fileLoading) return;
    rememberDraftLease(scope.runtime, scope.root, scope.path, {
      draft, baseline, lineEnding, stat: statRef.current,
      autoSaveEnabled: recovery?.autoSaveEnabled ?? autoSaveEnabled,
    });
  }, [draft, baseline, lineEnding, paneKind, fileLoading, autoSaveEnabled, recovery]);

  const [viewMode, setViewMode] = useState<'view' | 'edit'>('edit');

  // §10.2 v1: comment rail rides the edit textarea (source 'file'); the
  // gutter-drag contract lands with the E20 CodeMirror swap.
  const comments = useInlineCommentController({
    directory,
    sessionKey: useActiveSessionKey(),
    source: 'file',
    fileLabel: selectedPath?.split(/[\\/]/u).pop() ?? '',
    language: '',
    content: draft,
  });
  const readSelection = useCallback((): { start: number; end: number } | null => {
    const field = textareaRef.current;
    if (field === null || viewMode !== 'edit') return null;
    const start = field.selectionStart ?? 0;
    const end = field.selectionEnd ?? 0;
    if (start >= end || end > draft.length) return null;
    return { start, end };
  }, [viewMode, draft]);

  // Selection change → load (§3.3 step 1); pending guard waits (§2.7).
  useEffect(() => {
    if (!visible || selectedPath === null) return undefined;
    if (guardPendingRef.current !== null) return undefined;
    if (loadedRef.current === selectedPath && loadedScopeRef.current?.runtime === runtimeKey
      && loadedScopeRef.current.root === directory) return undefined;
    void loadFile(selectedPath);
    return undefined;
  }, [selectedPath, visible, loadFile, runtimeKey, directory]);

  // §2.6 stale-tab prune on mount: stat every open path; missing or
  // non-file removals drop the tabs.
  useEffect(() => {
    void (async () => {
      for (const path of openPaths) {
        try {
          const stat = await readFileStat(directory, path);
          if ((stat === null || stat.exists === false || !stat.isFile) && readDraftLease(runtimeKey, directory, path) === null) {
            useFilesViewTabsStore.getState().removeOpenPath(directory, path);
          }
        } catch { /* keep the tab on stat failure */ }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directory, visible]);

  // §3.5 stat poll every 2,000 ms for the visible selected text file.
  // §3.5 ordering: stat baseline updates ONLY after a successful observed
  // read; dirty → wait (statRef untouched); >200k/binary dirty-content
  // clears loadedFilePath to force a full pipeline reload (§3.5.6/7).
  useEffect(() => {
    if (!visible || selectedPath === null || paneKind !== 'text' || fileLoading) return undefined;
    const poll = window.setInterval(() => {
      void (async () => {
        if (document.hidden || loadedRef.current !== selectedPath) return;
        const stat = await readFileStat(directory, selectedPath);
        if (stat === null || !stat.isFile) return;
        const latest = { size: stat.size, mtimeMs: stat.mtimeMs ?? null };
        if (!hasFileStatChanged(statRef.current, latest)) return;
        if (isDirty) return; // §3.5.b dirty → wait; statRef retained
        if (latest.size > MAX_CONTENT_POLL_BYTES) {
          loadedRef.current = null; // §3.5.6: full pipeline reload
          return;
        }
        const fresh = prepareFileEditorContent(await readFileText(directory, selectedPath, true)).draft;
        if (fresh === baseline) {
          statRef.current = latest; // §3.5.c observed → retire the change
          return;
        }
        const confirmed = prepareFileEditorContent(await readFileText(directory, selectedPath, true)).draft;
        if (confirmed !== fresh) return; // half-written guard
        if (looksLikeBinaryText(confirmed)) {
          loadedRef.current = null; // §3.5.7 text→binary: reload through guards
          return;
        }
        setDraft(confirmed);
        setBaseline(confirmed);
        statRef.current = latest;
      })();
    }, STAT_POLL_INTERVAL_MS);
    return () => window.clearInterval(poll);
  }, [visible, selectedPath, paneKind, fileLoading, isDirty, baseline, directory]);

  // §3.7 save gates + write; O_TRUNC race guard.
  const saveDraft = useCallback(async (overwriteChangedFile = false): Promise<boolean> => {
    const path = loadedRef.current;
    if (path === null || paneKind !== 'text' || binaryDetected || fileLoading) return false;
    const scope = loadedScopeRef.current;
    if (scope === null || scope.runtime !== runtimeKey || scope.root !== directory || scope.path !== path) return false;
    if (draft === baseline) return true; // clean draft = ok no-op (§3.7.5)
    if (draft.length === 0 && baseline.length !== 0) {
      console.warn?.('[files] refused O_TRUNC-shaped save', path);
      return false;
    }
    const recovered = recovery?.path === path ? recovery : null;
    if (recovered !== null && !overwriteChangedFile) {
      const safety = await inspectDraftLeaseOnDisk(directory, path, { ...recovered, draft, baseline, lineEnding });
      if (safety !== 'verified') {
        setRecovery({ ...recovered, safety });
        return false;
      }
    }
    setSaveStatus('saving');
    try {
      await writeFileText(directory, path, serializeEditorContent(draft, lineEnding));
      setBaseline(draft);
      forgetDraftLease(runtimeKey, directory, path, draft);
      const stat = await readFileStat(directory, path);
      if (stat !== null && stat.isFile) statRef.current = { size: stat.size, mtimeMs: stat.mtimeMs ?? null };
      if (recovered !== null) {
        setRecovery(null);
        setAutoSaveEnabled(recovered.autoSaveEnabled);
      }
      setSaveStatus('saved');
      publishWorkspaceHint(directory, [path], 'file-save');
      window.setTimeout(() => setSaveStatus('idle'), SAVE_STATUS_LINGER_MS);
      return true;
    } catch {
      toast.error(t('common.error'));
      setSaveStatus('idle');
      return false;
    }
  }, [paneKind, binaryDetected, fileLoading, draft, baseline, lineEnding, directory, runtimeKey, recovery, t]);

  // §3.7 steps 3–4: 1,500 ms autosave when the schedule gate holds.
  useEffect(() => {
    const gate = autoSaveEnabled && isDirty && paneKind === 'text' && !fileLoading && !binaryDetected && loadedRef.current === selectedPath;
    if (!gate) return undefined;
    const timer = window.setTimeout(() => {
      void saveDraft();
    }, AUTO_SAVE_DELAY);
    return () => window.clearTimeout(timer);
  }, [autoSaveEnabled, isDirty, paneKind, fileLoading, binaryDetected, selectedPath, draft, saveDraft]);

  // Appendix B: save_file through the registry contract — the handler
  // matches the FULL effective chord (rebind-aware, modifiers included) and
  // fires only when the event target sits inside the editor wrapper (§3.2).
  useEffect(() => {
    const onKeydown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-editor-host]') === null) return;
      const effective = effectiveShortcutCombo('save_file');
      const eventMods = new Set<string>();
      if (event.metaKey) eventMods.add('mod');
      else if (event.ctrlKey) eventMods.add(effective.chords.some((chord) => chord.mods.has('ctrl')) ? 'ctrl' : 'mod');
      if (event.altKey) eventMods.add('alt');
      if (event.shiftKey) eventMods.add('shift');
      const matched = effective.chords.some((chord) => {
        if (chord.key !== event.key.toLowerCase()) return false;
        if (chord.mods.size !== eventMods.size) return false;
        for (const mod of chord.mods) if (!eventMods.has(mod)) return false;
        return true;
      });
      if (!matched) return;
      event.preventDefault();
      void saveDraft();
    };
    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  }, [saveDraft]);
  useKeybind('open_go_to_line', () => setShowGoToLine(true));

  function openFile(path: string): void {
    if (isDirty && !nextGuardRef.current) {
      guardPendingRef.current = path; // §2.7 remember pendingSelectFileRef
      setGuard({ next: path });
      return;
    }
    useFilesViewTabsStore.getState().setSelectedPath(directory, path, runtimeKey);
    void loadFile(path);
    nextGuardRef.current = false;
  }

  function closeTab(path: string): void {
    if (isDirty && loadedRef.current === path && !nextGuardRef.current) {
      guardPendingRef.current = null; // pendingClosePathRef closes for good
      setGuard({ next: null });
      return;
    }
    useFilesViewTabsStore.getState().removeOpenPath(directory, path);
    const next = effectiveSelectedPath(directory);
    if (loadedRef.current === path) {
      if (next !== null) {
        void loadFile(next);
      } else {
        setDraft('');
        setBaseline('');
        loadedRef.current = null;
        setPaneKind('text');
      }
    }
    nextGuardRef.current = false;
  }

  function resolveGuard(kind: 'save' | 'discard'): void {
    const pending = guard;
    setGuard(null);
    const jumpTo = pending?.next ?? null;
    void (async () => {
      if (kind === 'save') {
        const saved = await saveDraft();
        if (saved) nextGuardRef.current = true; // one-shot suppression (§2.7)
        else return; // failed save keeps everything in place next time
      } else {
        setDraft(baseline); // §2.7: revert to the loaded content
        if (loadedRef.current !== null) forgetDraftLease(runtimeKey, directory, loadedRef.current);
        nextGuardRef.current = true;
      }
      guardPendingRef.current = null;
      if (jumpTo !== null) {
        openFile(jumpTo);
        return;
      }
      if (pending !== null) closeTab(pending.next !== null ? pending.next : loadedRef.current ?? '');
    })();
  }


  async function confirmDialog(dialogSpec: DialogSpec, value: string): Promise<void> {
    try {
      if (dialogSpec.mode === 'create-file') {
        const target = joinPath(dialogSpec.parent, value);
        await writeFileText(directory, target, '');
        toast.success(t('filesView.toast.fileCreated'));
        publishWorkspaceHint(directory, [target], 'fs-mutation');
      } else if (dialogSpec.mode === 'create-folder') {
        const target = joinPath(dialogSpec.parent, value);
        await createDirectory(directory, target);
        toast.success(t('filesView.toast.folderCreated'));
        publishWorkspaceHint(directory, [target], 'fs-mutation');
      } else if (dialogSpec.mode === 'rename' && dialogSpec.path !== undefined) {
        const target = joinPath(dialogSpec.parent, value);
        await renameEntry(directory, dialogSpec.path, target);
        useFilesViewTabsStore.getState().removeOpenPathsByPrefix(directory, dialogSpec.path);
        toast.success(t('filesView.toast.renamed'));
        publishWorkspaceHint(directory, [dialogSpec.path, target], 'fs-mutation');
      } else if (dialogSpec.mode === 'delete' && dialogSpec.path !== undefined) {
        await deleteEntry(directory, dialogSpec.path);
        useFilesViewTabsStore.getState().removeOpenPathsByPrefix(directory, dialogSpec.path);
        publishWorkspaceHint(directory, [dialogSpec.path], 'fs-mutation');
      }
      setDialog(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('common.error'));
    }
  }

  return (
    <div className="flex h-full min-h-0 gap-3 px-3 pb-3 pt-2" data-testid="files-view">
      {treeEnabled ? (
        <div className="w-72 shrink-0 rounded-lg border border-border/60 bg-card/40">
          <FileTree
            root={directory}
            runtimeKey={runtimeKey}
            visible={visible}
            onOpenFile={(openPath) => openFile(openPath)}
            onNewFile={(parentDir) => setDialog({ mode: 'create-file', parent: parentDir })}
            onNewFolder={(parentDir) => setDialog({ mode: 'create-folder', parent: parentDir })}
            onRename={(renamePath) => setDialog({ mode: 'rename', parent: parentDirOf(renamePath), path: renamePath })}
            onDelete={(deletePath) => setDialog({ mode: 'delete', parent: parentDirOf(deletePath), path: deletePath })}
          />
        </div>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col rounded-lg border border-border/60 bg-card/40" data-editor-host="">
        <TabRow openPaths={openPaths} selected={selectedPath} onSelect={openFile} onClose={closeTab} />
        {recovery !== null && recovery.path === selectedPath ? <RecoveredDraftNotice key={recovery.path}
          safety={recovery.safety} draft={draft} onDiscard={() => void loadFile(recovery.path, true)}
          onOverwrite={() => void saveDraft(true)} /> : null}
        <EditorStage
          directory={directory}
          selectedPath={selectedPath}
          paneKind={paneKind}
          binaryDetected={binaryDetected}
          loading={fileLoading}
          error={fileError}
          draft={draft}
          setDraft={setDraft}
          wrapLines={wrapLines}
          textareaRef={textareaRef}
          onGoToLine={() => setShowGoToLine(true)}
          viewMode={viewMode}
          onViewMode={setViewMode}
        />
        {viewMode === 'edit' && paneKind === 'text' && !binaryDetected ? (
          <InlineComments controller={comments} hostId="files" />
        ) : null}
        <div className="flex items-center gap-2 border-t border-border/40 px-3 py-1.5">
          <button
            type="button"
            className="rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
            data-testid="files-add-comment"
            onClick={() => beginCommentFromSelection(draft, readSelection(), comments.begin)}
          >
            {t('comments.add')}
          </button>
          <button
            type="button"
            className="rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
            data-testid="save-now"
            onClick={() => void saveDraft()}
          >
            {saveStatus === 'saving' ? t('filesView.editor.saving') : saveStatus === 'saved' ? t('filesView.editor.saved') : t('filesView.editor.saveNow', { shortcut: saveShortcutDisplay() })}
          </button>
          <button type="button" className="rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setWrapLines(!wrapLines)}>
            {wrapLines ? 'Wrap: on' : 'Wrap: off'}
          </button>
          <button type="button" className="rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => {
            setAutoSaveEnabled(!autoSaveEnabled);
            setRecovery((current) => current === null ? null : { ...current, autoSaveEnabled: !autoSaveEnabled });
          }}>
            {autoSaveEnabled ? 'Auto-save on' : 'Manual save'}
          </button>
          {showGoToLine && viewMode === 'edit' ? (
            <EditorGoToLine draft={draft} textareaRef={textareaRef} restoreRef={goToLineRestoreRef} onClose={() => setShowGoToLine(false)} />
          ) : null}
          <span className="ml-auto text-[11px] text-muted-foreground">{isDirty ? 'Unsaved' : ''}</span>
        </div>
      </div>
      {dialog !== null ? (
        <FileDialog
          spec={{ mode: dialog.mode, targetPath: dialog.path ?? dialog.parent, targetName: (dialog.path ?? dialog.parent).split(/[\\/]/u).pop() ?? '' }}
          parentPath={dialog.parent}
          busy={false}
          onCancel={() => setDialog(null)}
          onConfirm={(value) => void confirmDialog(dialog, value)}
        />
      ) : null}
      {guard !== null ? (
        <UnsavedChangesGuard
          onSave={() => resolveGuard('save')}
          onDiscard={() => resolveGuard('discard')}
        />
      ) : null}
    </div>
  );
}
