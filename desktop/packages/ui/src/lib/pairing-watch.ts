// SPDX-License-Identifier: Apache-2.0
/**
 * Pairing result watcher (doc 08 §6.1 steps 5/8/9). The issuing dialog
 * auto-closes only after it has *seen* its pairing in the pending list — a
 * re-render race must not blink the dialog shut — and then only on polls that
 * actually succeeded: a transient fetch failure can never fake a redemption.
 *
 * The server's pending list is "not used ∧ not cancelled ∧ not expired", so
 * leaving that list is ambiguous by itself. The dialog knows the expiry it was
 * handed at create time, which is what separates `expired` from `cancelled`;
 * a live client row carrying the pairing id is the redemption signal.
 */
import type { PairingRuntime, PendingPairingRow, RemoteClientRow } from './pairing-client.ts';
import { listPendingPairings, listRemoteClients } from './pairing-client.ts';

export type PairingCloseReason = 'redeemed' | 'expired' | 'cancelled';

/** The watcher reads only id/pairingId/revokedAt, but the full wire rows are
 * the contract it is handed — tests build them through factories. */
export interface PairingPollResult {
  ok: boolean;
  pending?: readonly PendingPairingRow[];
  clients?: readonly RemoteClientRow[];
}

export interface PairingWatchState {
  pairingId: string;
  /** The `expiresAt` from the create reply; the only clock reference we own. */
  expiresAt: string;
  /** False until one successful poll has listed this pairing as pending. */
  seenPending: boolean;
  /** True once a live client row carries this pairing id (§6.1 "connected"). */
  redeemed: boolean;
  /** Set when the dialog should close, with the reason the UI reports. */
  closed: PairingCloseReason | null;
}

export function createPairingWatchState(
  pairingId: string,
  expiresAt: string,
): PairingWatchState {
  return { pairingId, expiresAt, seenPending: false, redeemed: false, closed: null };
}

function parseStamp(value: string | undefined): number {
  if (typeof value !== 'string') return Number.NaN;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

/** A revoked row is not a live connection for the auto-close signal. */
function liveClientForPairing(
  rows: readonly RemoteClientRow[] | undefined,
  pairingId: string,
): RemoteClientRow | null {
  for (const row of rows ?? []) {
    if (row.pairingId === pairingId && (row.revokedAt === null || row.revokedAt === undefined)) {
      return row;
    }
  }
  return null;
}

/**
 * Advances the watcher on one poll outcome. Same object for chaining; `closed`
 * transitions are sticky — a close is never reopened by a later poll.
 */
export function observePairingPoll(
  state: PairingWatchState,
  poll: PairingPollResult,
  now: number,
): PairingWatchState {
  if (state.closed !== null) return state;
  // A failed poll says nothing: the list is never blanked and the dialog never
  // closes on it (§6.1 step 5 silent-mode rule).
  if (!poll.ok || poll.pending === undefined) return state;

  const listed = poll.pending.some((row) => row.id === state.pairingId);
  if (listed) {
    // The server only lists live rows, so presence alone means "still pending".
    state.seenPending = true;
    return state;
  }
  if (!state.seenPending) {
    // Never observed pending: the list has not caught up, or the session
    // belongs to another window. Keep waiting rather than guessing.
    return state;
  }

  const client = liveClientForPairing(poll.clients, state.pairingId);
  if (client !== null) {
    state.redeemed = true;
    state.closed = 'redeemed';
    return state;
  }

  // Gone from pending with no live device: the create-time expiry says which.
  const expiresAt = parseStamp(state.expiresAt);
  state.closed = !Number.isNaN(expiresAt) && now >= expiresAt ? 'expired' : 'cancelled';
  return state;
}

/** One silent poll: any throw becomes `ok: false` so callers keep their list. */
export async function pollPairingResult(
  pairingId: string,
  runtime: PairingRuntime,
): Promise<PairingPollResult> {
  try {
    const [pending, clients] = await Promise.all([
      listPendingPairings(runtime),
      listRemoteClients(runtime),
    ]);
    return { ok: true, pending, clients };
  } catch {
    return { ok: false };
  }
}

export interface PairingWatcherOptions {
  runtime: PairingRuntime;
  /** §6.1 step 5: every 5 s. */
  intervalMs?: number;
  /** §6.1 step 5: and only while the page is visible. */
  isVisible?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  onState?: (state: PairingWatchState) => void;
  /**
   * Hands the dialog the rows it renders (pending + clients) from the *same*
   * poll the state machine just consumed. Without it the dialog would issue a
   * second pair of requests per tick and could render a list that disagrees
   * with the close decision.
   */
  onPoll?: (poll: PairingPollResult) => void;
}

/**
 * A hidden loop must still yield to the timer queue. A `sleep` seam that
 * resolves synchronously would otherwise starve the UI thread forever, so
 * hidden spins are capped; a real timer never comes close to the cap.
 */
export const MAX_HIDDEN_SPINS = 1000;

/**
 * Polls until the dialog may close. Returns the live state, a `stop` for
 * unmount, and a promise that settles on the close (or on `stop`).
 */
export function startPairingWatcher(
  pairingId: string,
  expiresAt: string,
  options: PairingWatcherOptions,
): {
  state: PairingWatchState;
  stop: () => void;
  done: Promise<PairingWatchState>;
} {
  const intervalMs = options.intervalMs ?? 5000;
  const isVisible = options.isVisible ?? (() => true);
  const sleep = options.sleep
    ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const state = createPairingWatchState(pairingId, expiresAt);
  let stopped = false;
  let settle: ((value: PairingWatchState) => void) | null = null;
  const done = new Promise<PairingWatchState>((resolve) => {
    settle = resolve;
  });
  const finish = (): void => {
    if (stopped) return;
    stopped = true;
    if (settle !== null) settle(state);
  };

  const tick = async (): Promise<void> => {
    let hiddenSpins = 0;
    while (!stopped && state.closed === null && hiddenSpins < MAX_HIDDEN_SPINS) {
      if (isVisible()) {
        hiddenSpins = 0;
        const poll = await pollPairingResult(pairingId, options.runtime);
        // Rows first: a dialog that renders them must see them even if the
        // state transition below throws in a consumer callback.
        if (poll.ok) options.onPoll?.(poll);
        observePairingPoll(state, poll, options.runtime.now());
        options.onState?.(state);
        if (state.closed !== null) break;
      } else {
        hiddenSpins += 1;
      }
      await sleep(intervalMs);
    }
    finish();
  };

  void tick();
  return { state, stop: finish, done };
}
