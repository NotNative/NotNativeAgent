// SPDX-License-Identifier: Apache-2.0
/**
 * Canonical English dictionary (doc 14 §H.2): the flat dotted key→string map;
 * the exported I18nKey type is the CLOSED key set — non-EN catalogs may only
 * carry subsets. P5-4 scope: shell/boot-notification keys; the settings
 * surfaces grow their namespaces as their pages land (§Letters A–E in
 * PROGRESS).
 */

const en = {
  'app.title': 'NotNativeDesktop',
  'shell.sessions': 'Sessions',
  'shell.newSession': 'New session',
  'shell.chatPlaceholder': 'Send a message to the harness…',
  'shell.send': 'Send',
  'shell.noSession': 'No session selected',
  'shell.connecting': 'Connecting to harness…',
  'shell.connected': 'Harness connected',
  'shell.offline': 'Harness offline',
  'shell.mockBanner': 'Mock harness — NotNativeAgent integration pending',
  'shell.busy': 'Working…',
  'shell.recovery.title': 'Startup did not finish',
  'shell.recovery.retry': 'Retry',
  // Pre-dictionary bootstrap strings (§H.3): splash/connection copy that
  // speaks before dictionaries install (bootstrap.ts resolves these ids).
  'bootstrap.connecting': 'Connecting…',
  'bootstrap.loading': 'Loading NotNativeDesktop…',
  'bootstrap.cliMissing': 'Harness CLI not found on this machine.',
  'bootstrap.devServerWait': 'Waiting for the dev server… (port {port})',
  'bootstrap.offline': 'The connection dropped. Retrying…',
  // Notification template i18n-key DEFAULTS (§G.8): templates hold KEYS,
  // never raw strings; the defaults page (P6+) writes these references.
  'settings.notifications.page.template.defaults.completion.title': 'Agent finished',
  'settings.notifications.page.template.defaults.completion.message': 'The session completed its turn.',
  'settings.notifications.page.template.defaults.error.title': 'Agent error',
  'settings.notifications.page.template.defaults.error.message': 'The session hit an error.',
  'settings.notifications.page.template.defaults.question.title': 'Agent question',
  'settings.notifications.page.template.defaults.question.message': 'The agent needs your input.',
  'settings.notifications.page.template.defaults.subtask.title': 'Subtask progress',
  'settings.notifications.page.template.defaults.subtask.message': 'A subtask reported new progress.',
  // Shortcut settings labels (§I.3): the customizable rows only — internal
  // bindings never appear in the recorder.
  'shortcuts.label.add_selection_to_chat': 'Add selection to chat',
  'shortcuts.label.focus_input': 'Focus composer',
  'shortcuts.label.open_timeline_dialog': 'Open timeline dialog',
  'shortcuts.label.new_chat': 'New chat',
  'shortcuts.label.switch_session_previous': 'Previous session',
  'shortcuts.label.switch_session_next': 'Next session',
  'shortcuts.label.rename_current_session': 'Rename current session',
  'shortcuts.label.toggle_permission_auto_accept': 'Toggle permission auto-accept',
  'shortcuts.label.close_session_tab': 'Close session tab',
  'shortcuts.label.open_draft_project_picker': 'Pick draft project',
  'shortcuts.label.open_draft_worktree_picker': 'Pick draft worktree',
  'shortcuts.label.open_session_list': 'Open session list',
  'shortcuts.label.new_chat_worktree': 'New chat in worktree',
  'shortcuts.label.new_mini_chat': 'New mini chat',
  'shortcuts.label.expand_input': 'Expand input',
  'shortcuts.label.toggle_dictation': 'Toggle dictation',
  'shortcuts.label.open_model_selector': 'Open model selector',
  'shortcuts.label.cycle_agent': 'Cycle agent',
  'shortcuts.label.cycle_favorite_model_forward': 'Next favorite model',
  'shortcuts.label.cycle_favorite_model_backward': 'Previous favorite model',
  'shortcuts.label.toggle_terminal': 'Toggle terminal',
  'shortcuts.label.toggle_terminal_expanded': 'Toggle expanded terminal',
  'shortcuts.label.toggle_sidebar': 'Toggle sidebar',
  'shortcuts.label.toggle_prompt_navigator': 'Toggle prompt navigator',
  'shortcuts.label.switch_session_tab': 'Switch session tab',
  'shortcuts.label.switch_context_surface': 'Switch context surface',
  'shortcuts.label.toggle_services_menu': 'Toggle services menu',
  'shortcuts.label.open_go_to_line': 'Go to line',
  'shortcuts.label.open_command_palette': 'Open command palette',
  'shortcuts.label.open_settings': 'Open settings',
  'shortcuts.label.open_help': 'Open help',
  'shortcuts.label.cycle_theme': 'Cycle theme',
};

export type I18nKey = keyof typeof en;
export type Dictionary = Record<I18nKey, string>;
export type PartialDictionary = Partial<Dictionary>;
export default en as Dictionary;
