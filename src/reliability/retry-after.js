// SPDX-License-Identifier: Apache-2.0

export const MAX_PROVIDER_RETRY_AFTER_MS = 30_000;

export function providerRetryAfterMs(response, trustZone, now = Date.now()) {
  if (trustZone !== 'public_network' || !response?.headers || typeof response.headers.get !== 'function') return null;
  const value = response.headers.get('retry-after');
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) return null;
  let delay;
  if (/^\d{1,6}$/u.test(value.trim())) delay = Number(value.trim()) * 1_000;
  else {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return null;
    delay = Math.max(0, timestamp - now);
  }
  return Math.min(MAX_PROVIDER_RETRY_AFTER_MS, delay);
}

export function boundedProviderRetryDelay(defaultDelayMs, suggestedDelayMs) {
  if (!Number.isFinite(suggestedDelayMs) || suggestedDelayMs < 0) return defaultDelayMs;
  return Math.max(defaultDelayMs, Math.min(MAX_PROVIDER_RETRY_AFTER_MS, Math.trunc(suggestedDelayMs)));
}
