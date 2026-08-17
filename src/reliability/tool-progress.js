// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';

export function toolProgressEvidence(items, steeringApplied = []) {
  const successes = items.filter((item) => item.result.status === 'succeeded');
  const steeringIds = Array.isArray(steeringApplied)
    ? steeringApplied.filter((item) => typeof item === 'string' && item.length > 0)
    : [];
  if (successes.length === 0 && steeringIds.length === 0) return null;
  const hash = createHash('sha256');
  const requestFingerprints = [];
  for (const item of successes) {
    hash.update(item.result.tool_name);
    hash.update(item.result.status);
    hash.update(stableJson(item.request?.args ?? {}));
    hash.update(item.result.content);
    requestFingerprints.push(createHash('sha256')
      .update(item.result.tool_name).update('\0').update(stableJson(item.request?.args ?? {})).digest('hex'));
  }
  for (const steeringId of steeringIds) hash.update('\0steering\0').update(steeringId);
  return {
    value: hash.digest('hex'),
    detail: {
      kind: successes.length > 0 ? 'tool_results' : 'operator_steering',
      checkpoint: successes.length > 0 ? 'tool_results_committed' : 'steering_consumed',
      summary: {
        successful_tool_calls: successes.length,
        tool_names: [...new Set(successes.map((item) => item.result.tool_name))].slice(0, 16),
        request_fingerprints: [...new Set(requestFingerprints)].slice(0, 16),
        ...(steeringIds.length > 0 ? { consumed_steering_messages: steeringIds.length } : {}),
      },
    },
  };
}

export function toolFailureFingerprint(items) {
  const shapes = items.filter((item) => item.result?.status !== 'succeeded').map((item) => stableJson({
    tool: item.result?.tool_name ?? item.request?.toolName ?? 'unknown',
    status: item.result?.status ?? 'unknown',
    reason: item.result?.reason_code ?? item.result?.reasonCode ?? 'unknown',
    message: item.result?.content ?? '',
  }));
  if (shapes.length === 0) return null;
  return createHash('sha256').update([...new Set(shapes)].sort().join('\n')).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
