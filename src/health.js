// SPDX-License-Identifier: Apache-2.0
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { VERSION } from './product.js';
import { inspectDataPermissions } from './data-permissions.js';
import { inspectNetworkDestinations } from './network-destinations.js';
import { boundedProviderCapabilities } from './provider/capabilities.js';

const MAX_TRANSCRIPT_RECORDS = 512;
const CONTEXT_PRESSURE_WARNING_RATIO = 0.8;
const DEFAULT_PROVIDER_HEALTH_DEADLINE_MS = 2_000;
const HEALTH = Object.freeze({
  READY: 'ready', UNKNOWN: 'unknown', DEGRADED: 'degraded', UNAVAILABLE: 'unavailable',
  DISABLED: 'disabled', WARNING: 'warning',
});

export class HealthInspector {
  constructor(engine) {
    this.engine = engine;
  }

  async inspect(options = {}) {
    const engine = this.engine;
    const [provider, persistence, dataPermissions, networkDestinations, memory, telemetry, staleLocks] = await Promise.all([
      safeInspection(() => providerHealth(engine, options.providerDeadlineMs ?? DEFAULT_PROVIDER_HEALTH_DEADLINE_MS), 'provider_health_failed'),
      safeInspection(() => persistenceHealth(engine), 'persistence_health_failed'),
      safeInspection(() => inspectDataPermissions(engine.dataPaths.root), 'data_permissions_health_failed'),
      safeInspection(() => inspectNetworkDestinations(engine), 'network_health_failed'),
      safeInspection(() => engine.memory.health(), 'memory_health_failed'),
      safeInspection(() => engine.telemetry.health(), 'telemetry_health_failed'),
      engine.lock ? safeInspection(() => engine.lock.health(), 'lock_health_failed') : status(HEALTH.DISABLED, { mode: 'ephemeral' }),
    ]);
    const contextBytes = Buffer.byteLength(JSON.stringify(engine.transcript.slice(-MAX_TRANSCRIPT_RECORDS)));
    return Object.freeze({
      checked_at: new Date().toISOString(), read_only: true,
      installation: status(HEALTH.READY, { version: VERSION, runtime: process.version, platform: process.platform, arch: process.arch }),
      configuration: status(HEALTH.READY, {
        version: engine.config.version, provenance: engine.config.provenance,
        winning_sources: engine.config.configurationProvenance ?? {}, warnings: engine.config.warnings,
        launch_overrides: engine.config.launchOverrides ?? null,
      }),
      runtime_bounds: status(HEALTH.READY, runtimeBounds(engine.config.limits)),
      provider,
      model_capability: status(provider.models?.length ? HEALTH.READY : HEALTH.UNKNOWN, { models: provider.models ?? [] }),
      persistence, data_permissions: dataPermissions,
      reviewer: status(HEALTH.READY, engine.reviewer.health()), network_destinations: networkDestinations,
      reviewer_llm: reviewerModelHealth(engine), ledger: status(HEALTH.READY, engine.ledger.health()),
      governance: governanceHealth(engine.governance.health()),
      sandbox: status(engine.tools?.paths?.root ? HEALTH.READY : HEALTH.UNAVAILABLE, { root: engine.tools?.paths?.root ?? null }),
      memory, skills: skillHealth(engine.skills), hooks: engine.hooks.health(), events: engine.events.health(),
      forensic_telemetry: telemetry, mcp: engine.mcp.status(), extensions: extensionHealth(engine.extensions), stale_locks: staleLocks,
      context_pressure: status(contextBytes > engine.config.limits.maxContextBytes * CONTEXT_PRESSURE_WARNING_RATIO ? HEALTH.WARNING : HEALTH.READY, {
        bytes: contextBytes, limit: engine.config.limits.maxContextBytes,
      }),
    });
  }
}

function runtimeBounds(limits) {
  return {
    provider_connect_ms: limits.connectMs, provider_first_token_ms: limits.firstTokenMs,
    provider_idle_ms: limits.idleMs, provider_overall_ms: limits.providerMs,
    semantic_review_ms: limits.semanticReviewMs, approval_ms: limits.approvalMs,
    provider_concurrency: limits.providerConcurrency, provider_queue_limit: limits.providerQueueLimit,
    read_only_tool_concurrency: limits.toolConcurrency, persistence_flush_ms: limits.persistenceFlushMs,
    shutdown_ms: limits.shutdownMs,
  };
}

function extensionHealth(registry) {
  if (!registry) return status(HEALTH.DISABLED, { installed: 0, errors: [] });
  const installed = registry.list();
  const errors = installed.filter((item) => ['failed', 'incompatible'].includes(item.state));
  return status(errors.length > 0 ? HEALTH.DEGRADED : HEALTH.READY, {
    installed: installed.length, errors, diagnostics: registry.diagnostics(),
  });
}

async function providerHealth(engine, deadlineMs) {
  let endpoint = null;
  try {
    const route = engine.router.resolve('primary');
    endpoint = route?.profile?.endpoint ?? null;
    if (!endpoint) throw Object.assign(new Error('primary route profile is invalid'), { code: 'provider_route_invalid' });
    const provider = engine.router.provider(route);
    if (typeof provider.capabilities !== 'function') return status(HEALTH.UNKNOWN, { reason: 'adapter has no health capability' });
    const capabilities = await boundedProviderCapabilities(provider, deadlineMs);
    return status(HEALTH.READY, { endpoint, models: capabilities.models ?? [] });
  } catch (error) {
    return status(HEALTH.DEGRADED, { endpoint, code: error.code ?? 'provider_unreachable' });
  }
}

function reviewerModelHealth(engine) {
  const health = engine.reviewer.health();
  try {
    const route = engine.router.resolve('reviewer', { requiredCapabilities: ['structured_output'] });
    if (!route?.profile?.id || typeof route.model !== 'string') throw Object.assign(new Error('reviewer route is invalid'), { code: 'reviewer_route_invalid' });
    return status(health.semantic_status === 'configured' ? HEALTH.READY : HEALTH.UNAVAILABLE, {
      component: health.semantic_component, provider: route.profile.id, model: route.model,
    });
  } catch (error) {
    return status(HEALTH.UNAVAILABLE, { component: health.semantic_component, code: error.code ?? 'reviewer_route_unavailable' });
  }
}

async function persistenceHealth(engine) {
  if (!engine.store) return status(HEALTH.DISABLED, { mode: 'ephemeral' });
  try {
    if (typeof engine.store.root !== 'string') throw Object.assign(new Error('store root is unavailable'), { code: 'store_root_invalid' });
    await access(engine.store.root, constants.R_OK | constants.W_OK);
    return status(HEALTH.READY, { mode: 'durable', root: engine.store.root });
  } catch (error) {
    return status(HEALTH.DEGRADED, { mode: 'durable', code: error.code ?? 'store_unavailable' });
  }
}

function status(state, details) {
  return Object.freeze({ status: state, ...details });
}

function skillHealth(registry) {
  const diagnostics = registry?.diagnostics?.() ?? [];
  return status(diagnostics.length > 0 ? HEALTH.DEGRADED : HEALTH.READY, {
    loaded: registry?.catalog?.().length ?? 0,
    skipped: diagnostics.length,
    diagnostics,
  });
}

function governanceHealth(details) {
  return status(details.status === 'attention' ? HEALTH.DEGRADED : HEALTH.READY, details);
}

async function safeInspection(operation, code) {
  try { return await operation(); }
  catch (error) { return status(HEALTH.DEGRADED, { code: error?.code ?? code }); }
}
