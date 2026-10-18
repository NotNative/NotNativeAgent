// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { normalize, resolve } from 'node:path';
import { redactText } from '../redaction.js';
import { inlineInterpreterGuidance, inlineInterpreterInvocation } from '../reliability/command-shaping.js';
import { missingFilesystemPrerequisite, satisfiesFilesystemPrerequisite } from '../reliability/filesystem-recovery.js';
import { stableRecoveryJson, recoveryToolIdentity } from '../reliability/recovery-tool-identity.js';
import { processTerminationEvidence } from '../reliability/process-termination.js';
import { toolLifecycleStatus, toolReviewOutcome } from './tool-result-contract.js';

const MAX_CONSTRAINTS = 64;
const CONSTRAINT_KIND = Object.freeze({
  prerequisite: 'prerequisite_repair', schema: 'schema_repair', action: 'action_repair',
  execution: 'execution_failure', governance: 'governance_boundary', path: 'path_repair',
});
const PROCESS_TOOLS = new Set(['process_run', 'shell_run']);
const PATH_REASON_CODES = new Set([
  'tool_directory_not_found', 'tool_parent_invalid', 'tool_parent_missing', 'tool_path_ambiguous',
  'tool_path_invalid', 'tool_path_reparse_unresolved', 'tool_path_reserved', 'tool_target_invalid',
  'tool_target_not_found',
]);
const PATH_SHAPE_REASON_CODES = new Set([
  'tool_parent_invalid', 'tool_path_ambiguous', 'tool_path_invalid',
  'tool_path_reparse_unresolved', 'tool_path_reserved',
]);

export function mergeToolConstraints(current = [], items = [], options = {}) {
  const succeeded = new Set(items.filter((item) => item.result?.status === 'succeeded')
    .map((item) => item.result.tool_name ?? item.call?.name).filter(Boolean));
  const retained = current.filter((constraint) => !constraintSatisfied(constraint, items, options.workspaceRoot)
    && !(constraint.kind === CONSTRAINT_KIND.path && pathConstraintSatisfied(constraint, items, options.workspaceRoot))
    && !(succeeded.has(constraint.tool) && [CONSTRAINT_KIND.schema, CONSTRAINT_KIND.execution].includes(constraint.kind)));
  const indexed = new Map(retained.map((constraint) => [constraint.id, constraint]));
  for (const [index, item] of items.entries()) {
    const constraint = constraintFor(item);
    if (!constraint) continue;
    if (constraintSatisfied(constraint, items, options.workspaceRoot)) continue;
    if (constraint.kind === CONSTRAINT_KIND.path && pathConstraintSatisfied(constraint, items, options.workspaceRoot, index + 1)) continue;
    const prior = indexed.get(constraint.id);
    indexed.delete(constraint.id);
    if (constraint.kind === CONSTRAINT_KIND.schema || (constraint.kind === CONSTRAINT_KIND.path && !constraint.target_path)) {
      for (const [id, existing] of indexed) {
        if (existing.kind === constraint.kind && existing.tool === constraint.tool
          && (constraint.kind !== CONSTRAINT_KIND.path || (!existing.target_path && existing.target_action === constraint.target_action))) indexed.delete(id);
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
  const requestIdentity = recoveryToolIdentity(item);
  // Why: an invalid path shape or unresolved ancestor cannot serve as stable
  // repair identity when the next valid request must select another path.
  const targetPath = kind === CONSTRAINT_KIND.path && !PATH_SHAPE_REASON_CODES.has(result.reason_code)
    ? requestPath(requestIdentity.args) : null;
  const targetAction = kind === CONSTRAINT_KIND.path && requestIdentity.toolName === 'fs_directory'
    && ['create', 'list', 'remove'].includes(requestIdentity.args?.action)
    ? requestIdentity.args?.action : null;
  const tool = prerequisite?.tool ?? requestIdentity.toolName;
  const reasonCode = safeDiagnostic(result.reason_code ?? result.status, 128);
  const requestFingerprint = digest(stableRecoveryJson(requestIdentity.args));
  const termination = processTerminationEvidence(result);
  const detail = prerequisite ? `missing ancestor directory: ${prerequisite.path}` : constraintDetail(kind, result);
  const identity = prerequisite
    ? `${kind}\0${prerequisite.tool}\0${prerequisite.path}`
    : kind === CONSTRAINT_KIND.action
      ? `${kind}\0${tool}\0${reasonCode}`
      : `${kind}\0${tool}\0${reasonCode}\0${requestFingerprint}\0${detail}`;
  return Object.freeze({
    id: digest(identity).slice(0, 32),
    kind, tool, status, reason_code: reasonCode,
    ...(targetPath ? { target_path: targetPath } : {}),
    ...(targetAction ? { target_action: targetAction } : {}),
    ...(termination ? { termination } : {}),
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
  if (PATH_REASON_CODES.has(reasonCode)) return CONSTRAINT_KIND.path;
  if (status === 'invalid_request') return CONSTRAINT_KIND.schema;
  if (status === 'denied') return CONSTRAINT_KIND.governance;
  return CONSTRAINT_KIND.execution;
}

function constraintDetail(kind, result) {
  if (kind === CONSTRAINT_KIND.execution && PROCESS_TOOLS.has(result.tool_name)) {
    const termination = processTerminationEvidence(result);
    if (termination?.kind === 'output_limit') return 'process output exceeded the capture limit';
    if (termination?.kind === 'timeout') return 'process timed out';
    if (termination?.kind === 'signal') return `process ended by signal ${termination.signal}`;
    if (termination?.kind === 'exit_code') return `process exited ${termination.exit_code}`;
    return safeDiagnostic(result.content ?? result.reason_code ?? result.status, 1024);
  }
  return redactText(String(result.content ?? result.reason_code ?? result.status)).replace(/\s+/gu, ' ').trim().slice(0, 1024);
}

function instruction(kind, result, item, prerequisite = null) {
  if (kind === CONSTRAINT_KIND.prerequisite) {
    return `Repair the missing ancestor by calling ${prerequisite.tool} with path ${JSON.stringify(prerequisite.path)}. `
      + 'Use action create and do not retry descendant writes until this exact ancestor exists. If another action already created it, verify the exact path with fs_list.';
  }
  if (kind === CONSTRAINT_KIND.path) return pathRepairInstruction(result.reason_code);
  if (kind === CONSTRAINT_KIND.schema) {
    const detail = constraintDetail(kind, result);
    return `The prior ${result.tool_name ?? item?.call?.name ?? 'tool'} request was rejected: ${detail}. `
      + 'Rebuild the call from the currently presented schema, use only its allowed fields, and do not repeat the same invalid request shape.';
  }
  if (kind === CONSTRAINT_KIND.action) {
    return 'The provider output limit was reached before the tool JSON closed. The immediate repair step uses a smaller output budget with optional thinking disabled. Make that one concise action call; for edits, select the smallest unique anchor and bounded replacement, then split larger changes across calls. Later steps may reason normally, but do not repeat the oversized request shape.';
  }
  if (kind === CONSTRAINT_KIND.governance) return 'Do not repeat an equivalent request unless new authenticated operator input changes its authority.';
  if (result?.reason_code === 'shell_interpreter_unavailable') return 'Do not repeat the unavailable shell. Use the host-native auto shell with its exact syntax, process_run, or a structured tool unless the requested interpreter is positively discovered.';
  if (result?.reason_code === 'process_output_too_large') return 'Narrow the query or use a bounded output option before retrying the process.';
  const args = item?.request?.args ?? item?.call?.args;
  if (kind === CONSTRAINT_KIND.execution && result?.tool_name === 'process_run'
    && inlineInterpreterInvocation(args?.executable, args?.args)) return inlineInterpreterGuidance();
  return 'Treat the result as failed evidence; diagnose the condition before a materially different retry.';
}

function pathRepairInstruction(reasonCode) {
  switch (reasonCode) {
    case 'tool_path_ambiguous': return 'Use an absolute path or a path relative to the workspace. Do not use a drive-relative path such as C:.';
    case 'tool_parent_invalid': return 'An existing ancestor is not a directory. Inspect that ancestor and choose a different target path.';
    case 'tool_path_reparse_unresolved': return 'The path contains an unresolved link or reparse point. Choose a different accessible path.';
    case 'tool_parent_missing': return 'The parent directory is missing. Inspect its path, then create that directory before retrying the child.';
    case 'tool_directory_not_found':
    case 'tool_target_not_found': return 'The target is missing. List its parent to locate it; create it only when the task requires creation.';
    case 'tool_target_invalid': return 'The target has the wrong filesystem type. Inspect it with fs_metadata and choose a target of the required type.';
    default: return 'The path is invalid. Choose a valid accessible path and do not repeat the same request.';
  }
}

function constraintSatisfied(constraint, items, workspaceRoot) {
  if (constraint.kind !== CONSTRAINT_KIND.prerequisite) return false;
  return items.some((item) => satisfiesFilesystemPrerequisite(item, constraint, workspaceRoot));
}

function pathConstraintSatisfied(constraint, items, workspaceRoot, startIndex = 0) {
  return items.some((item, index) => {
    if (index < startIndex) return false;
    const identity = recoveryToolIdentity(item);
    if (item?.result?.status !== 'succeeded' || identity.toolName !== constraint.tool) return false;
    if (constraint.target_action && identity.args?.action !== constraint.target_action) return false;
    // Why: an invalid or absent target path has no stable identity to compare.
    // A later same-tool success repairs that shape; reparse paths also need an existing target.
    if (!constraint.target_path) {
      return constraint.reason_code !== 'tool_path_reparse_unresolved'
        || item.result.metadata?.target_exists !== false;
    }
    if (constraint.tool === 'fs_directory' && constraint.target_action === 'list'
      && item.result.metadata?.target_exists !== true) return false;
    if (['fs_list', 'fs_metadata'].includes(constraint.tool)
      && item.result.metadata?.target_exists !== true) return false;
    const candidate = requestPath(identity.args);
    return candidate && comparablePath(candidate, workspaceRoot) === comparablePath(constraint.target_path, workspaceRoot);
  });
}

function requestPath(args) {
  return typeof args?.path === 'string' && args.path.length > 0 && args.path.length <= 4096 ? args.path : null;
}

function comparablePath(value, workspaceRoot) {
  const absolute = normalize(resolve(workspaceRoot ?? process.cwd(), value));
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function digest(value) { return createHash('sha256').update(value).digest('hex'); }

function safeDiagnostic(value, maximum) {
  return redactText(String(value ?? '')).replace(/\s+/gu, ' ').trim().slice(0, maximum);
}
