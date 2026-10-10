// SPDX-License-Identifier: Apache-2.0

const CORRECTABLE = new Set(['invalid_request', 'completed_nonzero']);

export function updateToolFailures(active, items) {
  active.toolFailureLedger ??= new Map();
  for (const item of items) updateFailure(active.toolFailureLedger, item);
  active.unresolvedToolFailures = [...active.toolFailureLedger.values()]
    .map((entry) => entry.reasonCode).slice(-64);
  // Why: a failed read can still supply usable diagnostic evidence. Its nonzero exit
  // does not create an effect or a mandatory retry; the answer may qualify the evidence.
  active.correctableToolFailures = items.filter((item) => CORRECTABLE.has(item.result.status)
    && !(item.result.status === 'completed_nonzero' && item.result.effect_certainty === 'none'))
    .map((item) => item.result.reason_code ?? item.result.status).slice(0, 64);
}

function updateFailure(ledger, item) {
  const status = item.result?.status;
  if (CORRECTABLE.has(status)) return;
  const scope = failureScope(item);
  if (status === 'succeeded') {
    ledger.delete(scope);
    return;
  }
  const effect = item.result?.effect_certainty ?? 'unknown';
  // Why: a settled non-success with no possible effect (denial, missing target, failed
  // read) is repair feedback, not a dangling obligation. Recording it here would keep
  // completion supervision nagging long after the model chose a different route.
  if (effect === 'none') return;
  const key = effect === 'unknown' ? `unknown:${scope}` : scope;
  ledger.set(key, Object.freeze({
    reasonCode: item.result?.reason_code ?? status ?? 'tool_failed', effectCertainty: effect, scope,
  }));
}

function failureScope(item) {
  const name = item.request?.toolName ?? item.call?.name ?? item.result?.tool_name ?? 'unknown';
  const args = item.request?.args ?? item.call?.args ?? {};
  const target = args.path ?? args.url ?? args.cwd ?? args.id ?? args.name ?? null;
  return `${name}:${JSON.stringify(target ?? args)}`;
}
