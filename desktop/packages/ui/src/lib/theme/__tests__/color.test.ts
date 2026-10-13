// SPDX-License-Identifier: Apache-2.0
/** Theme color-math gates: canonical hex handling + derivation operators. */
import { describe, expect, it } from 'vitest';
import {
  darken,
  isHexColor,
  lighten,
  mixColors,
  parseHex,
  readableForeground,
  relativeLuminance,
  toHex,
  toRgbTuples,
  withAlpha,
} from '../color.ts';

describe('hex canonicalization', () => {
  it('expands 3/4-digit hex to 6/8-digit canonical form', () => {
    expect(toHex(parseHex('#f80'))).toBe('#ff8800');
    expect(toHex(parseHex('#abcd'))).toBe('#aabbccdd');
    expect(toHex(parseHex('#abc'))).toBe('#aabbcc');
    expect(parseHex('#1234')).toEqual({ r: 17, g: 34, b: 51, a: 68 });
  });

  it('parses 6/8-digit hex and drops opaque alpha channel on emit', () => {
    expect(parseHex('#ff8800')).toEqual({ r: 255, g: 136, b: 0, a: 255 });
    expect(toHex(parseHex('#11223344'))).toBe('#11223344');
    expect(toHex(parseHex('#112233ff'))).toBe('#112233');
  });

  it('rejects malformed color strings', () => {
    expect(isHexColor('#12345')).toBe(false);
    expect(isHexColor('#1234567')).toBe(false);
    expect(isHexColor('ff8800')).toBe(false);
    expect(isHexColor('#12345g')).toBe(false);
    expect(isHexColor(42)).toBe(false);
  });
});

describe('derivation operators (doc 14 generator defaults)', () => {
  it('darken multiplies channels by (1 − fraction) preserving alpha', () => {
    expect(darken('#e60000', 0.1)).toBe('#cf0000');
    expect(darken('#ffffff', 1)).toBe('#000000');
    expect(darken('#11223344', 0.5)).toBe('#09111a44');
  });

  it('lighten mixes toward white by fraction preserving alpha', () => {
    expect(lighten('#000000', 0.5)).toBe('#808080');
    expect(lighten('#000000', 1)).toBe('#ffffff');
    expect(lighten('#11223344', 0)).toBe('#11223344');
  });

  it('mixColors interpolates linearly including alpha', () => {
    expect(mixColors('#000000', '#ffffff', 0.25)).toBe('#404040');
    expect(mixColors('#00000000', '#ffffffff', 0.5)).toBe('#80808080');
  });

  it('withAlpha quantizes alpha to bytes', () => {
    expect(withAlpha('#ff0000', 0.5)).toBe('#ff000080');
    expect(withAlpha('#ff0000', 1)).toBe('#ff0000');
    expect(withAlpha('#ff0000', 0)).toBe('#ff000000');
  });

  it('emits "r, g, b" candidate strings for rgba() callers', () => {
    expect(toRgbTuples('#20404e')).toBe('32, 64, 78');
  });
});

describe('contrast helpers', () => {
  it('orders luminance white > red and filters malformed candidates', () => {
    expect(relativeLuminance(parseHex('#ffffff'))).toBeGreaterThan(relativeLuminance(parseHex('#ff0000')));
    const dark = { r: 8, g: 8, b: 8, a: 255 };
    expect(readableForeground(toHex(dark), ['#ffffff', 'bogus', '#0f0f0f', 42 as unknown as string])).toBe('#ffffff');
    expect(readableForeground('#ffffff', ['#ffffff', '#000000'])).toBe('#000000');
  });
});
