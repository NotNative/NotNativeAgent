// SPDX-License-Identifier: Apache-2.0

const CORRECTABLE = new Set(['invalid_request', 'completed_nonzero']);

export function updateToolFailures(active, items) {
  const reasons = (selected) => selected
    .map((item) => item.result.reason_code ?? item.result.status).slice(0, 64);
  active.unresolvedToolFailures = reasons(items.filter((item) => !CORRECTABLE.has(item.result.status)
    && item.result.status !== 'succeeded'));
  active.correctableToolFailures = reasons(items.filter((item) => CORRECTABLE.has(item.result.status)));
}
