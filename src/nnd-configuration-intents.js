// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { CONFIGURATION_CATALOG } from './configuration-catalog.js';
import { applyIntentChanges } from './experience/configuration-intents.js';

const TYPES = new Set(['integer', 'number', 'string', 'boolean', 'enum', 'array']);
const FIELDS = new Map(CONFIGURATION_CATALOG.fields.filter((field) => field.editability.generic_editable
  && TYPES.has(field.type) && field.path !== 'workspace_root' && field.sensitivity !== 'credential_reference'
  && !/^(?:provider\.|providers\[|mcp_servers\[)/u.test(field.path) && !/[\[\]{}]/u.test(field.path))
  .map((field) => [field.path, field]));

export const NND_CONFIGURATION_EDITABLE_FIELDS = Object.freeze([...FIELDS.keys()]);

export function normalizeNndConfigurationOperations(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 32) throw invalid();
  const seen = new Set();
  return input.map((operation) => {
    if (!record(operation) || !['set', 'reset'].includes(operation.op)
      || Object.keys(operation).some((key) => !['op', 'field', 'value'].includes(key))) throw invalid();
    const descriptor = FIELDS.get(operation.field);
    if (!descriptor || seen.has(operation.field)) throw invalid();
    seen.add(operation.field);
    if (operation.op === 'reset') {
      if (Object.hasOwn(operation, 'value')) throw invalid();
      return Object.freeze({ op: 'reset', field: operation.field });
    }
    if (!Object.hasOwn(operation, 'value') || !typedValue(descriptor, operation.value)) throw invalid();
    return Object.freeze({ op: 'set', field: operation.field, value: structuredClone(operation.value) });
  });
}

export function applyNndConfigurationOperations(manifest, operations) {
  return applyIntentChanges(manifest, operations.map(({ op, field, value }) => ({ path: field, value: op === 'reset' ? undefined : value })));
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
function invalid() { return new ContractError('nnd_configuration_request_invalid', 'Configuration requires bounded typed operations on supported fields.'); }
