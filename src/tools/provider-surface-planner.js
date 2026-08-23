// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

export const PROVIDER_SURFACE_PHASES = Object.freeze(['conversation', 'orientation', 'action', 'recovery', 'monitoring']);

const ORIENTATION_BASELINE = Object.freeze([
  'fs.list', 'fs.read', 'fs.search_text',
]);
const ACTION_BASELINE = Object.freeze(['tool.search', 'fs.list', 'fs.read']);
const RECOVERY_BASELINE = Object.freeze(['tool.search', 'fs.list', 'fs.read']);
const DEFERRED_UNTIL_GROUNDED = new Set([
  'web.fetch', 'web.browse',
  'fs.directory', 'fs.write_text', 'fs.edit_text',
  'fs.create_directory', 'fs.edit_lines', 'fs.copy_file', 'fs.move_file', 'fs.delete_file',
]);
const LIMITS = Object.freeze({
  conversation: Object.freeze({ count: 0, bytes: 0 }),
  // Two task-specific tools may accompany the five-tool observation baseline.
  // Web applications commonly need both shell execution and browser verification
  // on the opening step; forcing either through discovery obscures the outcome.
  orientation: Object.freeze({ count: 7, bytes: 6 * 1024 }),
  action: Object.freeze({ count: 10, bytes: 8 * 1024 }),
  recovery: Object.freeze({ count: 6, bytes: 4 * 1024 }),
  monitoring: Object.freeze({ count: 6, bytes: 4 * 1024 }),
});
const WEB_FOCUSED_NAMES = new Set(['web.search', 'web.fetch', 'web.browse']);

export function providerSurfacePhase(value) {
  const phase = value ?? 'orientation';
  if (!PROVIDER_SURFACE_PHASES.includes(phase)) {
    throw new ContractError('provider_surface_phase_invalid', 'provider tool-surface phase is invalid');
  }
  return phase;
}

export function planProviderToolNames({
  availableNames = [], activatedNames = [], relevantNames = [], exposedNames = [], directNames = [], allowedNames = null,
  phase = 'orientation', encodedDefinition,
}) {
  phase = providerSurfacePhase(phase);
  const available = new Set(availableNames);
  if (phase === 'conversation') {
    return finalize([], availableNames, phase, [], encodedDefinition, LIMITS.conversation);
  }
  const activated = [...activatedNames];
  const direct = new Set(directNames);
  const webFocused = activated.includes('web.search')
    && !activated.some((name) => name.startsWith('fs.') || ['shell.run', 'process.run'].includes(name));
  if (allowedNames) {
    const names = availableNames.filter((name) => allowedNames.has(name));
    return finalize(names, [], phase, names.map((name) => [name, 'host_manifest']), encodedDefinition, null);
  }
  const reasons = new Map();
  const protectedNames = new Set();
  const ordered = [];
  const add = (name, reason, protect = false) => {
    if (webFocused && !WEB_FOCUSED_NAMES.has(name)) return;
    if (!available.has(name) || reasons.has(name)) return;
    reasons.set(name, reason); ordered.push(name);
    if (protect) protectedNames.add(name);
  };
  const baseline = webFocused ? (phase === 'orientation' ? ['web.search', 'web.browse'] : [...WEB_FOCUSED_NAMES])
    : phase === 'orientation' ? ORIENTATION_BASELINE
      : phase === 'action' ? ACTION_BASELINE : phase === 'conversation' ? [] : RECOVERY_BASELINE;
  for (const name of baseline) add(name, 'phase_baseline', true);
  if (phase === 'orientation' && !webFocused && activated.length === 0) {
    add('tool.search', 'capability_discovery', true);
  }
  if (phase !== 'conversation') {
    for (const name of exposedNames) add(name, 'explicit_exposure', true);
    for (const name of activatedNames) {
      if (phase !== 'orientation' || !DEFERRED_UNTIL_GROUNDED.has(name) || direct.has(name)) {
        add(name, 'task_intent');
      }
    }
    if (phase !== 'recovery') for (const name of relevantNames) {
      if (phase !== 'orientation' || !DEFERRED_UNTIL_GROUNDED.has(name)) add(name, 'semantic_relevance');
    }
  }
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
