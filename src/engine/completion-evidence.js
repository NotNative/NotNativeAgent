// SPDX-License-Identifier: Apache-2.0

// Compatibility: fs.read is the compact canonical surface, while fs.read_lines and
// fs.read_text remain supported granular tools. Evidence must count all three names.
const READ_TOOLS = new Set(['fs.read', 'fs.read_lines', 'fs.read_text']);

export function completionEvidence(transcript, turnId) {
  const records = Array.isArray(transcript) ? transcript.filter((item) => turnIdentity(item) === turnId) : [];
  const requests = records.filter((item) => item.type === 'tool_request' && item.toolName !== 'turn.finish');
  const results = new Map(records.filter((item) => item.type === 'tool_result' && item.toolName !== 'turn.finish')
    .map((item) => [item.providerCallId, item]));
  const successful = requests.filter((request) => lifecycle(results.get(request.providerCallId)) === 'succeeded');
  // Compatibility: new sealed requests store canonical path, while durable journals written
  // before shared argument normalization may still contain file_path.
  const filesRead = new Set(successful.filter((request) => READ_TOOLS.has(request.toolName))
    .map((request) => request.args?.path ?? request.args?.file_path).filter((path) => typeof path === 'string'));
  const toolNames = [...new Set(requests.map((item) => item.toolName))].sort();
  return Object.freeze({
    schema: 'nna.completion-evidence.v1', tool_requests: requests.length,
    tool_results: requests.filter((request) => results.has(request.providerCallId)).length,
    succeeded: successful.length, non_success: requests.length - successful.length,
    unique_files_read: filesRead.size,
    project_verifications: successful.filter((request) => request.toolName === 'project.verify').length,
    tool_names: Object.freeze(toolNames),
  });
}

export function completionEvidenceHint(evidence) {
  // Why: this bounded ledger gives the final response exact mechanical counts without trying
  // to infer nuanced prose. The model remains responsible for conclusions, not event totals.
  return `Machine-derived completion evidence (authoritative event counts; do not inflate or contradict them):\n${JSON.stringify(evidence)}\nWrite the final response now, consistent with the declared outcome and these counts.`;
}

function turnIdentity(item) { return item?.turnId ?? item?.turn_id ?? null; }
function lifecycle(item) { return item?.toolLifecycleStatus ?? item?.status ?? null; }
