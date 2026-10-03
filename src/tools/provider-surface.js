// SPDX-License-Identifier: Apache-2.0
import {
  LEGACY_PROVIDER_TOOL_NAMES, TOOL_SURFACE_ELIGIBLE_NAMES,
} from './core-names.js';

export const TOOL_SURFACE_ELIGIBLE = new Set(TOOL_SURFACE_ELIGIBLE_NAMES);

const LEGACY_PROVIDER = new Set(LEGACY_PROVIDER_TOOL_NAMES);
export function catalogVisible(name) {
  // Compatibility tools remain callable by an explicit host manifest or lease,
  // but the model-facing catalog prefers canonical tools. Internal specialist
  // tools are searchable: discovery exposes a schema, never execution authority.
  return !LEGACY_PROVIDER.has(name);
}

export function isToolSurfaceEligible(name, hasWorkflowLease) {
  // External and MCP capabilities remain catalog-searchable, but enter the
  // provider action surface only after an explicit workflow lease.
  return TOOL_SURFACE_ELIGIBLE.has(name) || hasWorkflowLease;
}

export function allowedByManifest(allowedTools, name) {
  return !allowedTools || allowedTools.has(name);
}

export function compactPurpose(definition) {
  const override = definition.providerFacade?.description;
  const purpose = typeof override === 'string' && override.trim() ? override.trim() : definition.purpose;
  const text = typeof purpose === 'string' ? purpose.trim().replace(/\s+/gu, ' ') : `Call ${definition.name}`;
  // Why: conditional contracts often live after the first sentence. Preserve
  // the complete bounded purpose so local models do not have to infer omitted
  // behavior from a tool name.
  return text.length <= 320 ? text : `${text.slice(0, 319)}…`;
}
