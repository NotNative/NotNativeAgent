// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { redactText } from '../redaction.js';
import { inlineInterpreterGuidance, inlineInterpreterInvocation } from '../reliability/command-shaping.js';
import { missingFilesystemPrerequisite, satisfiesFilesystemPrerequisite } from '../reliability/filesystem-recovery.js';
import { toolLifecycleStatus, toolReviewOutcome } from './tool-result-contract.js';

const MAX_CONSTRAINTS = 64;
const CONSTRAINT_KIND = Object.freeze({
  prerequisite: 'prerequisite_repair', schema: 'schema_repair', action: 'action_repair',
  execution: 'execution_failure', governance: 'governance_boundary',
});
const PROCESS_TOOLS = new Set(['process.run', 'shell.run']);

export function mergeToolConstraints(current = [], items = []) {
  const succeeded = new Set(items.filter((item) => item.result?.status === 'succeeded')
    .map((item) => item.result.tool_name ?? item.call?.name).filter(Boolean));
  const retained = current.filter((constraint) => !constraintSatisfied(constraint, items)
    && !(succeeded.has(constraint.tool) && [CONSTRAINT_KIND.schema, CONSTRAINT_KIND.execution].includes(constraint.kind)));
  const indexed = new Map(retained.map((constraint) => [constraint.id, constraint]));
  for (const item of items) {
    const constraint = constraintFor(item);
    if (!constraint) continue;
    if (constraintSatisfied(constraint, items)) continue;
    const prior = indexed.get(constraint.id);
    indexed.delete(constraint.id);
    if (constraint.kind === CONSTRAINT_KIND.schema) {
      for (const [id, existing] of indexed) {
        if (existing.kind === constraint.kind && existing.tool === constraint.tool) indexed.delete(id);
      }
    }
    indexed.set(constraint.id, Object.freeze({
      ...constraint, occurrences: (prior?.occurrences ?? 0) + 1,
    }));
  }
  return Object.freeze([...indexed.values()].slice(-MAX_CONSTRAINTS));
}

export function clearAuthorityConstraints(constraints = []) {
  return Object.freeze(constraints.filter((item) => item.kind !== CONSTRAINT_KIND.governance));
}

function constraintFor(item) {
  const result = item.result;
  const status = toolLifecycleStatus(result);
  if (!result || status === 'succeeded' || status === 'cancelled') return null;
  const prerequisite = missingFilesystemPrerequisite(item);
  const kind = prerequisite ? CONSTRAINT_KIND.prerequisite : constraintKind(status, result.reason_code);
  const tool = prerequisite?.tool ?? result.tool_name ?? item.call?.name ?? 'unknown';
  const reasonCode = safeDiagnostic(result.reason_code ?? result.status, 128);
  const requestFingerprint = digest(stableJson(item.call?.args ?? item.request?.args ?? {}));
  const detail = prerequisite ? `missing ancestor directory: ${prerequisite.path}` : constraintDetail(kind, result);
  const identity = prerequisite
    ? `${kind}\0${prerequisite.tool}\0${prerequisite.path}`
    : kind === CONSTRAINT_KIND.action
      ? `${kind}\0${tool}\0${reasonCode}`
      : `${kind}\0${tool}\0${reasonCode}\0${requestFingerprint}\0${detail}`;
  return Object.freeze({
    id: digest(identity).slice(0, 32),
    kind, tool, status, reason_code: reasonCode,
    ...(toolReviewOutcome(result) ? { review_outcome: toolReviewOutcome(result) } : {}),
    // Why: the hash remains part of the internal identity above, but a provider cannot
    // compute or act on it. Exposing it would turn kernel telemetry into model ceremony.
    detail,
    ...(prerequisite ? { required_tool: prerequisite.tool, required_path: prerequisite.path } : {}),
    instruction: instruction(kind, result, item, prerequisite),
  });
}

function constraintKind(status, reasonCode = null) {
  if (reasonCode === 'tool_arguments_truncated') return CONSTRAINT_KIND.action;
  if (status === 'invalid_request') return CONSTRAINT_KIND.schema;
  if (status === 'denied') return CONSTRAINT_KIND.governance;
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

function instruction(kind, result, item, prerequisite = null) {
  if (kind === CONSTRAINT_KIND.prerequisite) {
    return `Repair the missing ancestor by calling ${prerequisite.tool} with path ${JSON.stringify(prerequisite.path)}. `
      + 'Use action create and do not retry descendant writes until this exact ancestor exists. If another action already created it, verify the exact path with fs.list.';
  }
  if (kind === CONSTRAINT_KIND.schema) {
    const detail = constraintDetail(kind, result);
    return `The prior ${result.tool_name ?? item?.call?.name ?? 'tool'} request was rejected: ${detail}. `
      + 'Rebuild the call from the currently presented schema, use only its allowed fields, and do not repeat the same invalid request shape.';
  }
  if (kind === CONSTRAINT_KIND.action) {
    return 'The provider output limit was reached before the tool JSON closed. The immediate repair step uses a smaller output budget with optional thinking disabled. Make that one concise action call; for edits, select the smallest unique anchor and bounded replacement, then split larger changes across calls. Later steps may reason normally, but do not repeat the oversized request shape.';
  }
  if (kind === CONSTRAINT_KIND.governance) return 'Do not repeat an equivalent request unless new authenticated operator input changes its authority.';
  if (result?.reason_code === 'shell_interpreter_unavailable') return 'Do not repeat the unavailable shell. Use the host-native auto shell with its exact syntax, process.run, or a structured tool unless the requested interpreter is positively discovered.';
  const args = item?.call?.args ?? item?.request?.args;
  if (kind === CONSTRAINT_KIND.execution && result?.tool_name === 'process.run'
    && inlineInterpreterInvocation(args?.executable, args?.args)) return inlineInterpreterGuidance();
  return 'Treat the result as failed evidence; diagnose the condition before a materially different retry.';
}

function constraintSatisfied(constraint, items) {
  if (constraint.kind !== CONSTRAINT_KIND.prerequisite) return false;
  return items.some((item) => satisfiesFilesystemPrerequisite(item, constraint));
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
