// SPDX-License-Identifier: Apache-2.0
export { DEFAULT_KEY_BINDINGS, validateKeyBindings } from '../experience/key-bindings.js';

const KEY_BYTES = Object.freeze({
  f12: '\u001b[24~', 'shift+tab': '\u001b[Z',
  'ctrl+pageup': '\u001b[5;5~', 'ctrl+pagedown': '\u001b[6;5~',
  pageup: '\u001b[5~', pagedown: '\u001b[6~', end: '\u001b[F',
});

export function bindingBytes(binding) {
  if (KEY_BYTES[binding]) return KEY_BYTES[binding];
  const match = /^ctrl\+([a-z])$/u.exec(binding ?? '');
  return match ? String.fromCharCode(match[1].charCodeAt(0) - 96) : null;
}
