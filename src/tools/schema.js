// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

// Why: several OpenAI-compatible local hosts reject these otherwise valid JSON Schema keywords.
// Runtime validation remains authoritative, and documented projection restates each bound in the
// provider-visible field description so smaller models do not have to guess the hidden contract.
const PROVIDER_GRAMMAR_CONSTRAINTS = new Set([
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'maxUtf8Bytes', 'pattern', 'minItems', 'maxItems',
]);
const PROVIDER_DOCUMENTATION_FIELDS = new Set([
  'description', 'title', 'examples', 'example', '$comment',
  'deprecated', 'readOnly', 'writeOnly',
]);
const PROVIDER_UNAPPLIED_FIELDS = new Set(['default']);

export function providerSchema(value, options = {}) {
  const mode = options.mode ?? 'compact';
  if (!['compact', 'documented'].includes(mode)) {
    throw new ContractError('invalid_external_schema', 'provider schema projection mode is invalid');
  }
  return projectProviderSchema(value, new WeakSet(), 0, { nodes: 0 }, mode);
}

function projectProviderSchema(value, ancestors, depth, state, mode) {
  if (!value || typeof value !== 'object') return value;
  state.nodes += 1;
  if (depth > 24 || state.nodes > 10_000 || ancestors.has(value)) {
    throw new ContractError('invalid_external_schema', 'external tool schema structure exceeds bound');
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => projectProviderSchema(item, ancestors, depth + 1, state, mode));
    ancestors.delete(value);
    return result;
  }
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (PROVIDER_GRAMMAR_CONSTRAINTS.has(key)) continue;
    // Why: JSON Schema defaults are annotations, but provider models commonly read them as
    // values the runtime will insert. NNA validates supplied values and never applies defaults.
    if (PROVIDER_UNAPPLIED_FIELDS.has(key)) continue;
    if (mode === 'compact' && PROVIDER_DOCUMENTATION_FIELDS.has(key)) continue;
    if (key === 'properties' && child && typeof child === 'object' && !Array.isArray(child)) {
      result[key] = Object.fromEntries(Object.entries(child)
        .map(([name, rule]) => [name, projectProviderSchema(rule, ancestors, depth + 1, state, mode)]));
    } else result[key] = projectProviderSchema(child, ancestors, depth + 1, state, mode);
  }
  if (mode === 'documented') {
    const description = documentedDescription(value);
    if (description) result.description = description;
  }
  ancestors.delete(value);
  return result;
}

function documentedDescription(rule) {
  const original = typeof rule.description === 'string' ? rule.description.trim() : '';
  const constraints = providerConstraintSummary(rule);
  if (!constraints) return original;
  return `${original}${original ? ' ' : ''}Constraints: ${constraints}.`;
}

function providerConstraintSummary(rule) {
  const constraints = [];
  const types = Array.isArray(rule.type) ? rule.type : [rule.type];
  if (types.includes('string')) {
    constraints.push(boundedRange(rule.minLength, rule.maxLength, 'characters'));
    if (Number.isSafeInteger(rule.maxUtf8Bytes)) {
      constraints.push(`UTF-8 encoding at most ${formattedNumber(rule.maxUtf8Bytes)} bytes`);
    }
    if (typeof rule.pattern === 'string') constraints.push(`must match ${JSON.stringify(bounded(rule.pattern, 160))}`);
  }
  if (types.includes('integer') || types.includes('number')) {
    constraints.push(boundedRange(rule.minimum, rule.maximum, 'numeric value'));
  }
  if (types.includes('array')) constraints.push(boundedRange(rule.minItems, rule.maxItems, 'items'));
  return constraints.filter(Boolean).join('; ');
}

function boundedRange(minimum, maximum, noun) {
  const hasMinimum = Number.isFinite(minimum);
  const hasMaximum = Number.isFinite(maximum);
  if (hasMinimum && hasMaximum) return `${formattedNumber(minimum)}-${formattedNumber(maximum)} ${noun}`;
  if (hasMinimum) return `at least ${formattedNumber(minimum)} ${noun}`;
  if (hasMaximum) return `at most ${formattedNumber(maximum)} ${noun}`;
  return '';
}

function formattedNumber(value) { return Number(value).toLocaleString('en-US', { useGrouping: true }); }

export function schemaValidator(schema) {
  const prepared = prepareObjectSchema(schema);
  return async (args) => {
    const normalized = normalizeArguments(args, schema);
    validateArguments(normalized, schema, prepared);
    return { args: normalized, resolved: { source: 'external' } };
  };
}

export function schemaShapeValidator(schema) {
  const prepared = prepareObjectSchema(schema);
  return async (args) => {
    const normalized = normalizeArguments(args, schema);
    validateArguments(normalized, schema, prepared);
    return normalized;
  };
}

function normalizeArguments(args, schema) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  validateInputStructure(args);
  return normalizeValue(structuredClone(args), schema, new WeakSet());
}

function normalizeValue(value, rule, visited) {
  const types = Array.isArray(rule?.type) ? rule.type : [rule?.type];
  if (typeof value === 'string' && types.includes('integer') && !types.includes('string')) return integerFromString(value);
  if (typeof value === 'string' && types.includes('boolean') && !types.includes('string')) return booleanFromString(value);
  if (!value || typeof value !== 'object' || visited.has(value)) return value;
  visited.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = normalizeValue(value[index], rule?.items, visited);
    }
  } else {
    for (const key of Object.keys(value)) {
      value[key] = normalizeValue(value[key], rule?.properties?.[key], visited);
    }
  }
  return value;
}

function integerFromString(value) {
  const candidate = value.trim();
  if (!/^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(candidate)) return value;
  const parsed = Number(candidate);
  return Number.isSafeInteger(parsed) ? parsed : value;
}

function booleanFromString(value) {
  const candidate = value.trim().toLowerCase();
  if (candidate === 'true') return true;
  if (candidate === 'false') return false;
  return value;
}

function prepareObjectSchema(schema) {
  if (!schema || schema.type !== 'object' || (schema.properties && typeof schema.properties !== 'object')) {
    throw new ContractError('invalid_external_schema', 'tool input schema must describe an object');
  }
  validateSchema(schema);
  return { required: Array.isArray(schema.required) ? schema.required : [], properties: schema.properties ?? {} };
}

function validateArguments(args, schema, prepared) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new ContractError('tool_schema_invalid', `tool arguments must be an object; received ${valueType(args)}`);
  }
  validateInputStructure(args);
  const missing = prepared.required.find((key) => !Object.hasOwn(args, key));
  if (missing) throw schemaFailure(`required argument "${missing}" is missing`, {
    field: missing, issue: 'required_field_missing', correction: 'add_required_field',
  });
  if (schema.additionalProperties === false) {
    const unknown = Object.keys(args).find((key) => !Object.hasOwn(prepared.properties, key));
    if (unknown) throw unknownArgument(unknown, prepared.properties);
  }
  for (const [key, value] of Object.entries(args)) validateValue(value, prepared.properties[key], 0, `argument "${key}"`);
}

function validateValue(value, rule, depth, path) {
  if (depth > 12) throw new ContractError('tool_schema_invalid', `${path} nesting exceeds 12 levels`);
  if (!rule?.type) return;
  const types = Array.isArray(rule.type) ? rule.type : [rule.type];
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (!types.includes(actual) && !(actual === 'number' && types.includes('integer') && Number.isInteger(value))) {
    throw schemaFailure(`${path} must be ${describeTypes(types)}; received ${actual}`, {
      field: path, issue: 'type_mismatch', expected: types.join('|'), correction: 'replace_field_value',
    });
  }
  if (Array.isArray(rule.enum) && !rule.enum.some((item) => Object.is(item, value))) {
    throw schemaFailure(`${path} must be one of ${rule.enum.map((item) => JSON.stringify(item)).join(', ')}; received ${receivedValue(value, path)}`, {
      field: path, issue: 'value_not_allowed', allowed_values: rule.enum.join('|'), correction: 'replace_field_value',
    });
  }
  if (typeof value === 'string') validateString(value, rule, path);
  if (typeof value === 'number') validateNumber(value, rule, path);
  if (Array.isArray(value)) validateArray(value, rule, depth, path);
  else if (value && typeof value === 'object') validateObject(value, rule, depth, path);
}

function validateString(value, rule, path) {
  const length = characterLength(value);
  if (Number.isSafeInteger(rule.minLength) && length < rule.minLength) {
    throw new ContractError('tool_schema_invalid', `${path} must contain at least ${rule.minLength} characters; received ${length}`);
  }
  const maximum = rule.maxLength ?? 131_072;
  if (length > maximum) {
    throw new ContractError('tool_schema_invalid', `${path} must contain at most ${maximum} characters; received ${length}`);
  }
  if (Number.isSafeInteger(rule.maxUtf8Bytes)) {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > rule.maxUtf8Bytes) {
      throw new ContractError('tool_schema_invalid', `${path} UTF-8 encoding must be at most ${rule.maxUtf8Bytes} bytes; received ${bytes}`);
    }
  }
  if (typeof rule.pattern === 'string' && !(new RegExp(rule.pattern, 'u')).test(value)) {
    throw new ContractError(
      'tool_schema_invalid',
      `${path} must match ${acceptedFormat(rule)}; received ${receivedValue(value, path)}`,
    );
  }
}

function validateNumber(value, rule, path) {
  if (Number.isFinite(rule.minimum) && value < rule.minimum) throw new ContractError('tool_schema_invalid', `${path} must be at least ${rule.minimum}; received ${value}`);
  if (Number.isFinite(rule.maximum) && value > rule.maximum) throw new ContractError('tool_schema_invalid', `${path} must be at most ${rule.maximum}; received ${value}`);
}

function validateArray(value, rule, depth, path) {
  if (Number.isSafeInteger(rule.minItems) && value.length < rule.minItems) {
    throw new ContractError('tool_schema_invalid', `${path} must contain at least ${rule.minItems} items; received ${value.length}`);
  }
  const maximum = rule.maxItems ?? 4096;
  if (value.length > maximum) {
    throw new ContractError('tool_schema_invalid', `${path} must contain at most ${maximum} items; received ${value.length}`);
  }
  value.forEach((item, index) => validateValue(item, rule.items, depth + 1, `${path}[${index}]`));
}

function validateObject(value, rule, depth, path) {
  const required = Array.isArray(rule.required) ? rule.required : [];
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing) throw schemaFailure(`${path} is missing required property "${missing}"`, {
    field: `${path}.${missing}`, issue: 'required_field_missing', correction: 'add_required_field',
  });
  const unknown = rule.additionalProperties === false
    ? Object.keys(value).find((key) => !Object.hasOwn(rule.properties ?? {}, key)) : null;
  if (unknown) {
    const allowed = Object.keys(rule.properties ?? {});
    throw schemaFailure(
      `${path} contains unknown property "${unknown}"; allowed properties: ${allowed.length > 0 ? allowed.join(', ') : 'none'}`,
      { field: `${path}.${unknown}`, issue: 'unknown_field', allowed_fields: allowed.join('|'), correction: 'remove_unknown_field' },
    );
  }
  for (const [key, item] of Object.entries(value)) validateValue(item, rule.properties?.[key], depth + 1, `${path}.${key}`);
}

function describeTypes(types) {
  return types.map((type) => type === 'integer' ? 'an integer' : type === 'array' ? 'an array' : type === 'object' ? 'an object' : type === 'string' ? 'a string' : type).join(' or ');
}

function acceptedFormat(rule) {
  const description = typeof rule.description === 'string' ? rule.description.trim().replace(/\s+/gu, ' ') : '';
  if (description) return `this format (${bounded(description, 240)})`;
  return `pattern ${JSON.stringify(bounded(rule.pattern, 160))}`;
}

function receivedValue(value, path) {
  if (typeof value === 'string') {
    const length = characterLength(value);
    if (/(?:secret|token|password|credential|authorization|api[_ -]?key)/iu.test(path)) {
      return `[redacted string; ${length} characters]`;
    }
    return `${JSON.stringify(bounded(value, 160))}${length > 160 ? ` (${length} characters)` : ''}`;
  }
  const encoded = JSON.stringify(value);
  return typeof encoded === 'string' ? bounded(encoded, 160) : valueType(value);
}

function unknownArgument(name, properties = {}) {
  const allowed = Object.keys(properties ?? {});
  return schemaFailure(
    `unknown argument "${name}"; allowed arguments: ${allowed.length > 0 ? allowed.join(', ') : 'none'}`,
    { field: name, issue: 'unknown_field', allowed_fields: allowed.join('|'), correction: 'remove_unknown_field' },
  );
}

function schemaFailure(message, repair) {
  const error = new ContractError('tool_schema_invalid', message);
  error.toolMetadata = Object.freeze(repair);
  return error;
}

function bounded(value, maximum) {
  const characters = [...value];
  return characters.length <= maximum ? value : `${characters.slice(0, maximum - 1).join('')}…`;
}

function characterLength(value) { return [...value].length; }

function valueType(value) {
  return value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value;
}

function validateInputStructure(input) {
  const stack = [{ value: input, depth: 0 }];
  const visited = new WeakSet();
  let nodes = 0;
  while (stack.length > 0) {
    const { value, depth } = stack.pop();
    if (!value || typeof value !== 'object' || visited.has(value)) continue;
    visited.add(value); nodes += 1;
    if (depth > 12 || nodes > 10_000) {
      throw new ContractError('tool_schema_invalid', 'tool argument structure exceeds its nesting or node bound');
    }
    for (const child of Object.values(value)) stack.push({ value: child, depth: depth + 1 });
  }
}

function validateSchema(schema) {
  let encoded;
  try { encoded = JSON.stringify(schema); } catch {
    throw new ContractError('invalid_external_schema', 'external tool schema is not serializable');
  }
  if (Buffer.byteLength(encoded) > 131_072) {
    throw new ContractError('invalid_external_schema', 'external tool schema exceeds bound');
  }
  const stack = [{ value: schema, depth: 0 }];
  const visited = new WeakSet();
  let nodes = 0;
  while (stack.length > 0) {
    const { value, depth } = stack.pop();
    if (value && typeof value === 'object' && visited.has(value)) continue;
    if (value && typeof value === 'object') visited.add(value);
    nodes += 1;
    if (nodes > 10_000 || depth > 24) throw new ContractError('invalid_external_schema', 'external schema structure exceeds bound');
    if (value && typeof value === 'object') {
      if (typeof value.pattern === 'string') {
        try { new RegExp(value.pattern, 'u'); } catch {
          throw new ContractError('invalid_external_schema', 'external tool schema contains an invalid pattern');
        }
      }
      for (const child of Object.values(value)) stack.push({ value: child, depth: depth + 1 });
    }
  }
}
