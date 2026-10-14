// SPDX-License-Identifier: Apache-2.0
/** API §5.29: small-model readiness and bounded direct generation. */

import type { Hono } from 'hono';
import { readJsonBodyBounded } from '../lib/http/read-bounded.ts';
import {
  callSmallModelDirect, directCallWire, outputExhausted, parseSmallModelResponse,
} from '../lib/small-model/provider-call.ts';
import {
  SmallModelUnavailableError,
  boundGenerationInput,
} from '../lib/small-model/service.ts';
import {
  configuredApiKeyShape, credentialEvidence, credentialFor, providerList, readConfig,
  type CredentialEvidence, type ProviderRecord, type SmallModelPorts,
} from '../lib/small-model/provider-ports.ts';
import { isRealSessionId, nativeAssistGeneration } from './small-model-assist.ts';

export type { SmallModelPorts };

const BODY_MAX_CHARS = 1024 * 1024;
const GENERATION_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_TOKENS = 1024;

interface ModelRecord {
  id: string;
  providerID: string;
  name?: unknown;
  api?: unknown;
  limit?: unknown;
  release_date?: unknown;
}

interface Resolution {
  provider: ProviderRecord;
  model: ModelRecord;
  source: 'settings-override' | 'harness-small-model' | 'family-scan' | 'session-model' | 'request-model';
}

async function resolveRequestedSmallModel(input: {
  directory: string;
  requestModelParts: { providerID: string; modelID: string } | null;
  preferredProviderID: string;
  preferredModelID: string;
  restrict: boolean;
  ports: SmallModelPorts;
}): Promise<Response | Resolution> {
  const providers = await providerList(input.ports, input.directory);
  if (providers === null) return Response.json(genericFailure(), { status: 502 });
  const settings = await (input.ports.settings?.() ?? {});
  const config = await readConfig(input.ports, input.directory);
  const credentials = credentialEvidence(input.directory, providers, input.ports);
  const resolution = await resolve({
    providers, settings, config, credentials,
    requestModel: input.requestModelParts ? `${input.requestModelParts.providerID}/${input.requestModelParts.modelID}` : null,
    request: {
      preferredProviderID: input.preferredProviderID,
      preferredModelID: input.preferredModelID,
      restrict: input.restrict,
    },
    ports: input.ports, directory: input.directory,
  });
  return resolution ?? Response.json({ error: { message: 'No small model is available' } }, { status: 404 });
}


export function registerSmallModelRoutes(app: Hono, ports: SmallModelPorts = {}): void {
  app.get('/api/small-model', async (context) => {
    try {
      return Response.json(await inspect(context.req.url, ports));
    } catch (error) {
      if (error instanceof SmallModelUnavailableError) return Response.json({ message: error.message }, { status: 404 });
      return Response.json({ error: { message: 'Failed to inspect the Small Model' } }, { status: 502 });
    }
  });

  app.post('/api/small-model/generate', async (context) => {
    try {
      return await generateRoute(context.req.raw, ports);
    } catch (error) {
      if (error instanceof SmallModelUnavailableError) return Response.json({ error: { message: error.message } }, { status: 404 });
      return Response.json(genericFailure(), { status: 502 });
    }
  });
}

async function inspect(url: string, ports: SmallModelPorts): Promise<unknown> {
  const parameters = new URL(url).searchParams;
  const directory = textOf(parameters.get('directory'), 4096);
  const requestedProviderID = textOf(parameters.get('providerID'), 256);
  const requestedModelID = textOf(parameters.get('modelID'), 256);
  const providers = await providerList(ports, directory);
  if (providers === null) {
    return { available: false, model: null, authenticatedProviders: null,
      unavailableReason: 'provider-inventory-unavailable' };
  }
  const config = await readConfig(ports, directory);
  const settings = await (ports.settings?.() ?? {});
  const credentials = credentialEvidence(directory, providers, ports);
  const requestModel = requestedProviderID !== '' && requestedModelID !== ''
    ? `${requestedProviderID}/${requestedModelID}` : null;
  const resolution = await resolve({ providers, settings, config, credentials, requestModel, request: {}, ports, directory });
  if (resolution === null) {
    // Reason vocabulary mirrors walkthrough readiness (model-readiness.ts).
    // A roster with zero credential evidence failed on login first; every
    // other dead end means no selectable small model.
    const reason = Object.keys(credentials).length === 0 && providers.length > 0
      ? 'no-provider-login' : 'no-model';
    return { available: false, model: null, authenticatedProviders: Object.keys(credentials).sort(),
      unavailableReason: reason };
  }
  const hasLogin = hasCredential(credentials, resolution.provider.id, resolution.provider);
  const supported = wireSupported(resolution.provider.id);
  // F5 step 3: readiness never carries secrets — only the resolved
  // profile/model identity, limits, a credential-present flag, and one
  // actionable reason when generation is unavailable.
  return {
    available: hasLogin && supported,
    model: modelView(resolution.model, hasLogin, supported),
    authenticatedProviders: Object.keys(credentials).sort(),
    unavailableReason: !hasLogin ? 'no-provider-login'
      : !supported ? 'nnd_provider_unsupported' : null,
  };
}

export function generateSmallModel(raw: Record<string, unknown>, ports: SmallModelPorts, signal?: AbortSignal,
  timeoutMs = GENERATION_TIMEOUT_MS): Promise<Response> {
  return generateRoute(new Request('http://small-model.internal/api/small-model/generate', {
    method: 'POST', body: JSON.stringify(raw),
  }), ports, signal, timeoutMs);
}

async function generateRoute(rawRequest: Request, ports: SmallModelPorts, signal?: AbortSignal,
  timeoutMs = GENERATION_TIMEOUT_MS): Promise<Response> {
  const raw = await readJsonBodyBounded(rawRequest, BODY_MAX_CHARS);
  if (raw === null) return invalidInput('A valid JSON prompt body is required');
  const parsed = parseGenerationRequest(raw);
  if (parsed instanceof Response) return parsed;
  const { prompt, system, responseSchema, requestModel, maxOutputTokens } = parsed;
  const directory = textOf(raw.directory, 4096);
  const sessionID = textOf(raw.sessionID, 256);
  const preferredProviderID = textOf(raw.preferredProviderID, 256);
  const preferredModelID = textOf(raw.preferredModelID, 256);
  const restrict = raw.restrictToPreferredProvider === true;
  const requestModelParts = splitModel(requestModel);
  signal?.throwIfAborted();
  // F5 step 3: a real NNA session first generates through the native assist
  // seam — the engine's router owns model selection and credentials. The
  // direct wire below remains only for injected ports and env-key profiles.
  if (isRealSessionId(sessionID)) {
    const native = await nativeAssistGeneration({ directory, sessionID, system, prompt, maxOutputTokens }, signal);
    if (native !== null) return native;
  }
  const selected = await resolveRequestedSmallModel({
    directory, requestModelParts, preferredProviderID, preferredModelID, restrict, ports,
  });
  signal?.throwIfAborted();
  if (selected instanceof Response) return selected;
  const resolution = selected;
  const credential = credentialFor(directory, resolution.provider.id, resolution.provider, ports);
  signal?.throwIfAborted();
  if (resolution.model.id === '') return genericModelFailed();
  if (!wireSupported(resolution.provider.id) || credential === null) {
    return Response.json({
      error: { code: 'nnd_provider_unsupported', ...genericFailure() },
    }, { status: 422 });
  }
  const outputTokens = outputBudget(resolution.model, maxOutputTokens);
  const bounds = boundGenerationInput(
    { ...resolution.model, limit: objectOf(resolution.model.limit) ?? {} },
    system, prompt, outputTokens,
  );
  if (bounds.kind === 'too-small') return Response.json(contextTooSmall(0, 0), { status: 413 });
  const outcome = await callSmallModelDirect({
    model: { id: resolution.model.id, providerID: resolution.provider.id },
    provider: resolution.provider,
    credential: credential.key,
    baseURL: baseURLOf(resolution),
    system: bounds.system,
    prompt: bounds.prompt,
    maxOutputTokens: outputTokens,
    ...(responseSchema === null ? {} : { responseSchema }),
    sessionID: sessionID === '' ? null : sessionID,
    timeoutMs: Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 900_000) : GENERATION_TIMEOUT_MS,
    signal,
  }, ports.fetch ?? fetch);
  return generationResponse(outcome, resolution, bounds);
}

function parseGenerationRequest(raw: Record<string, unknown>): Response | {
  prompt: string; system: string; responseSchema: Record<string, unknown> | null; requestModel: string;
  maxOutputTokens: number;
} {
  const prompt = textOf(raw.prompt, BODY_MAX_CHARS).trim();
  if (prompt === '') return invalidInput('prompt is required');
  const responseSchema = schemaOf(raw.responseSchema);
  if (raw.responseSchema !== undefined && responseSchema === null) return invalidInput('responseSchema must be a bounded JSON Schema object');
  const requestModel = textOf(raw.model, 256);
  if (requestModel !== '' && splitModel(requestModel) === null) return invalidInput('model must be providerID/modelID');
  const maxOutputTokens = raw.maxOutputTokens === undefined ? DEFAULT_OUTPUT_TOKENS : integerInput(raw.maxOutputTokens, 1, 1_000_000);
  if (maxOutputTokens === null) return invalidInput('maxOutputTokens must be a positive integer');
  return { prompt, system: textOf(raw.system, BODY_MAX_CHARS), responseSchema, requestModel, maxOutputTokens };
}

function invalidInput(message: string): Response {
  return Response.json({ error: { message } }, { status: 400 });
}

function schemaOf(value: unknown): Record<string, unknown> | null {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8') <= 32_768 ? value as Record<string, unknown> : null; }
  catch { return null; }
}

function generationResponse(
  outcome: Awaited<ReturnType<typeof callSmallModelDirect>>,
  resolution: Resolution,
  bounds: { inputTruncated: boolean },
): Response {
  if (!outcome.ok) return providerOutcome(outcome);
  const wire = wireKind(resolution.provider.id);
  const text = parseSmallModelResponse(outcome.text, wire);
  if (text !== null && outputExhausted(outcome.text, wire)) {
    return Response.json({ error: { code: 'nnd_output_exhausted', ...genericFailure() } }, { status: 422 });
  }
  if (text === null) return Response.json(providerParseError(), { status: 502 });
  return Response.json({
    text,
    providerID: resolution.provider.id,
    modelID: resolution.model.id,
    source: resolution.source,
    ...(bounds.inputTruncated ? { inputTruncated: true } : {}),
  });
}

async function resolve(input: {
  providers: readonly ProviderRecord[];
  settings: Record<string, unknown>;
  config: unknown;
  credentials: CredentialEvidence;
  requestModel: string | null;
  request: { preferredProviderID?: string; preferredModelID?: string; restrict?: boolean };
  ports: SmallModelPorts;
  directory: string;
}): Promise<Resolution | null> {
  const preferred = preferredProvider(input.providers, input.request.preferredProviderID ?? null);
  const restrict = input.request.restrict === true;
  if (restrict && preferred === null) return null;
  if (input.requestModel !== null) {
    const model = explicitModel(input.providers, input.requestModel);
    if (model === null) return null;
    return { provider: model.provider, model: model.model, source: 'request-model' };
  }
  if (input.settings.smallModelUseDefault === false) {
    const value = textOf(input.settings.smallModelOverride, 512);
    if (value === '') return null;
    const model = explicitModel(input.providers, value);
    if (model === null) return null;
    return { provider: model.provider, model: model.model, source: 'settings-override' };
  }
  const configured = splitModel(textOf((objectOf(input.config)?.small_model as unknown), 512));
  if (configured !== null && restrict && (preferred === null || configured.providerID !== preferred.id)) return null;
  if (configured !== null) {
    const model = explicitModel(input.providers, `${configured.providerID}/${configured.modelID}`);
    if (model !== null && hasCredential(input.credentials, model.provider.id, model.provider)
      && wireSupported(model.provider.id)) {
      return { provider: model.provider, model: model.model, source: 'harness-small-model' };
    }
  }
  const preferredModel = input.request.preferredModelID === undefined || input.request.preferredModelID === ''
    ? null : explicitModel(input.providers, `${preferred?.id ?? ''}/${input.request.preferredModelID}`);
  const candidates = familyCandidates(input.providers, preferred?.id ?? null, preferred !== null && restrict);
  const usable = candidates.filter((candidate) => hasCredential(input.credentials, candidate.provider.id, candidate.provider)
    && wireSupported(candidate.provider.id));
  const chosen = chooseFamilyModel(usable);
  if (chosen !== null) {
    return { provider: chosen.provider, model: chosen.model, source: 'family-scan' };
  }
  if (preferredModel !== null) {
    return { provider: preferredModel.provider, model: preferredModel.model, source: 'session-model' };
  }
  return null;
}

function familyCandidates(
  providers: readonly ProviderRecord[], preferred: string | null, restricted: boolean,
): Array<{ provider: ProviderRecord; model: ModelRecord }> {
  const scoped = restricted
    ? providers.filter((provider) => provider.id === preferred)
    : providers.slice().sort((left, right) => (left.id === preferred ? -1 : right.id === preferred ? 1 : 0));
  const candidates: Array<{ provider: ProviderRecord; model: ModelRecord }> = [];
  for (const provider of scoped) {
    const models = objectOf(provider.models);
    if (!models) continue;
    for (const [modelID, value] of Object.entries(models)) {
      if (!objectOf(value)) continue;
      const model = { ...(objectOf(value) as Record<string, unknown>), id: modelID, providerID: provider.id } as ModelRecord;
      if (familyRank(modelID) === Number.MAX_SAFE_INTEGER) continue;
      candidates.push({ provider, model });
    }
  }
  return candidates;
}

function chooseFamilyModel(input: Array<{ provider: ProviderRecord; model: ModelRecord }>): {
  provider: ProviderRecord; model: ModelRecord;
} | null {
  if (input.length === 0) return null;
  const sorted = input.slice().sort((left, right) => {
    const leftRank = familyRank(left.model.id);
    const rightRank = familyRank(right.model.id);
    if (leftRank !== rightRank) return leftRank - rightRank;
    return dateOf(right.model.release_date).localeCompare(dateOf(left.model.release_date));
  });
  return sorted[0]!;
}

function preferredProvider(providers: readonly ProviderRecord[], value: string | null): ProviderRecord | null {
  if (typeof value !== 'string' || value === '') return null;
  return providers.find((provider) => provider.id === value) ?? null;
}

function explicitModel(input: readonly ProviderRecord[], value: string): {
  provider: ProviderRecord; model: ModelRecord;
} | null {
  const shape = splitModel(value);
  if (!shape) return null;
  const provider = input.find((entry) => entry.id === shape.providerID);
  if (!provider) return null;
  const raw = objectOf(provider.models)?.[shape.modelID];
  if (!objectOf(raw)) return null;
  const model = { ...(objectOf(raw) as Record<string, unknown>), id: shape.modelID, providerID: provider.id } as ModelRecord;
  return { provider, model };
}

function splitModel(value: string): { providerID: string; modelID: string } | null {
  const index = value.indexOf('/');
  if (index <= 0 || index >= value.length - 1) return null;
  return { providerID: value.slice(0, index), modelID: value.slice(index + 1) };
}

function wireSupported(providerID: string): boolean {
  return directCallWire(providerID) !== null;
}

function wireKind(providerID: string): 'openai' | 'anthropic' | 'google' {
  const wire = directCallWire(providerID);
  if (wire === null) throw new Error('unsupported provider wire');
  return wire;
}

function baseURLOf(resolution: { provider: ProviderRecord; model: ModelRecord }): URL | null {
  const options = objectOf(resolution.provider.options);
  const rawOption = textOf(options?.baseURL, 2048);
  const api = objectOf(resolution.model.api);
  const rawApi = textOf(api?.url, 2048);
  try {
    const value = new URL(rawOption !== '' ? rawOption : rawApi);
    return value.protocol === 'http:' || value.protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

function modelView(model: ModelRecord, hasLogin: boolean, supported: boolean): Record<string, unknown> {
  const limits = objectOf(model.limit);
  const outputLimit = positiveNumber(limits?.output);
  const contextLimit = positiveNumber(limits?.context);
  return {
    id: model.id, providerID: model.providerID, name: textOf(model.name, 512),
    hasLogin, supported,
    inputCharBudget: inputBudget(model, outputBudget(model, undefined)),
    contextTokens: contextLimit, contextKnown: contextLimit !== null,
    outputTokens: outputLimit, outputTokenLimit: outputLimit,
    structuredOutput: false,
  };
}

function hasCredential(credentials: CredentialEvidence, providerID: string, provider: ProviderRecord): boolean {
  return credentials[providerID] !== undefined || configuredApiKeyShape(provider) !== null;
}

function familyRank(modelID: string): number {
  const name = `${modelID}`.toLowerCase();
  if (name.includes('gemini-flash')) return 0;
  if (name.includes('gpt-nano')) return 1;
  if (name.includes('claude-haiku')) return 2;
  return Number.MAX_SAFE_INTEGER;
}

function inputBudget(model: ModelRecord, reservedOutputTokens: number): number {
  const context = positiveNumber(objectOf(model.limit)?.context);
  if (context === null) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.ceil((context - reservedOutputTokens) * 4));
}

function outputBudget(model: ModelRecord, requested: unknown): number {
  const limit = positiveNumber(objectOf(model.limit)?.output);
  const value = requested === undefined ? null : (
    typeof requested === 'number' && Number.isSafeInteger(requested) && requested > 0 ? requested : 1024
  );
  if (value === null) return limit === null ? 1024 : limit;
  return limit === null ? value : Math.min(value, limit);
}

function dateOf(value: unknown): string {
  return typeof value === 'string' ? value : '0000-00-00';
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function textOf(value: unknown, max = 256): string {
  return typeof value === 'string' ? value.slice(0, max).trim() : '';
}

function integerInput(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value) : null;
}

function genericFailure(): Record<string, unknown> {
  return {
    error: {
      message: 'The selected Small Model could not complete this action. Choose another model in Settings → Sessions → Small Model and try again.',
    },
  };
}

function genericModelFailed(): Response {
  return Response.json(genericFailure(), { status: 422 });
}

function providerOutcome(outcome: { status: number; code: string }): Response {
  const status = outcome.code === 'nnd_provider_unsupported' ? 422 : outcome.code === 'nnd_provider_failed' ? 502 : outcome.status;
  return Response.json({ error: { code: outcome.code, ...genericFailure() } }, { status: status < 400 || status > 499 ? 502 : status });
}

function providerParseError(): Record<string, unknown> {
  return { error: { code: 'nnd_provider_response_invalid', ...genericFailure() } };
}

function contextTooSmall(requiredChars: number, availableChars: number): unknown {
  return {
    error: {
      code: 'nnd_context_too_small', requiredChars, availableChars,
      message: 'The selected Small Model could not complete this action. Choose another model in Settings → Sessions → Small Model and try again.',
    },
  };
}
