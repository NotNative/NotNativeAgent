// SPDX-License-Identifier: Apache-2.0

export const TUI_COMMANDS = Object.freeze([
  command('/attach PATH', 'Queue an image for the next message', 'conversation'),
  command('/attachments', 'Inspect images queued in this conversation', 'conversation'),
  command('/detach INDEX|all', 'Remove a queued image before submission', 'conversation'),
  command('/attachment retry ID MESSAGE', 'Retry a temporarily failed managed image', 'conversation'),
  command('/attachment remove ID', 'Remove a failed managed image', 'conversation'),
  command('/audit', 'Show the redacted reviewer audit', 'governance'),
  command('/support [preview|PATH.zip]', 'Create or preview a redacted troubleshooting ZIP', 'diagnostics'),
  command('/websearch [ENDPOINT|test|deploy|disable]', 'Configure and test SearXNG web search', 'configuration'),
  command('/webfetch [status|trust ORIGIN|revoke ORIGIN]', 'Manage exact private origins trusted for WebFetch', 'configuration'),
  command('/workspace PATH', 'Open a new conversation rooted at a working directory', 'sessions'),
  command('/close', 'Close this conversation; active work requires confirmation', 'sessions'),
  command('/config', 'Open the configuration hub', 'configuration'),
  command('/gateway [status|test|start|stop|enable|disable]', 'Configure the Telegram gateway', 'configuration'),
  command('/gateway authorize|revoke USER_ID', 'Manage authorized Telegram operators', 'configuration'),
  command('/gateway token-env NAME', 'Use a Telegram token from an environment variable', 'configuration'),
  command('/gateway workspace PATH', 'Set the Telegram gateway working directory', 'configuration'),
  command('/confirm close', 'Confirm closing the active conversation', 'sessions'),
  command('/context', 'Inspect current context usage', 'conversation'),
  command('/diff [PATH]', 'Show file changes made by NNA in this conversation', 'conversation'),
  command('/compact', 'Explicitly compact settled conversation context', 'conversation'),
  command('/copy [N]', 'Copy the latest or Nth-latest assistant response explicitly', 'conversation'),
  command('/clear conversation', 'Request a confirmed clear of active conversation context', 'conversation'),
  command('/confirm clear conversation', 'Confirm clearing active conversation context', 'conversation'),
  command('/health', 'Inspect runtime and dependency health', 'diagnostics'),
  command('/trace [failures|open|turn ID]', 'Inspect the local forensic trace for this conversation', 'diagnostics'),
  command('/dream [status|pause|resume|run]', 'Inspect or control local idle maintenance', 'diagnostics'),
  command('/hooks', 'Inspect discovered hook bundles and registration health', 'diagnostics'),
  command('/extensions', 'Inspect installed extension capabilities and diagnostics', 'diagnostics'),
  command('/help', 'Browse commands and current key bindings', 'console'),
  command('/model [NAME]', 'Choose or directly set the active model', 'configuration'),
  command('/model qualify', 'Run bounded compatibility probes for the active model', 'configuration'),
  command('/mcp', 'Manage Model Context Protocol servers', 'configuration'),
  command('/mcp add-http ID ENDPOINT [CREDENTIAL_ENV]', 'Add a Streamable HTTP MCP server', 'configuration'),
  command('/mcp add-stdio ID COMMAND [ARG ...]', 'Add a stdio MCP server without a shell', 'configuration'),
  command('/mcp test ID', 'Connect, negotiate, and discover an MCP server', 'configuration'),
  command('/mcp enable|disable|delete ID', 'Change an MCP server configuration', 'configuration'),
  command('/mcp resources ID', 'Browse attributed resources from a connected MCP server', 'configuration'),
  command('/mcp read ID URI', 'Read one bounded untrusted MCP resource', 'configuration'),
  command('/mcp prompts ID', 'Browse prompts from a connected MCP server', 'configuration'),
  command('/mcp prompt ID NAME [JSON]', 'Get one attributed MCP prompt', 'configuration'),
  command('/memory', 'Inspect memory integration health and stored items', 'conversation'),
  command('/memory save TEXT', 'Explicitly save non-secret project memory', 'conversation'),
  command('/memory delete ID [EXPECTED_VERSION]', 'Delete project memory with optional version guard', 'conversation'),
  command('/skills', 'Browse registered user, project, and host-contributed skills', 'workflows'),
  command('/skill ID [REQUEST]', 'Invoke one user-accessible skill for this turn', 'workflows'),
  command('/devteam [REQUEST]', 'Plan, implement, test, and independently review a software change', 'workflows'),
  command('/troubleshoot [DESCRIPTION]', 'Diagnose an NNA turn from bounded runtime evidence', 'diagnostics'),
  command('/new NAME', 'Create and select a conversation', 'sessions'),
  command('/quit', 'Exit NNA and restore the terminal', 'console'),
  command('/provider [ID]', 'Choose a configured provider profile', 'configuration'),
  command('/provider ROLE ID', 'Assign a profile to primary, reviewer, subagent, or vision', 'configuration'),
  command('/provider ROLE clear', 'Clear a reviewer, subagent, or vision profile assignment', 'configuration'),
  command('/provider add ID ENDPOINT MODEL [CREDENTIAL_ENV]', 'Add a provider profile from Main', 'configuration'),
  command('/provider edit ID ENDPOINT MODEL [CREDENTIAL_ENV|-]', 'Edit a provider profile from Main', 'configuration'),
  command('/provider limits ID CONTEXT_BYTES OUTPUT_TOKENS', 'Set known provider model limits from Main', 'configuration'),
  command('/provider test ID', 'Test provider connectivity and model discovery', 'configuration'),
  command('/provider delete ID', 'Delete an unused provider profile from Main', 'configuration'),
  command('/permissions [revoke ID]', 'Inspect or revoke conversation preauthorizations', 'governance'),
  command('/rename NAME', 'Rename the active conversation', 'sessions'),
  command('/steer MESSAGE', 'Add authenticated guidance to the active turn', 'conversation'),
  command('/switch ID-OR-NAME', 'Select another attached conversation', 'sessions'),
  command('/trust workspace', 'Trust this resolved workspace for project configuration on restart', 'configuration'),
  command('/untrust workspace', 'Stop loading project configuration from this workspace', 'configuration'),
]);

export function commandSuggestions(input, limit = 6) {
  const query = String(input).trimStart().toLowerCase();
  if (!query.startsWith('/') || query.includes('\n')) return [];
  return TUI_COMMANDS
    .map((item) => ({ item, score: suggestionScore(item, query) }))
    .filter((candidate) => candidate.score < 2)
    .sort((left, right) => left.score - right.score || left.item.usage.localeCompare(right.item.usage))
    .slice(0, limit)
    .map((candidate) => candidate.item);
}

export function commandDefinition(name) {
  if (name === '/bundle') return TUI_COMMANDS.find((item) => item.name === '/support') ?? null;
  if (['/search-config', '/search_config'].includes(name)) return TUI_COMMANDS.find((item) => item.name === '/websearch') ?? null;
  return TUI_COMMANDS.find((item) => item.name === name) ?? null;
}

export function commandsByCategory() {
  const groups = new Map();
  for (const item of TUI_COMMANDS) {
    const values = groups.get(item.category) ?? [];
    values.push(item);
    groups.set(item.category, values);
  }
  return groups;
}

export function commandPresentation(item, session, bindings) {
  const unavailable = unavailableReason(item, session);
  return Object.freeze({
    ...item, available: unavailable === null, unavailableReason: unavailable,
    effectiveBinding: item.bindingAction ? bindings[item.bindingAction] ?? null : null,
  });
}

function command(usage, description, category) {
  const name = usage.split(' ')[0];
  return Object.freeze({
    name, usage, description, category, origin: 'core',
    availability: 'runtime', requiredCapability: requiredCapability(usage),
    bindingAction: bindingAction(name),
  });
}

function requiredCapability(usage) {
  if (usage.startsWith('/memory')) return 'configured memory adapter';
  if (usage.startsWith('/mcp')) return 'configured MCP capability';
  if (usage.startsWith('/provider')) return 'provider configuration';
  if (usage.startsWith('/gateway')) return 'Telegram gateway configuration';
  if (usage.startsWith('/attach') || usage.startsWith('/detach')) return 'attachment admission';
  if (usage.startsWith('/copy')) return 'terminal clipboard capability';
  if (usage.startsWith('/support')) return 'local diagnostic storage';
  if (usage.startsWith('/trace')) return 'local forensic telemetry';
  return 'Console';
}

function bindingAction(name) {
  return ({ '/help': 'help', '/new': 'new_tab', '/close': 'close_tab', '/quit': 'cancel' })[name] ?? null;
}

function unavailableReason(item, session) {
  const mainOnly = /^(?:\/provider (?:add|edit|test|delete)|\/mcp (?:add-|test|enable|disable|delete))/u.test(item.usage);
  if (mainOnly && session.role !== 'primary') return 'manage this from Main';
  if (item.name === '/close' && session.role === 'primary') return 'Main remains attached until exit';
  if (item.name === '/steer' && !session.activeTurnId) return 'no active turn';
  if (item.usage.startsWith('/memory ') && session.commandCapabilities?.memoryAvailable === false) return 'memory adapter unavailable';
  if (/^\/mcp (?:resources|read|prompts|prompt)/u.test(item.usage) && session.commandCapabilities?.mcpReady === false) return 'no ready MCP server';
  return null;
}

function suggestionScore(item, query) {
  if (item.usage.toLowerCase().startsWith(query)) return 0;
  if (item.description.toLowerCase().includes(query.slice(1))) return 1;
  return 2;
}
