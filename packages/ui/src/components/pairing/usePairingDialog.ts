// SPDX-License-Identifier: Apache-2.0
/**
 * P8-5b §6.1 pairing dialog controller.
 *
 * The dialog is presentation only; everything that talks to the pairing routes
 * lives here, split along the seams §6.1 already draws:
 *
 *   load transports         (step 1)         how the server can be reached at all
 *   plan the scope          (step 2)         which base URL the link may carry
 *   create + link           (steps 3, 4, 10)
 *   poll for the redemption (steps 5, 8, 9)
 *   QR + countdown          (§5.8, §5.3)
 *
 * Model transitions are in `pairingReducer.ts`. Late replies are dropped here:
 * every request stamps the flow token it was asked with, and an outcome is only
 * applied while that token is still current. The token moves when the dialog
 * opens, when a new pairing is created, and when the operator closes or resets,
 * so a create that resolves after the dialog went away, a pending-list refresh
 * for a pairing that was just cancelled, and a QR encoded for a spent link all
 * die at the same seam instead of at eight call sites.
 *
 * `live` is the stable object those async paths read through. Keeping the
 * current props and model behind it means every effect can be keyed on the few
 * primitives it actually depends on, instead of on a callback identity that
 * would change on every keystroke in the label field.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type Dispatch,
} from 'react';
import {
  cancelPairingSession,
  createPairingLink,
  createPairingRuntime,
  fetchPairingTransports,
  listPendingPairings,
  planPairingRequest,
  type PairingRuntime,
  type RemoteClientRow,
} from '../../lib/pairing-client.ts';
import {
  startPairingWatcher,
  type PairingCloseReason,
  type PairingPollResult,
  type PairingWatchState,
} from '../../lib/pairing-watch.ts';
import { browserQrRenderer, renderPairingQr, type QrDataUrlRenderer } from '../../lib/pairing-qr.ts';
import {
  describePairingError,
  formatCountdown,
  resolvePairingText,
  scopeRefusalMessage,
  secondsUntil,
  type PairingText,
} from './pairingText.ts';
import {
  initialPairingModel,
  pairingReducer,
  type CreatedPairingView,
  type PairingAction,
  type PairingModel,
} from './pairingReducer.ts';
import {
  defaultWriteClipboard,
  describeCreated,
  livePairingClient,
  usePairingLive,
  type PairingLive,
} from './pairingLive.ts';

export const PAIRING_POLL_INTERVAL_MS = 5000;
export const PAIRING_COUNTDOWN_INTERVAL_MS = 1000;

const DEFAULT_RUNTIME = createPairingRuntime();
const DEFAULT_CLOCK = (): number => Date.now();

export interface PairingDialogProps {
  open: boolean;
  /** `false` while pairing is off server-side: the dialog cannot start one. */
  pairingAvailable?: boolean;
  /** Test seam for the four pairing routes. */
  runtime?: PairingRuntime;
  /** Test seam for the QR encoder; omitting it uses the browser canvas build. */
  renderQr?: QrDataUrlRenderer | null;
  /** Visibility seam for the 5 s poll (§6.1 step 5). */
  isVisible?: () => boolean;
  /** Test seam for the poll cadence. */
  pollIntervalMs?: number;
  /** Test seam for the countdown and both expiry decisions. */
  now?: () => number;
  /**
   * §6.1: the dialog closes itself once the pairing settles. Hosts that want to
   * keep the result on screen pass `false` and read `onFinished`.
   */
  autoClose?: boolean;
  /** Test seam for the clipboard; defaults to `navigator.clipboard`. */
  writeClipboard?: (text: string) => Promise<void>;
  onClose: () => void;
  /** Fired with the new client id when the operator redeems the code. */
  onConnected?: (clientId: string) => void;
  /** Any close reason, so the host can refresh its own instance list. */
  onFinished?: (reason: PairingCloseReason) => void;
  labels?: Partial<PairingText>;
}

export interface PairingController {
  text: PairingText;
  model: PairingModel;
  refusal: string;
  shownError: string;
  secondsLeft: number | null;
  countdown: string;
  expired: boolean;
  creatable: boolean;
  seenPending: boolean;
  create: () => Promise<void>;
  cancel: (id: string) => Promise<void>;
  copy: () => Promise<void>;
  restart: () => void;
  close: () => void;
  dispatch: Dispatch<PairingAction>;
}

export function usePairingDialog(props: PairingDialogProps): PairingController {
  const text = useMemo(() => resolvePairingText(props.labels), [props.labels]);
  const runtime = props.runtime ?? DEFAULT_RUNTIME;
  const now = props.now ?? DEFAULT_CLOCK;
  const [model, dispatch] = useReducer(pairingReducer, undefined, () =>
    initialPairingModel((props.now ?? DEFAULT_CLOCK)()),
  );
  const live = usePairingLive(props, runtime, now, model);

  const announce = usePairingAnnounce(live, dispatch);
  const refreshPending = usePendingRefresh(live, dispatch);
  usePairingOpen(live, dispatch, refreshPending);
  usePairingWatch(live, dispatch, announce);
  usePairingClock(live, dispatch, announce);
  usePairingQr(live, dispatch);

  const create = usePairingCreate(live, dispatch, refreshPending);
  const cancel = usePairingCancel(live, dispatch, refreshPending);
  return {
    text,
    model,
    ...pairingDerived(live),
    create,
    cancel,
    copy: usePairingCopy(live, dispatch),
    restart: usePairingRestart(live, dispatch, refreshPending),
    close: usePairingClose(live, dispatch, cancel),
    dispatch,
  };
}

/** What the view derives from the model; cheap enough to redo each render. */
function pairingDerived(
  live: PairingLive,
): Pick<
  PairingController,
  'refusal' | 'shownError' | 'secondsLeft' | 'countdown' | 'expired' | 'creatable' | 'seenPending'
> {
  const model = live.model;
  const plan = planPairingRequest(
    model.scope,
    model.transports ?? { local: '', lan: null, relayAvailable: false },
    model.label,
    model.relayFallback,
  );
  const secondsLeft =
    model.created === null ? null : secondsUntil(model.created.expiresAt, model.tick);
  return {
    refusal: plan.ok ? '' : scopeRefusalMessage(plan.reason),
    shownError: model.error !== '' ? model.error : model.qrError,
    secondsLeft,
    countdown: formatCountdown(secondsLeft),
    expired: model.created !== null && model.closeReason === 'expired',
    creatable: plan.ok && !model.creating && live.props.pairingAvailable !== false,
    seenPending:
      model.created !== null && model.pending.some((row) => row.id === model.created?.pairingId),
  };
}

/**
 * Exactly one announcement per pairing, whichever path reaches it first: the
 * watcher's state machine, its settled promise, or local expiry (§5.3).
 */
function usePairingAnnounce(
  live: PairingLive,
  dispatch: Dispatch<PairingAction>,
): (reason: PairingCloseReason, clientId: string | null) => void {
  return useCallback((reason: PairingCloseReason, clientId: string | null): void => {
    if (live.announced) return;
    live.announced = true;
    dispatch({ type: 'closed', reason });
    if (reason === 'redeemed' && clientId !== null) live.props.onConnected?.(clientId);
    live.props.onFinished?.(reason);
    if (live.props.autoClose ?? true) live.props.onClose();
  }, [dispatch, live]);
}

async function loadTransports(live: PairingLive, dispatch: Dispatch<PairingAction>): Promise<void> {
  const flow = live.flow;
  try {
    const found = await fetchPairingTransports(live.runtime);
    if (flow !== live.flow) return;
    dispatch({ type: 'transports', transports: found, error: '' });
  } catch (caught) {
    if (flow !== live.flow) return;
    dispatch({ type: 'transports', transports: null, error: describePairingError(caught) });
  }
}

/** §6.1 step 5: refresh the pending list; a failure keeps the rows on screen. */
function usePendingRefresh(
  live: PairingLive,
  dispatch: Dispatch<PairingAction>,
): () => Promise<void> {
  return useCallback(async (): Promise<void> => {
    const flow = live.flow;
    try {
      const rows = await listPendingPairings(live.runtime);
      if (flow !== live.flow) return;
      dispatch({ type: 'pending', rows });
    } catch {
      // Silent mode (§6.1 step 5): keep whatever the list already showed.
    }
  }, [dispatch, live]);
}

/** Opening resets the phase, then asks the server how it can be reached. */
function usePairingOpen(
  live: PairingLive,
  dispatch: Dispatch<PairingAction>,
  refreshPending: () => Promise<void>,
): void {
  const { open } = live.props;
  useEffect(() => {
    // The previous pairing is over, whatever the host did to get here.
    live.stop();
    live.flow += 1;
    live.creating = false;
    live.announced = false;
    dispatch({ type: 'reset', now: live.now() });
    if (!open) return;
    void loadTransports(live, dispatch);
    void refreshPending();
    // Keyed on `open`: every other value is read through `live`.
  }, [dispatch, live, open, refreshPending]);
}

/** §6.1 steps 2-4: plan the scope, mint the session, build its link. */
function usePairingCreate(
  live: PairingLive,
  dispatch: Dispatch<PairingAction>,
  refreshPending: () => Promise<void>,
): () => Promise<void> {
  return useCallback(async (): Promise<void> => {
    // A second click while the create request is in flight would mint a second
    // pairing session and orphan the first one's poller. The flag is set here,
    // synchronously, because the model only learns about it after React has
    // processed the dispatch below.
    if (live.creating) return;
    const scope = live.model.scope;
    const transports = live.model.transports ?? { local: '', lan: null, relayAvailable: false };
    const label = live.model.label;
    const relayFallback = live.model.relayFallback;
    // The refusal line beside the radios comes from the derived plan, so a
    // submit that races a scope change simply does nothing.
    if (!planPairingRequest(scope, transports, label, relayFallback).ok) return;
    live.stop();
    live.announced = false;
    live.creating = true;
    live.flow += 1;
    dispatch({ type: 'createStart', now: live.now() });
    const flow = live.flow;
    try {
      const result = await createPairingLink({ scope, transports, label, relayFallback }, live.runtime);
      live.creating = false;
      if (flow !== live.flow) return;
      dispatch({
        type: 'createOk',
        created: describeCreated(result.response, result.link),
        now: live.now(),
      });
      void refreshPending();
    } catch (caught) {
      live.creating = false;
      if (flow !== live.flow) return;
      dispatch({ type: 'createFailed', error: describePairingError(caught) });
    }
  }, [dispatch, live, refreshPending]);
}

/** §6.1 step 9: drop a pending session; the watcher reads it as cancelled. */
function usePairingCancel(
  live: PairingLive,
  dispatch: Dispatch<PairingAction>,
  refreshPending: () => Promise<void>,
): (id: string) => Promise<void> {
  return useCallback(async (id: string): Promise<void> => {
    const flow = live.flow;
    try {
      await cancelPairingSession(id, live.runtime);
      await refreshPending();
      // The watcher sees "seen pending, now absent" and closes as cancelled.
    } catch (caught) {
      if (flow !== live.flow) return;
      dispatch({ type: 'createFailed', error: describePairingError(caught) });
    }
  }, [dispatch, live, refreshPending]);
}

/** §6.1 step 10: copy the link, and be honest when the clipboard refuses. */
function usePairingCopy(
  live: PairingLive,
  dispatch: Dispatch<PairingAction>,
): () => Promise<void> {
  return useCallback(async (): Promise<void> => {
    const link = live.model.created?.link ?? '';
    if (link === '') return;
    try {
      await (live.props.writeClipboard ?? defaultWriteClipboard)(link);
      dispatch({ type: 'copied', state: 'copied' });
    } catch {
      dispatch({ type: 'copied', state: 'failed' });
    }
  }, [dispatch, live]);
}

function usePairingRestart(
  live: PairingLive,
  dispatch: Dispatch<PairingAction>,
  refreshPending: () => Promise<void>,
): () => void {
  return useCallback((): void => {
    live.stop();
    live.creating = false;
    live.announced = false;
    live.flow += 1;
    dispatch({ type: 'reset', now: live.now() });
    void loadTransports(live, dispatch);
    void refreshPending();
  }, [dispatch, live, refreshPending]);
}

function usePairingClose(
  live: PairingLive,
  dispatch: Dispatch<PairingAction>,
  cancel: (id: string) => Promise<void>,
): () => void {
  return useCallback((): void => {
    const model = live.model;
    if (model.phase === 'result' && model.closeReason === null && model.created !== null) {
      // Closing a live pairing is the operator cancelling it: the row stays
      // pending until we ask the server to drop it (§6.1 step 9).
      void cancel(model.created.pairingId);
      announceClosed(live, dispatch, 'cancelled');
    }
    // Stop the poller synchronously rather than waiting for the unmount
    // `onClose` triggers; a 5 s tick must not fire against a dead dialog.
    live.stop();
    live.flow += 1;
    live.props.onClose();
  }, [cancel, dispatch, live]);
}

/**
 * The operator's own close: the reason is already decided by their click, so
 * this does not run the auto-close path — `onClose` is one line below it.
 */
function announceClosed(
  live: PairingLive,
  dispatch: Dispatch<PairingAction>,
  reason: PairingCloseReason,
): void {
  if (live.announced) return;
  live.announced = true;
  dispatch({ type: 'closed', reason });
  live.props.onFinished?.(reason);
}

/**
 * §6.1 steps 5 + 8: one watcher per created pairing. The rows the list shows
 * come from the same poll its state machine consumed, so the list can never
 * disagree with the close decision.
 */
function usePairingWatch(
  live: PairingLive,
  dispatch: Dispatch<PairingAction>,
  announce: (reason: PairingCloseReason, clientId: string | null) => void,
): void {
  const pairingId = live.model.created?.pairingId ?? '';
  const expiresAt = live.model.created?.expiresAt ?? '';
  const settled = live.model.closeReason !== null;
  const { isVisible, pollIntervalMs } = live.props;
  useEffect(() => {
    if (pairingId === '' || settled) return;
    let alive = true;
    let pollClients: readonly RemoteClientRow[] = [];
    const watcher = startPairingWatcher(pairingId, expiresAt, {
      runtime: live.runtime,
      intervalMs: pollIntervalMs ?? PAIRING_POLL_INTERVAL_MS,
      isVisible,
      onPoll: (poll: PairingPollResult) => {
        if (!alive) return;
        if (poll.clients !== undefined) pollClients = poll.clients;
        if (poll.pending !== undefined) dispatch({ type: 'pending', rows: poll.pending });
      },
      onState: (watch: PairingWatchState) => {
        if (!alive || watch.closed === null) return;
        announce(watch.closed, livePairingClient(watch, pollClients)?.id ?? null);
      },
    });
    live.stop = watcher.stop;
    void watcher.done.then((watch: PairingWatchState) => {
      // `closed === null` means stop() ran: the host already knows.
      if (!alive || watch.closed === null) return;
      announce(watch.closed, livePairingClient(watch, pollClients)?.id ?? null);
    });
    return () => {
      alive = false;
      watcher.stop();
    };
  }, [announce, dispatch, expiresAt, isVisible, live, pairingId, pollIntervalMs, settled]);
}

/**
 * One timer drives the countdown label and the local expiry guard. Past
 * `expiresAt` the code cannot be redeemed (§5.3), so the QR is dropped, the
 * poller is stopped, and the stale dialog closes.
 */
function usePairingClock(
  live: PairingLive,
  dispatch: Dispatch<PairingAction>,
  announce: (reason: PairingCloseReason, clientId: string | null) => void,
): void {
  const expiresAt = live.model.created?.expiresAt ?? '';
  const settled = live.model.closeReason !== null;
  const { tick } = live.model;
  useEffect(() => {
    if (expiresAt === '' || settled) return;
    const timer = window.setInterval(
      () => dispatch({ type: 'tick', now: live.now() }),
      PAIRING_COUNTDOWN_INTERVAL_MS,
    );
    return () => window.clearInterval(timer);
  }, [dispatch, expiresAt, live, settled]);

  useEffect(() => {
    if (expiresAt === '' || settled) return;
    const remaining = secondsUntil(expiresAt, tick);
    if (remaining === null || remaining > 0) return;
    announce('expired', null);
  }, [announce, expiresAt, settled, tick]);
}

/**
 * The QR is rendered for exactly the link we offer as text, and only while it
 * can still be redeemed. A failed render clears the image rather than keeping
 * the previous code, which may already be spent.
 */
function usePairingQr(live: PairingLive, dispatch: Dispatch<PairingAction>): void {
  const link = live.model.created?.link ?? '';
  const settled = live.model.closeReason !== null;
  const { renderQr } = live.props;
  const encodedRef = useRef('');
  useEffect(() => {
    if (link === '' || settled) return;
    // The link is unique per pairing, so this is "already encoded this code".
    if (encodedRef.current === link) return;
    encodedRef.current = link;
    const flow = live.flow;
    let cancelled = false;
    void (async () => {
      try {
        const renderer = renderQr === undefined ? await browserQrRenderer() : renderQr;
        const outcome = await renderPairingQr(link, renderer);
        if (cancelled || flow !== live.flow) return;
        dispatch(
          outcome.ok
            ? { type: 'qr', dataUrl: outcome.dataUrl, error: '' }
            : { type: 'qr', dataUrl: null, error: outcome.error.message },
        );
      } catch (caught) {
        if (cancelled || flow !== live.flow) return;
        dispatch({ type: 'qr', dataUrl: null, error: describePairingError(caught) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dispatch, link, live, renderQr, settled]);
}

export default usePairingDialog;
