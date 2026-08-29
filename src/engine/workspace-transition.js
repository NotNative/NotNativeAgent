// SPDX-License-Identifier: Apache-2.0
import { ProjectGuidance } from '../guidance/project.js';
import { ContractError } from '../ids.js';
import { ProjectIntake } from '../project-intake.js';

export async function changeEngineWorkspace(engine, target, operations = {}) {
  assertWorkspaceTransition(engine);
  const previousWorkspace = engine.tools.paths.root;
  const prepared = await engine.tools.prepareWorkspaceRoot(target);
  if (samePath(previousWorkspace, prepared.root)) {
    return Object.freeze({ previousWorkspace, workspaceRoot: prepared.root, changed: false });
  }
  const nextConfig = workspaceConfig(engine.config, prepared.root);
  const nextPendingConfig = engine.pendingConfig
    ? workspaceConfig(engine.pendingConfig, prepared.root, nextConfig.version + 1) : null;
  const nextGuidance = new ProjectGuidance(prepared.root, { telemetry: engine.telemetry });
  const nextIntake = new ProjectIntake(prepared.root, { telemetry: engine.telemetry });
  const record = Object.freeze({
    previousWorkspace, workspaceRoot: prepared.root,
    configVersion: nextConfig.version, turnId: engine.active?.turnId ?? null,
    changedAt: new Date().toISOString(),
  });
  if (operations.persist !== false) await operations.persist?.('workspace_changed', record);
  commitWorkspace(engine, prepared, nextConfig, nextPendingConfig, nextGuidance, nextIntake);
  notifyWorkspaceChanged(engine, record, operations.notify !== false);
  return Object.freeze({ previousWorkspace, workspaceRoot: prepared.root, changed: true });
}

export async function restoreEngineWorkspace(engine, target) {
  if (!target || samePath(engine.tools.paths.root, target)) return false;
  if (engine.config.executionManifest !== null) {
    throw new ContractError('workspace_change_forbidden', 'authenticated host workspace scope is immutable');
  }
  const prepared = await engine.tools.prepareWorkspaceRoot(target);
  const nextConfig = workspaceConfig(engine.config, prepared.root, engine.config.version);
  const nextPendingConfig = engine.pendingConfig
    ? workspaceConfig(engine.pendingConfig, prepared.root, engine.pendingConfig.version) : null;
  commitWorkspace(
    engine, prepared, nextConfig, nextPendingConfig,
    new ProjectGuidance(prepared.root, { telemetry: engine.telemetry }),
    new ProjectIntake(prepared.root, { telemetry: engine.telemetry }),
  );
  return true;
}

function commitWorkspace(engine, prepared, config, pendingConfig, guidance, intake) {
  // Invariant: every workspace-dependent owner changes only after validation and durable
  // recording. All operations below are bounded in-memory assignments and cannot partially fail.
  engine.tools.commitWorkspaceRoot(prepared);
  engine.config = config;
  if (engine.pendingConfig) engine.pendingConfig = pendingConfig;
  engine.projectGuidance = guidance;
  engine.projectIntake = intake;
  if (engine.active) {
    engine.active.authority = engine.authority.snapshot(config);
    engine.active.enrichment.projectIntake = null;
    engine.active.contextMeasurementEnrichment = null;
  }
}

function notifyWorkspaceChanged(engine, record, enabled) {
  engine.telemetry?.record('workspace.transition', 'succeeded', {
    changed: true, config_version: record.configVersion,
  }, { turnId: record.turnId });
  if (!enabled || typeof engine.workspaceChanged !== 'function') return;
  try {
    const observed = engine.workspaceChanged(Object.freeze({ ...record }));
    Promise.resolve(observed).catch((error) => engine.telemetry?.record('workspace.projection', 'failed', {
      code: error?.code ?? 'workspace_projection_failed',
    }, { turnId: record.turnId, reasonCode: error?.code }));
  } catch (error) {
    engine.telemetry?.record('workspace.projection', 'failed', {
      code: error?.code ?? 'workspace_projection_failed',
    }, { turnId: record.turnId, reasonCode: error?.code });
  }
}

function workspaceConfig(config, workspaceRoot, version = config.version + 1) {
  return Object.freeze({ ...config, workspaceRoot, version });
}

function assertWorkspaceTransition(engine) {
  if (!engine?.tools || !engine?.config || typeof engine.tools.prepareWorkspaceRoot !== 'function') {
    throw new ContractError('workspace_change_unavailable', 'working directory transition is unavailable');
  }
  if (engine.config.executionManifest !== null) {
    throw new ContractError('workspace_change_forbidden', 'authenticated host workspace scope is immutable');
  }
  if (!engine.active) {
    throw new ContractError('workspace_change_unavailable', 'working directory transition requires an active reviewed tool call');
  }
}

function samePath(left, right) {
  return process.platform === 'win32'
    ? String(left).toLowerCase() === String(right).toLowerCase()
    : left === right;
}
