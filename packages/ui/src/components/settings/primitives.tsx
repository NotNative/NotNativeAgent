// SPDX-License-Identifier: Apache-2.0
/**
 * Settings building blocks (doc 14 §A.3): tokenized primitives owning the
 * `settingsItem` DOM anchor convention (data-settings-item="<dotted-id>")
 * that the search jump targets, plus the shared class constants. They own
 * styling only — pages own behavior. Native controls stand in for the Base
 * UI wrappers until that dependency lands (delta E12).
 */
import type { ReactNode } from 'react';

export const SETTINGS_SELECT_TRIGGER_CLASS =
  'h-8 rounded-[7px] border-border/60 bg-interactive-hover/40 px-2 text-xs text-foreground outline-none focus:border-interactive-border-focus disabled:opacity-50';
export const SETTINGS_ICON_BUTTON_CLASS =
  'inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground';
export const SETTINGS_CONTROL_CLUSTER_CLASS = 'flex items-center gap-2';
export const SETTINGS_NUMBER_INPUT_CLASS =
  SETTINGS_SELECT_TRIGGER_CLASS +
  ' w-20 text-right tabular-nums';
export const SETTINGS_FIELD_LABEL_CLASS = 'text-xs font-medium text-foreground';
export const SETTINGS_HELPER_CLASS = 'text-[11px] leading-tight text-muted-foreground';

function anchored(item: string | undefined, className: string, children: ReactNode): ReactNode {
  return (
    <div className={className} data-settings-item={item}>
      {children}
    </div>
  );
}

export function SettingsSection({ title, item, children }: { title?: string; item?: string; children: ReactNode }): ReactNode {
  return (
    <section className="rounded-lg border border-border/40 bg-card/40 p-3" data-settings-item={item} data-settings-section={item ?? undefined}>
      {title !== undefined ? <SettingsGroupTitle>{title}</SettingsGroupTitle> : null}
      <div className="flex flex-col gap-1">{children}</div>
    </section>
  );
}

export function SettingsGroupTitle({ children }: { children: ReactNode }): ReactNode {
  return (
    <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{children}</h3>
  );
}

export function SettingsInset({ children }: { children: ReactNode }): ReactNode {
  return <div className="rounded-md border border-border/30 bg-background/40 p-2">{children}</div>;
}

export function SettingsFieldRow({
  label, item, helper, children,
}: { label: string; item?: string; helper?: string; children: ReactNode }): ReactNode {
  return anchored(
    item,
    'flex min-h-9 items-center justify-between gap-4 rounded px-2 py-1 hover:bg-interactive-hover/30',
    <>
      <div className="min-w-0">
        <div className={SETTINGS_FIELD_LABEL_CLASS}>{label}</div>
        {helper !== undefined ? <div className={SETTINGS_HELPER_CLASS}>{helper}</div> : null}
      </div>
      <div className={SETTINGS_CONTROL_CLUSTER_CLASS}>{children}</div>
    </>,
  );
}

export function SettingsStackedField({
  label, item, helper, children,
}: { label: string; item?: string; helper?: string; children: ReactNode }): ReactNode {
  return anchored(
    item,
    'flex flex-col gap-1.5 rounded px-2 py-1.5 hover:bg-interactive-hover/30',
    <>
      <div className={SETTINGS_FIELD_LABEL_CLASS}>{label}</div>
      {helper !== undefined ? <div className={SETTINGS_HELPER_CLASS}>{helper}</div> : null}
      {children}
    </>,
  );
}

export function SettingsCheckboxRow({
  label, item, helper, checked, disabled, onChange,
}: { label: string; item?: string; helper?: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }): ReactNode {
  return (
    <SettingsFieldRow label={label} item={item} helper={helper}>
      <input
        type="checkbox"
        className="h-4 w-4 accent-[var(--primary)]"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </SettingsFieldRow>
  );
}

export interface SettingsRadioOption {
  value: string;
  label: string;
  helper?: string;
}

export function SettingsRadioGroup({
  item, value, options, onChange,
}: { item?: string; value: string; options: SettingsRadioOption[]; onChange: (value: string) => void }): ReactNode {
  return anchored(item, 'flex flex-col gap-1', options.map((option) => (
    <label key={option.value} className="flex cursor-pointer items-start gap-2 rounded px-1 py-0.5 hover:bg-interactive-hover/20">
      <input
        type="radio"
        className="mt-0.5 h-3.5 w-3.5 accent-[var(--primary)]"
        checked={value === option.value}
        onChange={() => onChange(option.value)}
      />
      <span>
        <span className={SETTINGS_FIELD_LABEL_CLASS}>{option.label}</span>
        {option.helper !== undefined ? <span className={SETTINGS_HELPER_CLASS}> — {option.helper}</span> : null}
      </span>
    </label>
  )));
}

export function SettingsChipGroup({
  item, value, options, onChange,
}: { item?: string; value: string; options: SettingsRadioOption[]; onChange: (value: string) => void }): ReactNode {
  return anchored(
    item,
    'flex flex-wrap gap-1',
    options.map((option) => (
      <button
        key={option.value}
        type="button"
        aria-pressed={value === option.value}
        onClick={() => onChange(option.value)}
        className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
          value === option.value
            ? 'border-primary/60 bg-primary/15 text-primary'
            : 'border-border/60 text-muted-foreground hover:bg-interactive-hover'
        }`}
      >
        {option.label}
      </button>
    )),
  );
}

export interface SettingsSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export function SettingsSelect({
  item, value, options, onChange, resetValue, triggerClass,
}: {
  item?: string;
  value: string;
  options: SettingsSelectOption[];
  onChange: (value: string) => void;
  resetValue?: string;
  triggerClass?: string;
}): ReactNode {
  return anchored(item, SETTINGS_CONTROL_CLUSTER_CLASS,
    <>
      <select
        className={triggerClass ?? SETTINGS_SELECT_TRIGGER_CLASS}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      {resetValue !== undefined ? (
        <button type="button" title="Reset" className={SETTINGS_ICON_BUTTON_CLASS} onClick={() => onChange(resetValue)}>↺</button>
      ) : null}
    </>,
  );
}

export function SettingsNumberInput({
  item, value, min, max, step, unit, onChange, resetValue, disabled,
}: {
  item?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (value: number) => void;
  resetValue?: number;
  disabled?: boolean;
}): ReactNode {
  return anchored(item, SETTINGS_CONTROL_CLUSTER_CLASS,
    <>
      <input
        type="number"
        className={SETTINGS_NUMBER_INPUT_CLASS}
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (!Number.isFinite(next)) return;
          onChange(Math.max(min, Math.min(max, next)));
        }}
      />
      {unit !== undefined ? <span className="text-[11px] text-muted-foreground">{unit}</span> : null}
      {resetValue !== undefined ? (
        <button type="button" title="Reset" className={SETTINGS_ICON_BUTTON_CLASS} onClick={() => onChange(resetValue)}>↺</button>
      ) : null}
    </>,
  );
}

export function SettingsTextInput({
  item, value, max, placeholder, onCommit, resetValue,
}: {
  item?: string;
  value: string;
  max?: number;
  placeholder?: string;
  onCommit: (value: string) => void;
  resetValue?: string;
}): ReactNode {
  return anchored(item, SETTINGS_CONTROL_CLUSTER_CLASS,
    <>
      <input
        type="text"
        className={SETTINGS_SELECT_TRIGGER_CLASS + ' w-56 text-left'}
        value={value}
        placeholder={placeholder}
        maxLength={max}
        onChange={(event) => onCommit(event.target.value)}
      />
      {resetValue !== undefined ? (
        <button type="button" title="Reset" className={SETTINGS_ICON_BUTTON_CLASS} onClick={() => onCommit(resetValue)}>↺</button>
      ) : null}
    </>,
  );
}
