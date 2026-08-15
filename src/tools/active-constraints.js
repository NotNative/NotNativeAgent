// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { redactText } from '../redaction.js';

const MAX_CONSTRAINTS = 64;

export function mergeToolConstraints(current = [], items = []) {
  const succeeded = new Set(items.filter((item) => item.result?.status === 'succeeded')
    .map((item) => item.result.tool_name ?? item.call?.name).filter(Boolean));
  const retained = current.filter((item) => !(succeeded.has(item.tool)
    && ['schema_repair', 'execution_failure'].includes(item.kind)));
  for (const item of items) {
    const constraint = constraintFor(item);
    if (!constraint) continue;
    const duplicate = retained.findIndex((existing) => existing.id === constraint.id);
    if (duplicate >= 0) retained.splice(duplicate, 1);
    if (constraint.kind === 'schema_repair') {
      const stale = retained.findIndex((existing) => existing.kind === constraint.kind && existing.tool === constraint.tool);
      if (stale >= 0) retained.splice(stale, 1);
    }
    retained.push(constraint);
  }
  return Object.freeze(retained.slice(-MAX_CONSTRAINTS));
}

export function clearAuthorityConstraints(constraints = []) {
  return Object.freeze(constraints.filter((item) => item.kind !== 'governance_boundary'));
}

function constraintFor(item) {
  const result = item.result;
  if (!result || result.status === 'succeeded' || result.status === 'cancelled') return null;
  const kind = constraintKind(result.status);
  const tool = result.tool_name ?? item.call?.name ?? 'unknown';
  const reasonCode = result.reason_code ?? result.status;
  const requestFingerprint = digest(stableJson(item.call?.args ?? item.request?.args ?? {}));
  const detail = constraintDetail(kind, result);
  return Object.freeze({
    id: digest(`${kind}\0${tool}\0${reasonCode}\0${requestFingerprint}\0${detail}`).slice(0, 32),
    kind, tool, status: result.status, reason_code: reasonCode,
    request_fingerprint: requestFingerprint, detail,
    instruction: instruction(kind),
  });
}

function constraintKind(status) {
  if (status === 'invalid_request') return 'schema_repair';
  if (['deny_with_guidance', 'hard_deny'].includes(status)) return 'governance_boundary';
  return 'execution_failure';
}

function constraintDetail(kind, result) {
  if (kind === 'execution_failure' && ['process.run', 'shell.run'].includes(result.tool_name)) {
    const signal = result.metadata?.signal;
    return signal ? `process ended by signal ${signal}` : `process exited ${result.metadata?.exitCode ?? 'nonzero'}`;
  }
  return redactText(String(result.content ?? result.reason_code ?? result.status)).replace(/\s+/gu, ' ').trim().slice(0, 1024);
}

function instruction(kind) {
  if (kind === 'schema_repair') return 'Correct the reported field and value; do not repeat the same request fingerprint.';
  if (kind === 'governance_boundary') return 'Do not repeat an equivalent request unless new authenticated operator input changes its authority.';
  return 'Treat the result as failed evidence; diagnose the condition before a materially different retry.';
}

function digest(value) { return createHash('sha256').update(value).digest('hex'); }

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
