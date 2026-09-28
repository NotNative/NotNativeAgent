// SPDX-License-Identifier: Apache-2.0
/** Multi-run launcher (doc 12 §E.1/E.3): one prompt dispatched to N models. */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { toast } from 'sonner';
import { createMultiRun, type CreateMultiRunParams, type CreateMultiRunResult, type MultiRunModelSelection } from '../lib/multirun/create.ts';
import { createMultiRunUiServices, reportMultiRunError } from '../lib/multirun/ui-services.ts';
import { ModelPicker, type ModelSelection } from './model-picker.tsx';
import { useComposerModel } from './composer-model-config.ts';
import { authSessionBlocksSend, useAuthSessionStore } from '../lib/runtime-auth-expiry.ts';
import type { ComposerServices } from './composer.tsx';
import type { SyncEngine } from '../sync/sync-engine.ts';
import type { Provider } from '../lib/nnd/types.ts';

export interface MultiRunLauncherProps {
  services: ComposerServices;
  directory: string;
  onClose: () => void;
  onLaunched: (result: CreateMultiRunResult, directory: string) => void;
}

export function launchedSessionDirectory(
  engine: Pick<SyncEngine, 'routingDirectoryOf'>,
  result: { firstSessionId: string | null },
  fallbackDirectory: string,
): string | null {
  if (result.firstSessionId === null) return null;
  return engine.routingDirectoryOf?.(result.firstSessionId) ?? fallbackDirectory;
}

export function MultiRunLauncher({ services, directory, onClose, onLaunched }: MultiRunLauncherProps): ReactNode {
  const store = services.store(directory);
  const snapshot = useSyncExternalStore(store.subscribe, store.getState);
  const authStatus = useAuthSessionStore((state) => state.status);
  const { configUnavailable, nnaConfigured, nnaModel, sendAgent } = useComposerModel(snapshot, null, 'build', null);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [models, setModels] = useState<MultiRunModelSelection[]>([]);
  const [isolateRuns, setIsolateRuns] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const sendBlocked = authSessionBlocksSend(authStatus) || configUnavailable || (nnaConfigured && nnaModel === null);

  useEffect(() => {
    if (!nnaConfigured || nnaModel === null || models.length > 0) return;
    setModels([{ providerID: nnaModel.providerID, modelID: nnaModel.modelID }]);
    setPickerOpen(false);
  }, [models.length, nnaConfigured, nnaModel]);

  const pickModel = (selection: ModelSelection): void => {
    setModels((current) => {
      const index = current.findIndex((entry) => entry.providerID === selection.providerID && entry.modelID === selection.modelID);
      if (index >= 0) {
        const next = [...current];
        next[index] = { ...selection, variant: selection.variant ?? undefined };
        return next;
      }
      if (current.length >= 5) {
        toast.error('Each launch supports at most 5 models');
        return current;
      }
      return [...current, { ...selection, variant: selection.variant ?? undefined }];
    });
    setPickerOpen(false);
  };

  const removeModel = (index: number): void => {
    setModels((current) => current.filter((_, at) => at !== index));
  };

  const submit = () => submitMultiLaunch({
    agent: sendAgent, busy, directory, models, name, isolateRuns,
    prompt,
    engine: services.engine, store, setBusy, onLaunched, onClose,
  });

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4" data-testid="multirun-launcher">
      <form className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-xl border border-white/10 bg-neutral-950 p-4 shadow-2xl" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <MultiRunForm
          busy={busy} isolateRuns={isolateRuns} models={models} name={name} pickerOpen={pickerOpen}
          prompt={prompt} providerCatalog={snapshot.provider as Provider[]} sendBlocked={sendBlocked}
          setIsolateRuns={setIsolateRuns} setName={setName} setPickerOpen={setPickerOpen} setPrompt={setPrompt}
          onLaunch={submit} onClose={onClose} onPickModel={pickModel} onRemoveModel={removeModel}
        />
      </form>
    </div>
  );
}

function MultiRunForm(props: {
  busy: boolean;
  isolateRuns: boolean;
  models: MultiRunModelSelection[];
  name: string;
  pickerOpen: boolean;
  prompt: string;
  providerCatalog: Provider[];
  sendBlocked: boolean;
  setIsolateRuns: (value: boolean) => void;
  setName: (value: string) => void;
  setPickerOpen: (value: boolean) => void;
  setPrompt: (value: string) => void;
  onLaunch: () => void;
  onClose: () => void;
  onPickModel: (selection: ModelSelection) => void;
  onRemoveModel: (index: number) => void;
}): ReactNode {
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-neutral-200">Launch multi-run</h2>
        <button type="button" aria-label="Close multi-run launcher" className="text-neutral-500 hover:text-neutral-200 disabled:opacity-50" data-testid="multirun-close" disabled={props.busy} onClick={props.onClose}>X</button>
      </div>
      <label className="mt-3 block text-[11px] text-neutral-500" htmlFor="multirun-name">Group name</label>
      <input id="multirun-name" value={props.name} className="w-full rounded-lg border border-white/10 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-white/25" data-testid="multirun-name" onChange={(event) => props.setName(event.target.value)} />
      <label className="mt-3 block text-[11px] text-neutral-500" htmlFor="multirun-prompt">Prompt</label>
      <textarea id="multirun-prompt" rows={5} value={props.prompt} className="w-full resize-y rounded-lg border border-white/10 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-white/25" data-testid="multirun-prompt" onChange={(event) => props.setPrompt(event.target.value)} />
      <div className="relative mt-3 flex flex-wrap items-center gap-2">
        <button type="button" disabled={props.sendBlocked} className="rounded bg-white/5 px-3 py-1.5 text-[12px] text-neutral-200 hover:bg-white/10" data-testid="multirun-add-model" onClick={() => props.setPickerOpen(!props.pickerOpen)}>
          Add model {props.models.length > 0 ? `(${props.models.length}/5)` : ''}
        </button>
        <label className="flex items-center gap-2 text-[12px] text-neutral-400">
          <input type="checkbox" checked={props.isolateRuns} data-testid="multirun-isolate" onChange={(event) => props.setIsolateRuns(event.target.checked)} />
          Isolate each run in a worktree
        </label>
        {props.pickerOpen ? <ModelPicker providers={props.providerCatalog} selection={null} onPick={props.onPickModel} onOpenAddProvider={() => props.setPickerOpen(false)} /> : null}
      </div>
      <div className="mt-2 space-y-1" data-testid="multirun-model-list">
        {props.models.map((model, index) => (
          <div key={`${model.providerID}:${model.modelID}:${index}`} className="flex items-center gap-2 rounded bg-white/5 px-2 py-1.5 text-[12px] text-neutral-300">
            <span className="min-w-0 flex-1 truncate">{model.providerID} · {model.modelID}{model.variant ? ` · ${model.variant}` : ''}</span>
            <button type="button" aria-label={`Remove ${model.modelID}`} onClick={() => props.onRemoveModel(index)}>x</button>
          </div>
        ))}
        {props.models.length === 0 ? <span className="text-[11px] text-neutral-600">Select at least one model</span> : null}
      </div>
      <div className="mt-4 flex justify-end gap-2">
          <button type="button" disabled={props.busy} className="rounded border border-white/10 px-3 py-1.5 text-[12px] text-neutral-300 disabled:opacity-50" data-testid="multirun-cancel" onClick={props.onClose}>Cancel</button>
        <button type="submit" disabled={props.busy || props.sendBlocked} className="rounded bg-emerald-900/50 px-3 py-1.5 text-[12px] text-emerald-200 hover:bg-emerald-900/70 disabled:opacity-50" data-testid="multirun-submit">
          {props.busy ? 'Launching…' : 'Launch'}
        </button>
      </div>
    </>
  );
}

function createLaunchParams(name: string, prompt: string, models: MultiRunModelSelection[], isolateRuns: boolean): CreateMultiRunParams {
  return { name, groups: [{ prompt, models }], isolateRuns };
}

async function submitMultiLaunch(input: {
  agent: string;
  busy: boolean;
  directory: string;
  engine: SyncEngine;
  store: ReturnType<ComposerServices['store']>;
  models: MultiRunModelSelection[];
  name: string;
  prompt: string;
  isolateRuns: boolean;
  setBusy: (value: boolean) => void;
  onLaunched: (result: CreateMultiRunResult, directory: string) => void;
  onClose: () => void;
}): Promise<void> {
  if (input.busy) return;
  const params = createLaunchParams(input.name, input.prompt, input.models, input.isolateRuns);
  input.setBusy(true);
  try {
    const result = await createMultiRun(
      { ...params, agent: input.agent },
      createMultiRunUiServices({ directory: input.directory, engine: input.engine, store: input.store }),
    );
    input.onLaunched(result, launchedSessionDirectory(input.engine, result, input.directory) ?? input.directory);
    input.onClose();
  } catch (error) {
    reportMultiRunError(error);
  } finally {
    input.setBusy(false);
  }
}
