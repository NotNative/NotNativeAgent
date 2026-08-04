// SPDX-License-Identifier: Apache-2.0

const SENSITIVE_KEY = /(?:api[_-]?key|authorization|bearer|credential|password|private[_-]?key|secret|token)/iu;
const TEXT_PATTERNS = Object.freeze([
  /\bbearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}/giu,
  /\b(api[_-]?key|password|secret|token)\s*([=:])\s*([^\s,;"']+)/giu,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/gu,
]);

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
  result = result.replaceAll(TEXT_PATTERNS[0], 'Bearer [redacted]');
  result = result.replaceAll(TEXT_PATTERNS[1], '$1$2[redacted]');
  result = result.replaceAll(TEXT_PATTERNS[2], '[redacted private key]');
  return result;
}
