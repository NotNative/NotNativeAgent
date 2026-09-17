// SPDX-License-Identifier: Apache-2.0
/** nightowl pair (doc 14 §E.2). Owl night + lite day — purple accents. */
import type { ThemeSeed } from '../seed.ts';

export const NIGHTOWL_SEEDS: ThemeSeed[] = [
  {
    id: 'nightowl-light',
    name: 'Night Owl Lite',
    description: 'Owl lite — cool paper with plum primary.',
    variant: 'light',
    tags: ['prestige', 'nightowl'],
    background: '#f2f4f8',
    foreground: '#403f53',
    primary: '#824ab3',
    mutedForeground: '#7f7e8f',
    border: '#d5dbe4',
    status: { error: '#cf2f37', warning: '#a4700e', success: '#2f7d59', info: '#2f6fd6' },
    syntax: {
      comment: '#989fb1',
      keyword: '#824ab3',
      string: '#2f7d59',
      number: '#b96019',
      function: '#2f6fd6',
      type: '#2b7482',
      operator: '#403f53',
    },
  },
  {
    id: 'nightowl-dark',
    name: 'Night Owl',
    description: 'Owl night — deep ink-blue with warm violet glow.',
    variant: 'dark',
    tags: ['prestige', 'nightowl'],
    background: '#011627',
    foreground: '#d6deeb',
    primary: '#c792ea',
    primaryForeground: '#011627',
    mutedForeground: '#889ab2',
    border: '#122d42',
    status: { error: '#ef5350', warning: '#ffeb95', success: '#addb67', info: '#82aaff' },
    syntax: {
      comment: '#637777',
      keyword: '#c792ea',
      string: '#ecc48d',
      number: '#f78c6c',
      function: '#82aaff',
      type: '#ff5855',
      operator: '#7fdbca',
    },
  },
];
