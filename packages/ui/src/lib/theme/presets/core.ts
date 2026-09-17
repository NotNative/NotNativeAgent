// SPDX-License-Identifier: Apache-2.0
/**
 * NND brand + flexoki seeds (doc 14 §E.2 registration head). The brand pair
 * mirrors the design-system static palette (§B.1 warm sand / #151313 family)
 * so first-load theme re-paint is visually identical to the static sheet.
 * flexoki aliases: legacy ids `app-light`/`app-dark` resolve here.
 */
import type { ThemeSeed } from '../seed.ts';

const notnativeLight: ThemeSeed = {
  id: 'notnative-light',
  name: 'NotNative Light',
  description: 'NND brand light — warm sand, burnt orange.',
  variant: 'light',
  tags: ['core'],
  background: '#f2efe8',
  foreground: '#3a2f26',
  primary: '#d97a42',
  primaryForeground: '#fdf8f2',
  mutedForeground: '#6f6157',
  border: '#d8d0c2',
  status: { error: '#c04a3a', warning: '#b07f24', success: '#4c8a45', info: '#3d6fa8' },
  syntax: {
    comment: '#9a8b7d',
    keyword: '#c05636',
    string: '#4c8a45',
    number: '#b07f24',
    function: '#3d6fa8',
    type: '#8a5a1e',
    operator: '#6f6157',
  },
};

const notnativeDark: ThemeSeed = {
  id: 'notnative-dark',
  name: 'NotNative Dark',
  description: 'NND brand dark — #151313 substrate, golden sand primary.',
  variant: 'dark',
  tags: ['core'],
  background: '#151313',
  foreground: '#cdccc3',
  primary: '#edb449',
  primaryForeground: '#151313',
  mutedForeground: '#b6b4ab',
  border: '#393836',
  status: { error: '#d98678', warning: '#e0b35c', success: '#89b98a', info: '#7fa8cf' },
  syntax: {
    comment: '#8b857a',
    keyword: '#e8935c',
    string: '#89b98a',
    number: '#e0b35c',
    function: '#7fa8cf',
    type: '#d2b48c',
    operator: '#b6b4ab',
  },
};

const flexokiLight: ThemeSeed = {
  id: 'flexoki-light',
  name: 'Flexoki Light',
  description: 'Flexoki paper light — warm off-white, deep red primary.',
  author: 'stephango',
  variant: 'light',
  tags: ['core'],
  background: '#fffcf0',
  foreground: '#100f0c',
  primary: '#af3029',
  mutedForeground: '#6f6e69',
  border: '#e0dccf',
  status: { error: '#af3029', warning: '#ad8301', success: '#205f46', info: '#205ea6' },
  syntax: {
    comment: '#878580',
    keyword: '#af3029',
    string: '#205f46',
    number: '#bc5215',
    function: '#205ea6',
    type: '#825a00',
    operator: '#5e0586',
  },
};

const flexokiDark: ThemeSeed = {
  id: 'flexoki-dark',
  name: 'Flexoki Dark',
  description: 'Flexoki ink dark — near-black substrate, red-primary UI.',
  author: 'stephango',
  variant: 'dark',
  tags: ['core'],
  background: '#100f0c',
  foreground: '#cecdc3',
  primary: '#d14d41',
  mutedForeground: '#a4a39e',
  border: '#282726',
  status: { error: '#e5484d', warning: '#f5a623', success: '#58b06f', info: '#53a2e8' },
  syntax: {
    comment: '#85826f',
    keyword: '#d14d41',
    string: '#29c46f',
    number: '#e97a29',
    function: '#53a2e8',
    type: '#b69000',
    operator: '#9400e0',
  },
};

export const FLEXOKI_AND_CORE_SEEDS: ThemeSeed[] = [
  notnativeLight,
  notnativeDark,
  flexokiLight,
  flexokiDark,
];
