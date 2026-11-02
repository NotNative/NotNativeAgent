// SPDX-License-Identifier: Apache-2.0
/**
 * Literal-to-semantic colour mapping for the desktop UI
 * (docs/planning/desktop-ui-visual-system.md §4, §11).
 *
 * Why: screens grew up assuming the one dark palette that existed when they
 * were written (neutral-900 surfaces, white text, sky-600 primary). Those
 * literals are the reason a theme cannot reach them. Every literal names a
 * role the screen actually meant: a panel behind content, a muted label, a
 * primary action, a live indicator, an error. This module holds that mapping
 * once, so the migration is reviewable here instead of scattered across 70
 * files, and a later screen can read the intent instead of guessing a shade.
 *
 * The mapping ran once to migrate every component and stays as the
 * documented intent plus the sweep gate that fails if a literal returns.
 *
 * Invariant: this mapping is mechanical. It reads a token, never prose.
 */
export type Role =
  | 'surface' | 'surface-raised' | 'surface-input' | 'surface-dialog'
  | 'text' | 'text-muted' | 'text-subtle' | 'text-heading'
  | 'border' | 'border-strong'
  | 'primary' | 'primary-foreground'
  | 'live' | 'success' | 'warning' | 'error' | 'link';

/**
 * Where two families of literal meant the same role, the family decides, not
 * the shade: a neutral-900 input is still an input, not a page.
 */
type Entry = { role: Role; kind: 'text' | 'bg' | 'border' | 'ring' | 'outline' | 'shadow' };

/** Shade intent for the neutral and grey families, which carry the app chrome. */
const NEUTRAL: Record<number, Entry> = {
  950: { role: 'surface-dialog', kind: 'bg' },
  900: { role: 'surface', kind: 'bg' },
  800: { role: 'surface-raised', kind: 'bg' },
  700: { role: 'border', kind: 'border' },
  600: { role: 'border', kind: 'border' },
  500: { role: 'text-subtle', kind: 'text' },
  400: { role: 'text-muted', kind: 'text' },
  300: { role: 'text-muted', kind: 'text' },
  200: { role: 'text', kind: 'text' },
  100: { role: 'text-heading', kind: 'text' },
  50: { role: 'text-heading', kind: 'text' },
};

/**
 * Accent and tone families always mean their tone, whatever the shade: a
 * sky-600 button is the primary action and a rose-400 message is an error.
 */
const TONE_FAMILY: Record<string, Role> = {
  sky: 'primary', blue: 'primary', indigo: 'primary', violet: 'primary',
  amber: 'live', yellow: 'live', orange: 'live',
  emerald: 'success', green: 'success', lime: 'success', teal: 'success',
  rose: 'error', red: 'error', pink: 'error',
};

/**
 * A white or black literal depends on the utility it is used with: white
 * text is text, a white/10 border is an edge, and white/[0.03] behind a chip
 * is a raised surface.
 */
const WHITE_BLACK: Record<'white' | 'black', Record<'text' | 'bg' | 'border' | 'ring' | 'outline', Role>> = {
  white: { text: 'text-heading', bg: 'surface-raised', border: 'border', ring: 'primary', outline: 'primary' },
  black: { text: 'text', bg: 'surface-dialog', border: 'border-strong', ring: 'text', outline: 'text' },
};

const UTILITY_PREFIX: Record<Entry['kind'], string> = {
  text: 'text', bg: 'bg', border: 'border', ring: 'ring', outline: 'outline', shadow: 'shadow',
};

/** The semantic utility class for a role used as one kind of utility. */
export function classFor(role: Role, kind: Entry['kind']): string {
  if (kind === 'text') {
    switch (role) {
      case 'text': return 'text-foreground';
      case 'text-muted': return 'text-muted-foreground';
      case 'text-subtle': return 'text-muted-foreground';
      case 'text-heading': return 'text-foreground';
      case 'primary-foreground': return 'text-primary-foreground';
      case 'primary': return 'text-primary';
      case 'live': return 'text-tone-warning';
      case 'success': return 'text-tone-success';
      case 'warning': return 'text-tone-warning';
      case 'error': return 'text-tone-error';
      case 'link': return 'text-primary';
      default: return 'text-foreground';
    }
  }
  if (kind === 'bg') {
    switch (role) {
      case 'surface': return 'bg-background';
      case 'surface-raised': return 'bg-card';
      case 'surface-input': return 'bg-surface-recessed';
      case 'surface-dialog': return 'bg-popover';
      case 'primary': return 'bg-primary';
      case 'live': return 'bg-tone-warning';
      case 'success': return 'bg-tone-success';
      case 'warning': return 'bg-tone-warning';
      case 'error': return 'bg-tone-error';
      case 'link': return 'bg-primary';
      default: return 'bg-card';
    }
  }
  if (kind === 'border' || kind === 'ring' || kind === 'outline') {
    const map: Record<Role, string> = {
      surface: 'border-border', 'surface-raised': 'border-border', 'surface-input': 'border-border', 'surface-dialog': 'border-border',
      text: 'border-border', 'text-muted': 'border-border', 'text-subtle': 'border-border', 'text-heading': 'border-border',
      border: 'border-border', 'border-strong': 'border-border',
      primary: 'border-border', 'primary-foreground': 'border-primary-foreground',
      live: 'border-tone-warning-border', success: 'border-tone-success-border',
      warning: 'border-tone-warning-border', error: 'border-tone-error-border', link: 'border-primary',
    };
    const base = map[role] ?? 'border-border';
    const withoutPrefix = base.startsWith('border-') ? base.slice('border-'.length) : base;
    return `${kind}-${withoutPrefix}`;
  }
  return 'shadow-none';
}

/** The mapping's shape, for a reviewer reading this module's intent. */
export type Mapping = { literal: string; role: Role };

/** Every literal the mapping recognises, longest first so prefixes win. */
const LITERAL = String.raw`(?<![\w-])(text|bg|border|ring|outline|shadow)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(50|100|200|300|400|500|600|700|800|900|950)(?![\d])`;
const WHITE_BLACK_LITERAL = String.raw`(?<![\w-])(text|bg|border|ring|outline)-(white|black)(?![\d])`;

/**
 * Rewrite every literal in a source string. A literal with an opacity suffix
 * (`bg-neutral-900/40`) becomes an arbitrary-opacity class on its semantic
 * class, because the intent is a lighter step of the same role.
 */
/**
 * A tone's fill always takes an explicit low alpha, because the literal's
 * shade (red-950 against red-300) said "a tint, not the colour", and a
 * full-strength tone fill would read as a banner stripe. The primary action
 * is the exception: a filled button is drawn at full strength.
 */
const TONE_ALPHA = 18;

export function rewriteLiterals(source: string): string {
  let result = source.replace(new RegExp(LITERAL, 'gu'), (whole, kind: Entry['kind'], family: string, shade: string) => {
    const toneRole = TONE_FAMILY[family];
    if (toneRole !== undefined) {
      if (kind === 'bg') {
        return toneRole === 'primary' ? classFor(toneRole, 'bg') : `${classFor(toneRole, 'bg')}/${TONE_ALPHA}`;
      }
      return classFor(toneRole, kind);
    }
    const entry = NEUTRAL[Number(shade)];
    if (entry === undefined) return whole;
    // A neutral background at a mid or light shade is a dot, a divider, or a
    // hover tint on a page, not a card: only the darkest shades carry a
    // surface role.
    if (kind === 'bg' && Number(shade) <= 500) return 'bg-muted-foreground';
    return classFor(entry.role, kind);
  });
  result = result.replace(new RegExp(WHITE_BLACK_LITERAL, 'gu'), (whole, kind: 'text' | 'bg' | 'border' | 'ring' | 'outline', color: 'white' | 'black') =>
    classFor(WHITE_BLACK[color][kind], kind));
  // A literal shade already replaced by a tone alpha keeps the opacity the
  // author wrote: `bg-red-950/30` meant a faint error tint, and the tone token
  // supplies the hue the author's shade was standing in for.
  result = result.replace(/\b((?:text|bg|border)-[a-z][\w-]*?)\/(\d{1,3})\/(\d{1,3})\b/gu, (_whole, cls: string, _tone: string, opacity: string) =>
    `${cls}/${opacity}`);
  return result;
}

/** The literals a source still contains, for reporting and for gates. */
export function remainingLiterals(source: string): string[] {
  return [...source.matchAll(new RegExp(`${LITERAL}|${WHITE_BLACK_LITERAL}`, 'gu'))].map((match) => match[0]);
}

/**
 * A pixel or rem font size names a role the screen meant, not a number. The
 * scale keeps one size per role: micro chrome (counters, dense rows), meta
 * labels, the UI label, body text, and the code size.
 */
const FONT_ROLES: Record<string, string> = {
  '9px': '--type-micro',
  '10px': '--type-micro',
  '10.5px': '--type-micro',
  '11px': '--type-meta',
  '11.5px': '--type-meta',
  '12px': '--type-meta',
  '13px': '--type-markdown',
  '14px': '--type-markdown',
  '0.875rem': '--type-markdown',
  '0.8125rem': '--type-meta',
  '0.75rem': '--type-code',
};

/** Rewrite a pixel font size as its type role. */
export function rewriteFontSizes(source: string): string {
  return source.replace(/text-\[(\d*\.?\d+(?:px|rem))\]/gu, (whole, size: string) => {
    const role = FONT_ROLES[size];
    return role === undefined ? whole : `text-[length:var(${role})]`;
  });
}

/** The pixel font sizes a source still contains. */
export function remainingFontSizes(source: string): string[] {
  return [...source.matchAll(/text-\[(\d*\.?\d+(?:px|rem))\]/gu)].map((match) => match[0]);
}

/** A bare pixel radius names the shared control geometry. */
export function rewriteRadii(source: string): string {
  return source.replace(/rounded-\[(\d+px)\]/gu, () => 'rounded-[var(--radius-control)]');
}

