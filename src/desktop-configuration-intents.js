// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { CONFIGURATION_CATALOG } from './configuration-catalog.js';
import { applyIntentChanges } from './experience/configuration-intents.js';

const TYPES = new Set(['integer', 'number', 'string', 'boolean', 'enum', 'array']);
export const DESKTOP_ROUTE_BINDING_ROLES = Object.freeze(['reviewer', 'vision']);
export const DESKTOP_ROUTE_BINDING_FIELDS = Object.freeze(DESKTOP_ROUTE_BINDING_ROLES.flatMap((role) =>
  [`routes.${role}.provider_id`, `routes.${role}.model`]));
const MEMORY_PAIR = Object.freeze(['memory.enabled', 'memory.required']);
// routes.primary.deadline_ms has one meaning: the global provider timeout that
// withRouteDeadline persists as provider_timeout_ms with the alias key cleared.
export const PRIMARY_DEADLINE_PATHS = Object.freeze(['provider_timeout_ms', 'routes.primary.deadline_ms']);
const FIELDS = new Map(CONFIGURATION_CATALOG.fields.filter((field) => field.editability.generic_editable
  && TYPES.has(field.type) && field.path !== 'workspace_root' && field.sensitivity !== 'credential_reference'
  && !/^(?:provider\.|providers\[|mcp_servers\[)/u.test(field.path) && !/[\[\]{}]/u.test(field.path))
  .map((field) => [field.path, field]));

export const DESKTOP_CONFIGURATION_EDITABLE_FIELDS = Object.freeze([...FIELDS.keys()]);

export function normalizeDesktopConfigurationOperations(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 32) throw invalid();
  const seen = new Set();
  return input.map((operation) => {
    if (record(operation) && operation.op === 'bind_route') {
      if (Object.keys(operation).sort().join(',') !== 'model,op,provider_id,role'
        || !DESKTOP_ROUTE_BINDING_ROLES.includes(operation.role)
        || typeof operation.provider_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(operation.provider_id)
        || ['__proto__', 'constructor', 'prototype'].includes(operation.provider_id)
        || typeof operation.model !== 'string' || !operation.model.trim()
        || operation.model.length > 256 || /[\u0000-\u001f\u007f]/u.test(operation.model)
        || seen.has(`route:${operation.role}`)) throw invalid();
      seen.add(`route:${operation.role}`);
      return Object.freeze({ op: 'bind_route', role: operation.role,
        provider_id: operation.provider_id, model: operation.model });
    }
    if (!record(operation) || !['set', 'reset'].includes(operation.op)
      || Object.keys(operation).some((key) => !['op', 'field', 'value'].includes(key))) throw invalid();
    // Why: routes.primary.deadline_ms is a compatibility alias for the global
    // provider_timeout_ms, never a separate persisted key. Normalizing the field
    // here keeps one concept = one persisted meaning for every generic entry point,
    // while withRouteDeadline (src/provider/route-configuration.js) stays the pair
    // authority and needs no duplicated check here.
    // Compatibility: both advertised paths stay admitted, so the settings catalog
    // advertisement does not change; typed value and bound checks run on the
    // canonical pair descriptor.
    const path = operation.field === PRIMARY_DEADLINE_PATHS[1] && FIELDS.has(PRIMARY_DEADLINE_PATHS[1])
      ? PRIMARY_DEADLINE_PATHS[0] : operation.field;
    const descriptor = FIELDS.get(path);
    if (!descriptor || seen.has(path)
      || (MEMORY_PAIR.includes(path) && MEMORY_PAIR.some((field) => seen.has(field)))) throw invalid();
    seen.add(path);
    if (operation.op === 'reset') {
      if (Object.hasOwn(operation, 'value')) throw invalid();
      return Object.freeze({ op: 'reset', field: path });
    }
    if (!Object.hasOwn(operation, 'value') || !typedValue(descriptor, operation.value)) throw invalid();
    return Object.freeze({ op: 'set', field: path, value: structuredClone(operation.value) });
  });
}

export function applyDesktopConfigurationOperations(manifest, operations) {
  return applyIntentChanges(manifest, operations.flatMap((operation) => {
    if (operation.op === 'bind_route') return [
      { path: `routes.${operation.role}.provider_id`, value: operation.provider_id },
      { path: `routes.${operation.role}.model`, value: operation.model },
    ];
    const { op, field, value } = operation;
    // Why: the normalized pair member (or a stale alias-shaped operation) must
    // reproduce withRouteDeadline semantics on the raw document: one value stored
    // under provider_timeout_ms, the routes.primary.deadline_ms alias cleared.
    // This mirrors the canonical write from the second entry point, so both entry
    // points end in identical persisted state.
    if (field === PRIMARY_DEADLINE_PATHS[0] || field === PRIMARY_DEADLINE_PATHS[1]) {
      const changes = [{ path: PRIMARY_DEADLINE_PATHS[0], value: op === 'reset' ? undefined : value }];
      // Clear the alias only when its parent object exists; the set() helper would
      // otherwise create an empty routes.primary container that the canonical write
      // never produces.
      if (record(manifest.routes) && record(manifest.routes.primary)) {
        changes.push({ path: PRIMARY_DEADLINE_PATHS[1], value: undefined });
      }
      return changes;
    }
    const changes = [{ path: field, value: op === 'reset' ? undefined : value }];
    if (op === 'set' && field === 'memory.enabled' && value === false) {
      changes.push({ path: 'memory.required', value: false });
    } else if (op === 'set' && field === 'memory.required' && value === true) {
      changes.push({ path: 'memory.enabled', value: true });
    }
    return changes;
  }));
}

export function desktopConfigurationOperationPaths(operation) {
  if (operation.op === 'bind_route') return [`routes.${operation.role}.provider_id`, `routes.${operation.role}.model`];
  if (operation.op === 'set' && operation.field === 'memory.enabled' && operation.value === false) return MEMORY_PAIR;
  if (operation.op === 'set' && operation.field === 'memory.required' && operation.value === true) return MEMORY_PAIR;
  // A provider-deadline write touches the pair: the canonical key it persists and
  // the alias key it clears, so both go through the project-shadow check.
  if (operation.field === PRIMARY_DEADLINE_PATHS[0] || operation.field === PRIMARY_DEADLINE_PATHS[1]) return PRIMARY_DEADLINE_PATHS;
  return [operation.field];
}

function typedValue(field, value) {
  if (value === null) return field.unset?.null === 'unset'
    || (field.default?.kind === 'literal' && field.default.value === null);
  if (field.type === 'integer') return Number.isInteger(value);
  if (field.type === 'number') return Number.isFinite(value);
  if (field.type === 'boolean') return typeof value === 'boolean';
  if (field.type === 'enum') return typeof value === 'string' && field.enum.includes(value);
  if (field.type === 'string') return typeof value === 'string' && Buffer.byteLength(value) <= 65536;
  if (field.type === 'array') return Array.isArray(value) && value.length <= 64
    && value.every((item) => typeof item === 'string' && item.length <= 256);
  return false;
}
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function invalid() { return new ContractError('desktop_configuration_request_invalid', 'Configuration requires bounded typed operations on supported fields.'); }
