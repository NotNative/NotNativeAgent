// SPDX-License-Identifier: Apache-2.0

export const FOUNDATIONAL_TOOL_NAMES = Object.freeze([
  'tool_search',
  'fs_list', 'fs_read', 'fs_search_text',
  'shell_run',
  'work_plan', 'work_status', 'work_task_update',
  'turn_finish',
  'git_inspect',
]);

export const TOOL_SURFACE_ELIGIBLE_NAMES = Object.freeze([
  ...FOUNDATIONAL_TOOL_NAMES,
  'fs.directory', 'fs.write_text', 'fs.edit_text', 'fs.edit_lines',
  'agent.run', 'image.inspect', 'notification.telegram',
]);

export const LEGACY_PROVIDER_TOOL_NAMES = Object.freeze([
  'fs.glob', 'fs.list_directory', 'fs.metadata', 'fs.read_lines', 'fs.read_text',
  'fs.create_directory', 'fs.copy_file', 'fs.move_file', 'fs.delete_file',
  'nna.list_sessions',
]);

export const INTERNAL_TOOL_NAMES = Object.freeze([
  'project.verify', 'code.diagnostics', 'ref.store', 'process.run',
]);
