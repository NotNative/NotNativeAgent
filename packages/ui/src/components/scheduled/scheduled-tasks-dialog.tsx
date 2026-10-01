// SPDX-License-Identifier: Apache-2.0
/**
 * Scheduled tasks dialog (doc 12 §H rows): project selector, the task list
 * with schedule summaries, next/last runs and status badges, the enable
 * toggle (loop tasks ride the loop-file route - the file is authoritative -
 * plain tasks ride the general upsert), Run now, delete (the loop-file
 * delete confirms - it removes the file and the task), and the loop-file
 * editor handoff (FilesView opens at the file when it is inside the
 * workspace). List state + the C.10 live refresh live in
 * `scheduled-task-list.ts`.
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  deleteLoopFile, deleteScheduledTask, runScheduledTask, setLoopFileEnabled,
  upsertScheduledTask, type ScheduledTaskView, type TaskSchedule, type TaskState,
} from '../../lib/scheduled-tasks-api.ts';
import { useScheduledTaskList } from './scheduled-task-list.ts';
import { ScheduledTaskEditorDialog } from './scheduled-task-editor-dialog.tsx';
import type { ComposerServices } from '../../chat/composer.tsx';
import { useGlobalSyncStore } from '../../sync/global-stores.ts';
import { formatDateTimeForPreference } from '../../lib/format/time.ts';
import {
  interpolateText,
  scheduleLabel,
  scheduleStatusLabel,
  useScheduledText,
  type ScheduledText,
} from './scheduledText.ts';

export const SCHEDULED_OPEN_EVENT = 'nnd:scheduled-tasks-open';
export const FILES_OPEN_EVENT = 'nnd:files-open';

type TaskListBusy = (id: string, work: () => Promise<unknown>) => Promise<void>;
type EditingState = { projectId: string; task: ScheduledTaskView | null };

function normPath(path: string): string {
  return path.replaceAll('\\', '/');
}

function withinDir(file: string, directory: string): boolean {
  const base = normPath(directory).replace(/\/+$/u, '');
  return normPath(file).startsWith(`${base}/`);
}

function relativeTo(file: string, directory: string): string {
  return normPath(file).slice(normPath(directory).replace(/\/+$/u, '').length + 1);
}

function badgeClass(status: TaskState['lastStatus']): string {
  if (status === 'success') return 'bg-emerald-900/50 text-emerald-300';
  if (status === 'error') return 'bg-red-900/40 text-red-300';
  if (status === 'running') return 'bg-amber-900/40 text-amber-300';
  return 'bg-neutral-800 text-neutral-400';
}

function atText(at: number | undefined, label: string): string {
  if (typeof at !== 'number' || !Number.isFinite(at)) return '';
  return `${label} ${formatDateTimeForPreference(at, 'auto', { year: 'numeric', month: 'short', day: '2-digit' })}`;
}

export interface ScheduledTasksDialogProps {
  directory: string;
  onClose: () => void;
  /** The chat directory services (E-09-28): the editor entry points (+ new,
   * per-row task edit) render only when the store services are available. */
  services?: ComposerServices;
}

export function ScheduledTasksDialog({ directory, onClose, services }: ScheduledTasksDialogProps): ReactNode {
  const global = useSyncExternalStore(useGlobalSyncStore.subscribe, useGlobalSyncStore.getState);
  const roster = global.projects.map((project) => ({
    id: String(project['id']),
    worktree: normPath(String(project['worktree'] ?? '')),
  })).filter((project) => project.id.length > 0).sort((a, b) => a.id.localeCompare(b.id));

  const [projectId, setProjectId] = useState('');
  const list = useScheduledTaskList(projectId);
  const [editing, setEditing] = useState<EditingState | null>(null);

  // Default selection: the active directory's project, else the first.
  useEffect(() => {
    if (projectId !== '' || roster.length === 0) return;
    const active = normPath(directory).replace(/\/+$/u, '');
    const match = roster.find((project) => project.worktree.toLowerCase() === active.toLowerCase());
    setProjectId((match ?? roster[0]!)?.id ?? '');
  }, [directory, projectId, roster]);

  return (
    <>
      <TasksPanel roster={roster} projectId={projectId} onProjectChange={setProjectId}
        tasks={list.tasks} loading={list.loading} error={list.error} busyTaskId={list.busyTaskId}
        busy={list.busy} onClose={onClose} directory={directory}
        onHeaderNew={services === undefined || projectId.length === 0 ? null : () => setEditing({ projectId, task: null })}
        onEdit={services === undefined ? null : (task) => setEditing({ projectId, task })} />
      {services !== undefined && editing !== null ? (
        <ScheduledTaskEditorDialog projectId={editing.projectId} directory={directory}
          task={editing.task} services={services}
          onClose={() => setEditing(null)}
          onSaved={() => {
            const savedProjectId = editing.projectId;
            setEditing(null);
            if (savedProjectId === projectId) list.refresh(projectId);
          }} />
      ) : null}
    </>
  );
}

interface TasksPanelProps {
  roster: Array<{ id: string; worktree: string }>;
  projectId: string;
  onProjectChange: (id: string) => void;
  tasks: ScheduledTaskView[];
  loading: boolean;
  error: string | null;
  busyTaskId: string;
  busy: TaskListBusy;
  onClose: () => void;
  directory: string;
  onHeaderNew: (() => void) | null;
  onEdit: ((task: ScheduledTaskView) => void) | null;
}

function TasksPanel({
  roster, projectId, onProjectChange, tasks, loading, error, busyTaskId, busy, onClose, directory, onHeaderNew, onEdit,
}: TasksPanelProps): ReactNode {
  const text = useScheduledText();
  return (
    <div role="dialog" aria-label={text.title} tabIndex={0} data-testid="scheduled-tasks-dialog"
      className="absolute inset-0 z-30 flex items-start justify-center bg-black/50 p-10"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}>
      <div className="flex max-h-[75vh] w-full max-w-3xl flex-col rounded-xl border border-white/10 bg-neutral-950 p-3">
      <TasksHeader roster={roster} projectId={projectId} onProjectChange={onProjectChange} onClose={onClose}
          onHeaderNew={onHeaderNew} text={text} />
        {error !== null ? <div className="p-3 text-[12px] text-red-300" data-testid="scheduled-error">{error}</div> : null}
        {!loading && error === null && tasks.length === 0 ? (
          <div className="p-4 text-[12px] text-neutral-600" data-testid="scheduled-empty">{text.empty}</div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <TaskRows tasks={tasks} projectId={projectId} directory={directory} busyTaskId={busyTaskId} busy={busy}
            onEdit={onEdit} text={text} />
        </div>
        <footer className="mt-2 border-t border-white/10 pt-2 text-[10px] text-neutral-600">
          {interpolateText(tasks.length === 1 ? text.taskCountOne : text.taskCountMany, { count: tasks.length })} · {text.footerLoopFiles}
        </footer>
      </div>
    </div>
  );
}

function TasksHeader({ roster, projectId, onProjectChange, onClose, onHeaderNew, text }: {
  roster: Array<{ id: string; worktree: string }>;
  projectId: string;
  onProjectChange: (id: string) => void;
  onClose: () => void;
  onHeaderNew: (() => void) | null;
  text: ScheduledText;
}): ReactNode {
  return (
    <div className="mb-2 flex items-center gap-2">
      <strong className="text-[13px] text-neutral-100">{text.title}</strong>
      <select aria-label={text.projectLabel} data-testid="scheduled-project-select" value={projectId}
        onChange={(event) => onProjectChange(event.target.value)}
        className="ml-auto rounded-lg border border-white/10 bg-neutral-900 px-2 py-1 text-[12px] text-neutral-200 outline-none">
        {roster.map((project) => (
          <option key={project.id} value={project.id}>{project.id}</option>
        ))}
      </select>
      {onHeaderNew !== null ? (
        <button type="button" data-testid="task-new" title={text.newTaskTitle}
          className="rounded bg-sky-800 px-2 py-1 text-[11px] text-white hover:bg-sky-700" onClick={onHeaderNew}>{text.newButton}</button>
      ) : null}
      <button type="button" aria-label={text.close} className="rounded px-2 py-1 text-[12px] text-neutral-400 hover:text-white" onClick={onClose}>×</button>
    </div>
  );
}

interface TaskRowsProps {
  tasks: ScheduledTaskView[];
  projectId: string;
  directory: string;
  busyTaskId: string;
  busy: TaskListBusy;
  onEdit: ((task: ScheduledTaskView) => void) | null;
  text: ScheduledText;
}

function TaskRows({ tasks, projectId, directory, busyTaskId, busy, onEdit, text }: TaskRowsProps): ReactNode {
  return (
    <>
      {tasks.map((task) => (
        <TaskRow key={task.id} task={task} text={text}
          directory={directory} busy={busyTaskId === task.id}
          onToggle={() => void busy(task.id, () => toggleTask(projectId, task))}
          onRun={() => void busy(task.id, () => runNow(projectId, task.id, task.name, text).then(() => undefined))}
          onDelete={() => void busy(task.id, () => deleteScheduledTask(projectId, task.id))}
          onLoopDelete={() => void busy(task.id, () => deleteLoopFile(projectId, task.id))}
          onLoopEdit={() => openLoopFile(directory, task.loopFile ?? '', task.name, text)}
          onEdit={onEdit === null ? null : () => onEdit(task)}
        />
      ))}
    </>
  );
}

interface TaskRowProps {
  text: ScheduledText;
  task: ScheduledTaskView;
  directory: string;
  busy: boolean;
  onToggle: () => void;
  onRun: () => void;
  onDelete: () => void;
  onLoopDelete: () => void;
  onLoopEdit: () => void;
  onEdit: (() => void) | null;
}

function TaskRow({
  task, text, directory, busy, onToggle, onRun, onDelete, onLoopDelete, onLoopEdit, onEdit,
}: TaskRowProps): ReactNode {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const loop = task.loopFile !== undefined;
  const loopWithin = loop && withinDir(task.loopFile ?? '', directory);
  return (
    <div className="flex items-start gap-2 rounded-lg px-2 py-2 hover:bg-white/5" data-testid="scheduled-task-row">
      <button type="button" aria-label={interpolateText(text.toggle, { name: task.name })} data-testid="task-toggle"
        disabled={busy}
        aria-pressed={task.enabled}
        className={`mt-0.5 rounded px-1.5 py-0.5 text-[10px] ${task.enabled ? 'bg-emerald-900/50 text-emerald-300' : 'bg-neutral-800 text-neutral-500'} disabled:opacity-40`}
        onClick={onToggle}>
        {task.enabled ? text.on : text.off}
      </button>
      <TaskNameBlock task={task} text={text} />
      <RowActions task={task} text={text} busy={busy} loop={loop} loopWithin={Boolean(loopWithin)}
        confirmDelete={confirmDelete} setConfirmDelete={setConfirmDelete}
        onToggle={onToggle} onRun={onRun} onDelete={onDelete} onLoopDelete={onLoopDelete} onLoopEdit={onLoopEdit}
        onEdit={onEdit} />
    </div>
  );
}

function TaskNameBlock({ task, text }: { task: ScheduledTaskView; text: ScheduledText }): ReactNode {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <span className="text-[12px] text-neutral-200">{task.name}</span>
        <span className={`rounded px-1.5 py-0.5 text-[9px] uppercase ${badgeClass(task.state.lastStatus)}`} data-testid="task-badge">{scheduleStatusLabel(task.state.lastStatus, text)}</span>
        {task.loopFile !== undefined ? (
          <span className="rounded bg-indigo-900/40 px-1.5 py-0.5 text-[9px] text-indigo-300" title={task.loopFile} data-testid="task-loop-chip">{text.loopChip}</span>
        ) : null}
        {task.execution.goalEnabled ? <span className="rounded bg-sky-900/40 px-1.5 py-0.5 text-[9px] text-sky-300">{text.goalChip}</span> : null}
      </div>
      <div className="text-[10px] text-neutral-500">{scheduleLabel(task.schedule, text)}</div>
      <div className="text-[10px] text-neutral-600">
        {atText(task.state.nextRunAt, text.next)}{task.state.nextRunAt !== undefined && task.state.lastRunAt !== undefined ? ' · ' : ''}
        {atText(task.state.lastRunAt, text.last)}
      </div>
    </div>
  );
}

function RowActions({
  task, text, busy, loop, loopWithin, confirmDelete, setConfirmDelete,
  onToggle, onRun, onDelete, onLoopDelete, onLoopEdit, onEdit,
}: {
  task: ScheduledTaskView;
  text: ScheduledText;
  busy: boolean;
  loop: boolean;
  loopWithin: boolean;
  confirmDelete: boolean;
  setConfirmDelete: (value: boolean) => void;
  onToggle: () => void;
  onRun: () => void;
  onDelete: () => void;
  onLoopDelete: () => void;
  onLoopEdit: () => void;
  onEdit: (() => void) | null;
}): ReactNode {
  return (
    <>
      <button type="button" aria-label={interpolateText(text.runAria, { name: task.name })} data-testid="task-run" disabled={busy}
        className="rounded bg-neutral-800 px-2 py-1 text-[10px] text-neutral-200 hover:bg-neutral-700 disabled:opacity-40" onClick={onRun}>{text.run}</button>
      {onEdit !== null ? (
        <button type="button" aria-label={interpolateText(text.editAria, { name: task.name })} data-testid="task-edit" disabled={busy}
          className="rounded px-2 py-1 text-[10px] text-neutral-400 hover:text-neutral-200 disabled:opacity-30" onClick={onEdit}>{text.edit}</button>
      ) : null}
      {loop ? (
        <button type="button" aria-label={interpolateText(text.loopEditAria, { name: task.name })} data-testid="task-loop-edit" disabled={busy || !loopWithin}
          className="rounded px-2 py-1 text-[10px] text-neutral-400 hover:text-neutral-200 disabled:opacity-30" title={task.loopFile} onClick={onLoopEdit}>{text.loopEdit}</button>
      ) : null}
      {loop && confirmDelete ? (
        <button type="button" aria-label={interpolateText(text.loopDeleteAria, { name: task.name })} data-testid="task-loop-confirm"
          className="rounded bg-red-900/60 px-2 py-1 text-[10px] text-red-100" onClick={() => { setConfirmDelete(false); onLoopDelete(); }}>{text.loopDelete}</button>
      ) : null}
      <button type="button" aria-label={interpolateText(text.deleteAria, { name: task.name })} data-testid="task-delete" disabled={busy}
        className="rounded px-2 py-1 text-[10px] text-neutral-500 hover:text-red-300 disabled:opacity-40"
        onClick={loop ? () => setConfirmDelete(true) : () => onDelete()}>×</button>
    </>
  );
}

/** Loop tasks mutate the FILE; plain tasks ride the general upsert. */
function toggleTask(projectId: string, task: ScheduledTaskView): Promise<unknown> {
  if (task.loopFile !== undefined) return setLoopFileEnabled(projectId, task.id, !task.enabled);
  return upsertScheduledTask(projectId, { ...task, enabled: !task.enabled });
}

async function runNow(projectId: string, taskId: string, name: string, text: ScheduledText): Promise<unknown> {
  const outcome = await runScheduledTask(projectId, taskId);
  if ('error' in outcome) {
    toast.error(interpolateText(text.runFailed, { name, error: outcome.error }));
    return null;
  }
  const localizedStatus = scheduleStatusLabel(outcome.status, text);
  if (outcome.status === 'success') toast.success(interpolateText(text.runCompleted, { name }));
  else toast.message(interpolateText(text.runEnded, { name, status: localizedStatus }));
  if (outcome.persistError !== undefined) toast.error(interpolateText(text.persistenceDelayed, { name, error: outcome.persistError }));
  return null;
}

/** Hand the file to FilesView when the ACTIVE editor root can open it: the
 * pane is mounted at the active session directory (MainLayout), so the
 * handoff must be relative to THAT root - a file inside the project worktree
 * but outside the active directory cannot be opened from here. */
function openLoopFile(directory: string, loopFile: string, name: string, text: ScheduledText): void {
  if (loopFile.length === 0) return;
  if (directory.length === 0 || !withinDir(loopFile, directory)) {
    toast.message(interpolateText(text.loopOutsideWorkspace, { name, loopFile }));
    return;
  }
  window.dispatchEvent(new CustomEvent(FILES_OPEN_EVENT, {
    detail: { directory: normPath(directory), path: relativeTo(loopFile, directory) },
  }));
}
