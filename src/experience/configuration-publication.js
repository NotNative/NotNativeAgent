// SPDX-License-Identifier: Apache-2.0
import { ContractError, newId } from '../ids.js';
import { prepareEngineConfiguration, publishEngineConfiguration } from '../runtime-config.js';
import { persistManifest } from '../provider/route-configuration.js';

export async function publishConfigurationBatch(entries, options = {}) {
  const prepare = options.prepare ?? prepareEngineConfiguration;
  const prepared = entries.map(({ session, manifest }) => ({
    session,
    config: prepare(session.engine, manifest),
  }));
  await options.persist?.();
  await options.beforePublish?.();
  // Every prepared engine gets the same publication attempt; one failure must not leave later sessions stale.
  const results = await Promise.allSettled(prepared.map(({ session, config }) => (
    publishEngineConfiguration(session.engine, config, newId('tui_config'))
  )));
  const failure = results.find((item) => item.status === 'rejected');
  if (failure) {
    const secondaryFailures = results.filter((item) => item.status === 'rejected' && item !== failure).map((item) => item.reason);
    if (secondaryFailures.length > 0 && failure.reason && typeof failure.reason === 'object'
      && Object.isExtensible(failure.reason)) {
      failure.reason.secondaryFailures = [...(failure.reason.secondaryFailures ?? []), ...secondaryFailures];
    }
    throw failure.reason;
  }
  return results.map((item) => item.value);
}

export function writeWorkspaceManifest(workspace, manifest) {
  requireWorkspaceOptions(workspace);
  return (workspace.options.manifestWriter ?? persistManifest)(workspace.options.configPath, manifest);
}

export function publishWorkspaceConfiguration(workspace, entries, next) {
  requireWorkspaceOptions(workspace);
  if (!next || typeof next !== 'object' || !next.manifest || !next.config) {
    throw new ContractError('workspace_configuration_invalid', 'next workspace configuration is incomplete');
  }
  return publishConfigurationBatch(entries, {
    prepare: workspace.options.configurationPreparer,
    persist: () => writeWorkspaceManifest(workspace, next.manifest),
    beforePublish: () => { workspace.config = advanceWorkspaceConfig(workspace, next.config); },
  });
}

export function advanceWorkspaceConfig(workspace, config) {
  if (!config || typeof config !== 'object' || !Number.isSafeInteger(workspace?.config?.version)) {
    throw new ContractError('workspace_configuration_invalid', 'workspace configuration version is unavailable');
  }
  return Object.freeze({ ...config, version: workspace.config.version + 1 });
}

function requireWorkspaceOptions(workspace) {
  if (!workspace?.options || typeof workspace.options !== 'object') {
    throw new ContractError('workspace_configuration_invalid', 'workspace configuration options are unavailable');
  }
}
