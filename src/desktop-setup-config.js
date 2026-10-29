// SPDX-License-Identifier: Apache-2.0
import { readDesktopConfigurationSources } from './desktop-configuration-sources.js';

export { DESKTOP_CONFIGURATION_OPTIONS } from './desktop-configuration-sources.js';

export async function readDesktopSetupConfiguration(paths, signal) {
  return (await readDesktopConfigurationSources(paths, { signal })).config;
}
