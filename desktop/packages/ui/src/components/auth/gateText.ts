// SPDX-License-Identifier: Apache-2.0
/**
 * SessionAuthGate copy + stage-to-heading mapping (doc 08 §6.6). Defaults are
 * the EN literals AND registered i18n keys (`GATE_KEY`): inside an
 * I18nProvider the component translates them via `useOptionalI18n`, bare
 * mounts (tests, VS Code shell) fall back to the literal table. Explicit
 * `labels` overrides keep absolute authority either way.
 */
import {
  formatRetryAfterLine,
  type PasswordLoginResult,
  type SessionGateView,
  type SessionProbe,
} from '../../lib/sessionAuthGateState.ts';
import type { I18nKey } from '../../lib/i18n/messages/en.ts';

// Canonical `unknown presence` lives with the state module; re-exported so
// labels consumers can keep importing it alongside the copy table.
export { UNKNOWN_PRESENCE } from '../../lib/sessionAuthGateState.ts';

export const GATE_TEXT = {
  pending: 'Checking session…',
  lockedTitle: 'This instance is locked',
  passwordLabel: 'Server password',
  unlock: 'Unlock',
  unlocking: 'Unlocking…',
  trustDevice: 'Trust this device',
  usePasskey: 'Use passkey',
  addPasskey: 'Add passkey',
  passkeysDisabled: 'Passkeys are disabled until a UI password is set.',
  tunnelTitle: 'Tunnel access needs a connect token',
  tunnelBody: 'This host is reachable through the relay tunnel, which does not accept passwords. Use a one-time connect link from the host.',
  rateLimitedTitle: 'Too many attempts',
  errorTitle: 'Cannot reach this host',
  retry: 'Try again',
  authenticating: 'Waiting for the authenticator…',
  passwordRejected: 'The password was not accepted',
  nativeCodeLabel: 'One-time NNA access code',
  nativeCodeHelp: 'Enter the access code supplied by NNA. It expires after one minute.',
  nativeCodeRejected: 'The access code was not accepted. Request a new code from NNA.',
} as const;

/** Widened view of the table: merged overrides are plain `string`s. */
export type GateText = { [K in keyof typeof GATE_TEXT]: string };

/** Registered i18n key per gate string (W-64 polish). Keys mirror the EN
 * table one-to-one; the dictionary test guards the values from drifting. */
export const GATE_KEY: { [K in keyof typeof GATE_TEXT]: I18nKey } = {
  pending: 'auth.gate.pending',
  lockedTitle: 'auth.gate.lockedTitle',
  passwordLabel: 'auth.gate.passwordLabel',
  unlock: 'auth.gate.unlock',
  unlocking: 'auth.gate.unlocking',
  trustDevice: 'auth.gate.trustDevice',
  usePasskey: 'auth.gate.usePasskey',
  addPasskey: 'auth.gate.addPasskey',
  passkeysDisabled: 'auth.gate.passkeysDisabled',
  tunnelTitle: 'auth.gate.tunnelTitle',
  tunnelBody: 'auth.gate.tunnelBody',
  rateLimitedTitle: 'auth.gate.rateLimitedTitle',
  errorTitle: 'auth.gate.errorTitle',
  retry: 'auth.gate.retry',
  authenticating: 'auth.gate.authenticating',
  passwordRejected: 'auth.gate.passwordRejected',
  nativeCodeLabel: 'auth.gate.nativeCodeLabel',
  nativeCodeHelp: 'auth.gate.nativeCodeHelp',
  nativeCodeRejected: 'auth.gate.nativeCodeRejected',
};

/** Rendered defaults for the two inputs the gate needs before it has answers. */
export const PENDING_PROBE: SessionProbe = {
  stage: 'pending',
  status: 0,
  authenticated: false,
  authRequired: true,
  methods: [],
  tunnelLocked: false,
  retryAfterSeconds: null,
};

export function headingFor(stage: SessionGateView['stage'], text: GateText): string {
  if (stage === 'tunnel-locked') return text.tunnelTitle;
  if (stage === 'rate-limited') return text.rateLimitedTitle;
  if (stage === 'error') return text.errorTitle;
  return text.lockedTitle;
}

/**
 * Merge caller overrides over the defaults. Written key-by-key rather than as
 * one spread so a `labels` entry that is present-but-undefined can never erase
 * a default line from the rendered screen. The defaults parameter lets
 * provider-aware callers pass t()-translated tables (W-64); bare mounts use
 * the literal table.
 */
export function resolveGateText(labels?: Partial<GateText>, defaults: GateText = GATE_TEXT): GateText {
  if (labels === undefined) return defaults;
  const merged = { ...defaults } as Record<keyof GateText, string>;
  for (const key of Object.keys(labels) as Array<keyof GateText>) {
    const value = labels[key];
    if (typeof value === 'string' && value.length > 0) merged[key] = value;
  }
  return merged;
}

/**
 * One failure line per §6.6 outcome. A tunnel-locked 403 shows the connect-token
 * explanation rather than a password hint, because there is no password that
 * will work at that scope (§2.9); a 429 shows the server's own window.
 */
export function describeLoginFailure(
  outcome: PasswordLoginResult,
  labels?: Partial<GateText>,
  defaults: GateText = GATE_TEXT,
): string {
  const text = resolveGateText(labels, defaults);
  if (outcome.tunnelLocked) return text.tunnelBody;
  if (outcome.status === 429) return formatRetryAfterLine(outcome.retryAfterSeconds);
  if (outcome.status === 0) return outcome.error ?? text.errorTitle;
  return outcome.error ?? text.passwordRejected;
}
