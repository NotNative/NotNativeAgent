// SPDX-License-Identifier: Apache-2.0
import { useRef, useState, type ReactNode } from 'react';
import { addNativeWorkspace, type WorkspaceAdmissionSelection } from '../lib/nnd/workspace-admission.ts';
import { hasNativeWorkspacePicker, pickWorkspaceDirectory } from '../lib/nnd/workspace-picker.ts';
import { WorkspacePathDialog } from './workspace-path-dialog.tsx';

type Feedback = { kind: 'error' | 'success'; message: string; path: string | null };

export function useWorkspaceAddition(onAdded: (selection: WorkspaceAdmissionSelection) => void): {
  choose: () => Promise<void>;
  busy: boolean;
  controls: ReactNode;
} {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<'choosing' | 'adding' | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualPath, setManualPath] = useState('');
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const add = async (path: string): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setPhase('adding');
    setFeedback(null);
    try {
      const selected = await addNativeWorkspace(path.trim());
      onAdded(selected);
      setManualOpen(false);
      setManualPath('');
      setFeedback({ kind: 'success', path: null,
        message: `${selected.added ? 'Workspace added' : 'Workspace already available'}: ${selected.directory}` });
    } catch (error) {
      setManualOpen(false);
      setFeedback({ kind: 'error', path,
        message: error instanceof Error ? error.message : 'Could not add this workspace.' });
    } finally { inFlight.current = false; setBusy(false); setPhase(null); }
  };

  const choose = async (): Promise<void> => {
    if (inFlight.current) return;
    if (!hasNativeWorkspacePicker()) { setManualOpen(true); return; }
    inFlight.current = true;
    setBusy(true);
    setPhase('choosing');
    setFeedback(null);
    let path: string | null = null;
    try { path = await pickWorkspaceDirectory(); }
    catch (error) {
      setFeedback({ kind: 'error', path: null,
        message: error instanceof Error ? error.message : 'Could not open the folder picker.' });
    } finally { inFlight.current = false; setBusy(false); setPhase(null); }
    if (path) await add(path);
  };

  const controls = <>
    {phase ? <div className="mb-2 text-xs text-neutral-300" role="status" data-testid="workspace-add-progress">
      {phase === 'choosing' ? 'Choose a workspace folder…' : 'Adding workspace in NNA…'}
    </div> : null}
    {feedback ? <div className={`mt-2 rounded-lg border px-2 py-2 text-xs ${feedback.kind === 'error' ? 'border-red-800/60 bg-red-950/30 text-red-200' : 'border-emerald-800/60 bg-emerald-950/30 text-emerald-200'}`}
      role={feedback.kind === 'error' ? 'alert' : 'status'} data-testid="workspace-add-feedback">
      <div>{feedback.message}</div>
      {feedback.kind === 'error' ? <div className="mt-2 flex gap-3">
        <button type="button" disabled={busy} className="underline disabled:opacity-50" onClick={() => void (feedback.path ? add(feedback.path) : choose())}>Retry</button>
        {feedback.path ? <button type="button" disabled={busy} className="underline disabled:opacity-50" onClick={() => void choose()}>Choose another folder</button> : null}
      </div> : null}
    </div> : null}
    {manualOpen ? <WorkspacePathDialog path={manualPath} busy={busy} onPathChange={setManualPath}
      onSubmit={() => void add(manualPath)} onClose={() => setManualOpen(false)} /> : null}
  </>;
  return { choose, busy, controls };
}
