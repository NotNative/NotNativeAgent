// SPDX-License-Identifier: Apache-2.0
/** fields-of-the-shire pair (doc 14 §E.2). Pastoral greens. */
import type { ThemeSeed } from '../seed.ts';

export const FIELDS_SEEDS: ThemeSeed[] = [
  {
    id: 'fields-of-the-shire-light',
    name: 'Fields of the Shire Light',
    description: 'Sun-washed meadow grass over parchment.',
    variant: 'light',
    tags: ['prestige', 'nature'],
    background: '#f4f6ec',
    foreground: '#26361f',
    primary: '#4d7f34',
    mutedForeground: '#5f6a4e',
    border: '#ccd3b8',
    status: { error: '#b3442f', warning: '#a06a15', success: '#3f7d33', info: '#3b6b98' },
    syntax: {
      comment: '#8b9483',
      keyword: '#6b4f2a',
      string: '#3f7d33',
      number: '#a06a15',
      function: '#4d7f34',
      type: '#3b6b98',
      operator: '#5f6a4e',
    },
  },
  {
    id: 'fields-of-the-shire-dark',
    name: 'Fields of the Shire Dark',
    description: 'Night pasture — deep pine substrate with firefly green.',
    variant: 'dark',
    tags: ['prestige', 'nature'],
    background: '#15241a',
    foreground: '#cfe3c0',
    primary: '#8fc743',
    primaryForeground: '#15241a',
    mutedForeground: '#93a48a',
    border: '#2e4233',
    status: { error: '#cc7a66', warning: '#d9a94e', success: '#8fc743', info: '#7fa3c8' },
    syntax: {
      comment: '#6d7f6a',
      keyword: '#b7d98a',
      string: '#8fc743',
      number: '#d9a94e',
      function: '#7fa3c8',
      type: '#c9b06b',
      operator: '#93a48a',
    },
  },
];
