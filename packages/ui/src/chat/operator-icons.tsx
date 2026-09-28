// SPDX-License-Identifier: Apache-2.0
/** Small, original outline glyphs for the always-visible operator dock. */
import type { ReactNode } from 'react';

type SurfaceIcon = 'context' | 'activity' | 'changes' | 'files' | 'worktrees' | 'walkthrough' | 'notes' | 'browser' | 'terminal';

export function OperatorIcon({ surface }: { surface: SurfaceIcon }): ReactNode {
  const paths: Record<SurfaceIcon, ReactNode> = {
    context: <><path d="M12 3a9 9 0 1 0 9 9" /><path d="M12 3v4m0-4h4" /></>,
    activity: <><path d="M3 12h4l2-5 3 10 2-5h7" /></>,
    changes: <><circle cx="6" cy="5" r="1.5" /><circle cx="18" cy="8" r="1.5" /><circle cx="6" cy="19" r="1.5" /><path d="M6 7v10m0-4c0-4 12-1 12-3" /></>,
    files: <><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M3 10h18" /></>,
    worktrees: <><path d="M4 5h16M4 10h16M4 15h16M4 20h16" /><circle cx="8" cy="5" r="1.5" /><circle cx="15" cy="15" r="1.5" /></>,
    walkthrough: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16" /></>,
    notes: <><path d="M5 3h11l3 3v15H5z" /><path d="M16 3v4h3M8 11h8M8 15h8" /></>,
    browser: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c-5 5-5 13 0 18m0-18c5 5 5 13 0 18" /></>,
    terminal: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3m5 0h5" /></>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[surface]}</svg>;
}
