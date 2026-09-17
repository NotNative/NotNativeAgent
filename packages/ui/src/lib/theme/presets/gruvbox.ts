// SPDX-License-Identifier: Apache-2.0
/** gruvbox pair (doc 14 §E.2). Retro groove — earth tones, yellow/amber UI. */
import type { ThemeSeed } from '../seed.ts';

export const GRUVBOX_SEEDS: ThemeSeed[] = [
  {
    id: 'gruvbox-light',
    name: 'Gruvbox Light',
    description: 'Gruvbox hard light — faded cream with dark-yellow UI.',
    variant: 'light',
    tags: ['prestige', 'gruvbox'],
    background: '#fbf1c7',
    foreground: '#3c3836',
    primary: '#b87626',
    mutedForeground: '#7c6f64',
    border: '#e0d5b2',
    status: { error: '#9d0006', warning: '#b57614', success: '#427b58', info: '#076678' },
    syntax: {
      comment: '#928374',
      keyword: '#9d0006',
      string: '#79740e',
      number: '#8f3f71',
      function: '#076678',
      type: '#427b58',
      operator: '#7c6f64',
    },
  },
  {
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
    description: 'Gruvbox dark — warm charcoal with golden sand UI.',
    variant: 'dark',
    tags: ['prestige', 'gruvbox'],
    background: '#282828',
    foreground: '#ebdbb2',
    primary: '#fabd2f',
    primaryForeground: '#282828',
    mutedForeground: '#a89984',
    border: '#3c3836',
    status: { error: '#fb4934', warning: '#fabd2f', success: '#b8bb26', info: '#83a598' },
    syntax: {
      comment: '#928374',
      keyword: '#fb4934',
      string: '#b8bb26',
      number: '#d3869b',
      function: '#83a598',
      type: '#fabd2f',
      operator: '#8ec07c',
    },
  },
];
