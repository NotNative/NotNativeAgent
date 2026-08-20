// SPDX-License-Identifier: Apache-2.0
import { AttachmentManager, AttachmentObservationRouter } from '../attachments.js';
import { MemoryBoundary } from '../memory.js';
import { McpManager } from '../mcp-manager.js';
import { ModelRouter } from '../provider/router.js';
import { InteractivePermissionBroker } from '../permission-broker.js';
import { ProviderRunner } from '../provider/runner.js';
import { RoutedSemanticReviewer } from '../provider/model-reviewer.js';
import { ReviewerLedger } from '../persistence/reviewer-ledger.js';
import { MandatoryReviewer } from '../reviewer.js';
import { ToolGovernor } from '../tools/governor.js';
import { ToolLoop } from '../tools/loop.js';
import { ToolRegistry } from '../tool-registry.js';
import { ElevationBroker } from '../elevation-broker.js';
import { FairScheduler } from '../provider/fair-scheduler.js';
import { userDataPaths } from '../product.js';
import { HookRuntime } from '../hook-runtime.js';
import { ExtensionRegistry } from '../extensions.js';
import { ProjectGuidance } from '../guidance/project.js';
import { ProjectIntake } from '../project-intake.js';
import { ModelRuntimeRegistry } from '../provider/model-runtime.js';
import { ReliabilityEngine } from '../reliability-engine.js';
import { SkillRegistry } from '../skill-registry.js';
import { GovernanceEngine } from '../governance-engine.js';
import { GroundingPolicy } from '../governance/grounding-policy.js';
import { join } from 'node:path';
import { ConversationWork } from '../conversation-work.js';
import { TelegramNotificationQueue } from '../notifications/telegram.js';

export function installEngineComponents(engine, options, storeRoot, hooks) {
  installRouting(engine, options);
  engine.scheduler ??= options.scheduler ?? new FairScheduler({
    limit: engine.config.limits.providerConcurrency, maxQueued: engine.config.limits.providerQueueLimit,
  });
  installOutput(engine, options);
  installReliability(engine, options, hooks);
  installExtensions(engine, options);
  installGovernance(engine, options, storeRoot);
  installCapabilities(engine, options, storeRoot, hooks);
  installReview(engine, options);
  engine.toolLoop = toolLoop(engine, hooks);
  engine.providerRunner = providerRunner(engine, hooks);
}

function installRouting(engine, options) {
  engine.router = new ModelRouter(engine.config, options.providerFactory);
  engine.projectGuidance = options.projectGuidance ?? new ProjectGuidance(engine.config.workspaceRoot, {
    telemetry: engine.telemetry,
  });
  engine.projectIntake = options.projectIntake ?? new ProjectIntake(engine.config.workspaceRoot, {
    telemetry: engine.telemetry,
  });
  engine.modelRuntime = options.modelRuntime ?? new ModelRuntimeRegistry({ telemetry: engine.telemetry });
}

function installReliability(engine, options, hooks) {
  const recorder = (facts) => recordAuxiliaryProviderReceipt(engine, hooks, facts);
  engine.reliability = options.reliability ?? new ReliabilityEngine({
    modelDialects: options.modelDialects,
    modelDialectPath: options.modelDialectPath ?? (process.env.NODE_TEST_CONTEXT ? null : userDataPaths().modelDialects),
    continuationCompactor: options.continuationCompactor,
    scheduler: engine.scheduler,
    telemetry: engine.telemetry,
    contextTokenCounter: options.contextTokenCounter,
    contextTokenizerIdentity: options.contextTokenizerIdentity,
    contextTokenizerExact: options.contextTokenizerExact,
    tokenReceiptRecorder: recorder,
  });
  engine.reliability.continuationCompactor?.setTokenReceiptRecorder?.(recorder);
  engine.recordProviderAttempt = recorder;
  // Transitional aliases preserve extension and test contracts while canonical ownership moves.
  engine.dialects = engine.reliability.modelDialects;
  engine.continuationCompactor = engine.reliability.continuationCompactor;
}

function installOutput(engine, options) {
  const output = options.output ?? (async () => undefined);
  engine.output = async (record) => {
    engine.telemetry?.record('runtime.output', outputStatus(record), outputTelemetry(record), {
      turnId: record?.turn_id ?? engine.active?.turnId,
      stepId: record?.step_id ?? engine.active?.stepId,
      attemptId: record?.attempt_id ?? engine.active?.attemptId,
      toolRequestId: record?.tool_request_id,
      outcome: record?.outcome,
      reasonCode: record?.reason_code ?? record?.code,
      effectCertainty: record?.effect_certainty,
    });
    const result = await output(record);
    if (record?.type === 'turn_result') await engine.telegramNotifications?.terminal(record);
    return result;
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
  installNotifications(engine, options); const imageObserver = createImageObserver(engine);
  engine.work = options.conversationWork ?? new ConversationWork({
    persist: hooks.persist, output: engine.output, telemetry: engine.telemetry, sessionId: engine.sessionId,
  });
  engine.skills = options.skillRegistry ?? new SkillRegistry({
    hosted: engine.config.executionManifest !== null,
    hostSkills: engine.config.skills,
    roots: options.skillRoots ?? (engine.dataPaths.skills ? [{ scope: 'user', path: engine.dataPaths.skills }] : []),
    allowedTools: engine.config.executionManifest?.allowedTools,
  });
  engine.tools = new ToolRegistry(engine.config.workspaceRoot, {
    hosted: engine.config.executionManifest !== null,
    boundedToWorkspace: engine.config.executionManifest !== null,
    enabled: toolsAllowed(engine.config.executionManifest),
    allowedTools: engine.config.executionManifest?.allowedTools,
    webSearchConfigPath: options.webSearchConfigPath ?? userDataPaths().webSearchConfig,
    webSearchClient: options.webSearchClient,
    webFetchConfigPath: options.webFetchConfigPath ?? userDataPaths().webFetchConfig,
    ...browserToolOptions(engine, options, imageObserver),
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
    elevationBroker: elevationBrokerFor(engine, options),
    subagentControl: engine.config.executionManifest === null && engine.subagentDepth === 0 ? {
      workspaceRoot: engine.config.workspaceRoot,
      run: (input, signal) => engine.runSubagent(input, signal),
    } : null,
    conversationWork: engine.work,
    telegramNotifications: engine.telegramNotifications,
    activeTurnId: () => engine.active?.turnId ?? null,
    sessionHistory: historyToolOptions(engine),
  });
  engine.memory = new MemoryBoundary(engine.config.memory ?? { enabled: false }, options.memoryAdapter, { grounding: engine.grounding });
  engine.attachments = new AttachmentManager({
    config: engine.config.attachments ?? { enabled: false },
    root: options.attachmentRoot ?? `${storeRoot}/attachments/${engine.sessionId}`,
    router: imageObserver,
    persist: hooks.persist,
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

function createImageObserver(engine) {
  return new AttachmentObservationRouter(engine.router, undefined, {
    recordTokenReceipt: engine.recordProviderAttempt,
  });
}

function elevationBrokerFor(engine, options) {
  if (engine.surface !== 'interactive_tui' || engine.config.executionManifest !== null) return null;
  return options.elevationBroker ?? (options.elevationControl
    ? new ElevationBroker({ interactive: options.elevationControl, root: engine.dataPaths.elevation })
    : null);
}

function historyToolOptions(engine) {
  return {
    transcript: () => engine.transcript,
    telemetry: engine.telemetry,
    compressionState: () => ({
      tier: engine.active?.contextPressureTier ?? 'none',
      compactionAttempts: engine.active?.compactionAttempts ?? 0,
    }),
  };
}

function installNotifications(engine, options) {
  if (engine.surface !== 'interactive_tui' || engine.config.executionManifest !== null) return;
  engine.telegramNotifications = options.telegramNotifications ?? new TelegramNotificationQueue(
    engine.dataPaths.telegramOutbox ?? userDataPaths().telegramOutbox, engine.sessionId,
  );
}

function browserToolOptions(engine, options, imageObserver) {
  const defaults = userDataPaths();
  return {
    browserManager: options.browserManager,
    browserRoot: join(engine.dataPaths.root ?? defaults.root, 'runtime', 'browser', engine.sessionId),
    managedPlaywrightRoot: options.managedPlaywrightRoot ?? engine.dataPaths.managedPlaywright ?? defaults.managedPlaywright,
    secretBroker: options.secretBroker, sessionId: engine.sessionId,
    observeBrowserScreenshot: (path, signal) => (engine.attachments?.router ?? imageObserver).observe({
      managedPath: path, mimeType: 'image/png',
    }, 'Visually inspect this browser screenshot. Describe the rendered scene, layout, visible defects, missing content, and evidence relevant to verifying the active task.', signal),
  };
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
      dialects: engine.reliability, sessionId: engine.sessionId,
      recordTokenReceipt: engine.recordProviderAttempt,
    }),
    semanticTimeoutMs: options.semanticReviewTimeoutMs ?? engine.config.limits.semanticReviewMs,
    decisionTtlMs: engine.config.limits.approvalMs,
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

function outputTelemetry(record) {
  return {
    type: typeof record?.type === 'string' ? record.type : 'unknown',
    status: typeof record?.status === 'string' ? record.status : null,
    outcome: typeof record?.outcome === 'string' ? record.outcome : null,
    reason_code: typeof record?.reason_code === 'string' ? record.reason_code : null,
    effect_certainty: typeof record?.effect_certainty === 'string' ? record.effect_certainty : null,
  };
}

function toolsAllowed(executionManifest) {
  return executionManifest === null || executionManifest.allowedCapabilities.includes('tools');
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
    dialects: engine.reliability,
    reliability: engine.reliability,
    publish: hooks.publish, acceptText: hooks.acceptText, status: hooks.providerStatus,
    settleAttempt: hooks.settleAttempt, recordRecovery: hooks.recordRecovery,
    scheduler: engine.scheduler,
    queueStatus: hooks.queueStatus,
    runtimeResolver: (route, signal) => engine.modelRuntime.resolve(engine.router, route, signal),
    prepareRequest: async (request, route, active, context) => {
      const manifest = engine.reliability.providerRequestManifest(request, context, route, active);
      await hooks.persist('provider_request_manifest', manifest);
      return manifest;
    },
    verifyRequest: (request, manifest, route, active) => (
      engine.reliability.assertProviderRequestManifest(request, manifest, route, active)
    ),
    recordTokenReceipt: (manifest, active, detail) => recordProviderReceipt(engine, hooks, manifest, active, detail),
  });
}

async function recordAuxiliaryProviderReceipt(engine, hooks, facts) {
  const active = engine.active;
  if (!active || !facts?.request || !facts?.route) return null;
  const context = facts.context ?? facts.request.messages ?? [];
  const manifest = engine.reliability.providerRequestManifest(
    facts.request, context, facts.route, active,
    { outputReserveTokens: facts.request.maxOutputTokens },
  );
  return recordProviderReceipt(engine, hooks, manifest, active, {
    ...facts, providerProfile: facts.route.profile?.id ?? facts.route.providerId,
    model: facts.route.model,
  });
}

async function recordProviderReceipt(engine, hooks, manifest, active, detail) {
  const receipt = engine.reliability.providerTokenReceipt(manifest, active, detail);
  await hooks.persist('provider_token_receipt', receipt);
  active.tokenReceipts.push(receipt);
  active.tokenAccounting = engine.reliability.aggregateTokenReceipts(active.tokenReceipts);
  engine.telemetry?.record('provider.token_accounting', 'recorded', {
    receipt_id: receipt.receipt_id, role: receipt.role, outcome: receipt.outcome,
    measurement: receipt.accounting.measurement,
    measured_total_tokens: receipt.accounting.measured_total_tokens,
    estimated_unreported_tokens: receipt.accounting.estimated_unreported_tokens,
  }, {
    turnId: active.turnId, stepId: active.stepId, attemptId: receipt.attempt_id,
    providerRequestId: active.logicalRequestId,
  });
  return receipt;
}
