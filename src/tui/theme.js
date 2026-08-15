// SPDX-License-Identifier: Apache-2.0

// Presentation code should name intent instead of scattering terminal palette
// indexes through each renderer. Keeping the default values here also makes a
// future 16-color or user-selectable theme a data change rather than a rewrite.
export const TUI_THEME = Object.freeze({
  accent: '1;38;5;213',
  accentSoft: '38;5;141',
  activeTab: '1;38;5;255;48;5;54',
  border: '38;5;238',
  brandBorder: '38;5;93',
  danger: '38;5;203',
  dangerStrong: '1;38;5;203',
  inputMarker: '1;38;5;81',
  inputTranscript: '38;5;255;48;5;236',
  muted: '38;5;245',
  mutedDark: '38;5;103',
  mutedStrong: '38;5;244',
  primary: '38;5;252',
  secondary: '38;5;248',
  secondaryStrong: '38;5;250',
  selected: '1;38;5;255;48;5;236',
  selectedMarker: '1;38;5;213;48;5;236',
  success: '38;5;77',
  successStrong: '1;38;5;77',
  activity: '38;5;147',
});

const SGR_CODES = /^\d+(?:;\d+)*$/u;

for (const codes of Object.values(TUI_THEME)) {
  if (!SGR_CODES.test(codes)) throw new Error('TUI theme contains an invalid SGR code');
}

export function paint(codes, value) {
  if (typeof codes !== 'string' || !SGR_CODES.test(codes)) throw new TypeError('paint requires valid SGR codes');
  // Text is sanitized at the terminal projection boundary; nested styling is intentionally preserved here.
  return `\u001b[${codes}m${String(value ?? '')}\u001b[0m`;
}
