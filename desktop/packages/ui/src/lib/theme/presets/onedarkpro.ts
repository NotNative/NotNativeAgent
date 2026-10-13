// SPDX-License-Identifier: Apache-2.0
/** onedarkpro pair (doc 14 §E.2). One Dark Pro / One Light. */
import type { ThemeSeed } from '../seed.ts';

export const ONEDARKPRO_SEEDS: ThemeSeed[] = [
  {
    id: 'onedarkpro-light',
    name: 'One Light',
    description: 'Atom light — warm paper, focus blue.',
    variant: 'light',
    tags: ['prestige', 'one-dark'],
    background: '#fafafa',
    foreground: '#383a42',
    primary: '#4078f2',
    mutedForeground: '#828593',
    border: '#e2e4e9',
    status: { error: '#e45649', warning: '#c18401', success: '#50a14f', info: '#0184bc' },
    syntax: {
      comment: '#a0a1a7',
      keyword: '#a626a4',
      string: '#50a14f',
      number: '#986801',
      function: '#4078f2',
      type: '#986801',
      operator: '#4078f2',
    },
  },
  {
    id: 'onedarkpro-dark',
    name: 'One Dark Pro',
    description: 'Atom dark — muted slate with electric blue.',
    variant: 'dark',
    tags: ['prestige', 'one-dark'],
    background: '#282c34',
    foreground: '#abb2bf',
    primary: '#61afef',
    primaryForeground: '#282c34',
    mutedForeground: '#8f96a3',
    border: '#3b3f46',
    status: { error: '#e06c75', warning: '#e5c07b', success: '#98c379', info: '#61afef' },
    syntax: {
      comment: '#5c6370',
      keyword: '#c678dd',
      string: '#98c379',
      number: '#d19a66',
      function: '#61afef',
      type: '#e5c07b',
      operator: '#56b6c2',
    },
  },
];
