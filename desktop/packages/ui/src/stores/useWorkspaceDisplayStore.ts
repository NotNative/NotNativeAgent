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
  error: string | null;
  load: () => Promise<void>;
  save: (id: string, value: Display) => Promise<void>;
}
async function request(body?: object): Promise<Record<string, Display>> {
  const response = await runtimeFetch('/api/workspace-presentation', body ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  } : undefined);
  const data = await response.json();
  if (!response.ok || data?.version !== 1 || !data.workspaces) throw new Error('Could not save or load workspace names.');
  return data.workspaces;
}
let revision = 0;
let connection = 0;
let writes: Promise<void> = Promise.resolve();
let reading: Promise<void> | null = null;
export const useWorkspaceDisplayStore = create<State>((set) => ({
  rows: {}, error: null, ready: false,
  load: () => {
    if (reading) return reading;
    const runtime = getRuntimeKey(), read = ++revision;
    const attempt = request().then(rows => { if (runtime === getRuntimeKey() && read === revision) set({ rows, error: null, ready: true }); })
      .catch(error => { if (runtime === getRuntimeKey() && read === revision) set({ error: String(error) }); })
      .finally(() => { if (reading === attempt) reading = null; });
    reading = attempt;
    return attempt;
  },
  save: (id, value) => {
    const runtime = getRuntimeKey(), epoch = connection;
    const write = writes.catch(() => undefined).then(async () => {
      if (epoch !== connection) throw new Error('Connection changed; refresh workspaces.');
      revision += 1;
      const rows = await request({ id, ...value });
      if (runtime !== getRuntimeKey() || epoch !== connection) throw new Error('Connection changed; refresh workspaces.');
      set({ rows, error: null, ready: true });
    });
    writes = write;
    return write;
  },
}));
onRuntimeEndpointChanged(() => { revision += 1; connection += 1; reading = null; useWorkspaceDisplayStore.setState({ rows: {}, error: null, ready: false }); });

export function workspaceDisplay(directory: string, rows: Record<string, Display>): Display & { id: string | null } {
  const inventory = useWorkspaceStore.getState().inventory;
  const same = (root: string) => { const a = normalizeDirectory(root), b = normalizeDirectory(directory);
    return /^[A-Za-z]:\//u.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b; };
  const entry = inventory && [inventory.attached, ...inventory.admitted].find(row => same(row.root));
  return { id: entry?.id ?? null, label: '', hidden: false, ...(entry ? rows[entry.id] : {}) };
}
