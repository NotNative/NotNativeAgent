// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';

export type WorkspaceTool = 'chat' | 'files' | 'diff' | 'git' | 'plan' | 'terminal' | 'agent-groups';

interface WorkspaceToolRailProps {
  active: WorkspaceTool | 'archive';
  nativeAlpha: boolean;
  terminalUnavailable: boolean;
  labels: Record<WorkspaceTool | 'scheduled' | 'worktrees' | 'multirun', string>;
  onSelect: (tool: WorkspaceTool) => void;
  onScheduled: () => void;
  onWorktrees: () => void;
  onMultiRun: () => void;
}

const destinations: { id: WorkspaceTool; icon: string; testId: string }[] = [
  { id: 'chat', icon: '◫', testId: 'chat-toggle' },
  { id: 'files', icon: '▤', testId: 'files-toggle' },
  { id: 'diff', icon: '⇆', testId: 'diff-toggle' },
  { id: 'git', icon: '⑂', testId: 'git-toggle' },
  { id: 'plan', icon: '☷', testId: 'plan-toggle' },
  { id: 'terminal', icon: '>_', testId: 'terminal-toggle' },
  { id: 'agent-groups', icon: '▦', testId: 'agent-groups-toggle' },
];

/** A persistent destination rail; transient tools remain separate actions. */
export function WorkspaceToolRail(props: WorkspaceToolRailProps): ReactNode {
  const { active, nativeAlpha, terminalUnavailable, labels, onSelect } = props;
  return (
    <nav aria-label="Workspace tools" className="flex w-14 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-white/10 bg-neutral-950/70 px-1 py-3">
      {destinations.map(({ id, icon, testId }) => {
        const disabled = id === 'terminal' ? terminalUnavailable : nativeAlpha && id !== 'chat' && id !== 'diff';
        return <button key={id} type="button" data-testid={testId} title={labels[id]} aria-label={labels[id]}
          aria-current={active === id ? 'page' : undefined} disabled={disabled} onClick={() => onSelect(id)}
          className={`flex h-10 w-10 items-center justify-center rounded-lg text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${active === id ? 'bg-amber-500/15 text-amber-300' : 'text-neutral-400 hover:bg-white/10 hover:text-neutral-100'}`}>
          <span aria-hidden="true">{icon}</span>
        </button>;
      })}
      <span className="my-2 w-7 border-t border-white/10" aria-hidden="true" />
      <RailAction label={labels.scheduled} testId="scheduled-tasks-toggle" icon="◷" disabled={nativeAlpha} onClick={props.onScheduled} />
      <RailAction label={labels.worktrees} testId="worktrees-toggle" icon="⌥" disabled={nativeAlpha} onClick={props.onWorktrees} />
      <RailAction label={labels.multirun} testId="multirun-toggle" icon="⧉" disabled={nativeAlpha} onClick={props.onMultiRun} />
    </nav>
  );
}

function RailAction({ label, testId, icon, disabled, onClick }: { label: string; testId: string; icon: string; disabled: boolean; onClick: () => void }): ReactNode {
  return <button type="button" data-testid={testId} title={label} aria-label={label} disabled={disabled} onClick={onClick}
    className="flex h-10 w-10 items-center justify-center rounded-lg text-sm text-neutral-400 hover:bg-white/10 hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-35">
    <span aria-hidden="true">{icon}</span>
  </button>;
}
