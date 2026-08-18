// SPDX-License-Identifier: Apache-2.0

const NUMERIC_ACCOUNTING_FIELDS = Object.freeze([
  'attempts', 'measured_attempts', 'estimated_attempts', 'mixed_attempts',
  'measured_total_tokens', 'estimated_unreported_tokens',
  'accounted_input_tokens', 'accounted_output_tokens', 'accounted_total_tokens',
]);

export function accumulateTokenAccounting(current, update) {
  if (!update || update.schema !== 'nna.token-accounting.v1') return current;
  const result = { schema: 'nna.token-accounting.v1' };
  for (const key of NUMERIC_ACCOUNTING_FIELDS) result[key] = (current?.[key] ?? 0) + (update[key] ?? 0);
  result.measurement = result.estimated_unreported_tokens > 0
    ? (result.measured_total_tokens > 0 ? 'mixed' : 'estimated')
    : result.measured_total_tokens > 0 ? 'provider' : 'unavailable';
  result.by_role = mergeRoles(current?.by_role, update.by_role);
  return Object.freeze(result);
}

function mergeRoles(left = {}, right = {}) {
  const roles = {};
  for (const role of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const measured = (left[role]?.measured_total_tokens ?? 0) + (right[role]?.measured_total_tokens ?? 0);
    const estimated = (left[role]?.estimated_unreported_tokens ?? 0) + (right[role]?.estimated_unreported_tokens ?? 0);
    roles[role] = Object.freeze({
      attempts: (left[role]?.attempts ?? 0) + (right[role]?.attempts ?? 0),
      measured_total_tokens: measured, estimated_unreported_tokens: estimated,
      accounted_total_tokens: measured + estimated,
    });
  }
  return Object.freeze(roles);
}

export function statusTokenText(usage, accounting) {
  const measured = accounting?.measured_total_tokens;
  const total = Number.isFinite(measured) && measured > 0 ? measured : usage?.total_tokens ?? usage?.totalTokens;
  const estimated = accounting?.estimated_unreported_tokens;
  if (Number.isFinite(total) && Number.isFinite(estimated) && estimated > 0) return `${total}+~${estimated} tokens`;
  if (!Number.isFinite(total) && Number.isFinite(estimated) && estimated > 0) return `~${estimated} tokens`;
  return Number.isFinite(total) ? `${total} tokens` : 'tokens --';
}

export function receiptTokenText(record) {
  const usage = record?.usage;
  const measured = record?.token_accounting?.measured_total_tokens;
  const total = Number.isFinite(measured) && measured > 0 ? measured : usage?.total_tokens ?? usage?.totalTokens;
  const estimated = record?.token_accounting?.estimated_unreported_tokens;
  if (Number.isFinite(total) && Number.isFinite(estimated) && estimated > 0) return `${total}+~${estimated} tokens`;
  if (!Number.isFinite(total) && Number.isFinite(estimated) && estimated > 0) return `~${estimated} tokens`;
  if (Number.isFinite(total)) return `${total} tokens`;
  const prompt = usage?.prompt_tokens;
  const completion = usage?.completion_tokens;
  return Number.isFinite(prompt) && Number.isFinite(completion) ? `${prompt + completion} tokens` : null;
}

export function detailedTokenText(record) {
  const usage = record?.usage;
  const prompt = usage?.prompt_tokens;
  const completion = usage?.completion_tokens;
  const estimated = record?.token_accounting?.estimated_unreported_tokens;
  const measured = record?.token_accounting?.measured_total_tokens;
  const suffix = Number.isFinite(estimated) && estimated > 0 ? ` + ~${estimated} unreported` : '';
  const primaryTotal = usage?.total_tokens ?? usage?.totalTokens;
  if (Number.isFinite(measured) && measured > 0 && (measured !== primaryTotal || suffix)) {
    return `${measured} measured tokens${suffix}`;
  }
  if (Number.isFinite(prompt) && Number.isFinite(completion)) return `${prompt} in + ${completion} out${suffix}`;
  const total = usage?.total_tokens ?? usage?.totalTokens;
  if (Number.isFinite(total)) return `${total} tokens${suffix}`;
  return Number.isFinite(estimated) && estimated > 0 ? `~${estimated} tokens` : null;
}
