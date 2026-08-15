// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { isDeepStrictEqual } from 'node:util';

const EXECUTION_MANIFEST_FIELDS = Object.freeze([
  'id', 'principal', 'hostOrigin', 'disconnectPolicy', 'workspaceRoot', 'persistence',
  'allowedCapabilities', 'allowedTools', 'hostIdentity', 'skillGrant',
]);
const NULLABLE_EXECUTION_FIELDS = new Set(['allowedTools', 'hostIdentity', 'skillGrant']);

export function assertResumeProvenance(headerRecords, current, currentMission = null) {
  const created = headerRecords?.find((record) => record.type === 'session_created')?.payload;
  if (!created) return;
  const priorMission = created.mission ?? null;
  if (!isDeepStrictEqual(priorMission, currentMission)) {
    throw new ContractError('mission_manifest_mismatch', 'mission authority does not match the durable session');
  }
  const prior = created.executionManifest ?? null;
  if (!prior && !current) return;
  if (!prior || !current) {
    throw new ContractError('execution_manifest_required', 'session resume requires its original authenticated host execution manifest');
  }
  if (!executionManifestsMatch(prior, current)) {
    throw new ContractError('execution_manifest_mismatch', 'host execution manifest does not match the durable session');
  }
}

function executionManifestsMatch(prior, current) {
  return EXECUTION_MANIFEST_FIELDS.every((field) => isDeepStrictEqual(
    NULLABLE_EXECUTION_FIELDS.has(field) ? prior[field] ?? null : prior[field],
    NULLABLE_EXECUTION_FIELDS.has(field) ? current[field] ?? null : current[field],
  ));
}
