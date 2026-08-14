// SPDX-License-Identifier: Apache-2.0
import { newId } from '../ids.js';
import { prepareEngineConfiguration, publishEngineConfiguration } from '../runtime-config.js';
import { persistManifest } from '../route-configuration.js';

export async function publishConfigurationBatch(entries, options = {}) {
  const prepare = options.prepare ?? prepareEngineConfiguration;
  const prepared = entries.map(({ session, manifest }) => ({
    session,
    config: prepare(session.engine, manifest),
  }));
  await options.persist?.();
  options.beforePublish?.();
  const results = await Promise.allSettled(prepared.map(({ session, config }) => (
    publishEngineConfiguration(session.engine, config, newId('tui_config'))
  )));
  const failure = results.find((item) => item.status === 'rejected');
  if (failure) throw failure.reason;
  return results.map((item) => item.value);
}

export function writeWorkspaceManifest(workspace, manifest) {
  return (workspace.options.manifestWriter ?? persistManifest)(workspace.options.configPath, manifest);
}

export function publishWorkspaceConfiguration(workspace, entries, next) {
  return publishConfigurationBatch(entries, {
    prepare: workspace.options.configurationPreparer,
    persist: () => writeWorkspaceManifest(workspace, next.manifest),
    beforePublish: () => { workspace.config = advanceWorkspaceConfig(workspace, next.config); },
  });
}

export function advanceWorkspaceConfig(workspace, config) {
  return Object.freeze({ ...config, version: workspace.config.version + 1 });
}
