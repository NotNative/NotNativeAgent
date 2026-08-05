// SPDX-License-Identifier: Apache-2.0
import { valueOverlay } from './tui-overlays.js';

const MUTATIONS = new Set([
  'fs.write_text', 'fs.edit_text', 'fs.edit_lines', 'fs.delete_file', 'fs.copy', 'fs.move',
]);

export function openFilesView(workspace) {
  const session = workspace.projection.active();
  const changes = workspace.activeEngine().tools.changeSnapshot();
  workspace.projection.openOverlay(valueOverlay('files', 'Conversation files', filesView(session, changes)));
}

export function filesView(session, changes = []) {
  const records = [...(session?.historyRecords ?? []), ...(session?.records ?? [])]
    .filter((record) => record.type === 'tool_status' && record.tool?.startsWith('fs.') && record.status !== 'running');
  const failed = records.filter((record) => record.status !== 'succeeded' && record.status !== 'duplicate_ignored');
  const read = unique(records.filter((record) => !MUTATIONS.has(record.tool) && record.status === 'succeeded'));
  const lines = [
    'Current Console runtime only; /diff shows the content changes retained by NNA.',
    `Read or discovered: ${read.length} | Changed: ${changes.length} | Failed: ${failed.length}`,
  ];
  section(lines, 'Changed', changes.map((entry) => `${entry.path} [${entry.operations.join(', ')}]`));
  section(lines, 'Read or discovered', read.map((record) => `${record.tool} ${record.target ?? '(no target reported)'}`));
  section(lines, 'Failed', failed.map((record) => {
    const reason = record.failure_reason ?? record.reason_code ?? record.status;
    return `${record.tool} ${record.target ?? '(no target reported)'} - ${reason}`;
  }));
  return lines.join('\n');
}

function unique(records) {
  const seen = new Set();
  return records.filter((record) => {
    const key = `${record.tool}\0${record.target ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(-128);
}

function section(lines, title, entries) {
  if (entries.length === 0) return;
  lines.push('', `${title}:`, ...entries.slice(-128).map((entry) => `  ${entry}`));
}
