// SPDX-License-Identifier: Apache-2.0

export const FOUNDATIONAL_TOOL_NAMES = Object.freeze([
  'tool_search',
  'fs_list', 'fs_read', 'fs_search_text',
  'shell_run',
  'work_plan', 'work_status', 'work_task_update',
  'turn_finish',
  'question',
  'git_inspect',
  // NND browser surface only installs this definition; foundational here means
  // the model sees it without a discovery lease when the desktop surface owns it.
  'nnd_browser',
]);

export const TOOL_SURFACE_ELIGIBLE_NAMES = Object.freeze([
  ...FOUNDATIONAL_TOOL_NAMES,
  'fs_directory', 'fs_write_text', 'fs_edit_text', 'fs_edit_lines',
  'agent_run', 'image_inspect', 'notification_telegram',
  // NND browser surface: a core governed action surface, not lease-gated discovery.
  'nnd_browser',
]);

export const LEGACY_PROVIDER_TOOL_NAMES = Object.freeze([
  'fs_glob', 'fs_list_directory', 'fs_metadata', 'fs_read_lines', 'fs_read_text',
  'fs_create_directory', 'fs_copy_file', 'fs_move_file', 'fs_delete_file',
  'nna_list_sessions',
]);

export const INTERNAL_TOOL_NAMES = Object.freeze([
  'project_verify', 'code_diagnostics', 'ref_store', 'process_run',
]);
