// SPDX-License-Identifier: Apache-2.0
import type { HarnessConfig } from '../lib/nnd/types.ts';

const FALLBACK_MODEL = { providerID: 'mock', modelID: 'mock' } as const;
type ModelIdentity = { providerID: string; modelID: string };
type Selection = ModelIdentity & { variant?: string | null };

export function resolveComposerModel(config: HarnessConfig | null | undefined, selection: Selection | null | undefined, agent: string): {
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
  const nnaModel = nnaConfigured && typeof nnd.primaryModel?.providerID === 'string' && typeof nnd.primaryModel.modelID === 'string'
    ? { providerID: nnd.primaryModel.providerID, modelID: nnd.primaryModel.modelID } : null;
  return {
    configUnavailable, nnaConfigured, nnaModel,
    model: nnaModel ?? (selection ? { providerID: selection.providerID, modelID: selection.modelID } : FALLBACK_MODEL),
    sendAgent: nnaConfigured ? 'nna' : agent,
    modelLabel: nnaConfigured
      ? (nnaModel ? `${nnaModel.providerID} · ${nnaModel.modelID}` : 'NNA model unavailable')
      : (configUnavailable ? 'Model config unavailable' : selection ? `${selection.modelID}${selection.variant ? ` · ${selection.variant}` : ''}` : 'mock · mock-smart'),
  };
}
