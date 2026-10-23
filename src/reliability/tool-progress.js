// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { missingFilesystemPrerequisite, satisfiesFilesystemPrerequisite } from './filesystem-recovery.js';
import { stableRecoveryJson, recoveryToolFingerprint, recoveryToolIdentity } from './recovery-tool-identity.js';
import { processTerminationEvidence } from './process-termination.js';

export function toolProgressEvidence(items, steeringApplied = [], options = {}) {
  const prerequisites = options.constraints?.filter((item) => item.kind === 'prerequisite_repair') ?? [];
  const successes = items.filter((item) => item?.result?.status === 'succeeded'
    && (typeof item.result.content === 'string' || Buffer.isBuffer(item.result.content))
    && (prerequisites.length === 0 || prerequisites.some((prerequisite) => satisfiesFilesystemPrerequisite(item, prerequisite, options.workspaceRoot))));
  // Why: an unrelated read-only diagnostic remains progress, but a failed
  // mutation with uncertain effects cannot discharge a missing prerequisite.
  const diagnostics = items.filter((item) => item?.result?.status === 'completed_nonzero'
    && (prerequisites.length === 0 || item.result.effect_certainty === 'none'));
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
    const identity = recoveryToolIdentity(item);
    hash.update(identity.toolName);
    hash.update(item.result.status);
    hash.update(stableRecoveryJson(identity.args));
    // Successful observations may legitimately change while the request stays
    // constant. A nonzero diagnostic earns progress once per invocation shape;
    // volatile timestamps or counters in repeated output must not defeat the
    // unchanged-request loop boundary.
    if (item.result.status === 'succeeded') hash.update(item.result.content);
    requestFingerprints.push(recoveryToolFingerprint(identity.toolName, identity.args));
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
        tool_names: [...new Set(completed.map((item) => recoveryToolIdentity(item).toolName))].slice(0, 16),
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
    const shapes = contractFailures.map((item) => stableRecoveryJson({
      tool: recoveryToolIdentity(item).toolName,
      status: item.result?.status ?? 'unknown',
      reason: item.result?.reason_code ?? item.result?.reasonCode ?? 'unknown',
      args: recoveryToolIdentity(item).args,
      error: item.result?.content ?? '',
      termination: processTerminationEvidence(item.result),
    }));
    // Why: a changed argument or diagnostic is a distinct repair attempt. Only
    // an exact repeated contract failure belongs to the same no-progress episode.
    return createHash('sha256').update([...new Set(shapes)].sort().join('\n')).digest('hex');
  }
  // Invariant: volatile failure text cannot reset the same-request no-progress episode.
  const shapes = items.filter((item) => item.result?.status !== 'succeeded').map((item) => stableRecoveryJson({
    tool: recoveryToolIdentity(item).toolName,
    status: item.result?.status ?? 'unknown',
    reason: item.result?.reason_code ?? item.result?.reasonCode ?? 'unknown',
    args: recoveryToolIdentity(item).args,
    effect_certainty: item.result?.effect_certainty ?? 'unknown',
    partial_data: item.result?.partial_data ?? false,
    termination: processTerminationEvidence(item.result),
  }));
  if (shapes.length === 0) return null;
  return createHash('sha256').update([...new Set(shapes)].sort().join('\n')).digest('hex');
}

export function toolRequestFingerprint(toolName, args = {}) {
  return recoveryToolFingerprint(toolName, args);
}

export function toolRequestFingerprints(items) {
  return [...new Set(items.map((item) => {
    const identity = recoveryToolIdentity(item);
    return recoveryToolFingerprint(identity.toolName, identity.args);
  }))];
}
