// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

export function assertResumeProvenance(headerRecords, current, currentMission = null) {
  const created = headerRecords?.find((record) => record.type === 'session_created')?.payload;
  if (!created) return;
  const priorMission = created.mission ?? null;
  if (JSON.stringify(priorMission) !== JSON.stringify(currentMission)) {
    throw new ContractError('mission_manifest_mismatch', 'mission authority does not match the durable session');
  }
  const prior = created.executionManifest ?? null;
  if (!prior && !current) return;
  if (!prior || !current) {
    throw new ContractError('execution_manifest_required', 'session resume requires its original authenticated host execution manifest');
  }
  if (prior.id !== current.id || prior.principal !== current.principal
    || prior.hostOrigin !== current.hostOrigin || prior.disconnectPolicy !== current.disconnectPolicy
    || prior.workspaceRoot !== current.workspaceRoot || prior.persistence !== current.persistence
    || JSON.stringify(prior.allowedCapabilities) !== JSON.stringify(current.allowedCapabilities)
    || JSON.stringify(prior.allowedTools ?? null) !== JSON.stringify(current.allowedTools ?? null)
    || JSON.stringify(prior.hostIdentity ?? null) !== JSON.stringify(current.hostIdentity ?? null)
    || JSON.stringify(prior.skillGrant ?? null) !== JSON.stringify(current.skillGrant ?? null)) {
    throw new ContractError('execution_manifest_mismatch', 'host execution manifest does not match the durable session');
  }
}
