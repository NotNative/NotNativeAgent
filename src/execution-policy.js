// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

const MAX_CLAIMS = 512;
const SAFE_CLAIM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const FORBIDDEN_HOST_TOOLS = new Set(['agent.run']);

export function validateAllowedTools(value) {
  if (value === undefined) return null;
  if (!validUniqueClaims(value)) {
    throw new ContractError('execution_tools_invalid', 'allowed_tools contains an invalid or duplicate tool name');
  }
  if (value.some((tool) => FORBIDDEN_HOST_TOOLS.has(tool))) {
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
  if (typeof value !== 'string' || !SAFE_CLAIM_PATTERN.test(value)) {
    throw new ContractError('host_identity_invalid', `${name} must be a safe bounded claim`);
  }
  return value;
}

function claimList(value, name) {
  if (!validUniqueClaims(value)) {
    throw new ContractError('host_identity_invalid', `${name} must contain unique safe bounded claims`);
  }
  return [...value].sort();
}

function validUniqueClaims(value) {
  return Array.isArray(value) && value.length <= MAX_CLAIMS
    && value.every((item) => typeof item === 'string' && SAFE_CLAIM_PATTERN.test(item))
    && new Set(value).size === value.length;
}
