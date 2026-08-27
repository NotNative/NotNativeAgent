// SPDX-License-Identifier: Apache-2.0
import {
  CORE_TOOL_NAMES, LEGACY_PROVIDER_TOOL_NAMES, PROVIDER_NATIVE_TOOL_NAMES,
} from './core-names.js';

export const ALWAYS_EXPOSED = new Set(CORE_TOOL_NAMES);
export const PROVIDER_NATIVE = new Set(PROVIDER_NATIVE_TOOL_NAMES);

const LEGACY_PROVIDER = new Set(LEGACY_PROVIDER_TOOL_NAMES);
export function catalogVisible(name) {
  // Compatibility tools remain callable by an explicit host manifest or lease,
  // but the model-facing catalog prefers canonical tools. Internal specialist
  // tools are searchable: discovery exposes a schema, never execution authority.
  return !LEGACY_PROVIDER.has(name);
}

export function providerVisible(name, exposed) {
  // External and MCP capabilities remain catalog-searchable, but enter the
  // provider action surface only after an explicit workflow lease.
  return PROVIDER_NATIVE.has(name) || exposed;
}

export function allowedByManifest(allowedTools, name) {
  return !allowedTools || allowedTools.has(name);
}
