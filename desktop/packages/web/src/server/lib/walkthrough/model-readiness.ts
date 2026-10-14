// SPDX-License-Identifier: Apache-2.0
/** Walkthrough model inventory and bounded readiness resolution. */
import type { CredentialEvidence, ProviderRecord } from '../small-model/provider-ports.ts';
import { configuredApiKeyShape } from '../small-model/provider-ports.ts';
import type { ModelIdentity } from './identity.ts';
import { chooseFamilyModel, familyCandidates } from '../small-model/service.ts';

const MAX_TEXT = 2048;

export type WalkthroughModelOption = {
  providerID: string;
  modelID: string;
  label: string;
  hasLogin: boolean;
  structuredOutput: boolean | null;
  inputCharBudget: number | null;
  contextTokens: number | null;
  contextKnown: boolean;
  outputTokens: number | null;
};

export type WalkthroughReadiness = {
  ready: boolean;
  reason: 'no-model' | 'empty-diff' | 'only-generated' | 'no-provider-login' | 'nnd_provider_unsupported' | 'structured-output-unsupported' | 'nnd_context_too_small' | null;
  requiredChars: number;
  availableChars: number | null;
};

type ModelOptionResult = {
  selected: { providerID: string; modelID: string } | null;
  model: WalkthroughModelOption | null;
  options: WalkthroughModelOption[];
  providerInventoryAvailable: boolean;
};

function boundedText(value: unknown, limit = MAX_TEXT): string {
  return typeof value === 'string' ? value.slice(0, limit).trim() : '';
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function hasCredential(credentials: CredentialEvidence, providerID: string, provider: ProviderRecord): boolean {
  return credentials[providerID] !== undefined || configuredApiKeyShape(provider) !== null;
}

function modelStructuredOutput(model: { id: string; capabilities?: unknown }): boolean | null {
  const output = objectOf(objectOf(model.capabilities)?.output);
  if (typeof output?.json === 'boolean') return output.json;
  return null;
}

function modelBudget(model: { id: string; limit?: unknown; options?: unknown; capabilities?: unknown }): {
  inputCharBudget: number | null;
  contextTokens: number | null;
  outputTokens: number | null;
} {
  const limits = objectOf(model.limit);
  const contextTokens = positiveNumber(limits?.context);
  const providerOutputLimit = positiveNumber(limits?.output);
  const desiredOutput = contextTokens === null ? 24_000
    : Math.min(96_000, Math.max(24_000, Math.floor(contextTokens * 0.25)));
  const outputTokens = providerOutputLimit === null ? desiredOutput : Math.min(desiredOutput, providerOutputLimit);
  return {
    contextTokens,
    outputTokens,
    inputCharBudget: contextTokens === null ? null
      : Math.max(0, (Math.min(contextTokens, 1<<30) - Math.min(outputTokens ?? 0, 1<<30)) * 4),
  };
}

function modelOption(provider: ProviderRecord, modelID: string, record: unknown,
  credentials: CredentialEvidence): WalkthroughModelOption | null {
  const shape = objectOf(record);
  if (shape?.id !== modelID) return null;
  const identifier = boundedText(provider.id, 512);
  const modelIdentifier = boundedText(modelID, 1024);
  if (identifier === '' || modelIdentifier === '') return null;
  const budgets = modelBudget(shape as ModelBudgetInput);
  const name = boundedText(shape.name, 512);
  return {
    providerID: identifier,
    modelID: modelIdentifier,
    label: name === '' ? `${identifier}/${modelIdentifier}` : `${name} (${modelIdentifier})`,
    hasLogin: hasCredential(credentials, identifier, provider),
    structuredOutput: modelStructuredOutput(shape as ModelStructuredInput),
    inputCharBudget: budgets.inputCharBudget,
    contextTokens: budgets.contextTokens,
    contextKnown: budgets.contextTokens !== null,
    outputTokens: budgets.outputTokens,
  };
}

type ModelBudgetInput = { id: string; limit?: unknown; options?: unknown; capabilities?: unknown };
type ModelStructuredInput = { id: string; capabilities?: unknown };

function identityFromString(value: unknown): { providerID: string; modelID: string } | null {
  const text = boundedText(value, 2048);
  const separator = text.indexOf('/');
  if (separator <= 0 || separator >= text.length - 1) return null;
  return { providerID: text.slice(0, separator), modelID: text.slice(separator + 1) };
}

export function walkthroughModelSelection(input: {
  providers: readonly ProviderRecord[] | null;
  credentials: CredentialEvidence;
  requestModel: unknown;
  settingsOverride: unknown;
  smallModelSettings?: Record<string, unknown>;
  config: unknown;
}): ModelOptionResult {
  const providers = input.providers;
  if (providers === null) {
    return { selected: null, model: null, options: [], providerInventoryAvailable: false };
  }
  const options = providers.flatMap((provider) => Object.entries(provider.models ?? {})
    .map(([modelID, record]) => modelOption(provider, modelID, record, input.credentials))
    .filter((option): option is WalkthroughModelOption => option !== null));
  const config = objectOf(input.config);
  // Why (uniformity #2): selection honors the per-request operator model and
  // the desktop-local small-model setting (an honored per-call choice); the
  // dead config reads (walkthrough_model / small_model) are gone — NNA never
  // emits those keys and has no auxiliary-model concept to read them from.
  const requestOrFeature = identityFromString(input.requestModel) ?? identityFromString(input.settingsOverride);
  let selected = requestOrFeature;
  const settings = input.smallModelSettings ?? {};
  if (selected === null && settings.smallModelUseDefault === false) {
    selected = identityFromString((settings as { smallModelOverride?: unknown }).smallModelOverride);
  } else if (selected === null) {
    const candidate = chooseFamilyModel({ candidates: familyCandidates({ providers, preferredProviderID: null })
      .filter(({ provider, model }) => hasCredential(input.credentials, provider.id, provider)
        && ['openai', 'anthropic', 'google'].includes(provider.id)
        && modelStructuredOutput(model) !== false) });
    selected = candidate === null ? null : { providerID: candidate.provider.id, modelID: candidate.model.id };
  }
  const model = selected === null ? null :
    options.find((option) => option.providerID === selected.providerID && option.modelID === selected.modelID) ?? null;
  return { selected, model, options, providerInventoryAvailable: true };
}

function readinessForModel(requiredChars: number, selection: ModelOptionResult): WalkthroughReadiness {
  const available = selection.model?.inputCharBudget ?? null;
  let reason: WalkthroughReadiness['reason'] = null;
  if (selection.selected === null || selection.model === null) reason = 'no-model';
  else if (selection.model?.hasLogin === false) reason = 'no-provider-login';
  else if (!['openai', 'anthropic', 'google'].includes(selection.model.providerID)) reason = 'nnd_provider_unsupported';
  else if (selection.model?.structuredOutput === false) reason = 'structured-output-unsupported';
  else if (available !== null && requiredChars > available) reason = 'nnd_context_too_small';
  return { ready: reason === null, reason, requiredChars, availableChars: available };
}

export function walkthroughReadiness(input: {
  digestCount: number;
  fileCount: number;
  requiredChars: number;
  selection: ModelOptionResult;
}): WalkthroughReadiness {
  if (input.digestCount === 0) {
    return {
      ready: false,
      reason: input.fileCount > 0 ? 'only-generated' : 'empty-diff',
      requiredChars: input.requiredChars,
      availableChars: null,
    };
  }
  return readinessForModel(input.requiredChars, input.selection);
}
