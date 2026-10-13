// SPDX-License-Identifier: Apache-2.0
/**
 * The execution half of the scheduled-task editor (doc 12 §H "Editor
 * dialog"): model/agent selectors fed by the chat directory stores, the
 * prompt textarea with the composer's autocompletes (`@file` rides
 * /api/fs/search, `/` rides the command registry, `#snippet` rides the
 * snippet source roster (E-09-28 (d) parity with the composer's `#`
 * picker, P9-4e-ii), the goal toggle + token budget, and the
 * enabled
 * chips. Click-to-pick only - keyboard picker navigation stays a composer
 * concern (E-09-28 (d)).
 */
import { useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { activeTrigger, replaceTriggerToken, type AutocompleteTrigger } from '../../chat/prompt-language.ts';
import { PickerPopup } from '../../chat/composer-bits.tsx';
import { fsSearch, type FsEntry } from '../../lib/server-api.ts';
import { snippetNames } from '../../lib/snippets-source.ts';
import type { Provider } from '../../lib/nnd/types.ts';
import type { TaskExecution } from '../../lib/scheduled-tasks-api.ts';
import { useScheduledText } from './scheduledText.ts';

type PickerState = { trigger: AutocompleteTrigger; items: string[]; insert: (item: string) => void };
const MODEL_SEP = '::';
const SNIPPET_SOURCES = snippetNames; // P9-4e-ii: snapshot-at-open, refreshed next trigger

export function ExecutionEditor({ execution, onChange, providers, commands, agents, directory }: {
  execution: TaskExecution;
  onChange: (next: TaskExecution) => void;
  providers: Provider[];
  commands: string[];
  agents: string[];
  directory: string;
}): ReactNode {
  const text = useScheduledText();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <ModelSelect execution={execution} onChange={onChange} providers={providers} />
        <AgentSelect execution={execution} onChange={onChange} agents={agents} />
      </div>
      <PromptField execution={execution} onChange={onChange} commands={commands} agents={agents} directory={directory} />
      <LabelledCheck label={text.runAsGoal} testid="execution-goal" checked={execution.goalEnabled === true}
        onToggle={(next) => onChange({ ...execution, goalEnabled: next || undefined, goalTokenBudget: next ? execution.goalTokenBudget : undefined })} />
      {execution.goalEnabled === true ? <GoalBudget execution={execution} onChange={onChange} /> : null}
    </div>
  );
}

function LabelledCheck({ label, testid, checked, onToggle }: {
  label: string; testid: string; checked: boolean; onToggle: (next: boolean) => void;
}): ReactNode {
  return (
    <div className="flex items-center gap-2">
      <button type="button" data-testid={testid} aria-pressed={checked}
        className={`rounded px-2 py-0.5 text-[11px] ${checked ? 'bg-emerald-900/50 text-emerald-300' : 'bg-neutral-800 text-neutral-400 hover:text-neutral-200'}`}
        onClick={() => onToggle(!checked)}>{label}</button>
    </div>
  );
}

function modelValue(execution: TaskExecution): string {
  return `${execution.providerID}${MODEL_SEP}${execution.modelID}`;
}

function ModelSelect({ execution, onChange, providers }: {
  execution: TaskExecution;
  onChange: (next: TaskExecution) => void;
  providers: Provider[];
}): ReactNode {
  const text = useScheduledText();
  const listed = providers.some((provider) =>
    execution.providerID === provider.id && execution.modelID in provider.models);
  const hasChoices = providers.some((provider) => Object.keys(provider.models).length > 0);
  const customPair = execution.providerID.length > 0 || execution.modelID.length > 0;
  const pick = (raw: string): void => {
    const index = raw.lastIndexOf(MODEL_SEP);
    if (index <= 0) return;
    onChange({ ...execution, providerID: raw.slice(0, index), modelID: raw.slice(index + MODEL_SEP.length) });
  };
  return (
    <label className="flex items-center gap-1 text-[11px] text-neutral-400">
      <span>{text.model}</span>
      <select data-testid="execution-model-select" value={modelValue(execution)}
        onChange={(event) => pick(event.target.value)}
        className="max-w-64 rounded-lg border border-white/10 bg-neutral-900 px-2 py-1 text-[12px] text-neutral-200">
        {!listed && customPair ? <option value={modelValue(execution)}>{modelValue(execution)}</option> : null}
        {!hasChoices && !customPair ? <option value="">{text.noModels}</option> : null}
        {providers.map((provider) => (
          <optgroup key={provider.id} label={provider.name || provider.id}>
            {Object.keys(provider.models).map((modelID) => (
              <option key={modelID} value={`${provider.id}${MODEL_SEP}${modelID}`}>{modelID}</option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

function AgentSelect({ execution, onChange, agents }: {
  execution: TaskExecution;
  onChange: (next: TaskExecution) => void;
  agents: string[];
}): ReactNode {
  const current = execution.agent ?? 'build';
  const listed = agents.includes(current);
  const text = useScheduledText();
  return (
    <label className="flex items-center gap-1 text-[11px] text-neutral-400">
      <span>{text.agent}</span>
      <select data-testid="execution-agent-select" value={current}
        onChange={(event) => onChange({ ...execution, agent: event.target.value || undefined })}
        className="max-w-48 rounded-lg border border-white/10 bg-neutral-900 px-2 py-1 text-[12px] text-neutral-200">
        {!listed ? <option value={current}>{current}</option> : null}
        {agents.map((name) => <option key={name} value={name}>{name}</option>)}
      </select>
    </label>
  );
}

function GoalBudget({ execution, onChange }: { execution: TaskExecution; onChange: (next: TaskExecution) => void }): ReactNode {
  const text = useScheduledText();
  return (
    <label className="flex items-center gap-2 text-[11px] text-neutral-400">
      <span>{text.goalBudget}</span>
      <input type="number" min={1000} step={1000} data-testid="execution-goal-budget"
        value={execution.goalTokenBudget ?? ''}
        onChange={(event) => {
          const raw = Number(event.target.value);
          const budget = event.target.value.length > 0 && Number.isFinite(raw) && raw >= 1 ? raw : undefined;
          onChange({ ...execution, goalTokenBudget: budget });
        }}
        className="w-40 rounded-lg border border-white/10 bg-neutral-900 px-2 py-1 text-[12px] text-neutral-200" />
    </label>
  );
}

/** The late fs result merge into the LIVE picker: same tokenStart AND same
 * kind (L170's token counter drops stale INPUTS; same-tokenStart is not
 * enough for a mid-pending trigger-char swap - '@ma' retyped as '#ma' keeps
 * both spans but changes the kind, and merging would repopulate the '#'
 * picker with the stale mention's results bound to a mention insert).
 * Items merge with the live ones and filter by the SEARCH's query. */
function mergedPickerItems(
  current: { trigger: AutocompleteTrigger; items: string[] } | null,
  files: FsEntry[], trigger: AutocompleteTrigger,
): { trigger: AutocompleteTrigger; items: string[] } | null {
  if (current === null || current.trigger.tokenStart !== trigger.tokenStart
    || current.trigger.kind !== trigger.kind) return null;
  return {
    trigger: current.trigger,
    items: [...new Set([...current.items, ...files.map((file) => file.path)])]
      .filter((name) => name.toLowerCase().includes(trigger.query.toLowerCase())).sort(),
  };
}

function PromptField({ execution, onChange, commands, agents, directory }: {
  execution: TaskExecution;
  onChange: (next: TaskExecution) => void;
  commands: string[];
  agents: string[];
  directory: string;
}): ReactNode {
  const text = useScheduledText();
  const [picker, setPicker] = useState<PickerState | null>(null);
  // Insert closures must operate on the LATEST document: the picker survives
  // renders, so the prop snapshot it would otherwise capture goes stale.
  const promptRef = useRef(execution.prompt);
  const fsToken = useRef(0);
  const escapeHatch = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape' && picker !== null) {
      event.stopPropagation(); // the picker closes first; the dialog stays open
      setPicker(null);
    }
  };
  const applyPick = (trigger: AutocompleteTrigger, item: string): void => {
    const replacement = trigger.kind === 'mention' ? `@${item}` : trigger.kind === 'snippet' ? `#${item}` : `/${item}`;
    const { text: next } = replaceTriggerToken(promptRef.current, trigger, replacement);
    promptRef.current = next;
    setPicker(null);
    onChange({ ...execution, prompt: next });
  };
  const onPromptInput = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    const next = event.target.value;
    const caret = event.target.selectionStart ?? next.length;
    promptRef.current = next;
    onChange({ ...execution, prompt: next });
    const trigger = activeTrigger(next, caret);
    if (trigger === null) { setPicker(null); return; }
    const source = trigger.kind === 'snippet' ? SNIPPET_SOURCES()
      : trigger.kind === 'mention' ? agents : commands;
    const items = source.filter((name) => name.toLowerCase().includes(trigger.query.toLowerCase())).sort();
    setPicker({ trigger, items, insert: (item) => applyPick(trigger, item) });
    if (trigger.kind === 'mention') {
      const token = ++fsToken.current;
      void fsSearch(directory, trigger.query).then((files: FsEntry[]) => {
        if (token !== fsToken.current) return; // stale completion publishes nothing
        setPicker((current) => {
          const merged = mergedPickerItems(current, files, trigger);
          if (merged === null) return current;
          return { ...merged, insert: (item) => applyPick(trigger, item) };
        });
      }).catch(() => undefined); // picker stays agent-only on failure
    }
  };
  return (
    <div className="relative">
      <PickerPopup picker={picker} />
      <textarea value={execution.prompt} onChange={onPromptInput} onKeyDown={escapeHatch}
        data-testid="task-prompt-input" rows={3} placeholder={text.promptPlaceholder}
        className="w-full resize-y rounded-lg border border-white/10 bg-neutral-900 p-2 text-[12px] text-neutral-100 outline-none" />
    </div>
  );
}
