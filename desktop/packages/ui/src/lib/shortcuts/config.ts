// SPDX-License-Identifier: Apache-2.0
/**
 * Shortcut declarations (doc 14 §I.1/§I.2 config.ts): grouped schema of
 * {id, defaultBinding, customizable, prefixStyle?}. Declaration only — the
 * types, lookups and override resolution live in schema.ts; parsing/display
 * in bindings.ts. `mod` = Cmd on macOS else Ctrl; `alt` = Option/Alt.
 */
import type { I18nKey } from '../i18n/messages/en.ts';

export type ShortcutCategory = 'session' | 'models' | 'panels' | 'navigation' | 'application';

export interface ShortcutDecl {
  id: string;
  defaultBinding: string;
  customizable: boolean;
  settingsLabelKey?: I18nKey;
  prefixStyle?: boolean;
}

interface GroupDecl {
  category: ShortcutCategory;
  entries: ShortcutDecl[];
}

const custom = (id: string, binding: string, labelKey: I18nKey): ShortcutDecl =>
  ({ id, defaultBinding: binding, customizable: true, settingsLabelKey: labelKey });
const internal = (id: string, binding: string): ShortcutDecl =>
  ({ id, defaultBinding: binding, customizable: false });

export const SHORTCUT_SCHEMA: readonly GroupDecl[] = [
  {
    category: 'session',
    entries: [
      custom('add_selection_to_chat', 'mod+l', 'shortcuts.label.add_selection_to_chat'),
      custom('focus_input', 'mod+i', 'shortcuts.label.focus_input'),
      custom('open_timeline_dialog', 'mod+k t', 'shortcuts.label.open_timeline_dialog'),
      custom('new_chat', 'mod+n', 'shortcuts.label.new_chat'),
      custom('switch_session_previous', 'mod+alt+arrowleft', 'shortcuts.label.switch_session_previous'),
      custom('switch_session_next', 'mod+alt+arrowright', 'shortcuts.label.switch_session_next'),
      custom('rename_current_session', 'mod+k r', 'shortcuts.label.rename_current_session'),
      custom('close_session_tab', 'alt+w', 'shortcuts.label.close_session_tab'),
      custom('open_draft_project_picker', 'mod+k p', 'shortcuts.label.open_draft_project_picker'),
      custom('open_draft_worktree_picker', 'mod+k g', 'shortcuts.label.open_draft_worktree_picker'),
      custom('open_session_list', 'mod+k l', 'shortcuts.label.open_session_list'),
      custom('new_chat_worktree', 'mod+shift+n', 'shortcuts.label.new_chat_worktree'),
      custom('new_mini_chat', 'mod+alt+n', 'shortcuts.label.new_mini_chat'),
      custom('expand_input', 'mod+shift+e', 'shortcuts.label.expand_input'),
      custom('toggle_dictation', 'mod+alt+v', 'shortcuts.label.toggle_dictation'),
      internal('abort_run', 'escape'), // aborts the running agent
    ],
  },
  {
    category: 'models',
    entries: [
      custom('open_model_selector', 'mod+shift+m', 'shortcuts.label.open_model_selector'),
      internal('cycle_thinking_variant', 'mod+shift+t'),
      custom('cycle_agent', 'tab', 'shortcuts.label.cycle_agent'),
      custom('cycle_favorite_model_forward', 'ctrl+]', 'shortcuts.label.cycle_favorite_model_forward'),
      custom('cycle_favorite_model_backward', 'ctrl+[', 'shortcuts.label.cycle_favorite_model_backward'),
    ],
  },
  {
    category: 'panels',
    entries: [
      custom('toggle_terminal', 'mod+j', 'shortcuts.label.toggle_terminal'),
      custom('toggle_terminal_expanded', 'mod+shift+j', 'shortcuts.label.toggle_terminal_expanded'),
      custom('toggle_sidebar', 'mod+b', 'shortcuts.label.toggle_sidebar'),
      custom('toggle_prompt_navigator', 'mod+k n', 'shortcuts.label.toggle_prompt_navigator'),
      { ...custom('switch_session_tab', 'mod', 'shortcuts.label.switch_session_tab'), prefixStyle: true },
      { ...custom('switch_context_surface', 'mod+alt', 'shortcuts.label.switch_context_surface'), prefixStyle: true },
      custom('toggle_services_menu', 'mod+k i', 'shortcuts.label.toggle_services_menu'),
    ],
  },
  {
    category: 'navigation',
    entries: [
      internal('save_file', 'mod+s'),
      internal('find_in_file', 'mod+f'),
      custom('open_go_to_line', 'alt+g', 'shortcuts.label.open_go_to_line'),
    ],
  },
  {
    category: 'application',
    entries: [
      custom('open_command_palette', 'mod+p', 'shortcuts.label.open_command_palette'),
      custom('open_settings', 'mod+comma', 'shortcuts.label.open_settings'),
      custom('open_help', 'mod+k h', 'shortcuts.label.open_help'),
      custom('cycle_theme', 'mod+k c', 'shortcuts.label.cycle_theme'),
    ],
  },
];
