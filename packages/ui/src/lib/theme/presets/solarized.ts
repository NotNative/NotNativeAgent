// SPDX-License-Identifier: Apache-2.0
/** solarized pair (doc 14 §E.2). Rebase base16s — cyan-blue two-way. */
import type { ThemeSeed } from '../seed.ts';

export const SOLARIZED_SEEDS: ThemeSeed[] = [
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    description: 'Solarized day — flamberge cream, orange primary.',
    variant: 'light',
    tags: ['prestige', 'solarized'],
    background: '#fdf6e3',
    foreground: '#657b83',
    primary: '#cb4b16',
    mutedForeground: '#93a1a1',
    border: '#e6e0cf',
    status: { error: '#dc322f', warning: '#b58900', success: '#859900', info: '#268bd2' },
    syntax: {
      comment: '#93a1a1',
      keyword: '#859900',
      string: '#2aa198',
      number: '#d33682',
      function: '#268bd2',
      type: '#b58900',
      operator: '#586e75',
    },
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    description: 'Solarized night — deep-sea teal, orange primary.',
    variant: 'dark',
    tags: ['prestige', 'solarized'],
    background: '#002b36',
    foreground: '#93a1a1',
    primary: '#cb4b16',
    mutedForeground: '#586e75',
    border: '#073642',
    status: { error: '#dc322f', warning: '#b58900', success: '#859900', info: '#268bd2' },
    syntax: {
      comment: '#586e75',
      keyword: '#859900',
      string: '#2aa198',
      number: '#d33682',
      function: '#268bd2',
      type: '#b58900',
      operator: '#93a1a1',
    },
  },
];
