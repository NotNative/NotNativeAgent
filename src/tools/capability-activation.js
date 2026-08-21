// SPDX-License-Identifier: Apache-2.0

const BUNDLES = Object.freeze({
  filesystem_mutation: Object.freeze([
    'fs.directory', 'fs.write_text', 'fs.edit_text',
  ]),
  execution: Object.freeze(['shell.run']),
  verification: Object.freeze(['project.verify']),
  exact_process: Object.freeze(['process.run']),
  elevation: Object.freeze(['system.elevate']),
  delegation: Object.freeze(['agent.run']),
  reference_staging: Object.freeze(['ref.inspect', 'ref.store']),
  conversation_work: Object.freeze(['work.plan']),
  notification: Object.freeze(['notification.telegram']),
  code_inspection: Object.freeze(['git.inspect', 'code.diagnostics']),
  nna_guidance: Object.freeze(['nna.search_guidance', 'nna.read_guidance']),
  nna_diagnostics: Object.freeze(['nna.diagnose_turn']),
  mcp_control: Object.freeze(['nna.mcp_status', 'nna.mcp_test']),
  session_history: Object.freeze(['session.search_history', 'session.read_history']),
  skill_workflow: Object.freeze(['skill.search', 'skill.load']),
});

const INTENTS = Object.freeze([
  ['filesystem_mutation', /\b(?:add|build|change|create|delete|develop|edit|fix|generate|implement|make|modify|patch|refactor|remove|rename|repair|scaffold|update|upgrade|write)\b/iu],
  ['execution', /\b(?:benchmark|build|check|compile|deploy|execute|format|install|launch|lint|run|serve|start|test|verify)\b/iu],
  ['verification', /\b(?:project\.verify|verification receipt|\/verify)\b/iu],
  ['exact_process', /\b(?:direct executable|exact argv|process\.run|single executable|without (?:a )?shell)\b/iu],
  ['delegation', /\b(?:delegate|parallel|sub[ -]?agent|specialist)\b/iu],
  ['reference_staging', /\b(?:reference|stage|store|stdin|large (?:content|payload)|reusable (?:content|payload))\b/iu],
  ['conversation_work', /\b(?:build|goal|implement|milestone|plan|project|refactor|repair|task|track|upgrade)\b/iu],
  ['notification', /\b(?:alert|notify|notification|telegram)\b/iu],
  ['code_inspection', /\b(?:code|codebase|compile|diagnostic|git|repository|repo|symbol|typecheck)\b/iu],
  ['nna_guidance', /\b(?:nna|notnativeagent|agent harness|skill authoring|provider profile)\b/iu],
  ['nna_diagnostics', /\b(?:diagnos(?:e|is|tic)|failed (?:session|turn)|failure code|health|logs?|runtime failure|troubleshoot)\b/iu],
  ['mcp_control', /\bmcp\b/iu],
  ['session_history', /\b(?:earlier|history|omitted history|past session|previous (?:decision|session|turn)|prior (?:decision|session|turn))\b/iu],
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
