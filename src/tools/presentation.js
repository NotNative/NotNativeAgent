// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { redactExtensionData, redactText } from '../redaction.js';

const SENSITIVE_KEY_PARTS = new Set(['token', 'secret', 'password', 'credential', 'authorization', 'bearer']);
const MAX_PRESENTED_VALUE_LENGTH = 4096;

export function safeToolArguments(args) {
  const result = {};
  for (const [key, value] of Object.entries(args ?? {}).slice(0, 64)) {
    if (isSensitiveKey(key)) result[key] = '[redacted]';
    else if (key === 'content') result.content = contentIdentity(value);
    else if (key === 'args' && Array.isArray(value)) result.args = Object.freeze(safeArgv(value));
    else result[key] = boundedValue(value);
  }
  return Object.freeze(result);
}

function safeArgv(values) {
  const result = [];
  let redactNext = false;
  for (const value of values.slice(0, 64)) {
    const text = String(value);
    // Process arguments commonly encode a secret as a flag followed by its value.
    result.push(redactNext ? '[redacted]' : redactText(text).slice(0, MAX_PRESENTED_VALUE_LENGTH));
    redactNext = /^(?:--?(?:api[_-]?key|authorization|credential|password|secret|token))$/iu.test(text);
  }
  return result;
}

function contentIdentity(value) {
  const text = String(value);
  return Object.freeze({
    bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex'),
  });
}

function boundedValue(value) {
  if (typeof value === 'string') return redactText(value).slice(0, MAX_PRESENTED_VALUE_LENGTH);
  if (value === undefined) return '[undefined]';
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : '[nonfinite]';
  const serialized = safeSerialize(redactExtensionData(value));
  return serialized.length <= MAX_PRESENTED_VALUE_LENGTH
    ? serialized : `${serialized.slice(0, MAX_PRESENTED_VALUE_LENGTH)}…`;
}

function isSensitiveKey(key) {
  const words = String(key).replace(/([a-z\d])([A-Z])/gu, '$1 $2').toLowerCase().split(/[^a-z\d]+/u).filter(Boolean);
  return words.some((word) => SENSITIVE_KEY_PARTS.has(word))
    || words.some((word, index) => word === 'api' && words[index + 1] === 'key')
    || words.includes('apikey');
}

function safeSerialize(value) {
  try {
    const serialized = JSON.stringify(value, (_key, child) => typeof child === 'bigint' ? String(child) : child);
    return serialized ?? `[${typeof value}]`;
  } catch {
    return '[unserializable]';
  }
}
