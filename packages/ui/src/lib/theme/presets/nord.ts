// SPDX-License-Identifier: Apache-2.0
/** nord pair (doc 14 §E.2). Polar night + snow storm — fjord blues. */
import type { ThemeSeed } from '../seed.ts';

export const NORD_SEEDS: ThemeSeed[] = [
  {
    id: 'nord-light',
    name: 'Nord Light',
    description: 'Nord snow storm — glacier paper with steel primary.',
    variant: 'light',
    tags: ['prestige', 'nord'],
    background: '#ecf2f7',
    foreground: '#2e3440',
    primary: '#4e7aa3',
    mutedForeground: '#6b7d8f',
    border: '#cdd9e4',
    status: { error: '#bf4044', warning: '#a36f1e', success: '#3f8269', info: '#4e7aa3' },
    syntax: {
      comment: '#93a1b0',
      keyword: '#5e81ac',
      string: '#48786f',
      number: '#b06d3e',
      function: '#5272a3',
      type: '#8b5f8b',
      operator: '#2e3440',
    },
  },
  {
    id: 'nord-dark',
    name: 'Nord',
    description: 'Nord polar night — dim fjord with frost primary.',
    variant: 'dark',
    tags: ['prestige', 'nord'],
    background: '#2e3440',
    foreground: '#e5e9f0',
    primary: '#88c0d0',
    primaryForeground: '#2e3440',
    mutedForeground: '#aeb8c6',
    border: '#3b4252',
    status: { error: '#bf616a', warning: '#ebcb8b', success: '#a3be8c', info: '#81a1c1' },
    syntax: {
      comment: '#78808c',
      keyword: '#81a1c1',
      string: '#a3be8c',
      number: '#b48ead',
      function: '#88c0d0',
      type: '#8fbcbb',
      operator: '#81a1c1',
    },
  },
];
