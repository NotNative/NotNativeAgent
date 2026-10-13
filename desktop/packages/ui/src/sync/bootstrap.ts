// SPDX-License-Identifier: Apache-2.0
/**
 * Global bootstrap (doc 04 §C.1): per-mount/runtime path+config+projects with
 * retries; ALL failed surfaces harness-down via the /health probe (never a
 * 5xx silently becoming empty state).
 */
import { harnessClient } from '../lib/nnd/client.ts';
import { useGlobalSyncStore } from './global-stores.ts';

const RETRY_DELAYS = [500, 1000, 2000];

async function retry<T>(op: () => Promise<{ data?: T; error?: string }>): Promise<T> {
  let lastError = 'unknown';
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt += 1) {
    const result = await op();
    if (!result.error && result.data !== undefined) return result.data;
    lastError = result.error ?? 'no data';
    if (attempt < RETRY_DELAYS.length) await new Promise((resolvePromise) => setTimeout(resolvePromise, RETRY_DELAYS[attempt]));
  }
  throw new Error(lastError);
}

export async function runGlobalBootstrap(): Promise<void> {
  const globalStore = useGlobalSyncStore.getState();
  const [pathResult, configResult, projectsResult] = await Promise.allSettled([
    retry(() => harnessClient.getPath()),
    retry(() => harnessClient.getConfig()),
    retry(() => harnessClient.listProjects()),
  ]);
  const successCount = await applyGlobalResults(globalStore, pathResult, configResult, projectsResult);
  if (successCount === 0) {
    // surface harness-down explicitly; readiness still unlocks the shell
    const probe = await harnessClient.globalHealth();
    globalStore.set({ ready: true, error: probe.error ?? 'harness unreachable' });
    return;
  }
  globalStore.set({ ready: true, error: null }); // partial failure = diagnostics only
}

async function applyGlobalResults(
  globalStore: ReturnType<typeof useGlobalSyncStore.getState>,
  pathResult: PromiseSettledResult<unknown>,
  configResult: PromiseSettledResult<unknown>,
  projectsResult: PromiseSettledResult<unknown>,
): Promise<number> {
  let successCount = 0;
  if (pathResult.status === 'fulfilled' && pathResult.value) {
    globalStore.set({ path: pathResult.value as Record<string, unknown> });
    successCount += 1;
  }
  if (configResult.status === 'fulfilled' && configResult.value) {
    globalStore.set({ config: configResult.value as Record<string, unknown> });
    successCount += 1;
  }
  if (projectsResult.status === 'fulfilled' && projectsResult.value) {
    globalStore.set({ projects: filterProjectList(projectsResult.value as Record<string, unknown>[]) });
    successCount += 1;
  }
  return successCount;
}

function filterProjectList(projects: Record<string, unknown>[]): Record<string, unknown>[] {
  return projects
    .filter((project) => Boolean(project) && typeof project['worktree'] === 'string')
    .filter((project) => !String(project['worktree']).includes('opencode-test'))
    .sort((a, b) => String(a['id']).localeCompare(String(b['id'])));
}

export { retry };
