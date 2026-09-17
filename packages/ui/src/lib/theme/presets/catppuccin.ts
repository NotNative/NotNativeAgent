// SPDX-License-Identifier: Apache-2.0
/** catppuccin pair (doc 14 §E.2). Mocha/latte — mauve primary, pastel syntax. */
import type { ThemeSeed } from '../seed.ts';

export const CATPPUCCIN_SEEDS: ThemeSeed[] = [
  {
    id: 'catppuccin-light',
    name: 'Catppuccin Latte',
    description: 'Catppuccin latte — milky light with mauve accents.',
    variant: 'light',
    tags: ['prestige', 'catppuccin'],
    background: '#eff1f5',
    foreground: '#4c4f69',
    primary: '#8839ef',
    mutedForeground: '#8c8fa1',
    border: '#ccd0da',
    status: { error: '#d20f39', warning: '#df8e1d', success: '#40a02b', info: '#1e66f5' },
    syntax: {
      comment: '#9ca0b0',
      keyword: '#8839ef',
      string: '#40a02b',
      number: '#fe640b',
      function: '#1e66f5',
      type: '#df8e1d',
      operator: '#179299',
    },
  },
  {
    id: 'catppuccin-dark',
    name: 'Catppuccin Mocha',
    description: 'Catppuccin mocha — dark froth with pastel glow.',
    variant: 'dark',
    tags: ['prestige', 'catppuccin'],
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    primary: '#cba6f7',
    primaryForeground: '#1e1e2e',
    mutedForeground: '#878a9c',
    border: '#363a4f',
    status: { error: '#f38ba8', warning: '#fab387', success: '#a6e3a1', info: '#89b4fa' },
    syntax: {
      comment: '#6d7094',
      keyword: '#cba6f7',
      string: '#a6e3a1',
      number: '#fab387',
      function: '#89b4fa',
      type: '#f9e2af',
      operator: '#74c7ec',
    },
  },
];
