// SPDX-License-Identifier: Apache-2.0
/**
 * The scope form half of `PairingDialog` (doc 08 §6.1 steps 2-4 + step 8 list).
 *
 * Presentational on purpose: every value arrives as a prop and every action
 * leaves as a callback, so the dialog keeps ownership of the transport fetch,
 * the create request, and the poll. Split out for the repository length gate.
 */
import type { PairingScope, PendingPairingRow } from '../../lib/pairing-client.ts';
import {
  LABEL_MAX_LENGTH,
  PAIRING_SCOPE_ORDER,
  type PairingText,
} from './pairingText.ts';

export interface PairingScopeFormProps {
  text: PairingText;
  scope: PairingScope;
  label: string;
  relayFallback: boolean;
  /** The create POST is in flight: the radios and the submit are inert. */
  creating: boolean;
  /** False when the plan cannot be honoured or pairing is off server-side. */
  creatable: boolean;
  /** One line for an unhonourable plan, `''` when the plan is fine. */
  refusal: string;
  error: string;
  pending: readonly PendingPairingRow[];
  onScopeChange: (scope: PairingScope) => void;
  onLabelChange: (label: string) => void;
  onRelayFallbackChange: (value: boolean) => void;
  onCancelPending: (id: string) => void;
  onSubmit: () => void;
}

export function PairingScopeForm(props: PairingScopeFormProps) {
  const { text } = props;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
      className="flex flex-col gap-3"
    >
      <PairingScopeRadios
        text={text}
        scope={props.scope}
        disabled={props.creating}
        onChange={props.onScopeChange}
      />

      <PairingLabelFields
        text={text}
        label={props.label}
        relayFallback={props.relayFallback}
        onLabelChange={props.onLabelChange}
        onRelayFallbackChange={props.onRelayFallbackChange}
      />

      {props.refusal !== '' ? (
        <div className="rounded border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs text-status-warning" data-testid="pairing-refusal">
          {props.refusal}
        </div>
      ) : null}

      {props.error !== '' ? (
        <div className="rounded border border-status-error/40 bg-status-error/10 px-3 py-2 text-xs text-status-error" data-testid="pairing-error">
          {props.error}
        </div>
      ) : null}

      <PairingPendingList
        rows={props.pending}
        title={text.pendingTitle}
        empty={text.pendingEmpty}
        unnamed={text.pendingUnnamed}
        viaRelay={text.viaRelay}
        cancel={text.cancelPending}
        onCancel={props.onCancelPending}
      />

      <div className="flex flex-row items-center gap-2">
        <button
          type="submit"
          className="rounded bg-primary/25 px-3 py-1 text-xs text-primary disabled:opacity-40"
          data-testid="pairing-create"
          disabled={!props.creatable}
        >
          {props.creating ? text.creating : text.create}
        </button>
      </div>
    </form>
  );
}

interface PairingPendingListProps {
  rows: readonly PendingPairingRow[];
  title: string;
  empty: string;
  unnamed: string;
  viaRelay: string;
  cancel: string;
  onCancel: (id: string) => void;
}

/**
 * §6.1 step 8: an existing pending session is shown before a new one is
 * created, so the operator can cancel it here instead of orphaning it.
 */
function PairingPendingList(props: PairingPendingListProps) {
  const { rows, title, empty, unnamed, viaRelay, cancel, onCancel } = props;
  if (rows.length === 0) {
    return <div className="text-[11px] text-muted-foreground">{empty}</div>;
  }
  return (
    <section className="flex flex-col gap-1">
      <h3 className="m-0 text-xs font-medium text-foreground">{title}</h3>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-row items-center gap-2 text-[11px] text-muted-foreground" data-testid="pairing-pending-row">
            <span className="min-w-0 flex-1 truncate">{row.label ?? unnamed}</span>
            {row.usesRelay ? (
              <span className="rounded-full border border-border/60 px-1.5 py-0.5">{viaRelay}</span>
            ) : null}
            <button
              type="button"
              className="rounded border border-border/60 px-2 py-0.5 text-muted-foreground hover:text-foreground"
              data-testid="pairing-cancel-pending"
              onClick={() => onCancel(row.id)}
            >
              {cancel}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The three scope radios (§6.1 step 2). The order is the documented one, and
 * the currently-selected option is never hidden when its plan is refused: the
 * refusal line sits beside the form so the operator can change one radio.
 */
interface PairingScopeRadiosProps {
  text: PairingText;
  scope: PairingScope;
  disabled: boolean;
  onChange: (scope: PairingScope) => void;
}

function PairingScopeRadios(props: PairingScopeRadiosProps) {
  const { text } = props;
  const SCOPE_TEXT = {
    anywhere: { label: text.scopeAnywhereLabel, hint: text.scopeAnywhereHint },
    local: { label: text.scopeLocalLabel, hint: text.scopeLocalHint },
    lan: { label: text.scopeLanLabel, hint: text.scopeLanHint },
  } as const;

  return (
    <fieldset className="flex flex-col gap-2 border-0 p-0">
      <legend className="text-xs font-medium text-foreground">{text.scopeLegend}</legend>
      {PAIRING_SCOPE_ORDER.map((option) => (
        <label key={option} className="flex flex-row items-start gap-2 text-xs text-foreground">
          <input
            className="mt-0.5"
            type="radio"
            name="pairing-scope"
            checked={props.scope === option}
            disabled={props.disabled}
            onChange={() => props.onChange(option)}
          />
          <span className="flex flex-col">
            <span>{SCOPE_TEXT[option].label}</span>
            <span className="text-[11px] text-muted-foreground">{SCOPE_TEXT[option].hint}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/**
 * The optional device label and the relay-fallback checkbox (§6.1 steps 3-4).
 * The label input enforces the create route's own limit rather than letting the
 * server 400 on an over-long name.
 */
interface PairingLabelFieldsProps {
  text: PairingText;
  label: string;
  relayFallback: boolean;
  onLabelChange: (label: string) => void;
  onRelayFallbackChange: (value: boolean) => void;
}

function PairingLabelFields(props: PairingLabelFieldsProps) {
  const { text } = props;
  return (
    <>
      <label className="flex flex-col gap-1 text-xs text-foreground">
        <span>{text.deviceLabel}</span>
        <input
          className="h-8 w-full rounded border border-border/60 bg-interactive-hover/30 px-2 text-xs text-foreground outline-none"
          type="text"
          value={props.label}
          maxLength={LABEL_MAX_LENGTH}
          placeholder={text.deviceLabelPlaceholder}
          onChange={(event) => props.onLabelChange(event.target.value)}
        />
        <span className="text-[11px] text-muted-foreground">{text.deviceLabelHint}</span>
      </label>

      <label className="flex flex-row items-start gap-2 text-xs text-foreground">
        <input
          className="mt-0.5"
          type="checkbox"
          checked={props.relayFallback}
          onChange={() => props.onRelayFallbackChange(!props.relayFallback)}
        />
        <span>{text.relayFallback}</span>
      </label>
    </>
  );
}

export default PairingScopeForm;
