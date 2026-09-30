// SPDX-License-Identifier: Apache-2.0
/** §7.4 small-model resolution, bounded inputs, and generation. */

export interface SmallModelRecord {
  id: string;
  providerID: string;
  name?: unknown;
  limit?: { context?: unknown; input?: unknown; output?: unknown };
  release_date?: unknown;
}

export interface ProviderRecord {
  id: string;
  name?: string;
  options?: unknown;
  models?: Record<string, unknown>;
}

export interface CredentialState {
  kind: 'none' | 'api-key' | 'oauth';
}

export interface ResolvedSmallModel {
  model: SmallModelRecord;
  provider: ProviderRecord;
  hasLogin: boolean;
  supported: boolean;
}

export class SmallModelUnavailableError extends Error {
  constructor(message = 'No small model is available') {
    super(message);
  }
}

export function selectedModel(input: {
  value: unknown; providers: readonly ProviderRecord[];
}): SmallModelRecord | null {
  if (typeof input.value !== 'string') return null;
  const [providerID, modelID] = input.value.trim().split('/', 2);
  if (!providerID || !modelID) return null;
  return providerModel(input.providers, providerID, modelID);
}

export function providerModel(
  providers: readonly ProviderRecord[], providerID: string, modelID: string,
): SmallModelRecord | null {
  const provider = providers.find((entry) => typeof entry.id === 'string' && entry.id === providerID);
  const models = objectOf(provider?.models);
  if (models === null) return null;
  const raw = objectOf(models[modelID]);
  if (raw === null || raw.id !== modelID) return null;
  return { ...raw, id: modelID, providerID } as SmallModelRecord;
}

export function familyCandidates(input: {
  providers: readonly ProviderRecord[]; preferredProviderID: string | null;
}): Array<{ provider: ProviderRecord; model: SmallModelRecord }> {
  const preferred = preferredProviderID(input.providers, input.preferredProviderID);
  const scoped = preferred === null ? input.providers : [preferred, ...input.providers.filter((entry) => entry !== preferred)];
  const candidates: Array<{ provider: ProviderRecord; model: SmallModelRecord }> = [];
  for (const provider of scoped) {
    const models = objectOf(provider.models);
    if (models === null) continue;
    for (const [modelID, rawRecord] of Object.entries(models)) {
      const raw = objectOf(rawRecord);
      if (raw === null) continue;
      const model = { ...raw, id: modelID, providerID: provider.id } as SmallModelRecord;
      const name = `${modelID}`.toLowerCase();
      const rank = name.includes('gemini-flash') ? 0 : name.includes('gpt-nano') ? 1
        : name.includes('claude-haiku') ? 2 : Number.MAX_SAFE_INTEGER;
      if (rank === Number.MAX_SAFE_INTEGER) continue;
      candidates.push({
        provider,
        model: { ...model, release_date: `${model.release_date ?? '0000-00-00'}` },
      });
    }
  }
  return candidates;
}

export function preferredProviderID(
  providers: readonly ProviderRecord[], preferred: string | null,
): ProviderRecord | null {
  if (typeof preferred !== 'string' || preferred.trim() === '') return null;
  return providers.find((entry) => entry.id === preferred) ?? null;
}

export function chooseFamilyModel(input: {
  candidates: Array<{ provider: ProviderRecord; model: SmallModelRecord }>;
}): { provider: ProviderRecord; model: SmallModelRecord } | null {
  const same = input.candidates.slice();
  if (same.length === 0) return null;
  same.sort((left, right) => {
    const leftRank = familyRank(left.model.id);
    const rightRank = familyRank(right.model.id);
    if (leftRank !== rightRank) return leftRank - rightRank;
    return dateOf(right.model.release_date).localeCompare(dateOf(left.model.release_date));
  });
  return same[0]!;
}

export function familyRank(modelID: string): number {
  const name = `${modelID}`.toLowerCase();
  if (name.includes('gemini-flash')) return 0;
  if (name.includes('gpt-nano')) return 1;
  if (name.includes('claude-haiku')) return 2;
  return Number.MAX_SAFE_INTEGER;
}

function dateOf(value: unknown): string {
  return typeof value === 'string' ? value : '0000-00-00';
}

export function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function inputBudget(model: SmallModelRecord, reservedOutputTokens: number): number {
  const context = positiveNumber(model.limit?.context);
  if (context === null) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.ceil((context - reservedOutputTokens) * 4));
}

export function outputBudget(model: SmallModelRecord, requested: unknown): number {
  const limit = positiveNumber(model.limit?.output);
  const value = positiveNumber(requested);
  if (value === null) return limit ?? 1024;
  return limit === null ? value : Math.min(value, limit);
}

export function boundGenerationInput(model: SmallModelRecord, system: string, prompt: string, outputTokens: number):
  { kind: 'too-small' } | { kind: 'ok'; system: string; prompt: string; inputTruncated: boolean } {
  const budget = inputBudget(model, outputTokens);
  const adjustedSystem = budget === Number.POSITIVE_INFINITY ? system : system.slice(0, budget);
  const promptSpace = budget - adjustedSystem.length;
  if (budget < 1 || promptSpace < Math.min(prompt.length, 1)) return { kind: 'too-small' };
  const boundedPrompt = budget === Number.POSITIVE_INFINITY ? prompt
    : prompt.slice(Math.max(0, prompt.length - promptSpace));
  return {
    kind: 'ok',
    system: adjustedSystem,
    prompt: boundedPrompt,
    inputTruncated: boundedPrompt.length < prompt.length || adjustedSystem.length < system.length,
  };
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value) : null;
}

export function textOf(value: unknown, max = 256): string {
  return typeof value === 'string' ? value.slice(0, max).trim() : '';
}
