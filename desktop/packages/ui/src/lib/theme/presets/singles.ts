// SPDX-License-Identifier: Apache-2.0
/**
 * Single-variant presets (doc 14 §E.2 — dracula/vesper/mono-plus are the
 * dark-only members, mono the light-only member, of the 38 built-in set;
 * vitesse ships as the explicit vitesse-dark/vitesse-light ids).
 */
import type { ThemeSeed } from '../seed.ts';

const dracula: ThemeSeed = {
  id: 'dracula',
  name: 'Dracula',
  description: 'Dracula dark — vampire estate purple on obelisk black.',
  variant: 'dark',
  tags: ['prestige', 'dracula'],
  background: '#282a36',
  foreground: '#f8f8f2',
  primary: '#bd93f9',
  primaryForeground: '#282a36',
  mutedForeground: '#8c90b4',
  border: '#44475a',
  status: { error: '#ff5555', warning: '#ffb86c', success: '#50fa7b', info: '#8be9fd' },
  syntax: {
    comment: '#6272a4',
    keyword: '#ff79c6',
    string: '#f1fa8c',
    number: '#bd93f9',
    function: '#50fa7b',
    type: '#8be9fd',
    operator: '#ff79c6',
  },
};

const vesper: ThemeSeed = {
  id: 'vesper',
  name: 'Vesper',
  description: 'Vesper dark — near-black with peach metallic.',
  variant: 'dark',
  tags: ['prestige', 'vesper'],
  background: '#101010',
  foreground: '#ffffff',
  primary: '#f8a86b',
  primaryForeground: '#101010',
  mutedForeground: '#8d8d8d',
  border: '#2a2a2a',
  status: { error: '#eb6f6f', warning: '#d9a353', success: '#68b58a', info: '#63a4cf' },
  syntax: {
    comment: '#5f5f5f',
    keyword: '#f8a86b',
    string: '#a3c98c',
    number: '#dbc394',
    function: '#63a4cf',
    type: '#cbc7a4',
    operator: '#8d8d8d',
  },
};

const monoPlus: ThemeSeed = {
  id: 'mono-plus',
  name: 'Mono Plus',
  description: 'Mono+ dark — grayscale with a teal glaze.',
  variant: 'dark',
  tags: ['prestige', 'mono'],
  background: '#131719',
  foreground: '#e8eaec',
  primary: '#6ea9b8',
  primaryForeground: '#131719',
  mutedForeground: '#8f969a',
  border: '#2b3237',
  status: { error: '#d98a80', warning: '#d3b06a', success: '#84b98f', info: '#79a9c4' },
  syntax: {
    comment: '#707a7e',
    keyword: '#6ea9b8',
    string: '#94bb9a',
    number: '#d4b47c',
    function: '#79a9c4',
    type: '#c0a882',
    operator: '#8f969a',
  },
};

const mono: ThemeSeed = {
  id: 'mono',
  name: 'Mono',
  description: 'Mono light — pure grayscale on white.',
  variant: 'light',
  tags: ['prestige', 'mono'],
  background: '#ffffff',
  foreground: '#171717',
  primary: '#444444',
  mutedForeground: '#787878',
  border: '#e4e4e4',
  status: { error: '#b4443c', warning: '#96700a', success: '#3c7a46', info: '#38699e' },
  syntax: {
    comment: '#9c9c9c',
    keyword: '#5e5e5e',
    string: '#3c7a46',
    number: '#9c6a2e',
    function: '#38699e',
    type: '#6a6a6a',
    operator: '#4a4a4a',
  },
};

const vitesseDark: ThemeSeed = {
  id: 'vitesse-dark',
  name: 'Vitesse Dark',
  description: 'Vitesse dark — soft ink with ochre accents.',
  variant: 'dark',
  tags: ['prestige', 'vitesse'],
  background: '#121211',
  foreground: '#dbd7ca',
  primary: '#f2a950',
  primaryForeground: '#121211',
  mutedForeground: '#93928c',
  border: '#2a2a27',
  status: { error: '#dc7f70', warning: '#dbb24b', success: '#84a257', info: '#6895bf' },
  syntax: {
    comment: '#758575',
    keyword: '#4d9375',
    string: '#c98a7d',
    number: '#d19a66',
    function: '#bf90b2',
    type: '#dbb24b',
    operator: '#93928c',
  },
};

const vitesseLight: ThemeSeed = {
  id: 'vitesse-light',
  name: 'Vitesse Light',
  description: 'Vitesse light — rice paper with ochre accents.',
  variant: 'light',
  tags: ['prestige', 'vitesse'],
  background: '#fdfdfc',
  foreground: '#393a34',
  primary: '#a65e2b',
  mutedForeground: '#90937d',
  border: '#e0e2db',
  status: { error: '#b25a48', warning: '#936b13', success: '#4b6e43', info: '#33739e' },
  syntax: {
    comment: '#a0ada0',
    keyword: '#2f6f44',
    string: '#a65719',
    number: '#9c3f21',
    function: '#5f668d',
    type: '#555f19',
    operator: '#393a34',
  },
};

export const SINGLE_SEEDS: ThemeSeed[] = [dracula, vesper, monoPlus, mono, vitesseDark, vitesseLight];
