// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

export const DEFAULT_KEY_BINDINGS = Object.freeze({
  submit: 'ctrl+s', newline: 'ctrl+j', cancel: 'ctrl+c', help: 'ctrl+g',
  allow_once: 'ctrl+y', deny: 'ctrl+n', reset_keys: 'f12', undo: 'ctrl+z',
  toggle_activity: 'ctrl+o', new_tab: 'ctrl+t', close_tab: 'ctrl+w',
  previous_tab: 'ctrl+pageup', next_tab: 'ctrl+pagedown', cycle_review: 'shift+tab',
  scroll_page_up: 'pageup', scroll_page_down: 'pagedown', scroll_bottom: 'end',
});

const KEY_BYTES = Object.freeze({
  f12: '\u001b[24~', 'shift+tab': '\u001b[Z',
  'ctrl+pageup': '\u001b[5;5~', 'ctrl+pagedown': '\u001b[6;5~',
  pageup: '\u001b[5~', pagedown: '\u001b[6~', end: '\u001b[F',
});

export function validateKeyBindings(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw invalid('key_bindings must be an object');
  const unknown = Object.keys(overrides).find((action) => !(action in DEFAULT_KEY_BINDINGS));
  if (unknown) throw invalid(`keyboard action ${unknown} is not supported`);
  const result = { ...DEFAULT_KEY_BINDINGS, ...overrides };
  const values = Object.values(result);
  if (values.some((value) => bindingBytes(value) === null)) throw invalid('keyboard binding is not supported by this terminal adapter');
  if (new Set(values).size !== values.length) throw new ContractError('key_conflict', 'keyboard actions conflict');
  for (const required of ['cancel', 'help', 'reset_keys']) {
    if (!result[required]) throw new ContractError('key_safety_missing', 'cancel, help, and reset keys must remain reachable');
  }
  return Object.freeze(result);
}

export function bindingBytes(binding) {
  if (KEY_BYTES[binding]) return KEY_BYTES[binding];
  const match = /^ctrl\+([a-z])$/u.exec(binding ?? '');
  return match ? String.fromCharCode(match[1].charCodeAt(0) - 96) : null;
}

function invalid(message) {
  return new ContractError('key_unsupported', message);
}
