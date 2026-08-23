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
  web_research: Object.freeze(['web.search', 'web.fetch', 'web.browse']),
  browser_interaction: Object.freeze(['web.browse']),
  browser_verification: Object.freeze(['web.browse']),
  code_inspection: Object.freeze(['git.inspect', 'code.diagnostics']),
  image_inspection: Object.freeze(['image.inspect']),
  nna_guidance: Object.freeze(['nna.search_guidance', 'nna.read_guidance']),
  nna_diagnostics: Object.freeze(['nna.diagnose_turn']),
  mcp_control: Object.freeze(['nna.mcp_status', 'nna.mcp_test']),
  session_history: Object.freeze(['session.search_history', 'session.read_history']),
  skill_workflow: Object.freeze(['skill.search', 'skill.load']),
});

const INTENTS = Object.freeze([
  ['web_research', /\b(?:weather|forecast|temperature|news|prices?|availability|today|tonight)\b/iu],
  ['web_research', /\b(?:latest|current)\s+(?:weather|forecast|temperature|news|prices?|availability|release|version|status|events?|conditions?)\b/iu],
  ['filesystem_mutation', /\b(?:add|build|change|create|delete|develop|edit|fix|generate|implement|make|modify|patch|refactor|remove|rename|repair|scaffold|update|upgrade|write)\b/iu],
  ['execution', /\b(?:benchmark|build|compile|deploy|execute|format|install|launch|lint|run|serve|start|test)\b/iu],
  ['verification', /\b(?:project\.verify|verification receipt|\/verify)\b/iu],
  ['exact_process', /\b(?:direct executable|exact argv|process\.run|single executable|without (?:a )?shell)\b/iu],
  ['delegation', /\b(?:delegate|parallel|sub[ -]?agent|specialist)\b/iu],
  ['reference_staging', /\b(?:reference|stage|store|stdin|large (?:content|payload)|reusable (?:content|payload))\b/iu],
  ['conversation_work', /\b(?:durable plan|goal|milestone|plan|task|track)\b/iu],
  ['notification', /\b(?:alert|notify|notification|telegram)\b/iu],
  ['browser_interaction', /(?:\b(?:browse|browser)\b|\bnavigate\s+(?:to|the)\b|\b(?:online|internet|web[ -]?(?:page|site))\b|\blocalhost\b|https?:\/\/|\b(?:research|investigate|look\s+up|find|compare|check|scan|shop)\b.{0,48}\b(?:availability|current|internet|latest|news|online|prices?|products?|retailers?|sources?|web)\b|\b(?:availability|current|latest|news|prices?|products?|retailers?)\b.{0,48}\b(?:compare|check|find|investigate|research|scan|shop)\b)/iu],
  ['browser_verification', /\b(?:three\.js|webgl|website|web[ -]?app|frontend|landing\s+page|browser\s+game)\b/iu],
  ['code_inspection', /\b(?:code|codebase|compile|diagnostic|git|repository|repo|symbol|typecheck)\b/iu],
  ['image_inspection', /\b(?:image|picture|render|screenshot|visual|visually)\b/iu],
  ['nna_guidance', /\b(?:nna|notnativeagent|agent harness|skill authoring|provider profile)\b/iu],
  ['nna_diagnostics', /\b(?:diagnos(?:e|is|tic)|failed (?:session|turn)|failure code|health|logs?|runtime failure|troubleshoot)\b/iu],
  ['mcp_control', /\bmcp\b/iu],
  ['session_history', /\b(?:earlier|history|omitted history|past session|previous (?:decision|session|turn)|prior (?:decision|session|turn))\b/iu],
  ['skill_workflow', /\b(?:devteam|skill|specialized workflow|troubleshoot workflow)\b/iu],
]);

const OPENING_ACTION_BUNDLES = new Set([
  'filesystem_mutation', 'execution', 'exact_process', 'elevation',
  'delegation', 'reference_staging', 'notification',
]);

export function taskActivatedToolNames(query = '') {
  const bundles = activatedBundles(query);
  const names = new Set();
  for (const bundle of bundles) for (const name of BUNDLES[bundle]) names.add(name);
  return Object.freeze([...names]);
}

export function actionOrientedIntent(query = '') {
  return activatedBundles(query).some((bundle) => OPENING_ACTION_BUNDLES.has(bundle));
}

export function toolOrientedIntent(query = '') {
  const text = String(query).slice(0, 32_768);
  if (!text.trim()) return false;
  if (activatedBundles(text).length > 0) return true;
  return /\b(?:inspect|read|list|search|find|locate|open|fetch|browse|research|look\s+up|download|upload)\b/iu.test(text)
    || /\b(?:workspace|files?|director(?:y|ies)|folders?|repository|repo|codebase|source\s+code|logs?|database)\b/iu.test(text)
    || /\b(?:weather|forecast|temperature|news|prices?|availability|latest|current|today|tonight|now)\b/iu.test(text);
}

export function directBrowserIntent(query = '') {
  const bundles = activatedBundles(query);
  return bundles.includes('browser_interaction') || bundles.includes('browser_verification');
}

export function monitoringIntent(query = '') {
  const text = String(query).slice(0, 32_768);
  return /\b(?:keep checking|monitor|poll|repeatedly check|wait for|watch)\b/iu.test(text);
}

function activatedBundles(query) {
  const text = String(query).slice(0, 32_768);
  if (!text.trim()) return [];
  return INTENTS.filter(([, pattern]) => pattern.test(text)).map(([bundle]) => bundle);
}

export const TOOL_CAPABILITY_BUNDLES = BUNDLES;
export const SITUATIONAL_TOOL_NAMES = Object.freeze([...new Set(Object.values(BUNDLES).flat())]);
