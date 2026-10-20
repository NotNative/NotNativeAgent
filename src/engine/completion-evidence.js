// SPDX-License-Identifier: Apache-2.0

// Why: fs_read and the granular read tools all produce authoritative file observations.
// Completion evidence must count each distinct callable surface.
const READ_TOOLS = new Set(['fs_read', 'fs_read_lines', 'fs_read_text']);

export function completionEvidence(transcript, turnId) {
  const records = Array.isArray(transcript) ? transcript.filter((item) => turnIdentity(item) === turnId) : [];
  const requests = records.filter((item) => item.type === 'tool_request' && item.toolName !== 'turn_finish');
  const results = pairToolResults(records);
  const successful = requests.filter((request) => lifecycle(results.get(request)) === 'succeeded');
  // Compatibility: new sealed requests store canonical path, while durable journals written
  // before shared argument normalization may still contain file_path.
  const filesRead = new Set(successful.filter((request) => READ_TOOLS.has(request.toolName))
    .map((request) => request.args?.path ?? request.args?.file_path).filter((path) => typeof path === 'string'));
  const toolNames = [...new Set(requests.map((item) => item.toolName))].sort();
  return Object.freeze({
    schema: 'nna.completion-evidence.v1', tool_requests: requests.length,
    tool_results: results.size,
    succeeded: successful.length, non_success: requests.length - successful.length,
    unique_files_read: filesRead.size,
    project_verifications: successful.filter((request) => request.toolName === 'project_verify').length,
    tool_names: Object.freeze(toolNames),
  });
}

function pairToolResults(records) {
  const byRequestId = new Map();
  const byCall = new Map();
  const paired = new Map();
  for (const record of records) {
    if (record.toolName === 'turn_finish') continue;
    if (record.type === 'tool_request') {
      enqueue(byRequestId, nonempty(record.requestId), record);
      enqueue(byCall, callKey(record), record);
    } else if (record.type === 'tool_result') {
      const request = nonempty(record.requestId)
        ? dequeue(byRequestId, record.requestId, paired, record.toolName)
        : dequeue(byCall, callKey(record), paired, record.toolName);
      if (request) paired.set(request, record);
    }
  }
  return paired;
}

function enqueue(map, key, request) {
  if (key === null) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(request);
}

function dequeue(map, key, paired, toolName) {
  if (key === null) return null;
  const queue = map.get(key);
  while (queue?.length) {
    const request = queue[0];
    if (paired.has(request)) { queue.shift(); continue; }
    if (request.toolName !== toolName) return null;
    queue.shift();
    return request;
  }
  return null;
}

function callKey(record) {
  const id = nonempty(record.providerCallId);
  return id === null ? null : JSON.stringify([record.stepId ?? null, id, record.toolName]);
}

function nonempty(value) { return typeof value === 'string' && value.length > 0 ? value : null; }

export function completionEvidenceHint(evidence) {
  // Why: this bounded ledger gives the final response exact mechanical counts without trying
  // to infer nuanced prose. The model remains responsible for conclusions, not event totals.
  return `Machine-derived completion evidence (authoritative event counts; do not inflate or contradict them):\n${JSON.stringify(evidence)}\nCounts prove recorded activity, not task correctness. Use them when reporting scope. Explain which checks support the conclusion and identify unverified requirements.`;
}

function turnIdentity(item) { return item?.turnId ?? item?.turn_id ?? null; }
function lifecycle(item) { return item?.toolLifecycleStatus ?? item?.status ?? null; }
