// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

const PROVIDER_GRAMMAR_CONSTRAINTS = new Set([
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems',
]);

export function providerSchema(value) {
  return projectProviderSchema(value, new WeakSet(), 0, { nodes: 0 });
}

function projectProviderSchema(value, ancestors, depth, state) {
  if (!value || typeof value !== 'object') return value;
  state.nodes += 1;
  if (depth > 24 || state.nodes > 10_000 || ancestors.has(value)) {
    throw new ContractError('invalid_external_schema', 'external tool schema structure exceeds bound');
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => projectProviderSchema(item, ancestors, depth + 1, state));
    ancestors.delete(value);
    return result;
  }
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (PROVIDER_GRAMMAR_CONSTRAINTS.has(key)) continue;
    if (key === 'properties' && child && typeof child === 'object' && !Array.isArray(child)) {
      result[key] = Object.fromEntries(Object.entries(child)
        .map(([name, rule]) => [name, projectProviderSchema(rule, ancestors, depth + 1, state)]));
    } else result[key] = projectProviderSchema(child, ancestors, depth + 1, state);
  }
  ancestors.delete(value);
  return result;
}

export function schemaValidator(schema) {
  const prepared = prepareObjectSchema(schema);
  return async (args) => {
    validateArguments(args, schema, prepared);
    return { args: structuredClone(args), resolved: { source: 'external' } };
  };
}

export function schemaShapeValidator(schema) {
  const prepared = prepareObjectSchema(schema);
  return async (args) => {
    validateArguments(args, schema, prepared);
  };
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
  if (missing) throw new ContractError('tool_schema_invalid', `required argument "${missing}" is missing`);
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
    throw new ContractError('tool_schema_invalid', `${path} must be ${describeTypes(types)}; received ${actual}`);
  }
  if (Array.isArray(rule.enum) && !rule.enum.some((item) => Object.is(item, value))) {
    throw new ContractError('tool_schema_invalid', `${path} must be one of ${rule.enum.map((item) => JSON.stringify(item)).join(', ')}; received ${receivedValue(value, path)}`);
  }
  if (typeof value === 'string') validateString(value, rule, path);
  if (typeof value === 'number') validateNumber(value, rule, path);
  if (Array.isArray(value)) validateArray(value, rule, depth, path);
  else if (value && typeof value === 'object') validateObject(value, rule, depth, path);
}

function validateString(value, rule, path) {
  if (Number.isSafeInteger(rule.minLength) && value.length < rule.minLength) {
    throw new ContractError('tool_schema_invalid', `${path} must contain at least ${rule.minLength} characters; received ${value.length}`);
  }
  const maximum = rule.maxLength ?? 131_072;
  if (value.length > maximum) {
    throw new ContractError('tool_schema_invalid', `${path} must contain at most ${maximum} characters; received ${value.length}`);
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
  if (missing) throw new ContractError('tool_schema_invalid', `${path} is missing required property "${missing}"`);
  const unknown = rule.additionalProperties === false
    ? Object.keys(value).find((key) => !Object.hasOwn(rule.properties ?? {}, key)) : null;
  if (unknown) {
    const allowed = Object.keys(rule.properties ?? {});
    throw new ContractError(
      'tool_schema_invalid',
      `${path} contains unknown property "${unknown}"; allowed properties: ${allowed.length > 0 ? allowed.join(', ') : 'none'}`,
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
    if (/(?:secret|token|password|credential|authorization|api[_ -]?key)/iu.test(path)) {
      return `[redacted string; ${value.length} characters]`;
    }
    return `${JSON.stringify(bounded(value, 160))}${value.length > 160 ? ` (${value.length} characters)` : ''}`;
  }
  const encoded = JSON.stringify(value);
  return typeof encoded === 'string' ? bounded(encoded, 160) : valueType(value);
}

function unknownArgument(name, properties = {}) {
  const allowed = Object.keys(properties ?? {});
  return new ContractError(
    'tool_schema_invalid',
    `unknown argument "${name}"; allowed arguments: ${allowed.length > 0 ? allowed.join(', ') : 'none'}`,
  );
}

function bounded(value, maximum) {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

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
