// SPDX-License-Identifier: Apache-2.0

export function throwWorkspaceShutdownFailures(poolFailure, shutdowns, cleanupFailures = []) {
  const failures = [...(poolFailure === null ? [] : [poolFailure]),
    ...shutdowns.filter((item) => item.status === 'rejected').map((item) => item.reason),
    ...cleanupFailures];
  if (failures.length === 0) return;
  const [primary, ...secondary] = failures;
  if (secondary.length === 0) throw primary;
  if (primary && (typeof primary === 'object' || typeof primary === 'function')) {
    let attached = false;
    try {
      primary.secondaryFailures = [...(primary.secondaryFailures ?? []), ...secondary];
      attached = true;
    } catch { /* an immutable primary needs a wrapper to retain every failure */ }
    if (attached) throw primary;
  }
  const combined = new AggregateError(failures, 'Console shutdown encountered multiple failures',
    { cause: primary });
  combined.code = primary?.code ?? 'interactive_failure';
  throw combined;
}
