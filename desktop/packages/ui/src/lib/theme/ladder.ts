// SPDX-License-Identifier: Apache-2.0
/**
 * Tone ladder for the desktop UI (docs/planning/desktop-ui-visual-system.md
 * §4.3).
 *
 * Invariant: every visible surface is a step on one ladder derived from the
 * active theme. Components name a step, never a colour. This module is the
 * only place that decides what a raised control, a recessed field, a tile, or
 * a floating surface look like for a given theme.
 *
 * Why lighting follows the theme's physics: a theme whose elevated surface is
 * darker than its canvas has to read a field as pressed into the page and a
 * pill as lifted above it; a theme whose elevated surface is lighter reads
 * both as lit from above. Deriving that from the theme's own luminances means
 * a new runtime theme inherits correct lighting without a second authoring
 * step, and no component can get it wrong.
 */
import { contrastRatio, mixColors, parseHex, relativeLuminance, withAlpha } from './color.ts';

export type LadderLighting = 'pressed' | 'lit';

export type LadderInput = {
  /** The theme's page surface. */
  canvas: string;
  /** The theme's elevated surface. */
  elevated: string;
  /** The theme's foreground. */
  foreground: string;
  /** The theme's primary (accent) colour. */
  primary: string;
};

export type Ladder = {
  lighting: LadderLighting;
  tokens: Record<string, string>;
};

/** Below this difference the two luminances are treated as equal. */
const EQUAL_LUMINANCE_EPSILON = 0.004;

/**
 * The lighting a theme needs. An elevated surface darker than the canvas reads
 * as pressed; lighter or equal reads as lit, which is also the safe fallback:
 * a lit edge is invisible on a surface that is already the same tone.
 */
export function chooseLighting(input: LadderInput): LadderLighting {
  const canvas = relativeLuminance(parseHex(input.canvas));
  const elevated = relativeLuminance(parseHex(input.elevated));
  return elevated < canvas - EQUAL_LUMINANCE_EPSILON ? 'pressed' : 'lit';
}

const EDGE_HAIRLINE = 0.5;
const EDGE_RING = 1;
const EDGE_STRONG = 1.5;

function edge(foreground: string, ratio: number, width: number): string {
  return `${width}px ${withAlpha(mixColors(foreground, '#000000', 1 - ratio), 1)}`;
}

/** A shadow as a list of layers, the last one soft and wide. */
function shadow(alpha: number, spread: number): string {
  const a = Math.min(Math.max(alpha, 0), 1);
  return [
    `0 1px 2px 0 rgb(0 0 0 / ${a.toFixed(3)})`,
    `0 ${Math.round(spread * 0.5)}px ${Math.round(spread * 2)}px -${Math.round(spread * 0.25)}px rgb(0 0 0 / ${(a * 0.7).toFixed(3)})`,
  ].join(', ');
}

/**
 * The complete ladder for one theme. Every value is derived; nothing here is
 * a literal a component would have to know.
 */
export function buildLadder(input: LadderInput): Ladder {
  const lighting = chooseLighting(input);
  const { canvas, elevated, foreground, primary } = input;
  const elevatedLuminance = relativeLuminance(parseHex(elevated));
  const canvasLuminance = relativeLuminance(parseHex(canvas));
  // A theme that lifts its surfaces uses a stronger edge on the elevated
  // surface than on the canvas, since the contrast already carries some of it.
  const onElevated = elevatedLuminance > canvasLuminance;
  const edgeStrength = onElevated ? 0.16 : 0.1;
  const ring = `0 0 0 ${EDGE_HAIRLINE}px ${withAlpha(mixColors(foreground, canvas, 0.84), 1)}`;
  const softEdge = `inset 0 0 0 ${EDGE_HAIRLINE}px ${withAlpha(mixColors(foreground, elevated, 0.84), 1)}`;
  const raisedEdge = lighting === 'lit'
    ? `inset 0 1px 0 0 ${withAlpha(mixColors(foreground, elevated, 0.92), 1)}`
    : '';
  const tokens: Record<string, string> = {
    '--surface-canvas': canvas,
    '--surface-panel': mixColors(canvas, elevated, 0.5),
    '--surface-raised': elevated,
    '--surface-recessed': mixColors(canvas, elevated, 0.3),
    '--surface-elevated': elevated,
    '--surface-floating': elevated,
    '--surface-popover': elevated,
    '--surface-tooltip': elevated,
    '--edge-hairline': `${EDGE_HAIRLINE}px`,
    '--edge-ring': `${EDGE_RING}px`,
    '--edge-strong': `${EDGE_STRONG}px`,
    '--edge-hairline-color': withAlpha(mixColors(foreground, canvas, edgeStrength), 1),
    '--edge-ring-color': withAlpha(mixColors(foreground, canvas, 0.84), 1),
    '--tone-tile': withAlpha(mixColors(foreground, canvas, onElevated ? 0.94 : 0.96), 1),
    '--tone-tile-hover': withAlpha(mixColors(foreground, canvas, onElevated ? 0.9 : 0.92), 1),
    '--tone-tile-pressed': withAlpha(mixColors(foreground, canvas, onElevated ? 0.84 : 0.88), 1),
    '--selection-fill': withAlpha(mixColors(primary, canvas, 0.82), 1),
    '--selection-foreground': foreground,
    '--hover-fill': withAlpha(mixColors(foreground, canvas, 0.94), 1),
    '--pressed-fill': withAlpha(mixColors(foreground, canvas, 0.88), 1),
    '--focus-field': primary,
    '--elevation-1': `${raisedEdge}${raisedEdge ? ', ' : ''}${softEdge}${lighting === 'lit' ? `, ${shadow(0.08, 2)}` : ''}`,
    '--elevation-2': `${ring}, ${shadow(lighting === 'lit' ? 0.1 : 0.08, 3)}`,
    '--elevation-3': `${ring}, ${shadow(lighting === 'lit' ? 0.18 : 0.14, 8)}`,
    '--elevation-4': `${ring}, 0 2px 6px -1px rgb(0 0 0 / ${lighting === 'lit' ? 0.12 : 0.08}), 0 12px 28px -6px rgb(0 0 0 / ${lighting === 'lit' ? 0.2 : 0.16}), 0 32px 72px -12px rgb(0 0 0 / ${lighting === 'lit' ? 0.26 : 0.22})`,
    '--field-shadow': lighting === 'lit'
      ? `${raisedEdge}, ${softEdge}, ${shadow(0.05, 2)}`
      : `${softEdge}, inset 0 1px 2px 0 rgb(0 0 0 / 0.04)`,
    '--raised-shadow': lighting === 'lit'
      ? `${raisedEdge}, ${softEdge}, ${shadow(0.08, 2)}`
      : `${softEdge}`,
    '--scrollbar-thumb': withAlpha(mixColors(foreground, canvas, 0.82), 1),
    '--scrollbar-thumb-hover': withAlpha(mixColors(foreground, canvas, 0.64), 1),
    '--glass-blur': '22px',
    '--glass-opacity': lighting === 'lit' ? '52%' : '50%',
    '--glass-saturation': '1.24',
    '--glow-shine': withAlpha(mixColors(foreground, elevated, 0.72), 1),
  };
  return { lighting, tokens };
}

/**
 * A tone's faces for one theme: the text colour, a low-alpha fill for a
 * banner, and a border in the same hue. Tones are named (info, success,
 * warning, error) and their colours come from the theme's status tokens, so
 * this function keys by the name and never inspects content.
 */
export function buildTones(_ladder: Ladder, name: string, color: string): Record<string, string> {
  const key = `--tone-${name}`;
  return {
    [key]: color,
    [`${key}-text`]: color,
    [`${key}-fill`]: withAlpha(color, 0.12),
    [`${key}-border`]: withAlpha(color, 0.32),
  };
}

/** Whether a tone's text keeps enough contrast on the theme's canvas. */
export function toneReadable(tone: string, canvas: string, minimum = 3): boolean {
  return contrastRatio(parseHex(tone), parseHex(canvas)) >= minimum;
}
