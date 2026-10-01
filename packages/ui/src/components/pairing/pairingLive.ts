// SPDX-License-Identifier: Apache-2.0
/**
 * P8-5b §6.1 pairing dialog plumbing shared by the controller's effects.
 *
 * Three unrelated things live here because they are all "how the controller
 * talks to the world" rather than "what the dialog believes":
 *
 *   - the clipboard fallback (§6.1 step 10),
 *   - the two pure projections out of a server reply (§5.1, §6.1 step 4),
 *   - the `live` object the async paths read through, which keeps a stable
 *     identity so each effect can be keyed on the few primitives it needs.
 *
 * Split out for the repository length gate; the reducer in `pairingReducer.ts`
 * stays the only place that decides what the dialog believes.
 */

import { useRef } from 'react';
import type {
  CreatedPairing,
  PairingCreateResponse,
  PairingRuntime,
  RemoteClientRow,
} from '../../lib/pairing-client.ts';
import type { PairingWatchState } from '../../lib/pairing-watch.ts';
import type { CreatedPairingView, PairingModel } from './pairingReducer.ts';
import type { PairingText } from './pairingText.ts';
import type { PairingDialogProps } from './usePairingDialog.ts';

/**
 * Default clipboard path. The async API is absent in non-secure contexts, and a
 * rejected write must not look like a successful copy, so the caller sees the
 * failure and keeps the selectable link visible.
 */
export async function defaultWriteClipboard(text: string): Promise<void> {
  const clipboard: { writeText?: (value: string) => Promise<void> } | undefined =
    typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (clipboard === undefined || typeof clipboard.writeText !== 'function') {
    throw new Error('Clipboard is unavailable in this context');
  }
  await clipboard.writeText(text);
}

/**
 * Flattens the create reply into what the result branch shows. The one-time
 * secret is deliberately not carried: it exists only inside `link` (§5.1).
 */
export function describeCreated(
  response: PairingCreateResponse,
  link: string,
): CreatedPairingView {
  const pairing: CreatedPairing = response.pairing;
  return {
    pairingId: pairing.id,
    expiresAt: pairing.expiresAt,
    fingerprint: pairing.fingerprint,
    serverLabel: response.server.label,
    usesRelay: pairing.usesRelay,
    link,
  };
}

/**
 * The client row the watcher redeemed, looked up in the rows from the same
 * poll. `pairingId` is only stamped on the row the redemption created, and a
 * row that is already revoked is not a live connection to announce.
 */
export function livePairingClient(
  watch: PairingWatchState,
  clients: readonly RemoteClientRow[],
): RemoteClientRow | null {
  if (!watch.redeemed) return null;
  for (const row of clients) {
    if (row.pairingId !== watch.pairingId) continue;
    if (row.revokedAt === null || row.revokedAt === undefined) return row;
  }
  return null;
}

/**
 * The live values the async paths need, behind one stable identity. `flow` is
 * the discard token, `creating` is the synchronous re-entry guard (the model's
 * own flag only becomes true once React has processed the dispatch), `stop` is
 * the live watcher's stop, and `announced` keeps a pairing to one close reason.
 */
export interface PairingLive {
  props: PairingDialogProps;
  text: PairingText;
  runtime: PairingRuntime;
  now: () => number;
  model: PairingModel;
  flow: number;
  creating: boolean;
  createFlow: number;
  stop: () => void;
  announced: boolean;
}

export function usePairingLive(
  props: PairingDialogProps,
  runtime: PairingRuntime,
  now: () => number,
  model: PairingModel,
  text: PairingText,
): PairingLive {
  const liveRef = useRef<PairingLive | null>(null);
  if (liveRef.current === null) {
    liveRef.current = {
      props,
      text,
      runtime,
      now,
      model,
      flow: 0,
      creating: false,
      createFlow: 0,
      stop: () => {},
      announced: false,
    };
  }
  const live = liveRef.current;
  // Render-time assignment: nothing below reads it during render, and every
  // async path reads it after this render has been committed.
  live.props = props;
  live.runtime = runtime;
  live.now = now;
  live.model = model;
  live.text = text;
  return live;
}
