import { describe, expect, it } from 'vitest';
import { normalizeDirectory } from '../client.ts';

describe('normalizeDirectory (HP-4)', () => {
  it('unifies separators, uppercases drive, trims trailing slashes', () => {
    expect(normalizeDirectory('C:\\work\\repo\\')).toBe('C:/work/repo');
    expect(normalizeDirectory('/home/user/dev/')).toBe('/home/user/dev');
    expect(normalizeDirectory('c:/lower')).toBe('C:/lower');
    expect(normalizeDirectory('  spaced/path  ')).toBe('spaced/path');
  });
});
