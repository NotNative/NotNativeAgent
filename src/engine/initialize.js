// SPDX-License-Identifier: Apache-2.0
import { assertResumeProvenance } from '../persistence/session-provenance.js';
import { dispatchSessionHook } from './hooks.js';
import { ContractError } from '../ids.js';

export async function initializeEngine(engine, operations, options = {}) {
  await engine.lock?.acquire();
  try {
    const telemetry = await engine.telemetry.initialize();
    if (telemetry.status === 'degraded') {
      await engine.output({ type: 'telemetry_status', status: 'degraded', code: telemetry.code, local_only: true });
    }
    await engine.dialects.initialize();
    const hookStatus = await engine.hooks.initialize();
    for (const status of hookStatus) await engine.output({ type: 'hook_status', ...status });
    await engine.skills.initialize();
    for (const diagnostic of engine.skills.diagnostics?.() ?? []) {
      await engine.output({ type: 'skill_status', ...diagnostic });
    }
    await engine.tools.initialize();
    if (!options.deferMcp) await initializeMcp(engine);
    await engine.governance.initialize();
    await engine.ledger.initialize();
    if (engine.store) await restoreDurableEngine(engine, operations);
    await dispatchSessionHook(engine, 'session.start', 'post');
    if (options.deferMcp) {
      engine.mcpInitialization = initializeMcp(engine).catch(async (error) => {
        await engine.output({
          type: 'mcp_status', id: null, status: 'failed',
          reason: error?.code ?? 'mcp_initialization_failed',
        }).catch(() => undefined);
      });
    }
  } catch (error) {
    await closeAfterInitializationFailure(engine);
    throw error;
  }
}

async function initializeMcp(engine) {
  const statuses = await engine.mcp.initialize();
  for (const status of statuses) await engine.output({ type: 'mcp_status', ...status });
}

async function restoreDurableEngine(engine, operations) {
  const recovered = await engine.store.open();
  if (recovered.corruptTail) {
    throw new ContractError('journal_corrupt', `verified prefix preserved at ${recovered.recoveryPath}`);
  }
  assertResumeProvenance(recovered.headerRecords, engine.config.executionManifest, engine.config.mission);
  engine.resumeBoundary = { beforeSequence: recovered.records[0]?.sequence ?? null, hasMore: recovered.truncated };
  const interrupted = operations.restore(recovered.records, recovered.truncated);
  engine.attachments.restore(recovered.records);
  if (recovered.records.length === 0) await operations.createSessionRecord();
  for (const turnId of interrupted) await operations.markInterrupted(turnId);
}

async function closeAfterInitializationFailure(engine) {
  await Promise.allSettled([
    () => engine.hooks.close(), () => engine.extensions?.close(), () => engine.ledger.close(),
    () => engine.governance?.close(),
    () => engine.dialects?.close(), () => engine.store?.close(),
  ].map((operation) => Promise.resolve().then(operation)));
  await engine.lock?.release().catch(() => undefined);
}
