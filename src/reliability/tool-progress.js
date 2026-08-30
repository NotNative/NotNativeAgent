// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { missingFilesystemPrerequisite, satisfiesFilesystemPrerequisite } from './filesystem-recovery.js';

export function toolProgressEvidence(items, steeringApplied = [], options = {}) {
  const prerequisites = options.constraints?.filter((item) => item.kind === 'prerequisite_repair') ?? [];
  const successes = items.filter((item) => item.result.status === 'succeeded'
    && (prerequisites.length === 0 || prerequisites.some((prerequisite) => satisfiesFilesystemPrerequisite(item, prerequisite))));
  const diagnostics = prerequisites.length === 0
    ? items.filter((item) => item.result.status === 'completed_nonzero')
    : [];
  const completed = [...successes, ...diagnostics];
  const steeringIds = Array.isArray(steeringApplied)
    ? steeringApplied.filter((item) => typeof item === 'string' && item.length > 0)
    : [];
  if (completed.length === 0 && steeringIds.length === 0) return null;
  const hash = createHash('sha256');
  if (Number.isSafeInteger(options.stateRevision) && options.stateRevision >= 0) {
    hash.update('\0observable_state_revision\0').update(String(options.stateRevision));
  }
  const requestFingerprints = [];
  for (const item of completed) {
    const toolName = item.result.tool_name ?? item.request?.toolName ?? 'unknown';
    hash.update(toolName);
    hash.update(item.result.status);
    hash.update(stableJson(item.request?.args ?? {}));
    // Successful observations may legitimately change while the request stays
    // constant. A nonzero diagnostic earns progress once per invocation shape;
    // volatile timestamps or counters in repeated output must not defeat the
    // unchanged-request loop boundary.
    if (item.result.status === 'succeeded') hash.update(item.result.content);
    requestFingerprints.push(createHash('sha256')
      .update(toolName).update('\0').update(stableJson(item.request?.args ?? {})).digest('hex'));
  }
  for (const steeringId of steeringIds) hash.update('\0steering\0').update(steeringId);
  return {
    value: hash.digest('hex'),
    detail: {
      kind: completed.length > 0 ? 'tool_results' : 'operator_steering',
      checkpoint: completed.length > 0 ? 'tool_results_committed' : 'steering_consumed',
      summary: {
        successful_tool_calls: successes.length,
        ...(diagnostics.length > 0 ? { diagnostic_tool_calls: diagnostics.length } : {}),
        tool_names: [...new Set(completed
          .map((item) => item.result.tool_name ?? item.request?.toolName ?? 'unknown'))].slice(0, 16),
        request_fingerprints: [...new Set(requestFingerprints)].slice(0, 16),
        ...(steeringIds.length > 0 ? { consumed_steering_messages: steeringIds.length } : {}),
      },
    },
  };
}

export function toolFailureFingerprint(items) {
  const prerequisites = items.map(missingFilesystemPrerequisite).filter(Boolean);
  if (prerequisites.length > 0) {
    const paths = [...new Set(prerequisites.map((item) => item.path))].sort();
    return createHash('sha256').update(`filesystem_prerequisite\0${paths.join('\0')}`).digest('hex');
  }
  const contractFailures = items.filter((item) => item.result?.status === 'invalid_request'
    && ['tool_schema_invalid', 'tool_arguments_malformed', 'tool_arguments_truncated']
      .includes(item.result?.reason_code ?? item.result?.reasonCode));
  if (contractFailures.length > 0) {
    const shapes = contractFailures.map((item) => stableJson({
      tool: item.result?.tool_name ?? item.request?.toolName ?? 'unknown',
      status: item.result?.status ?? 'unknown',
      reason: item.result?.reason_code ?? item.result?.reasonCode ?? 'unknown',
      args: item.request?.args ?? item.call?.args ?? {},
      error: item.result?.content ?? '',
    }));
    // Why: a changed argument or diagnostic is a distinct repair attempt. Only
    // an exact repeated contract failure belongs to the same no-progress episode.
    return createHash('sha256').update([...new Set(shapes)].sort().join('\n')).digest('hex');
  }
  const shapes = items.filter((item) => item.result?.status !== 'succeeded').map((item) => stableJson({
    tool: item.result?.tool_name ?? item.request?.toolName ?? 'unknown',
    status: item.result?.status ?? 'unknown',
    reason: item.result?.reason_code ?? item.result?.reasonCode ?? 'unknown',
    args: item.request?.args ?? item.call?.args ?? {},
    error: item.result?.content ?? '',
  }));
  if (shapes.length === 0) return null;
  return createHash('sha256').update([...new Set(shapes)].sort().join('\n')).digest('hex');
}

export function toolRequestFingerprint(toolName, args = {}) {
  return createHash('sha256').update(String(toolName ?? 'unknown')).update('\0').update(stableJson(args)).digest('hex');
}

export function toolRequestFingerprints(items) {
  return [...new Set(items.map((item) => toolRequestFingerprint(
    item.request?.toolName ?? item.result?.tool_name ?? item.call?.name ?? 'unknown',
    item.request?.args ?? item.call?.args ?? {},
  )))];
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
