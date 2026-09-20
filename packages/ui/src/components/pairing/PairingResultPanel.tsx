// SPDX-License-Identifier: Apache-2.0
/**
 * The result half of `PairingDialog` (doc 08 §5.8/§5.10 + §6.1 steps 5-8).
 *
 * Renders the QR, the manual link, the countdown, and whatever the watcher has
 * decided so far. Everything is a prop: the dialog owns the encode, the poll,
 * and the clipboard, and this file only presents their current values. The
 * one-time pairing secret deliberately never reaches this file — it is only
 * needed to build the QR, which the dialog has already done. Split out for the
 * repository length gate.
 */
import { QR_RENDER_OPTIONS } from '../../lib/pairing-qr.ts';
import type { PairingCloseReason } from '../../lib/pairing-watch.ts';
import { closeReasonMessage, type PairingText } from './pairingText.ts';

export interface PairingResultPanelProps {
  text: PairingText;
  /** The issuing server's own label (§6.1 step 4). */
  serverLabel: string;
  fingerprint: string;
  usesRelay: boolean;
  /** The assembled link: the manual fallback when the QR cannot be scanned. */
  link: string;
  /** Null when the server's expiry stamp is unusable: no countdown, no expiry claim. */
  secondsLeft: number | null;
  countdown: string;
  expired: boolean;
  qrDataUrl: string | null;
  qrError: string;
  /** The watcher's decision, once there is one. */
  closeReason: PairingCloseReason | null;
  /** True once the created session appears in the pending list (§6.1 step 5). */
  seenPending: boolean;
  error: string;
  copyState: 'idle' | 'copied' | 'failed';
  onCopy: () => void;
}

/** The QR is encoded at 1024 px (§5.8) and downscaled here for legibility. */
const QR_DISPLAY_PX = 192;

type Shared = { props: PairingResultPanelProps };

export function PairingResultPanel(props: PairingResultPanelProps) {
  const { text } = props;
  return (
    <section className="flex flex-col gap-3" data-testid="pairing-result">
      <PairingResultHeader props={props} />
      {props.expired ? (
        <div className="rounded border border-border/60 bg-muted px-3 py-2 text-xs text-muted-foreground" data-testid="pairing-expired">
          {text.expired}
        </div>
      ) : (
        <PairingQrBlock props={props} />
      )}
      <PairingStatusLine props={props} />
      {props.error !== '' ? (
        <div className="rounded border border-status-error/40 bg-status-error/10 px-3 py-2 text-xs text-status-error" data-testid="pairing-error">
          {props.error}
        </div>
      ) : null}
    </section>
  );
}

function PairingResultHeader({ props }: Shared) {
  const { text } = props;
  return (
    <div className="flex flex-row flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
      <span data-testid="pairing-server-label">{props.serverLabel}</span>
      <span>{text.fingerprintPrefix} {props.fingerprint}</span>
      {props.usesRelay ? (
        <span className="rounded-full border border-border/60 px-1.5 py-0.5">{text.viaRelay}</span>
      ) : null}
      <span data-testid="pairing-countdown">
        {props.secondsLeft === null ? '' : props.expired ? text.expiresNow : `${text.expiresPrefix} ${props.countdown}`}
      </span>
    </div>
  );
}

/**
 * §5.10: the QR is the convenience and the printed link is the guarantee. A
 * browser whose canvas cannot produce the data URL still gets a copyable link
 * plus the reason the picture is missing.
 */
function PairingQrBlock({ props }: Shared) {
  const { text } = props;
  return (
    <div className="flex flex-row flex-wrap gap-3">
      {props.qrDataUrl === null ? (
        <div
          className="flex items-center justify-center rounded border border-border/60 text-[11px] text-muted-foreground"
          data-testid="pairing-qr-placeholder"
          style={{ width: '192px', height: '192px' }}
        >
          {props.qrError === '' ? text.qrPending : text.qrUnavailable}
        </div>
      ) : (
        <img
          data-testid="pairing-qr"
          data-qr-size={QR_RENDER_OPTIONS.width}
          data-qr-error-level={QR_RENDER_OPTIONS.errorCorrectionLevel}
          src={props.qrDataUrl}
          width={QR_DISPLAY_PX}
          height={QR_DISPLAY_PX}
          alt={text.qrAlt}
          className="rounded border border-border/60 bg-white"
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="m-0 break-all font-mono text-[11px] text-muted-foreground" data-testid="pairing-link">
          {props.link}
        </p>
        <div className="flex flex-row items-center gap-2">
          <button
            type="button"
            className="rounded border border-border/60 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
            data-testid="pairing-copy"
            onClick={props.onCopy}
          >
            {props.copyState === 'copied' ? text.copied : text.copy}
          </button>
          {props.copyState === 'failed' ? (
            <span className="text-[11px] text-status-error" data-testid="pairing-copy-failed">
              {text.copyFailed}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * §6.1 step 5: until the created session shows up in the pending list the
 * dialog says it is waiting for that list, not for the device, because the
 * device may already have redeemed and lost the race to the next poll.
 */
function PairingStatusLine({ props }: Shared) {
  const { text } = props;
  return (
    <div className="flex flex-row items-center gap-2 text-[11px] text-muted-foreground">
      {props.closeReason !== null ? (
        <span data-testid="pairing-close-reason">{closeReasonMessage(props.closeReason)}</span>
      ) : props.expired ? null : (
        <span data-testid="pairing-waiting">
          {props.seenPending ? text.waiting : text.waitingForList}
        </span>
      )}
    </div>
  );
}

export default PairingResultPanel;
