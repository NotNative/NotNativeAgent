// SPDX-License-Identifier: Apache-2.0

const SENSITIVE_KEY = /(?:api[_-]?key|authorization|bearer|credential|password|private[_-]?key|secret|token)/iu;
const TEXT_PATTERNS = Object.freeze([
  /\bbearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}/giu,
  /\b(api[_-]?key|password|secret|token)\s*([=:])\s*([^\s,;"']+)/giu,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/gu,
]);
const EXACT_VALUES = new Map();

export function registerSecretValue(value, secretId = 'managed') {
  const text = String(value ?? '');
  if (text.length < 4 || text.length > 65_536) return false;
  const entry = EXACT_VALUES.get(text) ?? { ids: new Set(), count: 0 };
  entry.ids.add(String(secretId));
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
  if (Array.isArray(value)) return value.slice(0, 512).map((item) => redactExtensionData(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value).slice(0, 512)) {
    result[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redactExtensionData(child, depth + 1);
  }
  return result;
}

export function redactText(value) {
  let result = String(value);
  for (const [secret, entry] of EXACT_VALUES) {
    if (result.includes(secret)) result = result.replaceAll(secret, `[nna-redacted:${[...entry.ids][0]}]`);
    const encoded = Buffer.from(secret, 'utf8').toString('base64');
    if (encoded.length >= 8 && result.includes(encoded)) result = result.replaceAll(encoded, `[nna-redacted-encoded:${[...entry.ids][0]}]`);
  }
  result = result.replaceAll(TEXT_PATTERNS[0], 'Bearer [redacted]');
  result = result.replaceAll(TEXT_PATTERNS[1], '$1$2[redacted]');
  result = result.replaceAll(TEXT_PATTERNS[2], '[redacted private key]');
  return result;
}
