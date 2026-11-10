// SPDX-License-Identifier: Apache-2.0
import { createForensicTelemetry, SharedTelemetryHandle } from '../forensic-telemetry.js';

export function createEngineTelemetry(engine, options) {
  // Why a shared handle: a hosted fan-out borrows the parent's telemetry worker
  // (bound to a database path, not a conversation) and stamps its own session
  // identity onto every row; a borrower never owns the resident's lifecycle.
  if (options.sharedTelemetry && typeof options.sharedTelemetry.record === 'function'
    && options.sharedTelemetry !== false) {
    return new SharedTelemetryHandle(options.sharedTelemetry, {
      runtimeId: engine.runtimeId, sessionId: engine.sessionId,
      conversationId: options.conversationId ?? engine.sessionId,
      agentRunId: engine.sessionLineage?.agent_run_id ?? null,
      parentAgentRunId: engine.sessionLineage?.parent_agent_run_id ?? null,
    });
  }
  return createForensicTelemetry({
    telemetry: options.telemetry, workspaceRoot: engine.config.workspaceRoot,
    runtimeId: engine.runtimeId, sessionId: engine.sessionId,
    conversationId: options.conversationId ?? engine.sessionId,
    agentRunId: engine.sessionLineage?.agent_run_id, parentAgentRunId: engine.sessionLineage?.parent_agent_run_id,
    root: options.telemetryRoot ?? engine.dataPaths.projects,
    dbPath: options.telemetryDbPath, maxAgeMs: options.telemetryMaxAgeMs,
    maxBytes: options.telemetryMaxBytes,
  });
}
