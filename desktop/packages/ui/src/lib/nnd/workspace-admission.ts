// SPDX-License-Identifier: Apache-2.0
import { runtimeFetch } from '../runtime-fetch.ts';
import { getRuntimeKey } from '../runtime-switch.ts';

const BASE = '/api/v1/nnd/workspaces/admissions';
const WORKSPACE_ID = /^ws_[a-f0-9]{24}$/u;
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
type Row = { root: string; id: string; operation_id: string };
export type WorkspaceAdmissions = { installation_id: string; data_id: string;
  revision: string; selection_enabled: true; attached: { root: string; id: string }; admitted: Row[];
  unavailable: { root: string; id: string; reason: string }[] };
export type WorkspaceAdmissionSelection = { directory: string; inventory: WorkspaceAdmissions; added: boolean };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseInventory(value: unknown): WorkspaceAdmissions {
  if (!record(value) || !ID.test(String(value.installation_id)) || !ID.test(String(value.data_id))
    || value.selection_enabled !== true || typeof value.revision !== 'string'
    || !/^(?:absent|[a-f0-9]{64})$/u.test(value.revision) || !Array.isArray(value.admitted)
    || !record(value.attached) || typeof value.attached.root !== 'string'
    || !WORKSPACE_ID.test(String(value.attached.id))) {
    throw new Error('NNA workspace inventory is unavailable.');
  }
  const admitted = value.admitted.map((item: unknown): Row => {
    if (!record(item) || typeof item.root !== 'string' || !WORKSPACE_ID.test(String(item.id))
      || !ID.test(String(item.operation_id))) throw new Error('NNA workspace inventory is invalid.');
    return { root: item.root, id: String(item.id), operation_id: String(item.operation_id) };
  });
  const unavailable = (Array.isArray(value.unavailable) ? value.unavailable : []).map((item: unknown) => {
    if (!record(item) || typeof item.root !== 'string' || !WORKSPACE_ID.test(String(item.id))
      || item.reason !== 'identity_mismatch') throw new Error('NNA workspace inventory is invalid.');
    return { root: item.root, id: String(item.id), reason: item.reason };
  });
  return { installation_id: String(value.installation_id), data_id: String(value.data_id),
    revision: value.revision, selection_enabled: true,
    attached: { root: value.attached.root, id: String(value.attached.id) }, admitted, unavailable };
}

async function responseJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

function message(value: unknown, fallback: string): string {
  if (record(value) && record(value.error) && typeof value.error.message === 'string') return value.error.message;
  return fallback;
}

function sameWorkspace(left: string, right: string): boolean {
  const a = left.replaceAll('\\', '/'), b = right.replaceAll('\\', '/');
  return /^[A-Za-z]:\//u.test(a) && /^[A-Za-z]:\//u.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export async function readNativeWorkspaceAdmissions(): Promise<WorkspaceAdmissions> {
  const response = await runtimeFetch(BASE);
  const data = await responseJson(response);
  if (!response.ok) throw new Error(message(data, 'NNA workspace inventory is unavailable.'));
  return parseInventory(data);
}

/** A lost acknowledgement is looked up by operation ID; it is never blindly
 * resubmitted. The new root comes from native readback, not the typed path. */
export async function addNativeWorkspace(root: string): Promise<WorkspaceAdmissionSelection> {
  const runtime = getRuntimeKey();
  const before = await readNativeWorkspaceAdmissions();
  if (getRuntimeKey() !== runtime) throw new Error('Connection changed; refresh workspaces.');
  if (sameWorkspace(before.attached.root, root)) return { directory: before.attached.root, inventory: before, added: false };
  const existing = before.admitted.find(row => sameWorkspace(row.root, root));
  if (existing) return { directory: existing.root, inventory: before, added: false };
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
  return { directory: selected.root, inventory: after, added: true };
}

/** Only a native unavailable row can be removed here. NNA also refuses the
 * revoke if its durable session host still owns that root. */
export async function removeUnavailableNativeWorkspace(root: string): Promise<void> {
  const runtime = getRuntimeKey();
  const before = await readNativeWorkspaceAdmissions();
  if (!before.unavailable.some(row => row.root === root)) throw new Error('Workspace is no longer unavailable; refresh first.');
  const operationId = crypto.randomUUID();
  const body = { installation_id: before.installation_id, data_id: before.data_id,
    expected_revision: before.revision, operation_id: operationId, root };
  let receipt: unknown = null;
  try {
    const response = await runtimeFetch(`${BASE}/revoke`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body) });
    receipt = response.ok ? await responseJson(response) : null;
    if (!response.ok) throw new Error(message(await responseJson(response), 'NNA did not revoke this workspace.'));
  } catch (error) {
    if (getRuntimeKey() !== runtime) throw new Error('Connection changed; check NNA before retrying.');
    const response = await runtimeFetch(`${BASE}/operations/${operationId}`);
    receipt = response.ok ? await responseJson(response) : null;
    if (!record(receipt) || receipt.persistence !== 'saved') throw error;
  }
  if (!record(receipt) || receipt.operation_id !== operationId || receipt.persistence !== 'saved'
    || getRuntimeKey() !== runtime) throw new Error('Workspace removal outcome needs a refresh.');
  const after = await readNativeWorkspaceAdmissions();
  if (after.installation_id !== before.installation_id || after.data_id !== before.data_id
    || after.unavailable.some(row => row.root === root) || after.admitted.some(row => row.root === root)) {
    throw new Error('NNA still lists this workspace; refresh before retrying.');
  }
}
