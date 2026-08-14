// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

const PROVIDER_GRAMMAR_CONSTRAINTS = new Set([
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems',
]);

export function providerSchema(value) {
  if (Array.isArray(value)) return value.map(providerSchema);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (PROVIDER_GRAMMAR_CONSTRAINTS.has(key)) continue;
    if (key === 'properties' && child && typeof child === 'object' && !Array.isArray(child)) {
      result[key] = Object.fromEntries(Object.entries(child).map(([name, rule]) => [name, providerSchema(rule)]));
    } else result[key] = providerSchema(child);
  }
  return result;
}

export function schemaValidator(schema) {
  if (!schema || schema.type !== 'object' || (schema.properties && typeof schema.properties !== 'object')) {
    throw new ContractError('invalid_external_schema', 'external tool input schema must describe an object');
  }
  validateSchema(schema);
  return async (args) => {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new ContractError('tool_schema_invalid', 'tool arguments must be an object');
    }
    const required = Array.isArray(schema.required) ? schema.required : [];
    const missing = required.find((key) => !Object.hasOwn(args, key));
    if (missing) throw new ContractError('tool_schema_invalid', `required argument "${missing}" is missing`);
    if (schema.additionalProperties === false) {
      const unknown = Object.keys(args).find((key) => !Object.hasOwn(schema.properties ?? {}, key));
      if (unknown) throw new ContractError('tool_schema_invalid', `unknown argument "${unknown}"`);
    }
    for (const [key, value] of Object.entries(args)) validateValue(value, schema.properties?.[key], 0, `argument "${key}"`);
    return { args: structuredClone(args), resolved: { source: 'external' } };
  };
}

export function schemaShapeValidator(schema) {
  if (!schema || schema.type !== 'object' || (schema.properties && typeof schema.properties !== 'object')) {
    throw new ContractError('invalid_external_schema', 'tool input schema must describe an object');
  }
  const required = Array.isArray(schema.required) ? schema.required : [];
  const properties = schema.properties ?? {};
  return async (args) => {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new ContractError('tool_schema_invalid', 'tool arguments must be an object');
    }
    const missing = required.find((key) => !Object.hasOwn(args, key));
    if (missing) throw new ContractError('tool_schema_invalid', `required argument "${missing}" is missing`);
    if (schema.additionalProperties === false) {
      const unknown = Object.keys(args).find((key) => !Object.hasOwn(properties, key));
      if (unknown) throw new ContractError('tool_schema_invalid', `unknown argument "${unknown}"`);
    }
    for (const [key, value] of Object.entries(args)) validateValue(value, properties[key], 0, `argument "${key}"`);
  };
}

function validateValue(value, rule, depth, path) {
  if (!rule?.type) return;
  if (depth > 12) throw new ContractError('tool_schema_invalid', `${path} nesting exceeds 12 levels`);
  const types = Array.isArray(rule.type) ? rule.type : [rule.type];
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (!types.includes(actual) && !(actual === 'number' && types.includes('integer') && Number.isInteger(value))) {
    throw new ContractError('tool_schema_invalid', `${path} must be ${describeTypes(types)}; received ${actual}`);
  }
  if (Array.isArray(rule.enum) && !rule.enum.some((item) => Object.is(item, value))) {
    throw new ContractError('tool_schema_invalid', `${path} must be one of ${rule.enum.map((item) => JSON.stringify(item)).join(', ')}; received ${JSON.stringify(value)}`);
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
    throw new ContractError('tool_schema_invalid', `${path} does not match the required format`);
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
  if (unknown) throw new ContractError('tool_schema_invalid', `${path} contains unknown property "${unknown}"`);
  for (const [key, item] of Object.entries(value)) validateValue(item, rule.properties?.[key], depth + 1, `${path}.${key}`);
}

function describeTypes(types) {
  return types.map((type) => type === 'integer' ? 'an integer' : type === 'array' ? 'an array' : type === 'object' ? 'an object' : type === 'string' ? 'a string' : type).join(' or ');
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
  let nodes = 0;
  while (stack.length > 0) {
    const { value, depth } = stack.pop();
    nodes += 1;
    if (nodes > 10_000 || depth > 24) throw new ContractError('invalid_external_schema', 'external schema structure exceeds bound');
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) stack.push({ value: child, depth: depth + 1 });
    }
  }
}
