// SPDX-License-Identifier: Apache-2.0
/** Public shortcuts import surface (doc 14 §I.2 `@/lib/shortcuts`). */
export { SHORTCUT_SCHEMA, type ShortcutCategory, type ShortcutDecl } from './config.ts';
export {
  UNASSIGNED_SHORTCUT,
  SEQUENCE_TIMEOUT_MS,
  BindingFormatError,
  parseChord,
  parseCombo,
  comboToString,
  displayChord,
  displayCombo,
  combosConflict,
  chordRisk,
  effectiveBinding,
  type Chord,
  type ShortcutCombo,
} from './bindings.ts';
export {
  shortcutDecl,
  shortcutCategory,
  effectiveShortcutCombo,
  combosFor,
  defaultShortcutBinding,
  customizableActionIds,
  overrideIsPermitted,
  SHORTCUT_CATEGORIES,
  type ShortcutActionId,
} from './schema.ts';
export {
  registerShortcut,
  unregisterShortcut,
  isShortcutRegistrySuspended,
  suspendShortcutRegistry,
  activeShortcutHandler,
} from './registry.ts';
export {
  configureShortcutDispatcher,
  handleShortcutKeydown,
  handleDigitPrefixKeydown,
  cancelArmedShortcut,
  armedShortcutActionId,
  recorderConflict,
} from './dispatcher.ts';
export { installShortcutRouter, useKeybind, useKeybinds, type ShortcutRouterOptions } from './hooks.ts';
