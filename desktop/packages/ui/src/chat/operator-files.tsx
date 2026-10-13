// SPDX-License-Identifier: Apache-2.0
/** Read-only file inspection beside chat; editing remains in the existing Files workspace. */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { FileTree } from '../components/files/FileTree.tsx';
import { isBinaryFile, isImageFile, isPdfFile, looksLikeBinaryText } from '../lib/files/edit-support.ts';
import { readFileStat, readFileText } from '../lib/files/api.ts';
import { useReviewRefreshHints } from '../lib/git/refresh-hints.ts';
import { getRuntimeKey } from '../lib/runtime-switch.ts';
import { FILES_OPEN_EVENT } from '../components/scheduled/scheduled-tasks-dialog.tsx';

const MAX_READ_BYTES = 512_000;
const MAX_SHOWN_CHARS = 100_000;
type Preview = { path: string; state: 'loading' | 'text' | 'unavailable' | 'binary' | 'too-large'; text?: string; truncated?: boolean };

export function OperatorFiles({ directory, visible }: { directory: string; visible: boolean }): ReactNode {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [revision, setRevision] = useState(0);
  useReviewRefreshHints(directory, visible, () => setRevision((value) => value + 1));
  useEffect(() => {
    if (!visible || !selectedPath) return undefined;
    let current = true;
    setPreview({ path: selectedPath, state: 'loading' });
    void (async () => {
      if (isBinaryFile(selectedPath) || (isImageFile(selectedPath) && !selectedPath.toLowerCase().endsWith('.svg')) || isPdfFile(selectedPath)) {
        if (current) setPreview({ path: selectedPath, state: 'binary' });
        return;
      }
      try {
        const stat = await readFileStat(directory, selectedPath);
        if (!current) return;
        if (!stat?.isFile) { setPreview({ path: selectedPath, state: 'unavailable' }); return; }
        if (stat.size > MAX_READ_BYTES) { setPreview({ path: selectedPath, state: 'too-large' }); return; }
        const text = await readFileText(directory, selectedPath, true);
        if (!current) return;
        if (looksLikeBinaryText(text)) { setPreview({ path: selectedPath, state: 'binary' }); return; }
        setPreview({ path: selectedPath, state: 'text', text: text.slice(0, MAX_SHOWN_CHARS), truncated: text.length > MAX_SHOWN_CHARS });
      } catch { if (current) setPreview({ path: selectedPath, state: 'unavailable' }); }
    })();
    return () => { current = false; };
  }, [directory, selectedPath, revision, visible]);
  const openEditor = useCallback(() => {
    if (selectedPath) window.dispatchEvent(new CustomEvent(FILES_OPEN_EVENT, { detail: { directory, path: selectedPath } }));
  }, [directory, selectedPath]);
  const ignoreMutation = useCallback(() => undefined, []);
  return <section className="flex h-full min-h-0 flex-col" data-testid="operator-files">
    <div className="min-h-0 flex-[2] border-b border-white/10">
      <FileTree root={directory} runtimeKey={getRuntimeKey()} visible={visible} onOpenFile={setSelectedPath}
        onNewFile={ignoreMutation} onNewFolder={ignoreMutation} onRename={ignoreMutation} onDelete={ignoreMutation} readOnly />
    </div>
    <div className="flex min-h-0 flex-[3] flex-col" data-testid="operator-file-preview">
      <header className="flex items-center gap-2 border-b border-white/10 px-3 py-2 text-[11px]">
        <span className="min-w-0 flex-1 truncate text-neutral-300" title={selectedPath ?? ''}>{selectedPath ? selectedPath.split(/[\\/]/u).at(-1) : 'Select a file to preview'}</span>
        {selectedPath ? <button type="button" className="text-sky-300 hover:underline" onClick={openEditor}>Open editor</button> : null}
      </header>
      {selectedPath && preview?.path === selectedPath ? <div className="min-h-0 flex-1 overflow-auto p-3 text-[11px] text-neutral-400">
        {preview.state === 'loading' ? 'Loading preview…' : null}
        {preview.state === 'unavailable' ? 'Preview unavailable. Open the editor to inspect this file.' : null}
        {preview.state === 'binary' ? 'Binary or media file. Open the editor for its supported view.' : null}
        {preview.state === 'too-large' ? 'File is too large for the side preview. Open the editor.' : null}
        {preview.state === 'text' ? <><pre className="whitespace-pre-wrap break-words font-mono text-neutral-300">{preview.text}</pre>{preview.truncated ? <p className="mt-2 text-amber-300">Preview truncated. Open the editor for the full file.</p> : null}</> : null}
      </div> : null}
    </div>
  </section>;
}
