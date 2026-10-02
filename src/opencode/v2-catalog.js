// SPDX-License-Identifier: Apache-2.0
import { projectIdentifier } from './registry.js';
import { apiError, invalid, textInput } from './v2-contract.js';

export function requestDirectory(target, req, fallback) {
  let header = req.headers['x-opencode-directory'];
  try { if (header !== undefined) header = decodeURIComponent(header); }
  catch { throw invalid('Invalid directory header encoding'); }
  const value = target.query['location[directory]'] ?? header ?? fallback;
  return textInput(value, 'location.directory', 1024);
}

export function locationInfo(directory) {
  return { directory, project: { id: projectIdentifier(directory), directory, canonical: directory } };
}

export function catalogResponse(path, directory, api, config) {
  const location = { directory }; const model = modelInfo(api.model, config);
  if (path === '/api/location') return locationInfo(directory);
  if (path === '/api/model') return { location, data: [model] };
  if (path === '/api/model/default') return { location, data: model };
  if (path === '/api/agent' || path === '/api/agent/build') {
    const agent = { id: 'build', name: 'NNA', mode: 'primary', hidden: false, model: api.model,
      request: { settings: {}, headers: {}, body: {} }, permissions: [], description: 'NNA agent with authenticated reviewer governance' };
    return { location, data: path === '/api/agent' ? [agent] : agent };
  }
  if (path.startsWith('/api/agent/')) throw apiError(404, 'AgentNotFoundError', 'Agent was not found', { agentID: path.slice('/api/agent/'.length) });
  if (path === '/api/provider') return { location, data: [{ id: api.model.providerID, name: api.model.providerID, activation: 'enabled', package: 'nna' }] };
  if (path === '/api/project') return projects(api, directory);
  if (path === '/api/permission/saved') return { data: [] };
  if (path === '/api/config') return [{ type: 'document', info: { model: { providerID: api.model.providerID, model: api.model.id }, default_agent: 'build' } }];
  if (path === '/api/form') return { location, data: [...api.states.values()].filter((state) => state.info.location.directory === directory).flatMap((state) => api.forms(state.info.id)) };
  if (EMPTY_CATALOGS.has(path)) return { location, data: [] };
  return undefined;
}

const EMPTY_CATALOGS = new Set(['/api/plugin', '/api/skill', '/api/command', '/api/integration', '/api/reference', '/api/mcp', '/api/permission/request', '/api/shell']);

function modelInfo(model, config) {
  // Compatibility: this catalog exposes only the configured NNA route, never provider credentials.
  return { id: model.id, modelID: model.id, providerID: model.providerID, name: model.id,
    capabilities: { tools: true, input: ['text'], output: ['text'] }, variants: [],
    time: { released: 0 }, cost: [], status: 'active', enabled: true,
    limit: { context: 0, output: config?.routes?.primary?.maxOutputTokens ?? 0 } };
}

function projects(api, directory) {
  const directories = new Set([directory, ...[...api.states.values()].map((state) => state.info.location.directory)]);
  return [...directories].map((value) => ({ id: projectIdentifier(value), canonical: value,
    time: { created: 0, updated: 0, active: 0 }, sandboxes: [] }));
}
