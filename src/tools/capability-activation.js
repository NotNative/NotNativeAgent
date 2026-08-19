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
});

const INTENTS = Object.freeze([
  ['filesystem_mutation', /\b(?:add|build|change|create|delete|develop|edit|fix|generate|implement|make|modify|patch|refactor|remove|rename|repair|scaffold|update|upgrade|write)\b/iu],
  ['filesystem_transfer', /\b(?:copy|move|relocate|rename)\b/iu],
  ['filesystem_deletion', /\b(?:clean|delete|purge|remove)\b/iu],
  ['execution', /\b(?:benchmark|build|check|compile|deploy|execute|format|install|launch|lint|run|serve|start|test|verify)\b/iu],
  ['elevation', /\b(?:admin(?:istrator)?|elevat(?:e|ed|ion)|permission denied|root privilege|sudo|uac)\b/iu],
  ['delegation', /\b(?:delegate|parallel|sub[ -]?agent|specialist)\b/iu],
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
