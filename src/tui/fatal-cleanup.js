// SPDX-License-Identifier: Apache-2.0

export function registerFatalTuiCleanup(boundary, terminal, workspace, logger) {
  return boundary?.registerCleanup(async () => {
    const results = await Promise.allSettled([
      invoke(() => terminal?.restore?.()),
      invoke(() => workspace?.shutdown?.()),
      invoke(() => logger?.flush?.()),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') recordCleanupFailure(logger, result.reason);
    }
  }) ?? (async () => undefined);
}

function invoke(operation) {
  try { return Promise.resolve(operation()); } catch (error) { return Promise.reject(error); }
}

function recordCleanupFailure(logger, error) {
  try {
    logger?.record?.({ type: 'fatal_cleanup_failed', outcome: 'failed', code: error?.code ?? 'fatal_cleanup_failed' });
  } catch { /* Fatal cleanup diagnostics cannot interrupt the remaining cleanup work. */ }
}
