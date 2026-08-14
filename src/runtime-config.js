// SPDX-License-Identifier: Apache-2.0
import { AttachmentObservationRouter } from './attachments.js';
import { resolveManifest } from './config.js';
import { ContractError } from './ids.js';
import { ModelRouter } from './provider/router.js';

export async function updateEngineConfiguration(engine, command, principal) {
  const prepared = prepareEngineConfiguration(engine, command.manifest, principal);
  return publishEngineConfiguration(engine, prepared, command.request_id);
}

export function prepareEngineConfiguration(engine, manifest, principal) {
  const next = resolveManifest(manifest, {
    missionPrincipal: principal === 'authenticated-stdio-host' ? principal : undefined,
    principal,
    executionManifestId: engine.config.executionManifest?.id,
    hostOrigin: engine.config.executionManifest?.hostOrigin,
    hostIdentity: engine.config.executionManifest?.hostIdentity,
  });
  assertRuntimeConfigurationCompatible(engine.config, next);
  return Object.freeze({ ...next, version: engine.config.version + 1 });
}

export async function publishEngineConfiguration(engine, versioned, requestId) {
  const immediate = engine.state.state === 'idle';
  if (immediate) applyConfiguration(engine, versioned, null);
  else engine.pendingConfig = versioned;
  await engine.output({
    version: '1.0', type: 'accepted', request_id: requestId,
    command_type: 'configuration_update', accepted: true,
    configuration_version: versioned.version, applies: immediate ? 'immediate' : 'next_model_step',
  });
  return { accepted: true, configuration_version: versioned.version };
}

export function applyPendingConfiguration(engine, active) {
  if (!engine.pendingConfig) return;
  applyConfiguration(engine, engine.pendingConfig, active);
  engine.pendingConfig = null;
}

function applyConfiguration(engine, config, active) {
  engine.config = config;
  engine.router = new ModelRouter(config, engine.providerFactory);
  engine.attachments.config = config.attachments;
  engine.attachments.router = new AttachmentObservationRouter(engine.router);
  engine.memory.config = config.memory;
  engine.reviewer.semanticTimeoutMs = config.limits.semanticReviewMs;
  if (engine.permissionBroker) engine.permissionBroker.timeoutMs = config.limits.approvalMs;
  engine.toolLoop.concurrency = config.limits.toolConcurrency;
  engine.scheduler.configure(config.limits.providerConcurrency, config.limits.providerQueueLimit);
  engine.reviewer.semantic.setRouter?.(engine.router);
  if (active) active.authority = engine.authority.snapshot(config);
}

export function assertRuntimeConfigurationCompatible(current, next) {
  if (current.workspaceRoot !== next.workspaceRoot || current.persistence !== next.persistence) {
    throw new ContractError('configuration_scope_change', 'workspace and persistence changes require a new session');
  }
  if (JSON.stringify(current.mcpServers) !== JSON.stringify(next.mcpServers)) {
    throw new ContractError('configuration_mcp_change', 'MCP changes require a new session');
  }
  if (JSON.stringify(current.executionManifest) !== JSON.stringify(next.executionManifest)) {
    throw new ContractError('configuration_execution_scope_change', 'host capability and disconnect policy changes require a new session');
  }
  if (JSON.stringify(current.mission) !== JSON.stringify(next.mission)) {
    throw new ContractError('configuration_mission_change', 'mission authority is immutable for a session; start a newly authenticated session');
  }
}
