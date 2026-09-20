// SPDX-License-Identifier: Apache-2.0
/**
 * SessionAuthGate copy + stage-to-heading mapping (doc 08 §6.6). Split out of
 * `SessionAuthGate.tsx` so the component file stays under the length gate.
 *
 * Strings are literal English defaults, overridable per-instance through the
 * gate's `labels` prop: `t()` accepts only registered `I18nKey`s and
 * `useI18n()` throws outside its provider, so registering the auth keys in
 * `lib/i18n/messages/en.ts` is the follow-up that replaces this table.
 */
import {
  formatRetryAfterLine,
  type PasswordLoginResult,
  type SessionGateView,
  type SessionProbe,
} from '../../lib/sessionAuthGateState.ts';

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
} as const;

/** Widened view of the table: merged overrides are plain `string`s. */
export type GateText = { [K in keyof typeof GATE_TEXT]: string };

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
 * a default line from the rendered screen.
 */
export function resolveGateText(labels?: Partial<GateText>): GateText {
  if (labels === undefined) return GATE_TEXT;
  const merged = { ...GATE_TEXT } as Record<keyof GateText, string>;
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
): string {
  const text = resolveGateText(labels);
  if (outcome.tunnelLocked) return text.tunnelBody;
  if (outcome.status === 429) return formatRetryAfterLine(outcome.retryAfterSeconds);
  if (outcome.status === 0) return outcome.error ?? text.errorTitle;
  return outcome.error ?? text.passwordRejected;
}
