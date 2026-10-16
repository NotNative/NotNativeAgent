// SPDX-License-Identifier: Apache-2.0
export const OPERATIONAL_PAGES = {
  'operations-trust': { title: 'Trust and secrets', sections: [
    { id: 'workspaces', title: 'Workspace trust', anchor: 'trust.workspaces', keywords: 'trusted roots grant revoke project configuration skills admission' },
    { id: 'secrets', title: 'Secrets', anchor: 'trust.secrets', keywords: 'vault broker create rename scope metadata rotate enable disable delete audit API key token password' },
    { id: 'mcp', title: 'MCP credentials', anchor: 'trust.mcp', keywords: 'managed mcp credential references token server binding' },
    { id: 'diagnostics', title: 'Credential diagnostics', anchor: 'trust.diagnostics', keywords: 'secrets metadata vault status legacy provider credential alias startup' },
  ] },
  'operations-tools': { title: 'Tools and integrations', sections: [
    { id: 'servers', title: 'MCP servers', anchor: 'operations.mcp', keywords: 'mcp command endpoint enabled deadlines connections' },
    { id: 'inventory', title: 'Runtime inventory', anchor: 'operations.inventory', keywords: 'mcp runtime configured tools status' },
    { id: 'references', title: 'References', anchor: 'operations.references', keywords: 'mcp headers credentials environment secret references' },
  ] },
  'skills.installed': { title: 'Skills and hooks', sections: [
    { id: 'skills', title: 'Skills', anchor: 'operations.skills', keywords: 'skills catalog provenance diagnostics installed' },
    { id: 'hooks', title: 'Hooks', anchor: 'operations.hooks', keywords: 'hooks bundles subscriptions commands discovery diagnostics' },
  ] },
  'operations-search': { title: 'Search and browsing', sections: [
    { id: 'search', title: 'Web search', anchor: 'operations.search', keywords: 'searxng search profiles endpoints primary enable disable' },
    { id: 'fetch', title: 'Web fetch', anchor: 'operations.fetch', keywords: 'fetch trust domain redirects content network' },
    { id: 'browser', title: 'Managed browser', anchor: 'operations.browser', keywords: 'playwright chromium browser verify launch probe' },
    { id: 'deployment', title: 'SearXNG deployment', anchor: 'operations.deployment', keywords: 'docker container searxng deployment status' },
  ] },
  'operations-services': { title: 'Services and updates', sections: [
    { id: 'desktop', title: 'NNA desktop', anchor: 'operations.desktop', keywords: 'desktop service restart tray browser installation version' },
    { id: 'gateway', title: 'Telegram gateway', anchor: 'operations.gateway', keywords: 'telegram gateway disabled runtime timeout' },
    { id: 'compatibility', title: 'OpenCode service', anchor: 'operations.compatibility', keywords: 'opencode compatibility login auto start stop' },
    { id: 'updates', title: 'Updates', anchor: 'operations.updates', keywords: 'update check version install restart required' },
  ] },
  'operations-data': { title: 'Data and diagnostics', sections: [
    { id: 'summary', title: 'Diagnostic summary', anchor: 'operations.summary', keywords: 'export diagnostics support version data storage paths' },
    { id: 'conversations', title: 'Conversations', anchor: 'operations.conversations', keywords: 'archive restore conversations sessions transcript export usage tokens' },
    { id: 'files', title: 'Files', anchor: 'operations.files', keywords: 'attachments retain upload files limits bytes managed storage' },
    { id: 'environment', title: 'Environment', anchor: 'operations.environment', keywords: 'environment process credentials presence' },
  ] },
} as const;
export type OperationalPage = keyof typeof OPERATIONAL_PAGES;
export const isOperationalPage = (page: string): page is OperationalPage => Object.hasOwn(OPERATIONAL_PAGES, page);
export const OPERATIONAL_SEARCH = Object.entries(OPERATIONAL_PAGES).flatMap(([page, definition]) =>
  definition.sections.map(section => ({ id: section.anchor, page, title: section.title, keywords: section.keywords })));
