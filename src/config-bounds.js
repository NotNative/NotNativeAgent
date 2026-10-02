// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { CONFIGURATION_RULES, boundedInteger, boundedNumber, resolveConfigurationScalar as scalar } from './configuration-rules.js';
export { boundedInteger, boundedNumber } from './configuration-rules.js';

const DEFAULT_PROVIDER_TIMEOUT_MS = CONFIGURATION_RULES.provider_timeout_ms.default.value;
const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = CONFIGURATION_RULES.first_token_timeout_ms.default.value;
const DEFAULT_IDLE_TIMEOUT_MS = CONFIGURATION_RULES.idle_timeout_ms.default.value;
const LEGACY_FIRST_TOKEN_TIMEOUT_MS = 30_000;
const LEGACY_IDLE_TIMEOUT_MS = 45_000;
const LEGACY_SEMANTIC_REVIEW_TIMEOUT_MS = 15_000;

export function optionalZeroUnsetInteger(value, minimum, maximum) {
  if (value === undefined || value === null || value === 0) return null;
  return boundedInteger(value, null, minimum, maximum);
}

export function optionalZeroUnsetNumber(value, minimum, maximum) {
  if (value === undefined || value === null || value === 0) return null;
  return boundedNumber(value, null, minimum, maximum);
}

export function migrateLegacyProviderTimeoutDefaults(manifest) {
  const migrated = { ...manifest };
  if (migrated.first_token_timeout_ms === LEGACY_FIRST_TOKEN_TIMEOUT_MS) migrated.first_token_timeout_ms = undefined;
  if (migrated.idle_timeout_ms === LEGACY_IDLE_TIMEOUT_MS) migrated.idle_timeout_ms = undefined;
  // These values were persisted as mandatory defaults before trusted local
  // inference adopted opt-in stream deadlines. Treat the exact former pair as
  // inherited policy so existing installations receive the safer behavior.
  if (migrated.first_token_timeout_ms === DEFAULT_FIRST_TOKEN_TIMEOUT_MS
    && migrated.idle_timeout_ms === DEFAULT_IDLE_TIMEOUT_MS) {
    migrated.first_token_timeout_ms = undefined;
    migrated.idle_timeout_ms = undefined;
  }
  return migrated;
}

export function providerTimeouts(manifest) {
  const input = migrateLegacyProviderTimeoutDefaults(manifest);
  const primaryDeadline = input.routes?.primary?.deadline_ms;
  const configured = primaryDeadline === undefined ? input.provider_timeout_ms : primaryDeadline;
  const firstTokenConfigured = input.first_token_timeout_ms;
  const idleConfigured = input.idle_timeout_ms;
  return {
    providerMs: scalar('provider_timeout_ms', configured),
    providerOverrideMs: providerOverride(configured),
    firstTokenMs: scalar('first_token_timeout_ms', firstTokenConfigured),
    firstTokenOverrideMs: streamOverride('first_token_timeout_ms', firstTokenConfigured),
    idleMs: scalar('idle_timeout_ms', idleConfigured),
    idleOverrideMs: streamOverride('idle_timeout_ms', idleConfigured),
  };
}

export function providerRouteDeadlineOverride(value) {
  return scalar('routes.{role}.deadline_ms', value);
}

export function semanticReviewTimeout(manifest, providerMs) {
  const configured = manifest.semantic_review_timeout_ms;
  // Fifteen seconds was an early default that is too short for local models and
  // was persisted into existing manifests. Migrate that exact legacy value.
  if (configured === undefined || configured === LEGACY_SEMANTIC_REVIEW_TIMEOUT_MS) return providerMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  return scalar('semantic_review_timeout_ms', configured, providerMs ?? DEFAULT_PROVIDER_TIMEOUT_MS);
}

function providerOverride(configured) {
  if (configured === undefined) return null;
  if (configured === 0) return 0;
  return scalar('provider_timeout_ms', configured, null);
}

function streamOverride(key, configured) {
  if (configured === undefined) return null;
  if (configured === 0) return 0;
  return scalar(key, configured, null);
}

export function telemetryDestination(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || value.length > 2048) throw new Error('invalid');
    return url.href;
  } catch {
    throw new ContractError('telemetry_destination_invalid', 'telemetry destination must be a credential-free HTTP(S) URL');
  }
}
