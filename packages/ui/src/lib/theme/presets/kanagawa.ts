// SPDX-License-Identifier: Apache-2.0
/** kanagawa pair (doc 14 §E.2). Sumi-ink night, lotus paper day. */
import type { ThemeSeed } from '../seed.ts';

export const KANAGAWA_SEEDS: ThemeSeed[] = [
  {
    id: 'kanagawa-light',
    name: 'Kanagawa Lotus',
    description: 'Kanagawa lotus — washi paper, wave-blue primary.',
    variant: 'light',
    tags: ['prestige', 'kanagawa'],
    background: '#f2ecbc',
    foreground: '#545464',
    primary: '#4b8ea8',
    mutedForeground: '#7d7d90',
    border: '#ded3a5',
    status: { error: '#b3464a', warning: '#978236', success: '#5e7346', info: '#4b8ea8' },
    syntax: {
      comment: '#8f8f9c',
      keyword: '#b15b79',
      string: '#5e7346',
      number: '#8b6b40',
      function: '#4b8ea8',
      type: '#667555',
      operator: '#7d7d90',
    },
  },
  {
    id: 'kanagawa-dark',
    name: 'Kanagawa Wave',
    description: 'Kanagawa wave — sumi ink with sakura/crystal accents.',
    variant: 'dark',
    tags: ['prestige', 'kanagawa'],
    background: '#1f1f28',
    foreground: '#dcd7ba',
    primary: '#7e9cd8',
    primaryForeground: '#1f1f28',
    mutedForeground: '#8c8f98',
    border: '#2f2f3b',
    status: { error: '#c34043', warning: '#c0a36e', success: '#76946a', info: '#7e9cd8' },
    syntax: {
      comment: '#727169',
      keyword: '#957fb8',
      string: '#98bb6c',
      number: '#d27e99',
      function: '#7e9cd8',
      type: '#7aa89f',
      operator: '#c0a36e',
    },
  },
];
