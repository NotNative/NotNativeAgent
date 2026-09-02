// SPDX-License-Identifier: Apache-2.0

const KEY_BYTES = Object.freeze({
  // Standard xterm/VT function-key, back-tab, navigation, and modified-navigation sequences.
  f12: '\u001b[24~', 'shift+tab': '\u001b[Z',
  'ctrl+pageup': '\u001b[5;5~', 'ctrl+pagedown': '\u001b[6;5~',
  pageup: '\u001b[5~', pagedown: '\u001b[6~', end: '\u001b[F',
});

/** Returns the terminal byte sequence for a supported binding, or null when it is not representable. */
export function bindingBytes(binding) {
  if (Object.hasOwn(KEY_BYTES, binding)) return KEY_BYTES[binding];
  // Configurable Ctrl bindings intentionally cover letters only; named non-letter controls have dedicated actions.
  const match = /^ctrl\+([a-z])$/u.exec(binding ?? '');
  return match ? String.fromCharCode(match[1].charCodeAt(0) - 96) : null;
}
