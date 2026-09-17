// SPDX-License-Identifier: Apache-2.0
/**
 * Color math for the theme pipeline (doc 14 §B.1/§E.6). Themes author raw
 * hex/8-digit hex; derivation, generator fallbacks and readable-foreground
 * choices need pure conversions. 3/4-digit hex is expanded to 6/8-digit on
 * parse, so every value crossing the CSS generator is canonical.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}
export interface Rgba extends Rgb {
  a: number;
}

const HEX_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu;

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_PATTERN.test(value.trim());
}

export function parseHex(value: string): Rgba {
  const raw = value.trim().replace(/^#/u, '');
  const short = raw.length <= 4;
  const channel = (index: number): number => {
    const digits = short ? raw[index]!.repeat(2) : raw.slice(index * 2, index * 2 + 2);
    return Number.parseInt(digits, 16);
  };
  return {
    r: channel(0),
    g: channel(1),
    b: channel(2),
    a: raw.length === 4 || raw.length === 8 ? channel(3) : 255,
  };
}

export function toHex(color: Rgba): string {
  const part = (channel: number): string => channel.toString(16).padStart(2, '0');
  const alpha = color.a ?? 255;
  const base = `#${part(color.r)}${part(color.g)}${part(color.b)}`;
  return alpha === 255 ? base : `${base}${part(alpha)}`;
}

const clampByte = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));

export function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = parseHex(hex);
  return toHex({ r, g, b, a: clampByte(alpha * 255) });
}

/** Multiply channels by (1 − fraction) — the doc's darken semantics. */
export function darken(hex: string, fraction: number): string {
  const { r, g, b, a } = parseHex(hex);
  const scale = (value: number): number => clampByte(value * (1 - fraction));
  return toHex({ r: scale(r), g: scale(g), b: scale(b), a });
}

/** Mix toward white by fraction — the doc's lighten semantics. */
export function lighten(hex: string, fraction: number): string {
  return mixColors(hex, '#ffffff', fraction);
}

export function mixColors(a: string, b: string, t: number): string {
  const left = parseHex(a);
  const right = parseHex(b);
  const channel = (l: number, r: number): number => clampByte(l + (r - l) * t);
  return toHex({
    r: channel(left.r, right.r),
    g: channel(left.g, right.g),
    b: channel(left.b, right.b),
    a: channel(left.a, right.a),
  });
}

export function toRgbTuples(hex: string): string {
  const { r, g, b } = parseHex(hex);
  return `${r}, ${g}, ${b}`;
}

/** WCAG relative luminance on the 0..255 channel triple. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const linear = (channel: number): number => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Pick the candidate with the better contrast on the given background. */
export function readableForeground(onBackground: string, candidates: string[]): string {
  const bg = parseHex(onBackground);
  let winner = candidates[0] ?? '#000000';
  let best = -1;
  for (const candidate of candidates) {
    if (!isHexColor(candidate)) continue;
    const score = contrastRatio(bg, parseHex(candidate));
    if (score > best) {
      best = score;
      winner = candidate;
    }
  }
  return winner;
}
