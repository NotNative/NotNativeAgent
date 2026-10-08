// SPDX-License-Identifier: Apache-2.0
import { runtimeFetch } from '../runtime-fetch.ts';
import { getRuntimeKey } from '../runtime-switch.ts';

const BASE = '/api/v1/nnd/workspaces/admissions';
const WORKSPACE_ID = /^ws_[a-f0-9]{24}$/u;
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
type Row = { root: string; id: string; operation_id: string };
export type WorkspaceAdmissions = { installation_id: string; data_id: string;
  revision: string; selection_enabled: true; admitted: Row[] };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseInventory(value: unknown): WorkspaceAdmissions {
  if (!record(value) || !ID.test(String(value.installation_id)) || !ID.test(String(value.data_id))
    || value.selection_enabled !== true || typeof value.revision !== 'string'
    || !/^(?:absent|[a-f0-9]{64})$/u.test(value.revision) || !Array.isArray(value.admitted)) {
    throw new Error('NNA workspace inventory is unavailable.');
  }
  const admitted = value.admitted.map((item: unknown): Row => {
    if (!record(item) || typeof item.root !== 'string' || !WORKSPACE_ID.test(String(item.id))
      || !ID.test(String(item.operation_id))) throw new Error('NNA workspace inventory is invalid.');
    return { root: item.root, id: String(item.id), operation_id: String(item.operation_id) };
  });
  return { installation_id: String(value.installation_id), data_id: String(value.data_id),
    revision: value.revision, selection_enabled: true, admitted };
}

async function responseJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

function message(value: unknown, fallback: string): string {
  if (record(value) && record(value.error) && typeof value.error.message === 'string') return value.error.message;
  return fallback;
}

export async function readNativeWorkspaceAdmissions(): Promise<WorkspaceAdmissions> {
  const response = await runtimeFetch(BASE);
  const data = await responseJson(response);
  if (!response.ok) throw new Error(message(data, 'NNA workspace inventory is unavailable.'));
  return parseInventory(data);
}

/** A lost acknowledgement is looked up by operation ID; it is never blindly
 * resubmitted. The new root comes from native readback, not the typed path. */
export async function addNativeWorkspace(root: string): Promise<string> {
  const runtime = getRuntimeKey();
  const before = await readNativeWorkspaceAdmissions();
  if (getRuntimeKey() !== runtime) throw new Error('Connection changed; refresh workspaces.');
  const operationId = crypto.randomUUID();
  const body = { installation_id: before.installation_id, data_id: before.data_id,
    expected_revision: before.revision, operation_id: operationId, root };
  let receipt: unknown;
  try {
    const response = await runtimeFetch(BASE, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body) });
    receipt = await responseJson(response);
    if (!response.ok) throw new Error(message(receipt, 'NNA did not admit this workspace.'));
  } catch (error) {
    if (getRuntimeKey() !== runtime) throw new Error('Connection changed; check NNA before retrying.');
    const response = await runtimeFetch(`${BASE}/operations/${operationId}`);
    receipt = response.ok ? await responseJson(response) : null;
    if (!record(receipt) || receipt.persistence !== 'saved') throw error;
  }
  if (!record(receipt) || receipt.operation_id !== operationId || receipt.persistence !== 'saved'
    || getRuntimeKey() !== runtime) throw new Error('Workspace admission outcome needs a refresh.');
  const after = await readNativeWorkspaceAdmissions();
  if (getRuntimeKey() !== runtime) throw new Error('Connection changed; refresh workspaces.');
  const selected = after.admitted.find(row => row.operation_id === operationId);
  if (!selected) throw new Error('NNA saved the workspace; refresh its inventory before opening it.');
  return selected.root;
}
