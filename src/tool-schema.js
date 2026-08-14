// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

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
    for (const [key, value] of Object.entries(args)) validateValue(value, schema.properties?.[key], 0);
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
  };
}

function validateValue(value, rule, depth) {
  if (!rule?.type) return;
  if (depth > 12) throw new ContractError('tool_schema_invalid', 'tool argument nesting exceeds bound');
  const types = Array.isArray(rule.type) ? rule.type : [rule.type];
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (!types.includes(actual) && !(actual === 'number' && types.includes('integer') && Number.isInteger(value))) {
    throw new ContractError('tool_schema_invalid', 'tool argument type does not match schema');
  }
  if (Array.isArray(rule.enum) && !rule.enum.some((item) => Object.is(item, value))) {
    throw new ContractError('tool_schema_invalid', 'tool argument is not an allowed value');
  }
  if (typeof value === 'string') validateString(value, rule);
  if (typeof value === 'number') validateNumber(value, rule);
  if (Array.isArray(value)) validateArray(value, rule, depth);
  else if (value && typeof value === 'object') validateObject(value, rule, depth);
}

function validateString(value, rule) {
  if (value.length < (rule.minLength ?? 0) || value.length > (rule.maxLength ?? 131_072)) {
    throw new ContractError('tool_schema_invalid', 'tool string argument exceeds bound');
  }
  if (typeof rule.pattern === 'string' && !(new RegExp(rule.pattern, 'u')).test(value)) {
    throw new ContractError('tool_schema_invalid', 'tool string argument does not match its required pattern');
  }
}

function validateNumber(value, rule) {
  if ((Number.isFinite(rule.minimum) && value < rule.minimum)
    || (Number.isFinite(rule.maximum) && value > rule.maximum)) {
    throw new ContractError('tool_schema_invalid', 'tool numeric argument exceeds bound');
  }
}

function validateArray(value, rule, depth) {
  if (value.length < (rule.minItems ?? 0) || value.length > (rule.maxItems ?? 4096)) {
    throw new ContractError('tool_schema_invalid', 'tool array exceeds bound');
  }
  for (const item of value) validateValue(item, rule.items, depth + 1);
}

function validateObject(value, rule, depth) {
  const required = Array.isArray(rule.required) ? rule.required : [];
  if (required.some((key) => !Object.hasOwn(value, key))) {
    throw new ContractError('tool_schema_invalid', 'nested required property is missing');
  }
  if (rule.additionalProperties === false
    && Object.keys(value).some((key) => !Object.hasOwn(rule.properties ?? {}, key))) {
    throw new ContractError('tool_schema_invalid', 'nested tool argument contains an unknown property');
  }
  for (const [key, item] of Object.entries(value)) validateValue(item, rule.properties?.[key], depth + 1);
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
