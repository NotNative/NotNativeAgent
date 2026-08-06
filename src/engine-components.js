// SPDX-License-Identifier: Apache-2.0
import { AttachmentManager, AttachmentObservationRouter } from './attachments.js';
import { MemoryBoundary } from './memory.js';
import { McpManager } from './mcp-manager.js';
import { ModelRouter } from './router.js';
import { InteractivePermissionBroker } from './permission-broker.js';
import { ProviderRunner } from './provider-runner.js';
import { RoutedSemanticReviewer } from './model-reviewer.js';
import { ReviewerLedger } from './reviewer-ledger.js';
import { MandatoryReviewer } from './reviewer.js';
import { ToolGovernor } from './tool-governor.js';
import { ToolLoop } from './tool-loop.js';
import { ToolRegistry } from './tool-registry.js';
import { FairScheduler } from './fair-scheduler.js';
import { userDataPaths } from './product.js';
import { HookRuntime } from './hook-runtime.js';
import { ExtensionRegistry } from './extensions.js';
import { ModelDialectRegistry } from './model-dialects.js';
import { ProjectGuidance } from './project-guidance.js';
import { ProjectIntake } from './project-intake.js';
import { ModelRuntimeRegistry } from './model-runtime.js';
import { ContinuationCompactor } from './continuation-compactor.js';
import { SkillRegistry } from './skill-registry.js';
import { GovernanceEngine } from './governance-engine.js';
import { GroundingPolicy } from './grounding-policy.js';
import { join } from 'node:path';

export function installEngineComponents(engine, options, storeRoot, hooks) {
  installRouting(engine, options);
  engine.scheduler ??= options.scheduler ?? new FairScheduler({
    limit: engine.config.limits.providerConcurrency, maxQueued: engine.config.limits.providerQueueLimit,
  });
  installOutput(engine, options);
  installExtensions(engine, options);
  installGovernance(engine, options, storeRoot);
  installCapabilities(engine, options, storeRoot, hooks);
  installReview(engine, options);
  engine.toolLoop = toolLoop(engine, hooks);
  engine.providerRunner = providerRunner(engine, hooks);
  engine.continuationCompactor = options.continuationCompactor ?? new ContinuationCompactor({
    scheduler: engine.scheduler, telemetry: engine.telemetry,
  });
}

function installRouting(engine, options) {
  engine.router = new ModelRouter(engine.config, options.providerFactory);
  engine.dialects = options.modelDialects ?? new ModelDialectRegistry({
    path: options.modelDialectPath ?? (process.env.NODE_TEST_CONTEXT ? null : userDataPaths().modelDialects),
    telemetry: engine.telemetry,
  });
  engine.projectGuidance = options.projectGuidance ?? new ProjectGuidance(engine.config.workspaceRoot, {
    telemetry: engine.telemetry,
  });
  engine.projectIntake = options.projectIntake ?? new ProjectIntake(engine.config.workspaceRoot, {
    telemetry: engine.telemetry,
  });
  engine.modelRuntime = options.modelRuntime ?? new ModelRuntimeRegistry({ telemetry: engine.telemetry });
}

function installOutput(engine, options) {
  const output = options.output ?? (async () => undefined);
  engine.output = async (record) => {
    engine.telemetry?.record('runtime.output', outputStatus(record), record, {
      turnId: record?.turn_id ?? engine.active?.turnId,
      stepId: record?.step_id ?? engine.active?.stepId,
      attemptId: record?.attempt_id ?? engine.active?.attemptId,
      toolRequestId: record?.tool_request_id,
      outcome: record?.outcome,
      reasonCode: record?.reason_code ?? record?.code,
      effectCertainty: record?.effect_certainty,
    });
    return output(record);
  };
  engine.surface = options.surface ?? 'headless';
}

function installExtensions(engine, options) {
  engine.extensions = options.extensionRegistry ?? new ExtensionRegistry();
  engine.hooks = new HookRuntime({
    root: options.hookRoot ?? userDataPaths().hooks, events: engine.events,
    roots: options.hookRoots,
    runner: options.hookRunner,
  });
  engine.permissionBroker = permissionBroker(engine, options);
}

function installCapabilities(engine, options, storeRoot, hooks) {
  engine.skills = options.skillRegistry ?? new SkillRegistry({
    hosted: engine.config.executionManifest !== null,
    hostSkills: engine.config.skills,
    roots: options.skillRoots ?? (engine.dataPaths.skills ? [{ scope: 'user', path: engine.dataPaths.skills }] : []),
    allowedTools: engine.config.executionManifest?.allowedTools,
  });
  engine.tools = new ToolRegistry(engine.config.workspaceRoot, {
    hosted: engine.config.executionManifest !== null,
    boundedToWorkspace: engine.config.executionManifest !== null,
    enabled: engine.config.executionManifest?.allowedCapabilities.includes('tools') !== false,
    allowedTools: engine.config.executionManifest?.allowedTools,
    webSearchConfigPath: options.webSearchConfigPath ?? userDataPaths().webSearchConfig,
    webSearchClient: options.webSearchClient,
    webFetchConfigPath: options.webFetchConfigPath ?? userDataPaths().webFetchConfig,
    lspConfigPath: options.lspConfigPath,
    lspSpawnProcess: options.lspSpawnProcess,
    skillRegistry: engine.skills,
    diagnosticContext: () => ({
      journalPath: engine.store?.path ?? null,
      sessionsRoot: engine.store?.root ?? engine.dataPaths.sessions,
      sessionId: engine.sessionId,
      activeTurnId: engine.active?.turnId ?? null,
      state: engine.state.state,
    }),
    mcpControl: options.mcpControl,
    subagentControl: engine.config.executionManifest === null && engine.subagentDepth === 0 ? {
      workspaceRoot: engine.config.workspaceRoot,
      run: (input, signal) => engine.runSubagent(input, signal),
    } : null,
  });
  engine.memory = new MemoryBoundary(engine.config.memory ?? { enabled: false }, options.memoryAdapter, {
    grounding: engine.grounding,
  });
  engine.attachments = new AttachmentManager({
    config: engine.config.attachments ?? { enabled: false },
    root: options.attachmentRoot ?? `${storeRoot}/attachments/${engine.sessionId}`,
    router: new AttachmentObservationRouter(engine.router), persist: hooks.persist,
    status: (item) => engine.output({
      version: '1.0', type: 'attachment_status', session_id: engine.sessionId,
      turn_id: engine.active?.turnId ?? null, attachment_id: item.id, state: item.state,
      reason: item.reason ?? null, guidance: item.guidance ?? null,
    }),
    removeFile: options.attachmentRemoveFile,
    cleanupOnClose: engine.config.persistence === 'ephemeral',
  });
  engine.mcp = new McpManager({
    registry: engine.tools, configs: engine.config.mcpServers ?? [],
    transportFactory: options.mcpTransportFactory,
  });
}

function installReview(engine, options) {
  engine.ledger = new ReviewerLedger({
    durable: engine.config.persistence === 'durable',
    root: options.reviewerRoot ?? userDataPaths().reviewerLedger, sessionId: engine.sessionId,
    retentionEntries: engine.config.reviewerLedger.retentionEntries,
    persistenceDeadlineMs: engine.config.limits.persistenceFlushMs,
  });
  engine.reviewer = new MandatoryReviewer({
    ledger: engine.ledger,
    governance: engine.governance,
    telemetry: engine.telemetry,
    semanticReviewer: options.semanticReviewer ?? new RoutedSemanticReviewer(engine.router, {
      scheduler: engine.scheduler, telemetry: engine.telemetry, modelRuntime: engine.modelRuntime,
      dialects: engine.dialects, sessionId: engine.sessionId,
    }),
    semanticTimeoutMs: options.semanticReviewTimeoutMs ?? engine.config.limits.semanticReviewMs,
  });
  engine.governor = new ToolGovernor({
    events: engine.events, reviewer: engine.reviewer, registry: engine.tools,
    governance: engine.governance,
    permissionBroker: engine.permissionBroker,
  });
}

function installGovernance(engine, options, storeRoot) {
  engine.governance = options.governance ?? new GovernanceEngine({
    durable: engine.config.persistence === 'durable',
    root: options.governanceRoot ?? (options.storeRoot
      ? join(storeRoot, '.governance') : engine.dataPaths.governanceLedger),
    sessionId: engine.sessionId,
    telemetry: engine.telemetry,
    persistenceDeadlineMs: engine.config.limits.persistenceFlushMs,
  });
  engine.grounding = options.grounding ?? new GroundingPolicy({
    governance: engine.governance,
    telemetry: engine.telemetry,
  });
}

function outputStatus(record) {
  if (record?.type === 'error' || record?.outcome === 'failed' || record?.status === 'failed') return 'failed';
  if (record?.outcome === 'cancelled' || record?.status === 'cancelled') return 'cancelled';
  if (record?.outcome === 'denied' || record?.decision === 'deny') return 'denied';
  return 'succeeded';
}

function permissionBroker(engine, options) {
  if (options.permissionBroker) return options.permissionBroker;
  if (engine.surface !== 'interactive_tui') return null;
  return new InteractivePermissionBroker({
    output: engine.output, timeoutMs: options.permissionTimeoutMs ?? engine.config.limits.approvalMs,
  });
}

function toolLoop(engine, hooks) {
  return new ToolLoop({
    engine, state: engine.state, lifecycles: engine.lifecycles,
    tools: engine.tools, governor: engine.governor, events: engine.events,
    eventFactory: engine.eventFactory, output: engine.output,
    telemetry: engine.telemetry,
    persist: hooks.persist, publish: hooks.publish,
    toolContext: hooks.toolContext, executionContext: hooks.executionContext,
    surface: engine.surface, concurrency: engine.config.limits.toolConcurrency,
    parallelLimit: (group, signal) => engine.parallelToolLimit(group, signal),
  });
}

function providerRunner(engine, hooks) {
  return new ProviderRunner({
    state: engine.state, lifecycles: engine.lifecycles,
    telemetry: engine.telemetry,
    dialects: engine.dialects,
    publish: hooks.publish, acceptText: hooks.acceptText,
    settleAttempt: hooks.settleAttempt, recordRecovery: hooks.recordRecovery,
    scheduler: engine.scheduler,
    queueStatus: hooks.queueStatus,
    runtimeResolver: (route, signal) => engine.modelRuntime.resolve(engine.router, route, signal),
  });
}
