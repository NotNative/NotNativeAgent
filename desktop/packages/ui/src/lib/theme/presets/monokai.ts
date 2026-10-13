// SPDX-License-Identifier: Apache-2.0
/** monokai pair (doc 14 §E.2). Classic wedge — lime green on gunmetal. */
import type { ThemeSeed } from '../seed.ts';

export const MONOKAI_SEEDS: ThemeSeed[] = [
  {
    id: 'monokai-light',
    name: 'Monokai Light',
    description: 'Monokai sourced light — paper with moss green.',
    variant: 'light',
    tags: ['prestige', 'monokai'],
    background: '#fafafa',
    foreground: '#49483e',
    primary: '#587f2b',
    mutedForeground: '#75715e',
    border: '#e0e0dc',
    status: { error: '#c4272d', warning: '#a47c10', success: '#587f2b', info: '#218c8d' },
    syntax: {
      comment: '#a1a1a1',
      keyword: '#cb372d',
      string: '#587f2b',
      number: '#a66d1f',
      function: '#218c8d',
      type: '#7d4f9e',
      operator: '#49483e',
    },
  },
  {
    id: 'monokai-dark',
    name: 'Monokai Dark',
    description: 'Monokai classic — gunmetal backdrop, acid green.',
    variant: 'dark',
    tags: ['prestige', 'monokai'],
    background: '#272822',
    foreground: '#f8f8f2',
    primary: '#a6e22e',
    primaryForeground: '#272822',
    mutedForeground: '#90907c',
    border: '#413f34',
    status: { error: '#f92672', warning: '#e6db74', success: '#a6e22e', info: '#66d9ef' },
    syntax: {
      comment: '#75715e',
      keyword: '#f92672',
      string: '#e6db74',
      number: '#ae81ff',
      function: '#a6e22e',
      type: '#66d9ef',
      operator: '#f8f8f2',
    },
  },
];
