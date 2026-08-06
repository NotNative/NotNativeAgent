// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { redactExtensionData, redactText } from './redaction.js';

const SENSITIVE_KEY = /token|secret|password|credential|authorization|bearer|api.?key/iu;

export function safeToolArguments(args) {
  const result = {};
  for (const [key, value] of Object.entries(args ?? {}).slice(0, 64)) {
    if (SENSITIVE_KEY.test(key)) result[key] = '[redacted]';
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
    result.push(redactNext ? '[redacted]' : redactText(text).slice(0, 4096));
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
  if (typeof value === 'string') return redactText(value).slice(0, 4096);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : '[nonfinite]';
  const serialized = JSON.stringify(redactExtensionData(value));
  return serialized.length <= 4096 ? serialized : `${serialized.slice(0, 4096)}…`;
}
