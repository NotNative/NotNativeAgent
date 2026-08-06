// SPDX-License-Identifier: Apache-2.0
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { VERSION } from './product.js';
import { inspectDataPermissions } from './data-permissions.js';
import { inspectNetworkDestinations } from './network-destinations.js';
import { boundedProviderCapabilities } from './provider-capabilities.js';

export class HealthInspector {
  constructor(engine) {
    this.engine = engine;
  }

  async inspect(options = {}) {
    const provider = await providerHealth(this.engine, options.providerDeadlineMs ?? 2_000);
    const contextBytes = Buffer.byteLength(JSON.stringify(this.engine.transcript.slice(-512)));
    return Object.freeze({
      checked_at: new Date().toISOString(), read_only: true,
      installation: status('ready', { version: VERSION, runtime: process.version, platform: process.platform, arch: process.arch }),
      configuration: status('ready', {
        version: this.engine.config.version, provenance: this.engine.config.provenance,
        winning_sources: this.engine.config.configurationProvenance ?? {}, warnings: this.engine.config.warnings,
        launch_overrides: this.engine.config.launchOverrides ?? null,
      }),
      runtime_bounds: status('ready', runtimeBounds(this.engine.config.limits)),
      provider,
      model_capability: status(provider.models?.length ? 'ready' : 'unknown', { models: provider.models ?? [] }),
      persistence: await persistenceHealth(this.engine),
      data_permissions: await inspectDataPermissions(this.engine.dataPaths.root),
      reviewer: status('ready', this.engine.reviewer.health()),
      network_destinations: await inspectNetworkDestinations(this.engine),
      reviewer_llm: reviewerModelHealth(this.engine),
      ledger: status('ready', this.engine.ledger.health()),
      governance: governanceHealth(this.engine.governance.health()),
      sandbox: status(this.engine.tools?.paths?.root ? 'ready' : 'unavailable', { root: this.engine.tools?.paths?.root ?? null }),
      memory: await this.engine.memory.health(),
      hooks: this.engine.hooks.health(), events: this.engine.events.health(),
      forensic_telemetry: await this.engine.telemetry.health(),
      mcp: this.engine.mcp.status(), extensions: extensionHealth(this.engine.extensions),
      stale_locks: this.engine.lock ? await this.engine.lock.health() : status('disabled', { mode: 'ephemeral' }),
      context_pressure: status(contextBytes > this.engine.config.limits.maxContextBytes * 0.8 ? 'warning' : 'ready', {
        bytes: contextBytes, limit: this.engine.config.limits.maxContextBytes,
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
  if (!registry) return status('disabled', { installed: 0, errors: [] });
  const installed = registry.list();
  const errors = installed.filter((item) => ['failed', 'incompatible'].includes(item.state));
  return status(errors.length > 0 ? 'degraded' : 'ready', {
    installed: installed.length, errors, diagnostics: registry.diagnostics(),
  });
}

async function providerHealth(engine, deadlineMs) {
  let endpoint = null;
  try {
    const route = engine.router.resolve('primary');
    endpoint = route.profile.endpoint;
    const provider = engine.router.provider(route);
    if (typeof provider.capabilities !== 'function') return status('unknown', { reason: 'adapter has no health capability' });
    const capabilities = await boundedProviderCapabilities(provider, deadlineMs);
    return status('ready', { endpoint: route.profile.endpoint, models: capabilities.models ?? [] });
  } catch (error) {
    return status('degraded', { endpoint, code: error.code ?? 'provider_unreachable' });
  }
}

function reviewerModelHealth(engine) {
  const health = engine.reviewer.health();
  try {
    const route = engine.router.resolve('reviewer', { requiredCapabilities: ['structured_output'] });
    return status(health.semantic_status === 'configured' ? 'ready' : 'unavailable', {
      component: health.semantic_component, provider: route.profile.id, model: route.model,
    });
  } catch (error) {
    return status('unavailable', { component: health.semantic_component, code: error.code ?? 'reviewer_route_unavailable' });
  }
}

async function persistenceHealth(engine) {
  if (!engine.store) return status('disabled', { mode: 'ephemeral' });
  try {
    await access(engine.store.root, constants.R_OK | constants.W_OK);
    return status('ready', { mode: 'durable', root: engine.store.root });
  } catch (error) {
    return status('degraded', { mode: 'durable', code: error.code ?? 'store_unavailable' });
  }
}

function status(state, details) {
  return Object.freeze({ status: state, ...details });
}

function governanceHealth(details) {
  return status(details.status === 'attention' ? 'degraded' : 'ready', details);
}
