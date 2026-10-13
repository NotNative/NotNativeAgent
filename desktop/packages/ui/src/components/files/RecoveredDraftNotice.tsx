// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, type ReactNode } from 'react';

/** A recovered draft never silently overwrites a changed or unverified file. */
export function RecoveredDraftNotice({ safety, draft, onDiscard, onOverwrite }: {
  safety: 'verified' | 'changed' | 'unknown';
  draft: string;
  onDiscard: () => void;
  onOverwrite: () => void;
}): ReactNode {
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  // A prior confirmation cannot authorize overwriting a newly changed disk
  // state or a different edit than the one the operator just reviewed.
  useEffect(() => { setConfirmOverwrite(false); }, [safety, draft]);
  return <div className="flex flex-wrap items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
    role={safety === 'verified' ? 'status' : 'alert'} data-testid="files-recovered-draft">
    <span className="min-w-0 flex-1">
      {safety === 'verified' ? 'Unsaved edits restored from this app session. Auto-save is paused until you save.'
        : safety === 'changed' ? 'Unsaved edits restored, but the file changed on disk. Review before overwriting.'
          : 'Unsaved edits restored, but the on-disk file could not be verified. Save requires explicit overwrite.'}
    </span>
    <button type="button" className="rounded border border-amber-500/40 px-2 py-1" onClick={onDiscard}>Discard draft & reload</button>
    {safety !== 'verified' ? <button type="button" className="rounded border border-amber-500/40 px-2 py-1"
      onClick={() => { if (confirmOverwrite) onOverwrite(); else setConfirmOverwrite(true); }}>
      {confirmOverwrite ? 'Confirm overwrite' : 'Overwrite disk with draft…'}
    </button> : null}
  </div>;
}
