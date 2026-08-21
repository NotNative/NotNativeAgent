// SPDX-License-Identifier: Apache-2.0
import {
  CORE_TOOL_NAMES, INTERNAL_NATIVE_TOOL_NAMES, LEGACY_PROVIDER_TOOL_NAMES, PROVIDER_NATIVE_TOOL_NAMES,
} from './core-names.js';

export const ALWAYS_EXPOSED = new Set(CORE_TOOL_NAMES);
export const PROVIDER_NATIVE = new Set(PROVIDER_NATIVE_TOOL_NAMES);

const LEGACY_PROVIDER = new Set(LEGACY_PROVIDER_TOOL_NAMES);
const INTERNAL_NATIVE = new Set(INTERNAL_NATIVE_TOOL_NAMES);
const NATIVE_NAMES = new Set([...PROVIDER_NATIVE, ...LEGACY_PROVIDER, ...INTERNAL_NATIVE]);
export function catalogVisible(name) {
  return PROVIDER_NATIVE.has(name) || !NATIVE_NAMES.has(name);
}

export function providerVisible(name, exposed, activated) {
  return PROVIDER_NATIVE.has(name) || exposed || activated || !NATIVE_NAMES.has(name);
}

export function allowedByManifest(allowedTools, name) {
  return !allowedTools || allowedTools.has(name);
}
