// SPDX-License-Identifier: Apache-2.0
import { ModelRouter } from '../provider/router.js';
import { boundedProviderCapabilities } from '../provider/capabilities.js';
import { ContractError } from '../ids.js';

const DEFAULT_CAPABILITY_DEADLINE_MS = 3_000;
const MAX_MODEL_ID_LENGTH = 256;
const MAX_DISCOVERED_MODELS = 4096;
const MAX_CONNECTIONS = 16;
const SWEEP_CONCURRENCY = 4;

// Why: one sweep answers "which models can I reach right now" across every configured connection.
// Each connection reports on its own, so one unreachable endpoint degrades one row set instead of
// hiding the whole catalog.
export async function sweepWorkspaceModels(workspace, options = {}) {
  const config = workspace?.activeConfig?.();
  if (!config) throw new ContractError('provider_unavailable', 'the active provider configuration is unavailable');
  const engine = workspace.activeEngine?.();
  const router = new ModelRouter(config, engine?.providerFactory, {
    credentialResolver: engine?.credentialResolver, sessionId: engine?.sessionId,
  });
  const deadlineMs = workspace.options?.providerCapabilityDeadlineMs ?? DEFAULT_CAPABILITY_DEADLINE_MS;
  const profiles = Object.values(config.providerProfiles).slice(0, MAX_CONNECTIONS);
  const groups = groupByConnection(profiles);
  const rows = [];
  const seen = new Set();
  const onRow = typeof options.onRow === 'function' ? options.onRow : () => undefined;
  const emit = (row) => {
    if (rows.length >= MAX_DISCOVERED_MODELS) return;
    const key = `${row.connection_id}\u0000${row.model}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(Object.freeze(row));
    // Why: rows appear as each connection answers so the surface fills instead of blocking.
    try { onRow(rows.at(-1)); } catch { /* Invariant: a render failure cannot stop the sweep. */ }
  };
  // Every configured selection is reachable evidence even when its endpoint cannot enumerate models.
  for (const profile of profiles) emit(rowFor(profile, profile.model, 'configured'));
  await mapBounded(groups, SWEEP_CONCURRENCY, async (group) => {
    if (options.signal?.aborted) return;
    const profile = group.profiles[0];
    const route = routeFor(group);
    let value;
    try {
      const provider = router.provider(route);
      value = await boundedProviderCapabilities(provider, deadlineMs);
    } catch (error) {
      if (options.signal?.aborted) return;
      emit({ ...rowFor(profile, null, 'unavailable'), reason_code: error?.code ?? 'provider_unavailable' });
      return;
    }
    const models = Array.isArray(value?.models)
      ? value.models.filter((item) => typeof item === 'string' && item.length > 0 && item.length <= MAX_MODEL_ID_LENGTH)
      : [];
    const contextTokens = Number.isSafeInteger(value?.contextLimitTokens) && value.contextLimitTokens > 0
      ? value.contextLimitTokens : null;
    for (const model of models) {
      if (options.signal?.aborted) return;
      emit({ ...rowFor(profile, model, 'observed'), context_limit_tokens: contextTokens });
    }
  });
  return Object.freeze(rows);
}

function rowFor(profile, model, status) {
  const connection = profile.connectionId ?? profile.id;
  return Object.freeze({
    connection_id: connection, connection_name: profile.displayName ?? connection,
    endpoint: profile.endpoint ?? null, model, status,
    context_limit_tokens: null,
  });
}

// Why: two models that share a connection enumerate the same endpoint, so one probe answers both.
function groupByConnection(profiles) {
  const groups = new Map();
  for (const profile of profiles) {
    const key = profile.connectionId ?? profile.id;
    const group = groups.get(key) ?? { connectionId: key, profiles: [] };
    group.profiles.push(profile);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function routeFor(group) {
  const profile = group.profiles[0];
  return Object.freeze({
    logicalRequestId: `model_sweep:${group.connectionId}`,
    role: 'primary', targetRole: 'primary', model: profile.model, profile,
    contextLimitBytes: profile.contextLimitBytes, requiredCapabilities: Object.freeze([]),
    deadlineMs: null, budget: null, temperature: null, maxOutputTokens: null,
    reasoningEffort: null, enableThinking: null,
  });
}

async function mapBounded(items, concurrency, task) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await task(items[index]);
    }
  });
  await Promise.all(workers);
}
