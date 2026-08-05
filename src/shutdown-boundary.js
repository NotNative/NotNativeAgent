// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { dispatchSessionHook } from './engine-hooks.js';

export async function boundedShutdown(engine, operation) {
  let timer;
  const work = Promise.resolve().then(operation);
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      engine.shutdownExpired = true;
      engine.active?.controller.abort();
      try { engine.hooks.close(); } catch { /* timeout remains causally primary */ }
      reject(new ContractError('shutdown_timeout', 'runtime shutdown exceeded its deadline', true));
    }, engine.config.limits.shutdownMs);
  });
  try { return await Promise.race([work, timeout]); }
  catch (error) {
    if (error.code === 'shutdown_timeout') await engine.lock?.release().catch(() => undefined);
    throw error;
  }
  finally { clearTimeout(timer); work.catch(() => undefined); }
}

export async function performEngineShutdown(engine, command) {
  if (engine.active) {
    const completion = engine.active.completion;
    await engine.cancel(command);
    await completion?.catch(() => undefined);
  }
  if (engine.state.state === 'idle') {
    engine.state.transition('shutting_down', { trigger: 'shutdown', turnId: null });
  }
  let primaryFailure = null;
  try { await dispatchSessionHook(engine, 'session.end', 'pre'); }
  catch (error) { primaryFailure = error; }
  const cleanup = await Promise.allSettled([
    () => engine.events.close(), async () => {
      await engine.mcp.close();
      await engine.mcpInitialization;
    }, () => engine.attachments.close(),
    () => engine.extensions?.close(), () => engine.store?.close(), () => engine.ledger.close(),
  ].map((operation) => Promise.resolve().then(operation)));
  try { engine.hooks.close(); } catch (error) { primaryFailure ??= error; }
  try { await engine.lock?.release(); } catch (error) { primaryFailure ??= error; }
  try { await engine.dialects?.close(); } catch (error) { primaryFailure ??= error; }
  try { await engine.telemetry?.close(); } catch (error) { primaryFailure ??= error; }
  if (primaryFailure) throw primaryFailure;
  const cleanupFailure = cleanup.find((item) => item.status === 'rejected');
  if (cleanupFailure) throw cleanupFailure.reason;
  if (!engine.shutdownExpired) await engine.output({ type: 'shutdown_complete', request_id: command.request_id });
  return { accepted: true };
}
