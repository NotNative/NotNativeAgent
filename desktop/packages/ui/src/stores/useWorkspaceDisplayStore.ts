// SPDX-License-Identifier: Apache-2.0
import { create } from 'zustand';
import { runtimeFetch } from '../lib/runtime-fetch.ts';
import { getRuntimeKey, onRuntimeEndpointChanged } from '../lib/runtime-switch.ts';
import { useWorkspaceStore } from './useWorkspaceStore.ts';
import { normalizeDirectory } from '../lib/nnd/client.ts';

type Display = { label: string; hidden: boolean };
interface State {
  rows: Record<string, Display>;
  ready: boolean;
  defaultDirectory: string | null;
  error: string | null;
  load: () => Promise<void>;
  save: (id: string, value: Display) => Promise<void>;
}
async function request(body?: object): Promise<{ rows: Record<string, Display>; defaultDirectory: string | null }> {
  const response = await runtimeFetch('/api/workspace-presentation', body ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  } : undefined);
  const data = await response.json();
  if (!response.ok || data?.version !== 1 || !data.workspaces) throw new Error('Could not save or load workspace names.');
  return { rows: data.workspaces, defaultDirectory: typeof data.default_directory === 'string' ? normalizeDirectory(data.default_directory) : null };
}
let revision = 0;
let connection = 0;
let writes: Promise<void> = Promise.resolve();
let reading: Promise<void> | null = null;
export const useWorkspaceDisplayStore = create<State>((set) => ({
  rows: {}, error: null, ready: false, defaultDirectory: null,
  load: () => {
    if (reading) return reading;
    const runtime = getRuntimeKey(), read = ++revision;
    const attempt = request().then(data => { if (runtime === getRuntimeKey() && read === revision) set({ ...data, error: null, ready: true }); })
      .catch(error => { if (runtime === getRuntimeKey() && read === revision) set({ error: String(error) }); })
      .finally(() => { if (reading === attempt) reading = null; });
    reading = attempt;
    return attempt;
  },
  save: (id, value) => {
    const inventory = useWorkspaceStore.getState().inventory;
    const root = inventory && [inventory.attached, ...inventory.admitted].find(row => row.id === id)?.root;
    if (value.hidden && root && isDefaultWorkspace(root)) return Promise.reject(new Error('The default workspace cannot be removed.'));
    const runtime = getRuntimeKey(), epoch = connection;
    const write = writes.catch(() => undefined).then(async () => {
      if (epoch !== connection) throw new Error('Connection changed; refresh workspaces.');
      revision += 1;
      const data = await request({ id, ...value });
      if (runtime !== getRuntimeKey() || epoch !== connection) throw new Error('Connection changed; refresh workspaces.');
      set({ ...data, error: null, ready: true });
    });
    writes = write;
    return write;
  },
}));
onRuntimeEndpointChanged(() => { revision += 1; connection += 1; reading = null; useWorkspaceDisplayStore.setState({ rows: {}, error: null, ready: false, defaultDirectory: null }); });

export function isDefaultWorkspace(directory: string): boolean {
  const target = useWorkspaceDisplayStore.getState().defaultDirectory;
  const root = normalizeDirectory(directory);
  return !!target && (/^[A-Za-z]:\//u.test(root) ? root.toLowerCase() === target.toLowerCase() : root === target);
}

export function workspaceDisplay(directory: string, rows: Record<string, Display>): Display & { id: string | null } {
  const inventory = useWorkspaceStore.getState().inventory;
  const same = (root: string) => { const a = normalizeDirectory(root), b = normalizeDirectory(directory);
    return /^[A-Za-z]:\//u.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b; };
  const entry = inventory && [inventory.attached, ...inventory.admitted].find(row => same(row.root));
  const display = { id: entry?.id ?? null, label: '', hidden: false, ...(entry ? rows[entry.id] : {}) };
  return isDefaultWorkspace(directory) ? { ...display, label: display.label || 'Default workspace', hidden: false } : display;
}
