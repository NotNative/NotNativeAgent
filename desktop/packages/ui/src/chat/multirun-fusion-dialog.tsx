// SPDX-License-Identifier: Apache-2.0
/** Multi-run fusion dialog (doc 12 §E.5). */
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { toast } from 'sonner';
import { harnessClient } from '../lib/nnd/client.ts';
import type { Session } from '../lib/nnd/types.ts';
import { listMagicPromptOverrides } from '../lib/server-api.ts';
import {
  composeFusionPrompt,
  collectFusionSources,
  startFusion,
  type FusionIdentity,
  type FusionModelSelection,
  type FusionLaunchResult,
} from '../lib/multirun/fusion.ts';
import { ModelPicker, type ModelSelection } from './model-picker.tsx';
import { authSessionBlocksSend, useAuthSessionStore } from '../lib/runtime-auth-expiry.ts';
import { useComposerModel } from './composer-model-config.ts';
import { useGlobalSessionsStore } from '../sync/global-stores.ts';
import { useSessionViewStore } from '../sync/view-store.ts';
import type { ComposerServices } from './composer.tsx';
import type { Provider } from '../lib/nnd/types.ts';

export interface MultiRunFusionDialogProps {
  services: ComposerServices;
  trigger: Session;
  identity: FusionIdentity;
  onClose: () => void;
  onLaunched?: (result: FusionLaunchResult) => void;
}

export function MultiRunFusionDialog(props: MultiRunFusionDialogProps): ReactNode {
  const store = props.services.store(props.trigger.directory ?? '');
  const snapshot = useSyncExternalStore(store.subscribe, store.getState);
  const authStatus = useAuthSessionStore((state) => state.status);
  const globalSessions = useSyncExternalStore(
    useGlobalSessionsStore.subscribe,
    () => useGlobalSessionsStore.getState(),
  );
  const [model, setModel] = useState<FusionModelSelection | null>(null);
  const [agent, setAgent] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const composerModel = useComposerModel(snapshot, null, 'build', null);
  const sendBlocked = authSessionBlocksSend(authStatus) || composerModel.configUnavailable;
  const providers = snapshot.provider as Provider[];

  useEffect(() => {
    if (model !== null || (providers.length === 0 && !composerModel.nnaConfigured)) return;
    const configured = composerModel.nnaConfigured ? composerModel.nnaModel ?? null : null;
    const fallback = Object.values(providers[0]?.models ?? {})[0] as Provider['models'][string] | undefined;
    const selection = configured ?? (fallback ? { providerID: fallback.providerID, modelID: fallback.id } : null);
    if (selection) setModel(selection);
  }, [composerModel.nnaConfigured, composerModel.nnaModel, model, providers]);

  const candidates = useMemo(() => ({
    storeOfDirectory: (directory: string) => props.services.engine.childStoreOf?.(directory),
    directoryOfSession: (sessionID: string) => props.services.engine.routingDirectoryOf?.(sessionID),
    globalActive: () => globalSessions.active,
    globalArchived: () => globalSessions.archived,
    currentStore: () => store,
  }), [globalSessions.active, globalSessions.archived, props.services.engine, store]);

  const sources = useMemo(() => {
    try {
      return collectFusionSources(props.trigger, candidates);
    } catch {
      return [];
    }
  }, [candidates, props.trigger]);

  const agents = snapshot.agent.filter((entry) => !entry.hidden);
  const modelLabel = model ? `${model.providerID} · ${model.modelID}${model.variant ? ` · ${model.variant}` : ''}` : 'Select model';

  async function submit(): Promise<void> {
    if (busy || model === null) return;
    setBusy(true);
    try {
      const result = await startFusion(
        { trigger: props.trigger, identity: props.identity, model, ...(agent ? { agent } : {}) },
        {
          candidates,
          createSession: (request) => props.services.engine.actions.createSession(request),
          selectCurrentSession: ({ sessionID, directory }) => {
            useSessionViewStore.setState({ currentSessionId: sessionID, activeDirectory: directory });
          },
          closeDialog: props.onClose,
          listMessages: async ({ sessionID, directory, limit }) => {
            const result = await harnessClient.listMessages(sessionID, limit, { directory });
            if (result.error || !result.data) throw new Error(result.error ?? 'Unable to read session output');
            return result.data;
          },
          listMagicPromptOverrides: async () => {
            const overrides = await listMagicPromptOverrides();
            if (overrides === null) throw new Error('Unable to load fusion templates');
            return overrides;
          },
          send: (request) => props.services.engine.actions.send(request),
        },
      );
      props.onLaunched?.(result);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4" data-testid="fusion-dialog">
      <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-xl border border-white/10 bg-neutral-950 p-4 shadow-2xl">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-neutral-200">Run fusion</h2>
          <button type="button" aria-label="Close fusion dialog" data-testid="fusion-close" className="text-neutral-500 hover:text-neutral-200" disabled={busy} onClick={props.onClose}>X</button>
        </div>
        <p className="mt-2 text-[12px] text-neutral-500">
          {sources.length} source{sources.length === 1 ? '' : 's'} · {props.identity.groupSlug}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" disabled={busy || sendBlocked} className="rounded bg-white/5 px-3 py-1.5 text-[12px] text-neutral-200 hover:bg-white/10 disabled:opacity-50" data-testid="fusion-open-model-picker" onClick={() => setPickerOpen(!pickerOpen)}>
            {modelLabel}
          </button>
          <label className="text-[12px] text-neutral-400" htmlFor="fusion-agent">Agent</label>
          <select id="fusion-agent" value={agent} disabled={busy || agents.length === 0} data-testid="fusion-agent" className="max-w-40 rounded border border-white/10 bg-neutral-900 px-2 py-1.5 text-[12px] text-neutral-200 outline-none" onChange={(event) => setAgent(event.target.value)}>
            <option value="">Default</option>
            {agents.map((entry) => <option key={entry.name} value={entry.name}>{entry.name}</option>)}
          </select>
        </div>
        {pickerOpen ? (
          <ModelPicker providers={providers} selection={model ? { ...model, variant: model.variant ?? null } : null} onPick={(selection: ModelSelection) => {
            setModel({ ...selection, variant: selection.variant ?? undefined });
            setPickerOpen(false);
          }} onOpenAddProvider={() => setPickerOpen(false)} />
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" disabled={busy} className="rounded border border-white/10 px-3 py-1.5 text-[12px] text-neutral-300 disabled:opacity-50" data-testid="fusion-cancel" onClick={props.onClose}>Cancel</button>
          <button type="button" disabled={busy || sendBlocked || model === null || sources.length === 0} className="rounded bg-emerald-900/50 px-3 py-1.5 text-[12px] text-emerald-200 hover:bg-emerald-900/70 disabled:opacity-50" data-testid="fusion-start" onClick={() => void submit()}>
            {busy ? 'Fusing…' : 'Start fusion'}
          </button>
        </div>
      </div>
    </div>
  );
}

