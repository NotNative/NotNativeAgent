// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { CORE_TOOL_NAMES } from './core-names.js';

export const PROVIDER_SURFACE_PHASES = Object.freeze(['orientation', 'action', 'recovery', 'monitoring']);

const FOUNDATIONAL_BASELINE = Object.freeze([...CORE_TOOL_NAMES]);
const LIMITS = Object.freeze({
  orientation: Object.freeze({ count: 32, bytes: 64 * 1024 }),
  action: Object.freeze({ count: 32, bytes: 64 * 1024 }),
  recovery: Object.freeze({ count: 32, bytes: 64 * 1024 }),
  monitoring: Object.freeze({ count: 32, bytes: 64 * 1024 }),
});

export function providerSurfacePhase(value) {
  const phase = value ?? 'orientation';
  if (!PROVIDER_SURFACE_PHASES.includes(phase)) {
    throw new ContractError('provider_surface_phase_invalid', 'provider tool-surface phase is invalid');
  }
  return phase;
}

export function planProviderToolNames({
  availableNames = [], exposedNames = [], allowedNames = null,
  phase = 'orientation', encodedDefinition,
}) {
  phase = providerSurfacePhase(phase);
  const available = new Set(availableNames);
  if (allowedNames) {
    const names = availableNames.filter((name) => allowedNames.has(name));
    return finalize(names, [], phase, names.map((name) => [name, 'host_manifest']), encodedDefinition, null);
  }
  const reasons = new Map();
  const protectedNames = new Set();
  const ordered = [];
  const add = (name, reason, protect = false) => {
    if (!available.has(name) || reasons.has(name)) return;
    reasons.set(name, reason); ordered.push(name);
    if (protect) protectedNames.add(name);
  };
  for (const name of FOUNDATIONAL_BASELINE) add(name, 'foundational', true);
  for (const name of exposedNames) add(name, 'workflow_lease');
  const limits = LIMITS[phase];
  const selected = [];
  const omitted = [];
  let bytes = 0;
  for (const name of ordered) {
    const definitionBytes = encodedDefinition(name);
    const protectedEntry = protectedNames.has(name);
    if (!protectedEntry && (selected.length >= limits.count || bytes + definitionBytes > limits.bytes)) {
      omitted.push(name); continue;
    }
    selected.push(name); bytes += definitionBytes;
  }
  return finalize(selected, omitted, phase, [...reasons], encodedDefinition, limits);
}

function finalize(names, omitted, phase, reasons, encodedDefinition, limits) {
  const reasonMap = new Map(reasons);
  const bytes = names.reduce((total, name) => total + encodedDefinition(name), 0);
  return Object.freeze({
    phase, names: Object.freeze(names), omitted: Object.freeze(omitted),
    schemaBytes: bytes, limits,
    reasons: Object.freeze(Object.fromEntries(names.map((name) => [name, reasonMap.get(name)]))),
  });
}
