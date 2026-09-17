// SPDX-License-Identifier: Apache-2.0
/** ayu pair (doc 14 §E.2). Ayu's warm amber accent over inky depths/paper. */
import type { ThemeSeed } from '../seed.ts';

export const AYU_SEEDS: ThemeSeed[] = [
  {
    id: 'ayu-light',
    name: 'Ayu Light',
    description: 'Ayu light — paper white with amber accents.',
    variant: 'light',
    tags: ['prestige', 'ayu'],
    background: '#fafafa',
    foreground: '#5c6166',
    primary: '#f09639',
    mutedForeground: '#8a9199',
    border: '#e1e4e9',
    status: { error: '#d95657', warning: '#e09000', success: '#4dbf99', info: '#399ee6' },
    syntax: {
      comment: '#abafb1',
      keyword: '#fa8d3e',
      string: '#86b300',
      number: '#f29718',
      function: '#399ee6',
      type: '#437bff',
      operator: '#3eade8',
    },
  },
  {
    id: 'ayu-dark',
    name: 'Ayu Dark',
    description: 'Ayu dark — midnight ink with glowing amber.',
    variant: 'dark',
    tags: ['prestige', 'ayu'],
    background: '#0b0e14',
    foreground: '#bfbdb6',
    primary: '#ffb454',
    primaryForeground: '#0b0e14',
    mutedForeground: '#80838d',
    border: '#242935',
    status: { error: '#d95657', warning: '#fcba5a', success: '#40b98d', info: '#59c2ff' },
    syntax: {
      comment: '#626a73',
      keyword: '#ff8f40',
      string: '#aad94c',
      number: '#ffb454',
      function: '#59c2ff',
      type: '#73b8ff',
      operator: '#f29668',
    },
  },
];
