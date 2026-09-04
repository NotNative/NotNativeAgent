// SPDX-License-Identifier: Apache-2.0
import { ModelRouter } from '../provider/router.js';
import { boundedProviderCapabilities } from '../provider/capabilities.js';
import { qualifyModel } from '../provider/model-qualification.js';
import { ContractError } from '../ids.js';

const DEFAULT_CAPABILITY_DEADLINE_MS = 3_000;
const MAX_MODEL_ID_LENGTH = 256;
const MAX_DISCOVERED_MODELS = 4096;
const MIN_QUALIFICATION_TIMEOUT_MS = 5_000;
const DEFAULT_QUALIFICATION_TIMEOUT_MS = 20_000;
const QUALIFICATION_DEADLINE_MULTIPLIER = 4;

export async function availableWorkspaceModels(workspace) {
  const { router, route } = resolvePrimaryRoute(workspace);
  const provider = router.provider(route);
  if (!provider || typeof provider.capabilities !== 'function') return [route.model];
  const value = await boundedProviderCapabilities(
    provider, workspace.options?.providerCapabilityDeadlineMs ?? DEFAULT_CAPABILITY_DEADLINE_MS,
  );
  const models = Array.isArray(value?.models)
    ? value.models.filter((item) => typeof item === 'string' && item.length > 0 && item.length <= MAX_MODEL_ID_LENGTH) : [];
  return [...new Set([route.model, ...models])].sort((left, right) => left.localeCompare(right)).slice(0, MAX_DISCOVERED_MODELS);
}

export async function qualifyWorkspaceModel(workspace) {
  const { engine, router, route } = resolvePrimaryRoute(workspace);
  const provider = router.provider(route);
  if (!provider) throw new ContractError('provider_unavailable', 'the active model provider is unavailable');
  const capabilityDeadline = workspace.options?.providerCapabilityDeadlineMs;
  let result;
  try { result = await qualifyModel(provider, route, {
    timeoutMs: capabilityDeadline
      ? Math.max(MIN_QUALIFICATION_TIMEOUT_MS, capabilityDeadline * QUALIFICATION_DEADLINE_MULTIPLIER)
      : DEFAULT_QUALIFICATION_TIMEOUT_MS,
  }); } catch (error) {
    const code = ['qualification_timeout', 'qualification_output_too_large'].includes(error?.code)
      ? error.code : 'qualification_unavailable';
    // Why: a failed transport is not evidence of a model dialect defect.
    try { engine.telemetry?.record('model.qualification', 'failed', { code, model: route.model, provider_profile: route.profile.id }); }
    catch { /* Invariant: diagnostic failure cannot replace the qualification outcome. */ }
    throw new ContractError(code, 'Model qualification could not complete.');
  }
  engine.reliability.observe(route, result.overall === 'passed'
    ? { status: 'succeeded', qualification: true }
    : { status: 'failed', code: result.tools.passed ? 'other_failure' : 'tool_arguments_invalid', qualification: true });
  await engine.reliability.modelDialects.flush();
  return { ...result, dialect: engine.reliability.modelSnapshot(route) };
}

function resolvePrimaryRoute(workspace) {
  const engine = workspace?.activeEngine?.();
  const config = workspace?.activeConfig?.();
  if (!engine || !config) throw new ContractError('provider_unavailable', 'the active model runtime is unavailable');
  const router = new ModelRouter(config, engine.providerFactory, {
    credentialResolver: engine.credentialResolver, sessionId: engine.sessionId,
  });
  return { engine, router, route: router.resolve('primary') };
}
