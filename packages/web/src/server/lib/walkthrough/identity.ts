// SPDX-License-Identifier: Apache-2.0
/** Stable walkthrough model identity and cache-key foundation. */
import { createHash } from 'node:crypto';
import type { Snapshot } from '../../routes/git-walkthrough-snapshot.ts';

export type ModelIdentity = { providerID: string; modelID: string };

export function boundedText(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.slice(0, limit).trim() : '';
}

export function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function identityOf(identity: ModelIdentity | null): string {
  return identity === null ? 'harness:unresolved' : `${identity.providerID}/${identity.modelID}`;
}

function identityParts(provider: unknown, model: unknown): ModelIdentity | null {
  const providerID = boundedText(provider, 512);
  const modelID = boundedText(model, 1024);
  return providerID !== '' && modelID !== '' ? { providerID, modelID } : null;
}

export function sessionIdentity(record: unknown): ModelIdentity | null {
  const shape = objectOf(record);
  if (shape === null) return null;
  const direct = identityParts(shape.providerID, shape.modelID);
  if (direct !== null) return direct;
  const model = objectOf(shape.model);
  const sessionModel = identityParts(model?.providerID, model?.id ?? model?.modelID);
  if (sessionModel !== null) return sessionModel;
  for (const key of ['subjectModelID', 'assistantModelID', 'walkthroughModelID'] as const) {
    const detail = objectOf(shape[key]);
    const identity = identityParts(detail?.providerID, detail?.modelID);
    if (identity !== null) return identity;
  }
  return null;
}

export function seniorAssistantIdentity(messages: readonly unknown[]): ModelIdentity | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    const info = objectOf(objectOf(entry)?.info);
    if (info === null || info.role !== 'assistant') continue;
    const identity = identityParts(info.providerID, info.modelID);
    if (identity !== null) return identity;
  }
  return null;
}

export function providerModels(provider: unknown): ModelIdentity[] {
  const shape = objectOf(provider);
  const models = objectOf(shape?.models);
  if (models === null) return [];
  return Object.entries(models).map(([modelID, record]) =>
    identityParts(shape?.id, objectOf(record)?.id ?? modelID))
    .filter((identity): identity is ModelIdentity => identity !== null);
}

export function providerHasModel(providers: readonly unknown[], providerID: string, modelID: string): boolean {
  return providerID.length > 0 && providerID.length <= 512 && modelID.length > 0 && modelID.length <= 1024
    && providers.some((provider) => providerModels(provider).some((model) =>
      model.providerID === providerID && model.modelID === modelID));
}

export function identityFromString(value: unknown): ModelIdentity | null {
  const text = boundedText(value, 1536);
  const separator = text.indexOf('/');
  if (separator === -1) return null;
  return { providerID: text.slice(0, separator), modelID: text.slice(separator + 1) };
}

export function configuredIdentity(config: unknown, providers: readonly unknown[],
  override: string, smallModelOverride: string): ModelIdentity | null {
  const requested = identityFromString(override) ?? identityFromString(smallModelOverride)
    ?? identityFromString(objectOf(config)?.small_model) ?? identityFromString(objectOf(config)?.model);
  if (requested !== null && providerHasModel(providers, requested.providerID, requested.modelID)) return requested;
  return null;
}

export function walkthroughCacheKey(walkthroughVersion: string, root: string, sourceKey: string,
  identity: ModelIdentity | null, language: string, snapshot: Snapshot): string {
  const files = snapshot.stops.slice()
    .filter((stop, index, all) => index === all.findIndex((candidate) => candidate.id === stop.id))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(({ id, path }) => ({ id, path }));
  return createHash('sha256').update(JSON.stringify({
    version: walkthroughVersion,
    root,
    revision: snapshot.signature,
    sourceKey,
    model: identityOf(identity),
    language,
    files,
  }), 'utf8').digest('hex');
}
