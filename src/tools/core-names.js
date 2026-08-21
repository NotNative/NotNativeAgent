// SPDX-License-Identifier: Apache-2.0

export const CORE_TOOL_NAMES = Object.freeze([
  'tool.search',
  'fs.list', 'fs.read', 'fs.search_text',
  'web.search', 'web.fetch', 'web.browse',
]);

export const PROVIDER_NATIVE_TOOL_NAMES = Object.freeze([
  ...CORE_TOOL_NAMES,
  'fs.directory', 'fs.write_text', 'fs.edit_text', 'shell.run', 'work.plan', 'agent.run',
  'session.search_history', 'session.read_history', 'nna.diagnose_turn', 'notification.telegram',
]);

export const LEGACY_PROVIDER_TOOL_NAMES = Object.freeze([
  'fs.glob', 'fs.list_directory', 'fs.metadata', 'fs.read_lines', 'fs.read_text',
  'fs.create_directory', 'fs.edit_lines', 'fs.copy_file', 'fs.move_file', 'fs.delete_file',
  'work.status', 'work.goal', 'work.task_add', 'work.task_update', 'nna.list_sessions',
]);

export const INTERNAL_NATIVE_TOOL_NAMES = Object.freeze([
  'project.verify', 'git.inspect', 'code.diagnostics', 'skill.search', 'skill.load',
  'nna.search_guidance', 'nna.read_guidance', 'ref.store', 'ref.inspect', 'process.run', 'system.elevate',
]);
