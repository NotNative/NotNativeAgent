// SPDX-License-Identifier: Apache-2.0
import { assertResumeProvenance } from './session-provenance.js';
import { dispatchSessionHook } from './engine-hooks.js';
import { ContractError } from './ids.js';

export async function initializeEngine(engine, operations) {
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
    await engine.tools.initialize();
    const mcpStatus = await engine.mcp.initialize();
    for (const status of mcpStatus) await engine.output({ type: 'mcp_status', ...status });
    await engine.ledger.initialize();
    if (engine.store) await restoreDurableEngine(engine, operations);
    await dispatchSessionHook(engine, 'session.start', 'post');
  } catch (error) {
    await closeAfterInitializationFailure(engine);
    throw error;
  }
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
    () => engine.dialects?.close(), () => engine.store?.close(), () => engine.lock?.release(),
  ].map((operation) => Promise.resolve().then(operation)));
}
