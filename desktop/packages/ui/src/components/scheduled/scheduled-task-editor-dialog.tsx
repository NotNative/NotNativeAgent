// SPDX-License-Identifier: Apache-2.0
/**
 * The scheduled-task editor dialog shell (doc 12 §H "Editor dialog"):
 * hosts the schedule half (ScheduledScheduleEditor, E-09-27) and the
 * execution half (ExecutionEditor) around a name field, and saves through
 * the typed client's upsert (create = the client normalize seeds state,
 * edit = the original task rides through with unknowns + state intact,
 * E-09-24). Preview truth comes from the server route (E-09-26); the
 * time preference rides the settings registry (§J.1).
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  previewNextRuns, upsertScheduledTask, type ScheduledTaskInput,
  type ScheduledTaskView, type TaskExecution, type TaskSchedule,
} from '../../lib/scheduled-tasks-api.ts';
import { ScheduledScheduleEditor } from './scheduled-task-schedule-editor.tsx';
import { ExecutionEditor } from './scheduled-task-execution-editor.tsx';
import { emptyDraft, systemZone } from './schedule-form.ts';
import { useScheduledText } from './scheduledText.ts';
import { useSettingsField } from '../settings/page-helpers.tsx';
import type { ComposerServices } from '../../chat/composer.tsx';
import type { Provider } from '../../lib/nnd/types.ts';

export interface ScheduledTaskEditorDialogProps {
  projectId: string;
  directory: string;
  task: ScheduledTaskView | null;
  services: ComposerServices;
  onSaved: (task: ScheduledTaskView) => void;
  onClose: () => void;
}

/** Create drafts seed the FIRST catalog pair; a stored task keeps its own
 * pair even when the catalog does not list it (the select prepends it). */
function seedExecution(task: ScheduledTaskView | null, providers: Provider[]): TaskExecution {
  if (task !== null) return task.execution;
  const provider = providers.find((candidate) => Object.keys(candidate.models).length > 0);
  const modelID = provider !== undefined ? Object.keys(provider.models)[0] ?? '' : '';
  return { prompt: '', providerID: provider?.id ?? '', modelID };
}

/** The seed effect: only a CREATE with an empty pair adopts the catalog. */
function useEffectForSeed(execution: TaskExecution, task: ScheduledTaskView | null, providers: Provider[], setExecution: (next: TaskExecution) => void): void {
  useEffect(() => {
    if (task !== null || execution.providerID !== '' || providers.length === 0) return;
    const seeded = seedExecution(null, providers);
    if (seeded.modelID.length > 0) setExecution(seeded);
  }, [task, execution.providerID, providers, setExecution]);
}

export function ScheduledTaskEditorDialog({
  projectId, directory, task, services, onSaved, onClose,
}: ScheduledTaskEditorDialogProps): ReactNode {
  const store = services.store(directory);
  const snapshot = useSyncExternalStore(store.subscribe, store.getState);
  const providers = (snapshot.provider ?? []) as Provider[];
  const commandNames = (snapshot.command ?? []).map((entry) => entry.name);
  const agentNames = (snapshot.agent ?? []).map((entry) => entry.name);
  const format = useSettingsField<'auto' | '12h' | '24h'>('timeFormatPreference');
  const text = useScheduledText();

  const [name, setName] = useState(task?.name ?? '');
  const [enabled, setEnabled] = useState(task?.enabled ?? true);
  const [schedule, setSchedule] = useState<TaskSchedule>(task?.schedule ?? emptyDraft('daily', systemZone()));
  const [execution, setExecution] = useState<TaskExecution>(seedExecution(task, providers));
  const [saving, setSaving] = useState(false);
  const [blocked, setBlocked] = useState('');

  // Late catalog arrival: an EMPTY create seed adopts the first pair once
  // the directory store publishes its providers (a stored task never is).
  useEffectForSeed(execution, task, providers, setExecution);

  async function save(): Promise<void> {
    if (name.trim().length === 0) { setBlocked(text.nameRequired); return; }
    const base = task ?? {};
    const variantKept = task !== null && task.execution.providerID === execution.providerID
      && task.execution.modelID === execution.modelID;
    const input: ScheduledTaskInput = {
      ...(base as ScheduledTaskInput),
      name: name.trim(),
      enabled,
      schedule,
      execution: {
        prompt: execution.prompt,
        providerID: execution.providerID,
        modelID: execution.modelID,
        agent: execution.agent && execution.agent.length > 0 ? execution.agent : undefined,
        goalEnabled: execution.goalEnabled === true ? true : undefined,
        goalTokenBudget: execution.goalEnabled === true ? execution.goalTokenBudget : undefined,
        variant: variantKept ? task?.execution.variant : undefined,
      },
    };
    setSaving(true);
    let outcome: Awaited<ReturnType<typeof upsertScheduledTask>>;
    try {
      outcome = await upsertScheduledTask(projectId, input);
    } catch (requestError) {
      setSaving(false);
      toast.error(String(requestError).slice(0, 160));
      return;
    }
    setSaving(false);
    if (outcome.ok) { toast.success(task === null ? text.saved : text.updated); onSaved(outcome.task); return; }
    toast.error(outcome.error.slice(0, 160));
  }

  return (
    <div role="dialog" aria-label={text.editorTitle} tabIndex={0} data-testid="task-editor-dialog"
      className="absolute inset-0 z-40 flex items-start justify-center bg-black/60 p-8"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation(); // the tasks overlay behind must stay open (E-09-28 (g))
          onClose();
        }
      }}>
      <div className="max-h-[80vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-white/10 bg-neutral-950 p-4">
        <div className="mb-3 flex items-center gap-2">
          <strong className="text-[13px] text-neutral-100">{task === null ? text.newTask : text.editTask}</strong>
          <button type="button" aria-label={text.closeEditor} data-testid="task-editor-close"
            className="ml-auto rounded px-2 py-1 text-[12px] text-neutral-400 hover:text-white" onClick={onClose}>×</button>
        </div>
        <label className="mb-3 flex items-center gap-2 text-[11px] text-neutral-400">
          <span>{text.name}</span>
          <input value={name} data-testid="task-name-input"
            onChange={(event) => { setName(event.target.value); setBlocked(''); }}
            className="min-w-0 flex-1 rounded-lg border border-white/10 bg-neutral-900 px-2 py-1 text-[12px] text-neutral-100" />
        </label>
        {blocked.length > 0 ? <div className="mb-2 text-[11px] text-amber-300" data-testid="save-blocked">{blocked}</div> : null}
        <ScheduledScheduleEditor value={schedule} onChange={setSchedule}
          preview={previewNextRuns} timePreference={format.value ?? 'auto'} />
        <div className="mt-3 border-t border-white/10 pt-3">
          <ExecutionEditor execution={execution} onChange={setExecution}
            providers={providers} commands={commandNames} agents={agentNames} directory={directory} />
        </div>
        <div className="mt-3 flex items-center gap-2 border-t border-white/10 pt-3">
          <button type="button" data-testid="task-enabled-chip" aria-pressed={enabled}
            className={`rounded px-2 py-1 text-[11px] ${enabled ? 'bg-emerald-900/50 text-emerald-300' : 'bg-neutral-800 text-neutral-400'}`}
            onClick={() => setEnabled(!enabled)}>{enabled ? text.enabled : text.disabled}</button>
          <button type="button" data-testid="task-save" disabled={saving}
            className="ml-auto rounded bg-sky-800 px-3 py-1 text-[12px] text-white hover:bg-sky-700 disabled:opacity-40"
            onClick={() => void save()}>{saving ? text.saving : text.save}</button>
        </div>
      </div>
    </div>
  );
}
