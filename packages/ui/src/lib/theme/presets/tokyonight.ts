// SPDX-License-Identifier: Apache-2.0
/** tokyonight pair (doc 14 §E.2). Tokyo neon night + crisp day. */
import type { ThemeSeed } from '../seed.ts';

export const TOKYONIGHT_SEEDS: ThemeSeed[] = [
  {
    id: 'tokyonight-light',
    name: 'Tokyo Night Light',
    description: 'Tokyo by day — porcelain with indigo primary.',
    variant: 'light',
    tags: ['prestige', 'tokyonight'],
    background: '#e1e2e7',
    foreground: '#3760bf',
    primary: '#2e7de9',
    mutedForeground: '#6172b0',
    border: '#c4c8da',
    status: { error: '#f52a65', warning: '#b15c00', success: '#389f6f', info: '#2e7de9' },
    syntax: {
      comment: '#8489ac',
      keyword: '#7847bd',
      string: '#587539',
      number: '#b15c00',
      function: '#2e7de9',
      type: '#007197',
      operator: '#3760bf',
    },
  },
  {
    id: 'tokyonight-dark',
    name: 'Tokyo Night',
    description: 'Tokyo after dusk — indigo glow on the moonlit dark.',
    variant: 'dark',
    tags: ['prestige', 'tokyonight'],
    background: '#1a1b26',
    foreground: '#c0caf5',
    primary: '#7aa2f7',
    primaryForeground: '#1a1b26',
    mutedForeground: '#8b94b5',
    border: '#292e42',
    status: { error: '#f7768e', warning: '#e0af68', success: '#9ece6a', info: '#7aa2f7' },
    syntax: {
      comment: '#565f89',
      keyword: '#bb9af7',
      string: '#9ece6a',
      number: '#ff9e64',
      function: '#7aa2f7',
      type: '#2ac3de',
      operator: '#89ddff',
    },
  },
];
