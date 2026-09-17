// SPDX-License-Identifier: Apache-2.0
/** aura pair (doc 14 §E.2). Mauve-violet accents on charcoal/canvas. */
import type { ThemeSeed } from '../seed.ts';

export const AURA_SEEDS: ThemeSeed[] = [
  {
    id: 'aura-light',
    name: 'Aura Light',
    description: 'Aura on canvas — violet primary, soft graphite text.',
    variant: 'light',
    tags: ['prestige', 'aura'],
    background: '#ececef',
    foreground: '#46434b',
    primary: '#7a5cf0',
    mutedForeground: '#6c6a72',
    border: '#d4d3d8',
    status: { error: '#c13a4d', warning: '#a06b17', success: '#467552', info: '#3f66a8' },
    syntax: {
      comment: '#97949e',
      keyword: '#7a5cf0',
      string: '#3d75a4',
      number: '#a05a3d',
      function: '#3f8d84',
      type: '#94654d',
      operator: '#6c6a72',
    },
  },
  {
    id: 'aura-dark',
    name: 'Aura Dark',
    description: 'Aura on charcoal — lavender glow.',
    variant: 'dark',
    tags: ['prestige', 'aura'],
    background: '#15141b',
    foreground: '#bdbdb8',
    primary: '#a277ff',
    primaryForeground: '#15141b',
    mutedForeground: '#8b8a89',
    border: '#33323c',
    status: { error: '#e5617e', warning: '#d9ad4e', success: '#57bd8f', info: '#6ab2e0' },
    syntax: {
      comment: '#6d6a75',
      keyword: '#a277ff',
      string: '#4dab9c',
      number: '#e07568',
      function: '#6ab2e0',
      type: '#d99b5e',
      operator: '#8b8a89',
    },
  },
];
