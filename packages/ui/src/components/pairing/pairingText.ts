// SPDX-License-Identifier: Apache-2.0
/**
 * PairingDialog copy + pure formatting helpers (doc 08 §5.8/§5.10/§6.1).
 *
 * Split out of `PairingDialog.tsx` for the same reason as `auth/gateText.ts`:
 * the strings and the arithmetic are testable as data, and keeping them out of
 * the component keeps that file under the repository length gate. These strings
 * are literal English defaults; registering the pairing keys in
 * `lib/i18n/messages/en.ts` is the follow-up that replaces the table (the same
 * deferral the auth gate documents).
 */
import { PairingApiError, type PairingScope } from '../../lib/pairing-client.ts';
import type { PairingCloseReason } from '../../lib/pairing-watch.ts';

export const PAIRING_TEXT = {
  title: 'Connect a device to this server',
  description: 'Generate a one-time QR, scan it from the other device, and watch the pairing land.',
  disabled: 'Pairing is turned off on this server. Enable it under Settings → Remote instances.',
  transportsLoading: 'Checking how this server can be reached…',
  scopeLegend: 'How should the device reach this server?',
  deviceLabel: 'Device label (optional)',
  deviceLabelPlaceholder: 'This server\'s name for that device',
  deviceLabelHint: 'Leave empty and the device reports its own name when it redeems.',
  relayFallback: 'Also allow the encrypted relay when away from home',
  create: 'Create pairing',
  creating: 'Creating…',
  pendingTitle: 'Pending pairings',
  pendingEmpty: 'No pending pairings.',
  pendingUnnamed: 'Unnamed',
  viaRelay: 'via Relay',
  cancelPending: 'Cancel',
  copy: 'Copy link',
  copied: 'Copied',
  copyFailed: 'Copy failed; select the link and copy it manually.',
  qrAlt: 'Pairing QR code',
  qrPending: 'Generating QR…',
  qrUnavailable: 'QR unavailable',
  expired: 'This code has expired. Close this dialog and create a new one.',
  expiresPrefix: 'expires in',
  expiresNow: 'expired',
  waiting: 'Waiting for the device to redeem…',
  waitingForList: 'Waiting for the pending list…',
  fingerprintPrefix: 'fingerprint',
  done: 'Done',
  newPairing: 'New pairing',
  close: 'Close',
} as const;

/** Widened view of the table: merged overrides are plain `string`s. */
export type PairingText = { [K in keyof typeof PAIRING_TEXT]: string };

export const PAIRING_SCOPE_LABELS: Record<PairingScope, string> = {
  local: 'This computer only',
  lan: 'Home network only',
  anywhere: 'Anywhere',
};

export const PAIRING_SCOPE_HINTS: Record<PairingScope, string> = {
  local: 'Direct over loopback only. The device must reach this machine.',
  lan: 'Direct over the LAN address the server is actually bound to.',
  anywhere: 'Relay-first link; the home-network candidate rides along while the fallback is on.',
};

/** The order the radios are rendered in: the documented default first (§6.1). */
export const PAIRING_SCOPE_ORDER: readonly PairingScope[] = ['anywhere', 'local', 'lan'];

export const DEFAULT_SCOPE: PairingScope = 'anywhere';

/** Longest label the create route accepts; the input enforces it rather than 400ing. */
export const LABEL_MAX_LENGTH = 120;

/**
 * Seconds remaining against one clock reading. `null` means the stamp is
 * unusable, which the dialog treats as "no countdown" rather than "expired", so
 * a malformed field can never blank a live QR.
 */
export function secondsUntil(expiresAt: string | undefined, now: number): number | null {
  if (typeof expiresAt !== 'string') return null;
  const parsed = Date.parse(expiresAt);
  if (Number.isNaN(parsed)) return null;
  return Math.floor((parsed - now) / 1000);
}

/** `145` → `2m 25s`; anything under a minute drops the minute part. */
export function formatCountdown(seconds: number | null): string {
  if (seconds === null) return '';
  const clamped = seconds > 0 ? seconds : 0;
  const minutes = Math.floor(clamped / 60);
  const rest = clamped % 60;
  if (minutes === 0) return `${rest}s`;
  return `${minutes}m ${rest}s`;
}

/** §6.1 step 8 close reasons, in the words the dialog reports them in. */
export function closeReasonMessage(reason: PairingCloseReason | null): string {
  switch (reason) {
    case 'redeemed':
      return 'Device connected.';
    case 'cancelled':
      return 'Pairing cancelled.';
    case 'expired':
      return 'This code expired.';
    case null:
      return '';
  }
}

/**
 * One line per transport-planning refusal (§6.1 step 2). Each names the change
 * that would make the scope honourable, because the radio is still selected.
 */
export function scopeRefusalMessage(
  reason: 'no-loopback' | 'no-lan' | 'relay-unavailable' | 'empty-scope',
): string {
  switch (reason) {
    case 'no-loopback':
      return 'This server is not listening on loopback. Pick home network or the relay.';
    case 'no-lan':
      return 'No LAN address is available. Pick this computer only or the relay.';
    case 'relay-unavailable':
      return 'The encrypted relay is off. Enable it, or accept the home-network fallback.';
    case 'empty-scope':
      return 'No transport can carry this pairing.';
  }
}

/**
 * Route failures mapped to one line. A `PairingApiError` with status 0 is the
 * "plan cannot be honoured" sentinel, so its own message is already the right
 * words; 401/403 is a session problem, not a pairing problem.
 */
export function describePairingError(error: unknown): string {
  if (error instanceof PairingApiError) {
    if (error.status === 0) return error.message;
    if (error.status === 401 || error.status === 403) return 'Sign in again to manage devices.';
    if (error.status === 404) return 'That pairing session is already gone.';
    return error.message;
  }
  if (error instanceof Error && error.message !== '') return error.message;
  return 'Cannot reach this server right now.';
}

/** Merge caller overrides over the defaults, ignoring present-but-empty keys. */
export function resolvePairingText(labels?: Partial<PairingText>): PairingText {
  if (labels === undefined) return PAIRING_TEXT;
  const merged = { ...PAIRING_TEXT } as Record<keyof PairingText, string>;
  for (const key of Object.keys(labels) as Array<keyof PairingText>) {
    const value = labels[key];
    if (typeof value === 'string' && value.length > 0) merged[key] = value;
  }
  return merged;
}
