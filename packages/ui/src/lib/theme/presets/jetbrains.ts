// SPDX-License-Identifier: Apache-2.0
/** jetbrains pair (doc 14 §E.2). New-UI neutral surfaces, blue primary. */
import type { ThemeSeed } from '../seed.ts';

export const JETBRAINS_SEEDS: ThemeSeed[] = [
  {
    id: 'jetbrains-light',
    name: 'JetBrains Light',
    description: 'IDE light — crisp white, IDE blue primary.',
    variant: 'light',
    tags: ['prestige', 'jetbrains'],
    background: '#ffffff',
    foreground: '#19191c',
    primary: '#3574f0',
    mutedForeground: '#818594',
    border: '#dfe1e5',
    status: { error: '#cf3241', warning: '#967509', success: '#1e8a44', info: '#3574f0' },
    syntax: {
      comment: '#8c919f',
      keyword: '#0033b3',
      string: '#067d17',
      number: '#1750eb',
      function: '#00627c',
      type: '#a5490a',
      operator: '#8c919f',
    },
  },
  {
    id: 'jetbrains-dark',
    name: 'JetBrains Dark',
    description: 'IDE dark — one-gray panels, IDE blue primary.',
    variant: 'dark',
    tags: ['prestige', 'jetbrains'],
    background: '#1e1f22',
    foreground: '#bcbec4',
    primary: '#3574f0',
    mutedForeground: '#8a8c94',
    border: '#333539',
    status: { error: '#db5c5c', warning: '#d3a34c', success: '#5fa866', info: '#548af7' },
    syntax: {
      comment: '#7a7e85',
      keyword: '#cf8e6d',
      string: '#6aab73',
      number: '#2aacb8',
      function: '#56a8f5',
      type: '#c77dbb',
      operator: '#bcbec4',
    },
  },
];
