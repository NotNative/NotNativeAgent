// SPDX-License-Identifier: Apache-2.0
import type { HarnessConfig } from '../lib/nnd/types.ts';
import { useEffect } from 'react';
import { harnessClient } from '../lib/nnd/client.ts';
import type { DirectoryStore } from '../sync/types.ts';
import { useGlobalSyncStore } from '../sync/global-stores.ts';
import { nnaConfiguredModelFromMetadata, nnaSessionConfiguredModel } from './work-status.ts';

const FALLBACK_MODEL = { providerID: 'mock', modelID: 'mock' } as const;
type ModelIdentity = { providerID: string; modelID: string };
type Selection = ModelIdentity & { variant?: string | null };

export function useComposerModel(state: DirectoryStore, selection: Selection | null | undefined,
  agent: string, sessionID: string | null) {
  const globalConfig = useGlobalSyncStore((store) => store.config);
  useEffect(() => {
    if (state.config || globalConfig) return;
    let cancelled = false;
    const recover = async () => {
      for (let attempt = 0; attempt < 20 && !cancelled; attempt++) {
        const response = await harnessClient.getConfig();
        if (cancelled) return;
        const nnd = response.data?.nnd as { engine?: unknown; primaryModel?: { providerID?: unknown; modelID?: unknown } } | undefined;
        if (!response.error && nnd?.engine === 'nna'
          && typeof nnd.primaryModel?.providerID === 'string' && nnd.primaryModel.providerID
          && typeof nnd.primaryModel.modelID === 'string' && nnd.primaryModel.modelID) {
          useGlobalSyncStore.getState().set({ config: response.data as Record<string, unknown> });
          return;
        }
        if (attempt < 19) await new Promise(resolve => setTimeout(resolve, 500));
      }
    };
    void recover();
    return () => { cancelled = true; };
  }, [state.config, globalConfig]);
  const localEngine = (state.config?.nnd as { engine?: unknown } | undefined)?.engine;
  const globalEngine = (globalConfig?.nnd as { engine?: unknown } | undefined)?.engine;
  const config = globalEngine === 'nna' && (localEngine === 'nna' || !state.config)
    ? globalConfig as typeof state.config : state.config;
  const sessionModel = sessionID ? nnaSessionConfiguredModel(state, sessionID) : null;
  return resolveComposerModel(config, selection, agent, sessionModel, sessionID !== null);
}

export function modelForCreatedSession(metadata: unknown, nnaConfigured: boolean, fallback: ModelIdentity): ModelIdentity {
  if (!nnaConfigured) return fallback;
  const model = nnaConfiguredModelFromMetadata(metadata);
  if (!model) throw new Error('NNA did not report the created session route');
  return model;
}

export function resolveComposerModel(config: HarnessConfig | null | undefined, selection: Selection | null | undefined,
  agent: string, sessionModel: ModelIdentity | null = null, sessionSelected = false): {
  configUnavailable: boolean;
  nnaConfigured: boolean;
  nnaModel: ModelIdentity | null;
  model: ModelIdentity;
  sendAgent: string;
  modelLabel: string;
} {
  const nnd = config?.nnd as { engine?: string; primaryModel?: Partial<ModelIdentity> } | undefined;
  const configUnavailable = config == null;
  const nnaConfigured = nnd?.engine === 'nna';
  const nnaModel = nnaConfigured ? sessionSelected ? sessionModel : (typeof nnd.primaryModel?.providerID === 'string' && typeof nnd.primaryModel.modelID === 'string'
    ? { providerID: nnd.primaryModel.providerID, modelID: nnd.primaryModel.modelID } : null) : null;
  return {
    configUnavailable, nnaConfigured, nnaModel,
    model: nnaModel ?? (selection ? { providerID: selection.providerID, modelID: selection.modelID } : FALLBACK_MODEL),
    sendAgent: nnaConfigured ? 'nna' : agent,
    modelLabel: nnaConfigured
      ? (nnaModel ? `${nnaModel.providerID} · ${nnaModel.modelID}` : 'NNA model unavailable')
      : (configUnavailable ? 'Model config unavailable' : selection ? `${selection.modelID}${selection.variant ? ` · ${selection.variant}` : ''}` : 'mock · mock-smart'),
  };
}
