// SPDX-License-Identifier: Apache-2.0
import { resolve } from 'node:path';
import { ContractError, newId } from '../ids.js';
import { resolveManifest } from '../config.js';
import { resolveConfiguration } from '../configuration-sources.js';
import { manifestFromConfig } from '../provider/route-configuration.js';
import { transactManifest } from '../persistence/manifest-transaction.js';
import { applyIntentChanges, at, intentChanges } from './configuration-intents.js';

export function prepareWorkspaceSource(workspace, next, intent) {
  const options = workspace.options;
  if (options.manifestWriter || !options.configPath) return { next, rebase: (manifest) => manifest,
    persist: async () => { await options.manifestWriter?.(options.configPath, next.manifest); } };
  const changes = intentChanges(workspace.config, next.manifest, intent);
  const source = options.persistedSource ?? initialSource(options, workspace.config);
  if (resolve(source.path) !== resolve(options.configPath)) throw new ContractError('configuration_source_required', 'selected configuration source does not match the persistence target');
  const sources = options.sourceSnapshots ?? [source];
  const index = sources.findLastIndex((item) => sameSourcePath(item, source));
  if (index < 0) throw new ContractError('configuration_source_required', 'selected source is absent from startup provenance');
  requireOwnedChanges(sources.slice(index + 1).filter((item) => !sameSourcePath(item, source)), changes, options.configurationLaunchOverrides);
  const raw = applyIntentChanges(source.manifest, changes);
  // Invariant: repeated selections of one file observe one document, including lower-precedence aliases.
  const resolveRaw = (manifest) => resolveConfiguration(sources.map((item) => sameSourcePath(item, source) ? { ...item, manifest } : item)).config;
  const effective = resolveRaw(raw);
  const effectiveManifest = manifestFromConfig(effective);
  const plannedManifest = next.manifest;
  const rebase = (manifest) => applyIntentChanges(manifest, changes.filter((change) => !Object.hasOwn(change, 'id')
    && JSON.stringify(at(manifest, change.path)) === JSON.stringify(at(plannedManifest, change.path)))
    .map((change) => ({ path: change.path, value: at(effectiveManifest, change.path) })));
  const manifest = rebase(next.manifest);
  const preparedNext = { manifest, config: Object.freeze({ ...resolveManifest(manifest),
    ...(options.configurationLaunchOverrides ? { launchOverrides: options.configurationLaunchOverrides } : {}) }) };
  return { next: preparedNext, rebase, persist: async () => {
    const result = await transactManifest({ path: source.path, expectedRevision: source.revision,
      operationId: newId('tui_manifest'), payload: { changes }, transform: (current) => applyIntentChanges(current ?? source.manifest, changes), validate: resolveRaw });
    if (result.persistence !== 'saved') throw new ContractError('manifest_publication_failed', 'configuration was not saved');
    const saved = { ...source, manifest: raw, revision: result.persistedRevision };
    options.persistedSource = saved;
    options.sourceSnapshots = sources.map((item) => sameSourcePath(item, source)
      ? { ...item, manifest: raw, revision: result.persistedRevision } : item);
    return result;
  } };
}

function sameSourcePath(first, second) {
  if (!first.path || !second.path) return false;
  const key = (path) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  return key(first.path) === key(second.path);
}

function initialSource(options, config) {
  if (options.initializeManifest !== true) throw new ContractError('configuration_source_required', 'reload the selected configuration source before saving');
  if (options.sourceSnapshots?.length || options.configurationLaunchOverrides) throw new ContractError('configuration_source_required', 'initialization cannot serialize configuration overlays');
  return { name: 'programmatic', path: options.configPath, revision: 'absent', manifest: manifestFromConfig(config) };
}

function requireOwnedChanges(higher, changes, launch) {
  for (const change of changes) {
    if (launch && (change.path === 'providers' || change.path.startsWith('routes.primary.'))) {
      throw new ContractError('configuration_source_shadowed', 'this setting is controlled by a temporary command-line provider override');
    }
    for (const source of higher) {
      if (owns(source.manifest, change.path) || (change.path === 'providers' && source.manifest.provider)) {
        throw new ContractError('configuration_source_shadowed', `edit this setting in the higher-precedence ${source.name} source`);
      }
    }
  }
}

function owns(manifest, path) {
  let cursor = manifest;
  for (const key of path.split('.')) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return true;
    if (!Object.hasOwn(cursor, key)) return false;
    cursor = cursor[key];
  }
  return true;
}
