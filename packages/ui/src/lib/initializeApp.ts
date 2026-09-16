// SPDX-License-Identifier: Apache-2.0
import { useConfigStore } from '../stores/useConfigStore.ts';

/**
 * App initialization (doc 01 §4.3 step 4–5): connection check, then parallel
 * provider/agent inventories. Failures resolve false so the caller's bounded
 * retry loop decides. The retry loop itself lives in App (10 attempts,
 * 1000 ms base doubling, 16 000 ms cap → manual recovery screen).
 */
export async function initializeApp(): Promise<boolean> {
  const store = useConfigStore.getState();
  try {
    const connected = await store.checkConnection();
    if (!connected) return false;
    const latest = useConfigStore.getState();
    await Promise.all([latest.loadProviders(), latest.loadAgents()]);
  } catch (error) {
    useConfigStore.setState({ lastDisconnectReason: 'init_error' });
    console.debug?.('[init] failed', error);
    return false;
  }
  useConfigStore.getState().markInitialized(true);
  return true;
}

/** Server-owned health field HP-9 (`planModeExperimentalEnabled`). */
export async function fetchHealth(): Promise<{ planModeExperimentalEnabled: boolean } | null> {
  try {
    const response = await fetch('/health', { credentials: 'include' });
    if (!response.ok) return null;
    const body = (await response.json()) as { planModeExperimentalEnabled?: unknown };
    const flag = body?.planModeExperimentalEnabled;
    return {
      planModeExperimentalEnabled: flag === true || flag === 1 || flag === '1' || flag === 'true',
    };
  } catch {
    return null;
  }
}
