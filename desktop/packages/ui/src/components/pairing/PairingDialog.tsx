// SPDX-License-Identifier: Apache-2.0
/**
 * Pairing dialog shell (doc 08 §6.1, §5.8, §5.10).
 *
 * Presentation only: `usePairingDialog` owns the transports fetch, the scope
 * plan, the create request, the 5 s poll, the QR encode and the countdown, and
 * `PairingScopeForm` / `PairingResultPanel` own the markup for the two halves.
 * What is left here is the overlay, the disabled-pairing notice, and which half
 * to show.
 *
 * The dialog is mounted by the host and driven entirely by `open`; it never
 * decides to exist on its own, so a closed dialog holds no poller and no timer.
 */
import type { ReactNode } from 'react';
import PairingResultPanel from './PairingResultPanel.tsx';
import PairingScopeForm from './PairingScopeForm.tsx';
import { usePairingDialog, type PairingDialogProps } from './usePairingDialog.ts';
import type { PairingController } from './usePairingDialog.ts';

export type { PairingDialogProps } from './usePairingDialog.ts';

export function PairingDialog(props: PairingDialogProps): ReactNode {
  const controller = usePairingDialog(props);
  const { model, text } = controller;

  // The dialog is driven entirely by `open` (§6.1): a closed dialog holds no
  // poller, no timer, and renders no overlay. The hooks above still run —
  // that is what stops the watcher when a host flips `open` to false.
  if (props.open !== true) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-testid="pairing-dialog">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={text.title}
        className="flex max-h-[85vh] w-full max-w-[560px] flex-col gap-3 overflow-auto rounded-lg border border-border/60 bg-card p-4 shadow-2xl"
      >
        <div className="flex flex-col gap-1">
          <div className="text-sm font-medium text-foreground">{text.title}</div>
          <div className="text-xs text-muted-foreground">{text.description}</div>
        </div>

        {props.pairingAvailable === false ? (
          <div className="rounded border border-status-error/40 bg-status-error/10 px-3 py-2 text-xs text-status-error" data-testid="pairing-disabled">
            {text.disabled}
          </div>
        ) : null}

        {model.phase === 'loading' ? (
          <div className="text-xs text-muted-foreground">{text.transportsLoading}</div>
        ) : null}

        {model.phase === 'form' ? <PairingFormBranch controller={controller} /> : null}

        {model.phase === 'result' && model.created !== null ? (
          <PairingResultBranch controller={controller} />
        ) : null}

        <PairingActionRow controller={controller} />
      </div>
    </div>
  );
}

/** §6.1 steps 1-2 and 8: the scope radios, the label, and the pending list. */
function PairingFormBranch({ controller }: { controller: PairingController }): ReactNode {
  const { model, dispatch } = controller;
  return (
    <PairingScopeForm
      text={controller.text}
      scope={model.scope}
      label={model.label}
      relayFallback={model.relayFallback}
      creating={model.creating}
      creatable={controller.creatable}
      refusal={controller.refusal}
      error={controller.shownError}
      pending={model.pending}
      onScopeChange={(scope) => dispatch({ type: 'scope', scope })}
      onLabelChange={(label) => dispatch({ type: 'label', label })}
      onRelayFallbackChange={(value) => dispatch({ type: 'relayFallback', value })}
      onCancelPending={(id) => void controller.cancel(id)}
      onSubmit={() => void controller.create()}
    />
  );
}

/** §6.1 steps 3-7: the QR, the manual link, the countdown and the outcome. */
function PairingResultBranch({ controller }: { controller: PairingController }): ReactNode {
  const { model } = controller;
  const created = model.created;
  if (created === null) return null;
  return (
    <PairingResultPanel
      text={controller.text}
      serverLabel={created.serverLabel}
      fingerprint={created.fingerprint}
      usesRelay={created.usesRelay}
      link={created.link}
      secondsLeft={controller.secondsLeft}
      countdown={controller.countdown}
      expired={controller.expired}
      qrDataUrl={model.qrDataUrl}
      qrError={model.qrError}
      closeReason={model.closeReason}
      seenPending={controller.seenPending}
      error={controller.shownError}
      copyState={model.copyState}
      onCopy={() => void controller.copy()}
    />
  );
}

/**
 * `newPairing` restarts the flow in place; `close` is the one button that may
 * still be live while a pairing is pending, and the controller cancels it.
 */
function PairingActionRow({ controller }: { controller: PairingController }): ReactNode {
  const { model, text } = controller;
  return (
    <div className="flex flex-row justify-end gap-2">
      {model.phase === 'result' ? (
        <button
          type="button"
          className="rounded bg-primary/20 px-3 py-1 text-xs text-primary"
          data-testid="pairing-new"
          onClick={controller.restart}
        >
          {text.newPairing}
        </button>
      ) : null}
      <button
        type="button"
        className="rounded border border-border/60 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
        data-testid="pairing-close"
        onClick={controller.close}
      >
        {text.close}
      </button>
    </div>
  );
}

export default PairingDialog;
