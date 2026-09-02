// SPDX-License-Identifier: Apache-2.0

export const FOUNDATIONAL_TOOL_NAMES = Object.freeze([
  'tool.search',
  'system.time',
  'workspace.change',
  'fs.list', 'fs.read', 'fs.search_text',
  'shell.run', 'web.search', 'web.fetch', 'web.browse',
  'work.plan', 'work.status', 'work.goal', 'work.task_add', 'work.task_update',
  'turn.finish',
  'git.inspect',
  'session.search_history', 'session.read_history',
  'nna.search_guidance', 'nna.read_guidance', 'nna.diagnose_turn',
  'ref.inspect', 'skill.search', 'skill.load',
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
  'project.verify', 'code.diagnostics', 'ref.store', 'process.run', 'system.elevate',
]);
