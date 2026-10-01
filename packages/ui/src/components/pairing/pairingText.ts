// SPDX-License-Identifier: Apache-2.0
/**
 * PairingDialog copy + pure formatting helpers (doc 08 §5.8/§5.10/§6.1).
 *
 * Split out of `PairingDialog.tsx` for the same reason as `auth/gateText.ts`:
 * the strings and the arithmetic are testable as data, and keeping them out of
 * the component keeps that file under the repository length gate. These strings
 * are literal English defaults AND registered i18n keys; explicit labels
 * still have authority, while bare tests retain a stable English fallback.
 * registered in `lib/i18n/messages/en.ts`.
 */
import type { I18nKey } from '../../lib/i18n/messages/en.ts';
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
  scopeAnywhereLabel: 'Anywhere',
  scopeLocalLabel: 'This computer only',
  scopeLanLabel: 'Home network only',
  scopeAnywhereHint: 'Relay-first link; the home-network candidate rides along while the fallback is on.',
  scopeLocalHint: 'Direct over loopback only. The device must reach this machine.',
  scopeLanHint: 'Direct over the LAN address the server is actually bound to.',
  closeReasonRedeemed: 'Device connected.',
  closeReasonCancelled: 'Pairing cancelled.',
  closeReasonExpired: 'This code expired.',
  refusalNoLoopback: 'This server is not listening on loopback. Pick home network or the relay.',
  refusalNoLan: 'No LAN address is available. Pick this computer only or the relay.',
  refusalRelayUnavailable: 'The encrypted relay is off. Enable it, or accept the home-network fallback.',
  refusalEmptyScope: 'No transport can carry this pairing.',
  authSignInAgain: 'Sign in again to manage devices.',
  pairingSessionGone: 'That pairing session is already gone.',
  serverUnreachable: 'Cannot reach this server right now.',
} as const;

/** Widened view of the table: merged overrides are plain `string`s. */
export type PairingText = { [K in keyof typeof PAIRING_TEXT]: string };

export const PAIRING_KEY: { [K in keyof typeof PAIRING_TEXT]: I18nKey } = {
  title: 'pairingUi.title',
  description: 'pairingUi.description',
  disabled: 'pairingUi.disabled',
  transportsLoading: 'pairingUi.transportsLoading',
  scopeLegend: 'pairingUi.scopeLegend',
  deviceLabel: 'pairingUi.deviceLabel',
  deviceLabelPlaceholder: 'pairingUi.deviceLabelPlaceholder',
  deviceLabelHint: 'pairingUi.deviceLabelHint',
  relayFallback: 'pairingUi.relayFallback',
  create: 'pairingUi.create',
  creating: 'pairingUi.creating',
  pendingTitle: 'pairingUi.pendingTitle',
  pendingEmpty: 'pairingUi.pendingEmpty',
  pendingUnnamed: 'pairingUi.pendingUnnamed',
  viaRelay: 'pairingUi.viaRelay',
  cancelPending: 'pairingUi.cancelPending',
  copy: 'pairingUi.copy',
  copied: 'pairingUi.copied',
  copyFailed: 'pairingUi.copyFailed',
  qrAlt: 'pairingUi.qrAlt',
  qrPending: 'pairingUi.qrPending',
  qrUnavailable: 'pairingUi.qrUnavailable',
  expired: 'pairingUi.expired',
  expiresPrefix: 'pairingUi.expiresPrefix',
  expiresNow: 'pairingUi.expiresNow',
  waiting: 'pairingUi.waiting',
  waitingForList: 'pairingUi.waitingForList',
  fingerprintPrefix: 'pairingUi.fingerprintPrefix',
  done: 'pairingUi.done',
  newPairing: 'pairingUi.newPairing',
  close: 'pairingUi.close',
  scopeAnywhereLabel: 'pairingUi.scope.anywhere.label',
  scopeLocalLabel: 'pairingUi.scope.local.label',
  scopeLanLabel: 'pairingUi.scope.lan.label',
  scopeAnywhereHint: 'pairingUi.scope.anywhere.hint',
  scopeLocalHint: 'pairingUi.scope.local.hint',
  scopeLanHint: 'pairingUi.scope.lan.hint',
  closeReasonRedeemed: 'pairingUi.closeReason.redeemed',
  closeReasonCancelled: 'pairingUi.closeReason.cancelled',
  closeReasonExpired: 'pairingUi.closeReason.expired',
  refusalNoLoopback: 'pairingUi.refusal.noLoopback',
  refusalNoLan: 'pairingUi.refusal.noLan',
  refusalRelayUnavailable: 'pairingUi.refusal.relayUnavailable',
  refusalEmptyScope: 'pairingUi.refusal.emptyScope',
  authSignInAgain: 'pairingUi.error.signInAgain',
  pairingSessionGone: 'pairingUi.error.sessionGone',
  serverUnreachable: 'pairingUi.error.unreachable',
};

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
export function closeReasonMessage(
  reason: PairingCloseReason | null,
  text: PairingText = PAIRING_TEXT,
): string {
  switch (reason) {
    case 'redeemed':
      return text.closeReasonRedeemed;
    case 'cancelled':
      return text.closeReasonCancelled;
    case 'expired':
      return text.closeReasonExpired;
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
  text: PairingText = PAIRING_TEXT,
): string {
  switch (reason) {
    case 'no-loopback':
      return text.refusalNoLoopback;
    case 'no-lan':
      return text.refusalNoLan;
    case 'relay-unavailable':
      return text.refusalRelayUnavailable;
    case 'empty-scope':
      return text.refusalEmptyScope;
  }
}

/**
 * Route failures mapped to one line. A `PairingApiError` with status 0 is the
 * "plan cannot be honoured" sentinel, so its own message is already the right
 * words; 401/403 is a session problem, not a pairing problem.
 */
export function describePairingError(error: unknown, text: PairingText = PAIRING_TEXT): string {
  if (error instanceof PairingApiError) {
    if (error.status === 0) return error.message;
    if (error.status === 401 || error.status === 403) return text.authSignInAgain;
    if (error.status === 404) return text.pairingSessionGone;
    return error.message;
  }
  if (error instanceof Error && error.message !== '') return error.message;
  return text.serverUnreachable;
}

/** Merge caller overrides over the defaults, ignoring present-but-empty keys. */
export function resolvePairingText(
  labels?: Partial<PairingText>,
  defaults: PairingText = PAIRING_TEXT,
): PairingText {
  if (labels === undefined) return defaults;
  const merged = { ...defaults } as Record<keyof PairingText, string>;
  for (const key of Object.keys(labels) as Array<keyof PairingText>) {
    const value = labels[key];
    if (typeof value === 'string' && value.length > 0) merged[key] = value;
  }
  return merged;
}
