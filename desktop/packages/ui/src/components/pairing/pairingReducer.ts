// SPDX-License-Identifier: Apache-2.0
/**
 * P8-5b §6.1 pairing dialog model.
 *
 * Deliberately a pure reducer rather than fourteen `useState` cells: the §6.1
 * flow has several replies that can land after the operator has moved on — a
 * create that resolves after the dialog was closed, a pending-list refresh for
 * a pairing that was just cancelled, a QR encoded for a spent link — and the
 * reducer is the one place that decides what the dialog currently believes.
 *
 * Late replies are dropped by the caller, which stamps each request with the
 * flow token it was asked for and only dispatches while that token is still
 * current (`usePairingDialog.ts`). Keeping the token out of the model means the
 * reducer has no request bookkeeping to get wrong.
 *
 * The one-time pairing secret deliberately has no field here. It exists only
 * inside the link the server returned (§5.1); a copy in dialog state would be
 * one more place it could be logged or persisted by accident.
 */

import type { PairingCloseReason } from '../../lib/pairing-watch.ts';
import type {
  PairingScope,
  PairingTransports,
  PendingPairingRow,
} from '../../lib/pairing-client.ts';
import { DEFAULT_SCOPE } from './pairingText.ts';

export type PairingPhase = 'loading' | 'form' | 'result';
export type PairingCopyState = 'idle' | 'copied' | 'failed';

/** What the result branch shows about the pairing we just created. */
export interface CreatedPairingView {
  pairingId: string;
  expiresAt: string;
  fingerprint: string;
  /** The issuing server's own label: the device names its link after it (§6.1 step 4). */
  serverLabel: string;
  usesRelay: boolean;
  link: string;
}

export interface PairingModel {
  phase: PairingPhase;
  scope: PairingScope;
  label: string;
  relayFallback: boolean;
  /** `null` until the transports route answers, or answers with an error. */
  transports: PairingTransports | null;
  /** Whether the transports route has answered at all (§6.1 step 1). */
  transportsSettled: boolean;
  pending: readonly PendingPairingRow[];
  /** A create request is in flight; the button must not be re-entrant. */
  creating: boolean;
  /** Route or scope error shown above the action row. */
  error: string;
  copyState: PairingCopyState;
  created: CreatedPairingView | null;
  /** The link we offered as text, encoded as a QR (§5.8). */
  qrDataUrl: string | null;
  qrError: string;
  /** Close reason once the pairing has settled; `null` while it is live. */
  closeReason: PairingCloseReason | null;
  /** `Date.now()` seam value that drives the countdown. */
  tick: number;
}

export function initialPairingModel(now: number): PairingModel {
  return {
    phase: 'loading',
    scope: DEFAULT_SCOPE,
    label: '',
    relayFallback: true,
    transports: null,
    transportsSettled: false,
    pending: [],
    creating: false,
    error: '',
    copyState: 'idle',
    created: null,
    qrDataUrl: null,
    qrError: '',
    closeReason: null,
    tick: now,
  };
}

export type PairingAction =
  | { type: 'reset'; now: number }
  | { type: 'scope'; scope: PairingScope }
  | { type: 'label'; label: string }
  | { type: 'relayFallback'; value: boolean }
  | { type: 'pending'; rows: readonly PendingPairingRow[] }
  | { type: 'transports'; transports: PairingTransports | null; error: string }
  | { type: 'createStart'; now: number }
  | { type: 'createOk'; created: CreatedPairingView; now: number }
  | { type: 'createFailed'; error: string }
  | { type: 'copied'; state: PairingCopyState }
  | { type: 'qr'; dataUrl: string | null; error: string }
  | { type: 'tick'; now: number }
  | { type: 'closed'; reason: PairingCloseReason };

/**
 * The guards that cannot live in the caller: a close reason is decided once per
 * pairing (the watcher, its settled promise, local expiry and the operator's
 * close button all race), and a QR for a settled pairing is always stale.
 */
export function pairingReducer(model: PairingModel, action: PairingAction): PairingModel {
  switch (action.type) {
    case 'reset':
      return initialPairingModel(action.now);
    case 'closed':
      return applyClosed(model, action.reason);
    case 'transports':
      return applyTransports(model, action.transports, action.error);
    case 'createStart':
      return applyCreateStart(model, action.now);
    case 'createOk':
      return applyCreateOk(model, action.created, action.now);
    case 'createFailed':
      return { ...model, creating: false, error: action.error };
    case 'qr':
      return applyQr(model, action.dataUrl, action.error);
    case 'pending':
      return { ...model, pending: action.rows };
    case 'scope':
      return { ...model, scope: action.scope };
    case 'label':
      return { ...model, label: action.label };
    case 'relayFallback':
      return { ...model, relayFallback: action.value };
    case 'copied':
      return { ...model, copyState: action.state };
    case 'tick':
      return { ...model, tick: action.now };
    default:
      return model;
  }
}

/**
 * First path to settle the pairing wins. The watcher's state machine, its
 * settled promise, local expiry and the close button can all report the same
 * fact, and a later report must not overwrite the reason the operator saw.
 */
function applyClosed(model: PairingModel, reason: PairingCloseReason): PairingModel {
  return model.closeReason === null ? { ...model, closeReason: reason } : model;
}

/**
 * §6.1 step 1: the form is shown either way. A transports failure is a refusal
 * line beside the radios, not a dead dialog — the operator can still read why
 * pairing cannot start, and the pending list still arrives.
 */
function applyTransports(
  model: PairingModel,
  transports: PairingTransports | null,
  error: string,
): PairingModel {
  return { ...model, transports, transportsSettled: true, error, phase: 'form' };
}

/**
 * A new pairing supersedes whatever the dialog was showing, so the model is
 * rebuilt from scratch. The operator's choices and the server's transport
 * picture are kept: one failed create should not mean refilling the form, and
 * the transports do not change because a create failed.
 */
function applyCreateStart(model: PairingModel, now: number): PairingModel {
  const fresh = initialPairingModel(now);
  return {
    ...fresh,
    scope: model.scope,
    label: model.label,
    relayFallback: model.relayFallback,
    transports: model.transports,
    transportsSettled: model.transportsSettled,
    pending: model.pending,
    phase: 'form',
    creating: true,
  };
}

/**
 * The result replaces the form. A fresh pairing has no QR yet and has not been
 * copied, and its close reason is un-settled: the watcher starts from nothing.
 */
function applyCreateOk(
  model: PairingModel,
  created: CreatedPairingView,
  now: number,
): PairingModel {
  return {
    ...model,
    created,
    phase: 'result',
    creating: false,
    error: '',
    qrDataUrl: null,
    qrError: '',
    copyState: 'idle',
    closeReason: null,
    tick: now,
  };
}

/**
 * A QR for a settled pairing is stale by construction: the code has been
 * redeemed, cancelled or has expired, so a slow encode must not repaint the
 * result with an image of a code that no longer works.
 */
function applyQr(model: PairingModel, dataUrl: string | null, error: string): PairingModel {
  if (model.closeReason !== null) return model;
  return { ...model, qrDataUrl: dataUrl, qrError: error };
}
