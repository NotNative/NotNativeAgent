// SPDX-License-Identifier: Apache-2.0

export const CORE_TOOL_NAMES = Object.freeze([
  'tool.search',
  'fs.list_directory', 'fs.glob', 'fs.search_text', 'fs.metadata', 'fs.read_text', 'fs.read_lines',
  'fs.write_text', 'fs.edit_text', 'fs.edit_lines', 'fs.delete_file',
  'nna.search_guidance', 'nna.read_guidance', 'nna.list_sessions', 'nna.diagnose_turn',
  'nna.mcp_status', 'nna.mcp_test',
  'web.search', 'web.fetch', 'process.run', 'shell.run',
  'skill.search', 'skill.load', 'agent.run',
  'work.status', 'work.goal', 'work.task_add', 'work.task_update',
]);
