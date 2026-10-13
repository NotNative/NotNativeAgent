// SPDX-License-Identifier: Apache-2.0
/** Wait for the GUI harness route to expose the activated NNA model before booting a new view. */
import { harnessClient, type HarnessResult } from './client.ts';
import type { HarnessConfig } from './types.ts';

type ReadConfig = () => Promise<HarnessResult<HarnessConfig>>;
type Pause = (milliseconds: number) => Promise<void>;
const pause: Pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function waitForNativeModelReady(signal: AbortSignal,
  read: ReadConfig = () => harnessClient.getConfig(), wait: Pause = pause): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (signal.aborted) throw new Error('native-setup-cancelled');
    const response = await read();
    if (signal.aborted) throw new Error('native-setup-cancelled');
    const nnd = response.data?.nnd as { engine?: unknown; primaryModel?: { providerID?: unknown; modelID?: unknown } } | undefined;
    if (!response.error && nnd?.engine === 'nna'
      && typeof nnd.primaryModel?.providerID === 'string' && nnd.primaryModel.providerID
      && typeof nnd.primaryModel.modelID === 'string' && nnd.primaryModel.modelID) return;
    if (attempt < 19) await wait(500);
  }
  throw new Error('native-model-not-ready');
}
