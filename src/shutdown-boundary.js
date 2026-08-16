// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { dispatchSessionHook } from './engine/hooks.js';

export async function boundedShutdown(engine, operation) {
  let timer;
  const work = Promise.resolve().then(operation);
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      engine.shutdownExpired = true;
      try { engine.active?.controller.abort(); }
      catch (error) { recordShutdownFailure(engine, 'active_abort', error); }
      try { engine.hooks.close(); } catch { /* timeout remains causally primary */ }
      reject(new ContractError('shutdown_timeout', 'runtime shutdown exceeded its deadline', true));
    }, engine.config.limits.shutdownMs);
  });
  try { return await Promise.race([work, timeout]); }
  // Observe the losing promise after the timeout remains primary.
  finally { clearTimeout(timer); work.catch(() => undefined); }
}

export async function performEngineShutdown(engine, command) {
  const failures = [];
  if (engine.active) {
    const completion = engine.active.completion;
    await engine.cancel(command);
    await completion?.catch(() => undefined);
  }
  if (engine.state.state === 'idle') {
    engine.state.transition('shutting_down', { trigger: 'shutdown', turnId: null });
  } else if (engine.state.state !== 'shutting_down') {
    failures.push(new ContractError('shutdown_state_invalid',
      `runtime reached shutdown cleanup from ${engine.state.state}`));
  }
  try { await dispatchSessionHook(engine, 'session.end', 'pre'); }
  catch (error) { failures.push(error); }
  const cleanup = await Promise.allSettled([
    async () => engine.events.close(), async () => {
      await engine.mcp.close();
      // A deferred initialization may still own a late connection attempt;
      // await it so shutdown cannot return while that attempt is unsettled.
      await engine.mcpInitialization;
    }, async () => engine.attachments.close(),
    async () => engine.tools?.close?.(),
    async () => engine.extensions?.close(), async () => engine.store?.close(),
    async () => engine.ledger.close(), async () => engine.governance?.close(),
  ].map((operation) => Promise.resolve().then(operation)));
  failures.push(...cleanup.filter((item) => item.status === 'rejected').map((item) => item.reason));
  try { engine.hooks.close(); } catch (error) { failures.push(error); }
  try { await engine.lock?.release(); } catch (error) { failures.push(error); }
  try { await engine.dialects?.close(); } catch (error) { failures.push(error); }
  try { await engine.telemetry?.close(); } catch (error) { failures.push(error); }
  if (failures.length > 0) throw withSecondaryFailures(failures);
  if (!engine.shutdownExpired) await engine.output({ type: 'shutdown_complete', request_id: command.request_id });
  return { accepted: true };
}

function withSecondaryFailures(failures) {
  const primary = failures[0];
  if (failures.length > 1 && primary && typeof primary === 'object') {
    try {
      primary.secondaryFailures = Object.freeze(failures.slice(1).map((error) => Object.freeze({
        code: error?.code ?? 'shutdown_cleanup_failed',
      })));
    } catch { /* a non-extensible primary remains the causal error */ }
  }
  return primary;
}

function recordShutdownFailure(engine, operation, error) {
  try {
    engine.telemetry?.record('runtime.shutdown_cleanup', 'failed', {
      operation, reason_code: error?.code ?? 'shutdown_cleanup_failed',
    }, { reasonCode: error?.code ?? 'shutdown_cleanup_failed' });
  } catch { /* timeout cleanup must retain the shutdown timeout as primary */ }
}
