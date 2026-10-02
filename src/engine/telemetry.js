// SPDX-License-Identifier: Apache-2.0
import { createForensicTelemetry } from '../forensic-telemetry.js';

export function createEngineTelemetry(engine, options) {
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
