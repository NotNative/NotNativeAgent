// SPDX-License-Identifier: Apache-2.0
import { useWorkspaceStore } from '../stores/useWorkspaceStore.ts';
import { useWorkspaceDisplayStore } from '../stores/useWorkspaceDisplayStore.ts';
import { normalizeDirectory } from '../lib/nnd/client.ts';
import { addNativeWorkspace } from '../lib/nnd/workspace-admission.ts';
import { runtimeFetch } from '../lib/runtime-fetch.ts';
import { getRuntimeKey } from '../lib/runtime-switch.ts';

export function activeWorkspaceRoots(): string[] {
  const inventory = useWorkspaceStore.getState().inventory, rows = useWorkspaceDisplayStore.getState().rows;
  return inventory ? [inventory.attached, ...inventory.admitted].filter(row => !rows[row.id]?.hidden)
    .map(row => normalizeDirectory(row.root)) : [];
}
const same = (a: string, b: string) => /^[A-Z]:\//u.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b;
let preparing: { runtime: string; promise: Promise<string> } | null = null;
export async function newConversationWorkspace(preferred: string): Promise<string> {
  const runtime = getRuntimeKey();
  await Promise.all([useWorkspaceStore.getState().load(), useWorkspaceDisplayStore.getState().load()]);
  if (runtime !== getRuntimeKey()) throw new Error('Connection changed. Try New conversation again.');
  if (useWorkspaceStore.getState().phase !== 'ready' || !useWorkspaceDisplayStore.getState().ready || useWorkspaceDisplayStore.getState().error) throw new Error('Could not load active workspaces. Refresh the workspace list and retry.');
  const roots = activeWorkspaceRoots(), chosen = roots.find(root => same(root, normalizeDirectory(preferred)));
  if (roots.length) return chosen ?? roots[0]!;
  if (preparing?.runtime === runtime) return preparing.promise;
  const promise = prepareDefault(runtime).finally(() => { if (preparing?.promise === promise) preparing = null; });
  preparing = { runtime, promise }; return promise;
}
async function prepareDefault(runtime: string): Promise<string> {
  const response = await runtimeFetch('/api/workspace-default', { method: 'POST', signal: AbortSignal.timeout(30_000) });
  const data = await response.json();
  if (!response.ok || typeof data.directory !== 'string') throw new Error('Could not prepare the default workspace. Add a workspace to continue.');
  if (runtime !== getRuntimeKey()) throw new Error('Connection changed. Try New conversation again.');
  const selected = await addNativeWorkspace(data.directory);
  if (runtime !== getRuntimeKey()) throw new Error('Connection changed. Try New conversation again.');
  useWorkspaceStore.getState().adopt(selected.inventory);
  const row = [selected.inventory.attached, ...selected.inventory.admitted].find(row => same(normalizeDirectory(row.root), normalizeDirectory(selected.directory)));
  if (!row) throw new Error('NNA did not confirm the default workspace. Refresh and retry.');
  await useWorkspaceDisplayStore.getState().save(row.id, { label: 'Default workspace', hidden: false });
  return normalizeDirectory(selected.directory);
}
