// SPDX-License-Identifier: Apache-2.0

const PLATFORM_REASON_CODES = Object.freeze({
  EACCES: 'tool_access_denied',
  EBUSY: 'tool_resource_busy',
  ECONNREFUSED: 'tool_connection_refused',
  ECONNRESET: 'tool_connection_reset',
  EEXIST: 'tool_target_exists',
  EHOSTUNREACH: 'tool_network_unreachable',
  EISDIR: 'tool_target_type_invalid',
  EMFILE: 'tool_resource_limit',
  ENAMETOOLONG: 'tool_path_invalid',
  ENETUNREACH: 'tool_network_unreachable',
  ENFILE: 'tool_resource_limit',
  ENOENT: 'tool_target_not_found',
  ENOSPC: 'tool_storage_full',
  ENOTDIR: 'tool_path_invalid',
  ENOTEMPTY: 'tool_target_not_empty',
  EPERM: 'tool_access_denied',
  ETIMEDOUT: 'tool_timeout',
  ERR_MODULE_NOT_FOUND: 'tool_dependency_missing',
  MODULE_NOT_FOUND: 'tool_dependency_missing',
});

export function normalizeToolReasonCode(value, fallback) {
  const seen = new WeakSet();
  for (let depth = 0; value && typeof value === 'object'; depth += 1) {
    if (depth >= 16 || seen.has(value)) return fallback;
    seen.add(value);
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, 'code'); } catch { return fallback; }
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return fallback;
    value = descriptor.value;
  }
  if (typeof value === 'string') {
    const platform = PLATFORM_REASON_CODES[value.trim().toUpperCase()];
    if (platform) return platform;
    const normalized = value.trim().replace(/[^A-Za-z0-9_.:@/-]+/gu, '_').slice(0, 160);
    if (/^[A-Za-z0-9]/u.test(normalized)) return normalized;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return `${fallback}_code_${Math.trunc(value)}`;
  return fallback;
}
