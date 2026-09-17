// SPDX-License-Identifier: Apache-2.0
/** carbonfox pair (doc 14 §E.2). Fox pro-family: carbon night + canvas day. */
import type { ThemeSeed } from '../seed.ts';

export const CARBONFOX_SEEDS: ThemeSeed[] = [
  {
    id: 'carbonfox-light',
    name: 'Carbonfox Light',
    description: 'Day fox — cool paper, brush-blue primary.',
    variant: 'light',
    tags: ['prestige', 'fox'],
    background: '#f6f2ee',
    foreground: '#2f3239',
    primary: '#2d539e',
    mutedForeground: '#6c727f',
    border: '#d8d0cb',
    status: { error: '#a9322c', warning: '#955616', success: '#3d6547', info: '#28488a' },
    syntax: {
      comment: '#8f8b86',
      keyword: '#952f2f',
      string: '#467540',
      number: '#a5501e',
      function: '#28488a',
      type: '#325f90',
      operator: '#566175',
    },
  },
  {
    id: 'carbonfox-dark',
    name: 'Carbonfox Dark',
    description: 'Night fox — carbon substrate with ember accents.',
    variant: 'dark',
    tags: ['prestige', 'fox'],
    background: '#131a24',
    foreground: '#f6f2ee',
    primary: '#7199ee',
    primaryForeground: '#131a24',
    mutedForeground: '#9aa3b5',
    border: '#2b3544',
    status: { error: '#e46a63', warning: '#d9a353', success: '#6fb87f', info: '#64a0e0' },
    syntax: {
      comment: '#68788d',
      keyword: '#ee6fa5',
      string: '#6fb87f',
      number: '#d9a353',
      function: '#7199ee',
      type: '#69aede',
      operator: '#9aa3b5',
    },
  },
];
