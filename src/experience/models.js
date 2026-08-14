// SPDX-License-Identifier: Apache-2.0
import { ModelRouter } from '../router.js';
import { boundedProviderCapabilities } from '../provider-capabilities.js';
import { qualifyModel } from '../model-qualification.js';

export async function availableWorkspaceModels(workspace) {
  const engine = workspace.activeEngine();
  const router = new ModelRouter(workspace.activeConfig(), engine.providerFactory);
  const route = router.resolve('primary');
  const provider = router.provider(route);
  if (typeof provider.capabilities !== 'function') return [route.model];
  const value = await boundedProviderCapabilities(provider, workspace.options.providerCapabilityDeadlineMs ?? 3_000);
  const models = Array.isArray(value?.models)
    ? value.models.filter((item) => typeof item === 'string' && item.length > 0 && item.length <= 256) : [];
  return [...new Set([route.model, ...models])].sort((left, right) => left.localeCompare(right)).slice(0, 4096);
}

export async function qualifyWorkspaceModel(workspace) {
  const engine = workspace.activeEngine();
  const router = new ModelRouter(workspace.activeConfig(), engine.providerFactory);
  const route = router.resolve('primary');
  const result = await qualifyModel(router.provider(route), route, {
    timeoutMs: workspace.options.providerCapabilityDeadlineMs
      ? Math.max(5_000, workspace.options.providerCapabilityDeadlineMs * 4) : 20_000,
  });
  engine.dialects.observe(route, result.overall === 'passed'
    ? { status: 'succeeded', qualification: true }
    : { status: 'failed', code: result.tools.passed ? 'other_failure' : 'tool_arguments_invalid', qualification: true });
  await engine.dialects.flush();
  return { ...result, dialect: engine.dialects.snapshot(route) };
}
