// SPDX-License-Identifier: Apache-2.0
/** Keeps native permission authority closed until gap recovery and config agree. */
import { harnessClient } from '../lib/nnd/client.ts';
import { getRuntimeKey } from '../lib/runtime-switch.ts';
import { markActivityGap } from './activity-gap.ts';
import { authorityState, beginAuthorityRecovery, finishAuthorityRecovery, isCurrentAuthorityRecovery } from './authority-sync.ts';
import { useGlobalSyncStore } from './global-stores.ts';
import type { createRecovery } from './engine-recovery.ts';

export async function recoverGapAuthority(
  recovery: ReturnType<typeof createRecovery>, runtime: string, signal: AbortSignal,
  explicitGap: boolean, stable: () => boolean,
): Promise<boolean> {
  const nnd = useGlobalSyncStore.getState().config?.['nnd'];
  const wasNative = !!nnd && typeof nnd === 'object' && !Array.isArray(nnd)
    && (nnd as Record<string, unknown>)['engine'] === 'nna';
  if (explicitGap) markActivityGap(runtime);
  if (!explicitGap && authorityState(runtime) === 'ready') return false;
  const token = beginAuthorityRecovery(runtime);
  let healthy = false;
  try {
    const recovered = await recovery.recoverAuthorityGap('native-replay-gap');
    if (recovered && !signal.aborted && stable() && getRuntimeKey() === runtime) {
      const config = await harnessClient.getConfig();
      const nndConfig = config.data?.nnd as { engine?: unknown } | undefined;
      healthy = !signal.aborted && stable() && isCurrentAuthorityRecovery(runtime, token)
        && !config.error && !!config.data && typeof config.data === 'object' && !Array.isArray(config.data)
        && (!(explicitGap || wasNative) || nndConfig?.engine === 'nna')
        && (!('nnd' in config.data) || nndConfig?.engine === 'nna');
      if (healthy) {
        useGlobalSyncStore.getState().set({ config: config.data as Record<string, unknown> });
      }
    }
  } catch { /* a failed read leaves the gate closed */ }
  finishAuthorityRecovery(runtime, token, healthy && !signal.aborted && stable());
  return true;
}
