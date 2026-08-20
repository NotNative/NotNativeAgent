// SPDX-License-Identifier: Apache-2.0

const BUNDLES = Object.freeze({
  filesystem_mutation: Object.freeze([
    'fs.create_directory', 'fs.write_text', 'fs.edit_text', 'fs.edit_lines',
  ]),
  filesystem_transfer: Object.freeze(['fs.copy_file', 'fs.move_file']),
  filesystem_deletion: Object.freeze(['fs.delete_file']),
  execution: Object.freeze(['process.run', 'shell.run', 'project.verify']),
  elevation: Object.freeze(['system.elevate']),
  delegation: Object.freeze(['agent.run']),
  reference_staging: Object.freeze(['ref.inspect', 'ref.store']),
  conversation_work: Object.freeze(['work.status', 'work.goal', 'work.task_add', 'work.task_update']),
  notification: Object.freeze(['notification.telegram']),
  code_inspection: Object.freeze(['git.inspect', 'code.diagnostics']),
  nna_guidance: Object.freeze(['nna.search_guidance', 'nna.read_guidance']),
  nna_diagnostics: Object.freeze(['nna.list_sessions', 'nna.diagnose_turn']),
  mcp_control: Object.freeze(['nna.mcp_status', 'nna.mcp_test']),
  session_history: Object.freeze(['session.search_history', 'session.read_history']),
  web_retrieval: Object.freeze(['web.search', 'web.fetch', 'web.browse']),
  skill_workflow: Object.freeze(['skill.search', 'skill.load']),
});

const INTENTS = Object.freeze([
  ['filesystem_mutation', /\b(?:add|build|change|create|delete|develop|edit|fix|generate|implement|make|modify|patch|refactor|remove|rename|repair|scaffold|update|upgrade|write)\b/iu],
  ['filesystem_transfer', /\b(?:copy|move|relocate|rename)\b/iu],
  ['filesystem_deletion', /\b(?:clean|delete|purge|remove)\b/iu],
  ['execution', /\b(?:benchmark|build|check|compile|deploy|execute|format|install|launch|lint|run|serve|start|test|verify)\b/iu],
  ['elevation', /\b(?:admin(?:istrator)?|elevat(?:e|ed|ion)|permission denied|root privilege|sudo|uac)\b/iu],
  ['delegation', /\b(?:delegate|parallel|sub[ -]?agent|specialist)\b/iu],
  ['reference_staging', /\b(?:reference|stage|store|stdin|large (?:content|payload)|reusable (?:content|payload))\b/iu],
  ['conversation_work', /\b(?:build|goal|implement|milestone|plan|project|refactor|repair|task|track|upgrade)\b/iu],
  ['notification', /\b(?:alert|notify|notification|telegram)\b/iu],
  ['code_inspection', /\b(?:code|codebase|compile|diagnostic|git|repository|repo|symbol|typecheck)\b/iu],
  ['nna_guidance', /\b(?:nna|notnativeagent|agent harness|skill authoring|provider profile)\b/iu],
  ['nna_diagnostics', /\b(?:diagnos(?:e|is|tic)|failed (?:session|turn)|failure code|health|logs?|runtime failure|troubleshoot)\b/iu],
  ['mcp_control', /\bmcp\b/iu],
  ['session_history', /\b(?:earlier|history|omitted history|past session|previous (?:decision|session|turn)|prior (?:decision|session|turn))\b/iu],
  ['web_retrieval', /\b(?:browse|internet|latest|news|online|research|url|web|website|current (?:availability|law|news|price|release|role|schedule|status|version))\b/iu],
  ['skill_workflow', /\b(?:devteam|skill|specialized workflow|troubleshoot workflow)\b/iu],
]);

export function taskActivatedToolNames(query = '') {
  const text = String(query).slice(0, 32_768);
  if (!text.trim()) return Object.freeze([]);
  const names = new Set();
  for (const [bundle, pattern] of INTENTS) {
    if (pattern.test(text)) for (const name of BUNDLES[bundle]) names.add(name);
  }
  return Object.freeze([...names]);
}

export const TOOL_CAPABILITY_BUNDLES = BUNDLES;
export const SITUATIONAL_TOOL_NAMES = Object.freeze([...new Set(Object.values(BUNDLES).flat())]);
