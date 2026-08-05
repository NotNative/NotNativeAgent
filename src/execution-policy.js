// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

export function validateAllowedTools(value) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > 512
    || value.some((item) => typeof item !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(item))
    || new Set(value).size !== value.length) {
    throw new ContractError('execution_tools_invalid', 'allowed_tools contains an invalid or duplicate tool name');
  }
  if (value.includes('agent.run')) {
    throw new ContractError('execution_tool_forbidden', 'hosted execution cannot grant the root-only agent.run tool');
  }
  return [...value].sort();
}

export function validateHostIdentity(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractError('host_identity_invalid', 'host_identity must be an object');
  }
  const known = new Set(['subject_id', 'scope', 'platform_role', 'permissions', 'workspace_ids', 'group_ids', 'module_ids']);
  if (Object.keys(value).some((key) => !known.has(key))) {
    throw new ContractError('host_identity_invalid', 'host_identity contains an unknown claim');
  }
  const subjectId = boundedClaim(value.subject_id, 'subject_id');
  const scope = boundedClaim(value.scope, 'scope');
  const platformRole = boundedClaim(value.platform_role, 'platform_role');
  return {
    subjectId, scope, platformRole,
    permissions: claimList(value.permissions, 'permissions'),
    workspaceIds: claimList(value.workspace_ids, 'workspace_ids'),
    groupIds: claimList(value.group_ids, 'group_ids'),
    moduleIds: claimList(value.module_ids, 'module_ids'),
  };
}

function boundedClaim(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw new ContractError('host_identity_invalid', `${name} must be a safe bounded claim`);
  }
  return value;
}

function claimList(value, name) {
  if (!Array.isArray(value) || value.length > 512
    || value.some((item) => typeof item !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(item))
    || new Set(value).size !== value.length) {
    throw new ContractError('host_identity_invalid', `${name} must contain unique safe bounded claims`);
  }
  return [...value].sort();
}
