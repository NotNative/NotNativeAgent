// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

const SENSITIVE_KEY = /(?:api[_-]?key|authorization|bearer|credential|password|private[_-]?key|secret|token)/iu;
const TEXT_PATTERNS = Object.freeze([
  /\bbearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}/giu,
  /\b(api[_-]?key|password|secret|token)\s*([=:])\s*([^\s,;"']+)/giu,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/gu,
]);
const EXACT_VALUES = new Map();
const MIN_SECRET_LENGTH = 4;
const MAX_SECRET_LENGTH = 65_536;
const MAX_REGISTERED_SECRETS = 4096;
const MAX_COLLECTION_ITEMS = 512;

export function registerSecretValue(value, secretId = 'managed') {
  const text = String(value ?? '');
  if (text.length < MIN_SECRET_LENGTH || text.length > MAX_SECRET_LENGTH) return false;
  if (!EXACT_VALUES.has(text) && EXACT_VALUES.size >= MAX_REGISTERED_SECRETS) {
    throw new ContractError('secret_redaction_capacity', 'too many secret values are active for exact redaction');
  }
  const entry = EXACT_VALUES.get(text) ?? {
    id: String(secretId), encoded: Buffer.from(text, 'utf8').toString('base64'), count: 0,
  };
  entry.count += 1;
  EXACT_VALUES.set(text, entry);
  return true;
}

export function releaseSecretValue(value) {
  const text = String(value ?? '');
  const entry = EXACT_VALUES.get(text);
  if (!entry) return;
  entry.count -= 1;
  if (entry.count <= 0) EXACT_VALUES.delete(text);
}

export function redactExtensionData(value, depth = 0) {
  if (depth > 12) return '[redacted:depth-limit]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) {
    const result = value.slice(0, MAX_COLLECTION_ITEMS).map((item) => redactExtensionData(item, depth + 1));
    if (value.length > MAX_COLLECTION_ITEMS) result.push(`[redacted:${value.length - MAX_COLLECTION_ITEMS}-items-omitted]`);
    return result;
  }
  if (!value || typeof value !== 'object') return value;
  const result = {};
  const entries = Object.entries(value);
  for (const [key, child] of entries.slice(0, MAX_COLLECTION_ITEMS)) {
    result[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redactExtensionData(child, depth + 1);
  }
  if (entries.length > MAX_COLLECTION_ITEMS) result._nna_omitted_keys = entries.length - MAX_COLLECTION_ITEMS;
  return result;
}

export function redactText(value) {
  let result = String(value);
  for (const [secret, entry] of EXACT_VALUES) {
    if (result.includes(secret)) result = result.replaceAll(secret, `[nna-redacted:${entry.id}]`);
    if (entry.encoded.length >= 8 && result.includes(entry.encoded)) {
      result = result.replaceAll(entry.encoded, `[nna-redacted-encoded:${entry.id}]`);
    }
  }
  result = result.replaceAll(TEXT_PATTERNS[0], 'Bearer [redacted]');
  result = result.replaceAll(TEXT_PATTERNS[1], '$1$2[redacted]');
  result = result.replaceAll(TEXT_PATTERNS[2], '[redacted private key]');
  return result;
}
