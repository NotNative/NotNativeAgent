// SPDX-License-Identifier: Apache-2.0
import { readNndConfigurationSources } from './nnd-configuration-sources.js';

export { NND_CONFIGURATION_OPTIONS } from './nnd-configuration-sources.js';

export async function readNndSetupConfiguration(paths, signal) {
  return (await readNndConfigurationSources(paths, { signal })).config;
}
