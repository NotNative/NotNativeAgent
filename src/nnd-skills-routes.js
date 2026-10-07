// SPDX-License-Identifier: Apache-2.0
/** Native skills catalog observation route over
 * /v1/nnd/configuration/skills. Why: the skills_action census family cites
 * src/skills-cli.js runSkillsCommand, whose list verb builds a SkillRegistry
 * over runtimeSkillRoots(paths, project) — including the project skill root
 * gated on workspace trust. This surface reuses that authority verbatim:
 * GET catalog initializes a FRESH SkillRegistry (bundled + user +, when the
 * serving workspace is trusted, its project root), freezes the catalog
 * entries verbatim (wereTools → requires_tools already the shipped
 * envelope; see normalizeRegistryHostSkills) plus the registry's
 * duplicate/capability diagnostics, and reports whether the project root
 * was included (the trust verdict, read-only). Nothing on disk changes.
 * Honest codes: a failed discovery/initialization wraps to
 * nnd_skills_catalog_unavailable exactly like the CLI's
 * skills_catalog_unavailable (503); transport grammar is
 * nnd_skills_request_invalid (400); projector drift is
 * nnd_skills_projection_invalid (500). The response is bounded at 2 MiB
 * (nnd_skills_catalog_too_large, 413).
 */
import { resolve } from 'node:path';
import { ContractError } from './ids.js';
import { send } from './secret-broker-server.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { SkillRegistry } from './skill-registry.js';
import { workspaceIsTrusted } from './experience/trust.js';
import { runtimeSkillRoots } from './startup-configuration.js';

const BASE = '/v1/nnd/configuration/skills';
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const RESPONSE_BOUND = 2_097_152;
const PROJECT_DIRECTORY = '.nna';
const SKILLS_DIRECTORY = 'skills';
const ENTRY_KEYS = 'bodySha256,description,id,invocation,requiresTools,source,version';
const DIAGNOSTIC_KEYS = 'code,message,path,scope,status';
const INVALID_INVOCATIONS = 'user,agent,both';
const invalid = () => new ContractError('nnd_skills_request_invalid', 'Native skills request is invalid.');
const projection = () => new ContractError('nnd_skills_projection_invalid', 'Native skills projection refused a drifted catalog.');

function buildRegistry({ trusted, paths, workspaceRoot }) {
  return new SkillRegistry({ roots: runtimeSkillRoots(paths, {
    trusted,
    skillRoot: resolve(workspaceRoot, PROJECT_DIRECTORY, SKILLS_DIRECTORY),
  }) });
}

export function createNndSkillsService({ paths, installationId, dataId,
  trustedCheck = workspaceIsTrusted, registryFactory = buildRegistry }) {
  if (typeof paths?.trustedWorkspaces !== 'string' || typeof paths?.skills !== 'string'
    || !ID.test(installationId ?? '') || !ID.test(dataId ?? '')) throw invalid();
  return Object.freeze({
    async catalog(workspaceRoot) {
      if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) throw invalid();
      const root = resolve(workspaceRoot);
      let registry;
      let trusted;
      try {
        trusted = await trustedCheck(paths.trustedWorkspaces, root);
        registry = registryFactory({ trusted, paths, workspaceRoot: root });
        await registry.initialize();
      } catch (error) { throw wrapCatalogFailure(error); }
      return Object.freeze({ schema_version: '1.0', installation_id: installationId,
        data_id: dataId, scope: 'workspace', scope_root: root, trusted,
        catalog: registry.catalog(), diagnostics: registry.diagnostics() });
    },
  });
}

function wrapCatalogFailure(error) {
  if (error instanceof ContractError) return error;
  return new ContractError('nnd_skills_catalog_unavailable',
    'the skills catalog could not be loaded', { cause: error });
}

export function projectCatalog(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'catalog,data_id,diagnostics,installation_id,'
      + 'schema_version,scope,scope_root,trusted'
    || value.schema_version !== '1.0' || typeof value.installation_id !== 'string'
    || !ID.test(value.installation_id) || typeof value.data_id !== 'string'
    || !ID.test(value.data_id) || value.scope !== 'workspace'
    || typeof value.scope_root !== 'string' || value.scope_root.length === 0
    || typeof value.trusted !== 'boolean'
    || !Array.isArray(value.catalog) || value.catalog.length > 4096
    || !Array.isArray(value.diagnostics)) throw projection();
  const catalog = value.catalog.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).sort().join(',') !== ENTRY_KEYS
      || typeof entry.id !== 'string' || entry.id.length === 0 || entry.id.length > 128
      || typeof entry.version !== 'string' || entry.version.length === 0 || entry.version.length > 64
      || (entry.description !== null && (typeof entry.description !== 'string'
        || entry.description.length > 2_048))
      || (entry.invocation !== 'user' && entry.invocation !== 'agent' && entry.invocation !== 'both')
      || typeof entry.source !== 'string' || !/^(bundled|user|project):/u.test(entry.source)
      || !Array.isArray(entry.requiresTools)
      || entry.requiresTools.some((tool) => typeof tool !== 'string')
      || typeof entry.bodySha256 !== 'string'
      || !/^[0-9a-f]{64}$/u.test(entry.bodySha256)) throw projection();
    return { id: entry.id, version: entry.version, description: entry.description,
      invocation: entry.invocation, source: entry.source,
      requires_tools: Object.freeze([...entry.requiresTools]),
      body_sha256: entry.bodySha256 };
  });
  const diagnostics = value.diagnostics.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).sort().join(',') !== DIAGNOSTIC_KEYS
      || item.status !== 'skipped'
      || typeof item.path !== 'string' || typeof item.scope !== 'string'
      || typeof item.code !== 'string' || typeof item.message !== 'string') throw projection();
    return { status: item.status, scope: item.scope, path: item.path,
      code: item.code, message: item.message };
  });
  return { schema_version: '1.0', installation_id: value.installation_id, data_id: value.data_id,
    scope: value.scope, scope_root: value.scope_root, trusted: value.trusted,
    catalog, diagnostics };
}

export async function dispatchNndSkillsRequest(request, response, context) {
  const path = context.url.pathname;
  if (path !== BASE && !path.startsWith(`${BASE}/`)) return false;
  requireIntegrationPermission(context.principal, 'nnd.configuration.read');
  if (path === `${BASE}/catalog`) {
    if (request.method !== 'GET') return send(response, 405, { error: 'method_not_allowed' });
    if (context.url.search) throw invalid();
    const service = context.nndSkillsService;
    if (!service || typeof service.catalog !== 'function') {
      throw new ContractError('nnd_configuration_unavailable', 'Native skills catalog is unavailable.');
    }
    const root = context.skillsWorkspaceRoot ?? context.nndRuntime?.getHost?.()?.workspaceRoot;
    if (typeof root !== 'string' || root.length === 0) throw invalid();
    const receipt = projectCatalog(await service.catalog(root));
    if (Buffer.byteLength(JSON.stringify(receipt)) > RESPONSE_BOUND) {
      throw new ContractError('nnd_skills_catalog_too_large', 'the skills catalog exceeds the response bound');
    }
    return send(response, 200, receipt);
  }
  if (path === BASE) return send(response, 405, { error: 'method_not_allowed' });
  return send(response, 404, { error: 'not_found' });
}

export const NND_SKILLS_ENTRY_KEYS = ENTRY_KEYS;
export const NND_SKILLS_DIAGNOSTIC_KEYS = DIAGNOSTIC_KEYS;
export const NND_SKILLS_INVOCATIONS = INVALID_INVOCATIONS;
