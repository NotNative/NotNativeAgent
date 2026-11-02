// SPDX-License-Identifier: Apache-2.0
/**
 * Shared visual primitives (docs/planning/desktop-ui-visual-system.md §5).
 *
 * Invariant: every surface in the desktop UI is built from these components,
 * and these components carry no colour, no pixel font size, and no shadow of
 * their own. The class names they use resolve against the visual-system layer
 * (styles/visual-system.css), which draws from the theme's tone ladder. A
 * variant that differs is expressed as a data attribute, never as a literal.
 *
 * Security: a tone is always passed in from structured state (a status code,
 * a severity field, a parsed block prop). Nothing here infers a tone from
 * text.
 */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

export function toneAttribute(tone: Tone | undefined): 'info' | 'success' | 'warning' | 'error' | undefined {
  return tone === undefined || tone === 'neutral' ? undefined : tone;
}

/** Raised control: the base for every button-shaped surface. */
export function Button({ variant = 'secondary', className = '', children, ...rest }: {
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive';
} & ButtonHTMLAttributes<HTMLButtonElement>): ReactNode {
  const shape = variant === 'primary'
    ? 'ui-raised ui-raised-primary'
    : variant === 'destructive'
      ? 'ui-raised ui-raised-destructive'
      : variant === 'outline'
        ? 'ui-raised'
        : variant === 'ghost'
          ? ''
          : 'ui-raised';
  return (
    <button
      type="button"
      data-variant={variant}
      className={`${shape} inline-flex items-center justify-center gap-2 rounded-[var(--radius-control)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--type-ui-label)] leading-[var(--type-line)] ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Field: the only shaped text entry. */
export function Input({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>): ReactNode {
  return (
    <input
      className={`ui-field h-9 w-full rounded-[var(--radius-control)] px-[var(--space-3)] text-[length:var(--type-meta)] leading-[var(--type-line)] outline-none ${className}`}
      {...rest}
    />
  );
}

export function Textarea({ className = '', ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>): ReactNode {
  return (
    <textarea
      className={`ui-field min-h-16 w-full resize-y rounded-[var(--radius-control)] p-[var(--space-3)] text-[length:var(--type-meta)] leading-[var(--type-line)] outline-none ${className}`}
      {...rest}
    />
  );
}

/**
 * A slider on the field geometry. The track is the shared bar: a chosen value
 * is a tone step, not the accent, so it never competes with a primary button.
 */
export function Slider({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>): ReactNode {
  return (
    <input
      type="range"
      className={`ui-field h-6 w-full appearance-none rounded-[var(--radius-pill)] bg-transparent accent-[var(--focus-field)] ${className}`}
      {...rest}
    />
  );
}

/** Tile: a flat chooser. Chosen is the selection fill. */
export function Tile({ chosen = false, className = '', children, ...rest }: {
  chosen?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>): ReactNode {
  return (
    <button
      type="button"
      aria-pressed={chosen}
      data-chosen={chosen ? '' : undefined}
      className={`ui-tile flex items-center gap-2 rounded-[var(--radius-control)] px-[var(--space-3)] py-[var(--space-2)] text-start text-[length:var(--type-meta)] leading-[var(--type-line)] ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Badge({ label, tone, className = '' }: { label: string; tone?: Tone; className?: string }): ReactNode {
  return (
    <span className={`ui-badge w-fit ${className}`} data-tone={toneAttribute(tone)}>
      {label}
    </span>
  );
}

/**
 * Callout. Warning and error are banners with their title in the tone; info
 * and success are an icon and text, so several notes do not become stripes.
 */
export function Callout({ tone = 'neutral', title, children }: { tone?: Tone; title?: string; children?: ReactNode }): ReactNode {
  return (
    <div className="ui-callout flex gap-2" data-tone={toneAttribute(tone)}>
      <div className="min-w-0 flex-1">
        {title !== undefined ? <div className="ui-callout-title">{title}</div> : null}
        {children !== undefined ? <div className="text-foreground">{children}</div> : null}
      </div>
    </div>
  );
}

export function Box({ children, className = '' }: { children: ReactNode; className?: string }): ReactNode {
  return <div className={`ui-box ${className}`}>{children}</div>;
}

export function Bar({ value, max = 100, color }: { value: number; max?: number; color?: string }): ReactNode {
  const bounded = Math.min(Math.max(value, 0), max);
  const share = max > 0 ? Math.round((bounded / max) * 1000) / 10 : 0;
  return (
    <div className="ui-bar" data-value={share} style={color ? { '--color': color } as React.CSSProperties : undefined}>
      <span style={{ '--value': `${share}%` } as React.CSSProperties} />
    </div>
  );
}

export function Dot({ color }: { color?: string }): ReactNode {
  return <span className="ui-dot" aria-hidden style={color ? { '--color': color } as React.CSSProperties : undefined} />;
}

/** A labelled row: the only way a status surface presents a value. */
export function Row({ icon, label, value, tone }: {
  icon?: ReactNode;
  label: string;
  value?: ReactNode;
  tone?: Tone;
}): ReactNode {
  return (
    <div className="ui-row" data-tone={toneAttribute(tone)}>
      {icon !== undefined ? <span className="shrink-0 text-muted-foreground" aria-hidden>{icon}</span> : null}
      <span className="ui-row-label min-w-0 truncate">{label}</span>
      {value !== undefined ? <span className="ui-row-value">{value}</span> : null}
    </div>
  );
}

/**
 * Disclosure: the one geometry for reasoning, tool calls, and folded sections.
 * The connector is a click target of its own, so a reader can open the block
 * from the line as well as from its header.
 */
export function Disclosure({ title, open, onToggle, children, className = '' }: {
  title: ReactNode;
  open: boolean;
  onToggle: () => void;
  children?: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <div className={`ui-disclosure ${className}`} aria-expanded={open}>
      <button
        type="button"
        data-disclosure-connector=""
        aria-label={open ? 'Collapse' : 'Expand'}
        aria-expanded={open}
        onClick={onToggle}
        className="cursor-pointer border-0 bg-transparent"
      />
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-fit items-center gap-1 text-start text-[length:var(--type-meta)] font-medium text-foreground/80 transition-colors hover:text-foreground"
      >
        <span className="ui-disclosure-chevron inline-block" aria-hidden>&#x203A;</span>
        <span className="min-w-0 truncate">{title}</span>
      </button>
      {open && children !== undefined ? <div className="mt-[var(--space-2)] flex flex-col gap-2">{children}</div> : null}
    </div>
  );
}

/** A floating surface. Opaque when always on screen; glass when transient. */
export function Floating({ glass = false, className = '', children }: { glass?: boolean; className?: string; children: ReactNode }): ReactNode {
  return <div className={`${glass ? 'ui-floating-glass' : 'ui-floating'} ${className}`}>{children}</div>;
}
