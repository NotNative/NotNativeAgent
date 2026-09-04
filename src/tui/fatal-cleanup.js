// SPDX-License-Identifier: Apache-2.0

export function registerFatalTuiCleanup(boundary, terminal, workspace, logger, diagnostics = process.stderr) {
  return boundary?.registerCleanup(async () => {
    for (const [name, operation] of [
      ['restore', () => terminal?.restore?.()],
      ['shutdown', () => workspace?.shutdown?.()],
      ['flush', () => logger?.flush?.()],
    ]) {
      try { await operation(); }
      catch (error) { recordCleanupFailure(logger, diagnostics, name, error); }
    }
  }) ?? (async () => undefined);
}

function recordCleanupFailure(logger, diagnostics, operation, error) {
  try { diagnostics?.write?.(`NNA fatal cleanup failed during ${operation}.\n`); }
  catch { /* The fatal boundary retains its independent failure marker and deadline. */ }
  try {
    logger?.record?.({ type: 'fatal_cleanup_failed', outcome: 'failed', code: error?.code ?? 'fatal_cleanup_failed' });
  } catch { /* Fatal cleanup diagnostics cannot interrupt the remaining cleanup work. */ }
}
