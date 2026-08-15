// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

export const DEFAULT_KEY_BINDINGS = Object.freeze({
  submit: 'ctrl+s', newline: 'ctrl+j', cancel: 'ctrl+c', help: 'ctrl+g',
  allow_once: 'ctrl+y', deny: 'ctrl+n', reset_keys: 'f12', undo: 'ctrl+z',
  toggle_activity: 'ctrl+o', new_tab: 'ctrl+t', close_tab: 'ctrl+w',
  previous_tab: 'ctrl+pageup', next_tab: 'ctrl+pagedown', cycle_review: 'shift+tab',
  scroll_page_up: 'pageup', scroll_page_down: 'pagedown', scroll_bottom: 'end',
});

const NAMED_BINDINGS = new Set([
  'f12', 'shift+tab', 'ctrl+pageup', 'ctrl+pagedown', 'pageup', 'pagedown', 'end',
]);

export function validateKeyBindings(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw invalid('key_bindings must be an object');
  const unknown = Object.keys(overrides).find((action) => !(action in DEFAULT_KEY_BINDINGS));
  if (unknown) throw invalid(`keyboard action ${unknown} is not supported`);
  const invalidOverride = Object.entries(overrides).find(([, value]) => typeof value !== 'string' || !value.trim());
  if (invalidOverride) throw invalid(`keyboard action ${invalidOverride[0]} requires a binding`);
  const normalizedOverrides = Object.fromEntries(Object.entries(overrides).map(([action, binding]) => [action, binding.toLowerCase()]));
  const result = { ...DEFAULT_KEY_BINDINGS, ...normalizedOverrides };
  const values = Object.values(result);
  if (values.some((value) => !supportedBinding(value))) throw invalid('keyboard binding is not supported by this terminal adapter');
  // Bindings are globally unique because decoding occurs before modal context is selected.
  if (new Set(values).size !== values.length) throw new ContractError('key_conflict', 'keyboard actions conflict');
  for (const required of ['cancel', 'help', 'reset_keys']) {
    if (!result[required]) throw new ContractError('key_safety_missing', 'cancel, help, and reset keys must remain reachable');
  }
  return Object.freeze(result);
}

function supportedBinding(binding) {
  return NAMED_BINDINGS.has(binding) || /^ctrl\+[a-z]$/u.test(binding ?? '');
}

function invalid(message) {
  return new ContractError('key_unsupported', message);
}
