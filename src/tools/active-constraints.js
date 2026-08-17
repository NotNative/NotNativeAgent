// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { redactText } from '../redaction.js';

const MAX_CONSTRAINTS = 64;
const CONSTRAINT_KIND = Object.freeze({ schema: 'schema_repair', execution: 'execution_failure', governance: 'governance_boundary' });
const PROCESS_TOOLS = new Set(['process.run', 'shell.run']);

export function mergeToolConstraints(current = [], items = []) {
  const succeeded = new Set(items.filter((item) => item.result?.status === 'succeeded')
    .map((item) => item.result.tool_name ?? item.call?.name).filter(Boolean));
  const retained = current.filter((item) => !(succeeded.has(item.tool)
    && [CONSTRAINT_KIND.schema, CONSTRAINT_KIND.execution].includes(item.kind)));
  const indexed = new Map(retained.map((constraint) => [constraint.id, constraint]));
  for (const item of items) {
    const constraint = constraintFor(item);
    if (!constraint) continue;
    indexed.delete(constraint.id);
    if (constraint.kind === CONSTRAINT_KIND.schema) {
      for (const [id, existing] of indexed) {
        if (existing.kind === constraint.kind && existing.tool === constraint.tool) indexed.delete(id);
      }
    }
    indexed.set(constraint.id, constraint);
  }
  return Object.freeze([...indexed.values()].slice(-MAX_CONSTRAINTS));
}

export function clearAuthorityConstraints(constraints = []) {
  return Object.freeze(constraints.filter((item) => item.kind !== CONSTRAINT_KIND.governance));
}

function constraintFor(item) {
  const result = item.result;
  if (!result || result.status === 'succeeded' || result.status === 'cancelled') return null;
  const kind = constraintKind(result.status);
  const tool = result.tool_name ?? item.call?.name ?? 'unknown';
  const reasonCode = safeDiagnostic(result.reason_code ?? result.status, 128);
  const requestFingerprint = digest(stableJson(item.call?.args ?? item.request?.args ?? {}));
  const detail = constraintDetail(kind, result);
  return Object.freeze({
    id: digest(`${kind}\0${tool}\0${reasonCode}\0${requestFingerprint}\0${detail}`).slice(0, 32),
    kind, tool, status: result.status, reason_code: reasonCode,
    request_fingerprint: requestFingerprint, detail,
    instruction: instruction(kind, result),
  });
}

function constraintKind(status) {
  if (status === 'invalid_request') return CONSTRAINT_KIND.schema;
  if (['deny_with_guidance', 'hard_deny'].includes(status)) return CONSTRAINT_KIND.governance;
  return CONSTRAINT_KIND.execution;
}

function constraintDetail(kind, result) {
  if (kind === CONSTRAINT_KIND.execution && PROCESS_TOOLS.has(result.tool_name)) {
    const signal = safeDiagnostic(result.metadata?.signal, 64);
    const exitCode = result.metadata?.exitCode;
    if (signal) return `process ended by signal ${signal}`;
    if (Number.isSafeInteger(exitCode)) return `process exited ${exitCode}`;
    return safeDiagnostic(result.content ?? result.reason_code ?? result.status, 1024);
  }
  return redactText(String(result.content ?? result.reason_code ?? result.status)).replace(/\s+/gu, ' ').trim().slice(0, 1024);
}

function instruction(kind, result) {
  if (kind === CONSTRAINT_KIND.schema) return 'Correct the reported field and value; do not repeat the same request fingerprint.';
  if (kind === CONSTRAINT_KIND.governance) return 'Do not repeat an equivalent request unless new authenticated operator input changes its authority.';
  if (result?.reason_code === 'shell_interpreter_unavailable') return 'Do not repeat the unavailable shell. Use the host-native auto shell with its exact syntax, process.run, or a structured tool unless the requested interpreter is positively discovered.';
  return 'Treat the result as failed evidence; diagnose the condition before a materially different retry.';
}

function digest(value) { return createHash('sha256').update(value).digest('hex'); }

function stableJson(value, ancestors = new Set()) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return JSON.stringify(`[${typeof value}]`);
  if (typeof value === 'bigint') return JSON.stringify(`${value}n`);
  if (value && typeof value === 'object' && ancestors.has(value)) return JSON.stringify('[circular]');
  if (value && typeof value === 'object') ancestors.add(value);
  if (Array.isArray(value)) {
    const result = `[${value.map((item) => stableJson(item, ancestors)).join(',')}]`;
    ancestors.delete(value);
    return result;
  }
  if (value && typeof value === 'object') {
    const result = `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key], ancestors)}`).join(',')}}`;
    ancestors.delete(value);
    return result;
  }
  return JSON.stringify(value);
}

function safeDiagnostic(value, maximum) {
  return redactText(String(value ?? '')).replace(/\s+/gu, ' ').trim().slice(0, maximum);
}
