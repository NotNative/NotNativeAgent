// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { ContractError } from './ids.js';
import { isNndLoopbackEndpoint } from './nnd-service-contract.js';
import { validIdentity } from './reliability/process-identity.js';
import { assertHeldNndServiceLease, withNndServiceLease } from './nnd-service-lock.js';
import { ensurePrivateNndRuntimeDirectory } from './nnd-service-private-storage.js';
import { captureDiscoveryProcessIdentity, runDiscoveryOperation } from './nnd-service-discovery-windows.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const KEYS = ['version', 'purpose', 'installation_id', 'data_id', 'instance_id', 'endpoint', 'control_token', 'process_identity', 'created_at'];
function invalid(code = 'nnd_discovery_invalid') { return new ContractError(code, 'NND controller discovery is unavailable or inconsistent'); }
function validateRecord(record, identity) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).length !== KEYS.length
    || KEYS.some((key) => !Object.hasOwn(record, key)) || record.version !== '1.0' || record.purpose !== 'nnd_service_control'
    || record.installation_id !== identity.installation_id || record.data_id !== identity.data_id
    || typeof record.instance_id !== 'string' || !UUID.test(record.instance_id) || !isNndLoopbackEndpoint(record.endpoint)
    || typeof record.control_token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(record.control_token)
    || !validIdentity(record.process_identity) || !record.process_identity.start_id
    || record.process_identity.platform !== 'win32' || typeof record.created_at !== 'string'
    || !Number.isFinite(Date.parse(record.created_at))) throw invalid();
  return Object.freeze({ ...record, process_identity: Object.freeze({ ...record.process_identity }) });
}
async function storage(identity, signal) {
  if (!identity || !/^nna_[a-f0-9]{64}$/u.test(identity.installation_id)
    || !/^data_[a-f0-9]{64}$/u.test(identity.data_id) || typeof identity.data_root !== 'string') throw invalid();
  let root;
  try { root = await realpath(identity.data_root); } catch { throw invalid(); }
  const dataId = `data_${createHash('sha256').update(root.toLowerCase()).digest('hex')}`;
  if (dataId !== identity.data_id) throw invalid();
  const { path } = await ensurePrivateNndRuntimeDirectory(identity.data_root, { signal });
  return { directory: path, installation_id: identity.installation_id, data_id: dataId };
}
export async function createNndDiscoveryGeneration(identity, lease, { endpoint } = {}) {
  assertHeldNndServiceLease(lease, identity?.data_id);
  if (!isNndLoopbackEndpoint(endpoint)) throw invalid();
  return withNndServiceLease(lease, identity.data_id, async (signal) => {
    const context = await storage(identity, signal);
    const record = validateRecord({ version: '1.0', purpose: 'nnd_service_control',
      installation_id: identity.installation_id, data_id: identity.data_id, instance_id: randomUUID(), endpoint,
      control_token: randomBytes(32).toString('base64url'), process_identity: await captureDiscoveryProcessIdentity(signal),
      created_at: new Date().toISOString() }, identity);
    const result = await runDiscoveryOperation({ ...context, action: 'create', record }, signal);
    if (result?.created !== true) throw invalid();
    return record;
  });
}
export async function publishNndDiscoveryGeneration(identity, lease, instanceId, expectedInstanceId) {
  return mutate(identity, lease, 'publish', instanceId, expectedInstanceId);
}
export async function removeNndDiscoveryPointer(identity, lease, instanceId) {
  return mutate(identity, lease, 'remove', instanceId, instanceId);
}
async function mutate(identity, lease, action, instanceId, expectedInstanceId) {
  assertHeldNndServiceLease(lease, identity?.data_id);
  if (typeof instanceId !== 'string' || !UUID.test(instanceId)
    || (expectedInstanceId !== null && (typeof expectedInstanceId !== 'string' || !UUID.test(expectedInstanceId)))) throw invalid();
  return withNndServiceLease(lease, identity.data_id, async (signal) => {
    const context = await storage(identity, signal);
    const result = await runDiscoveryOperation({ ...context, action, instance_id: instanceId, expected_instance_id: expectedInstanceId }, signal);
    if (result?.[action === 'publish' ? 'published' : 'removed'] !== true) throw invalid();
    return Object.freeze(result);
  });
}
// Security: this private reader returns only the controller credential. Never print its result as CLI status.
export async function readNndServiceDiscovery(identity) {
  const result = await runDiscoveryOperation({ ...await storage(identity), action: 'read' });
  if (!result || !Object.hasOwn(result, 'record')) throw invalid();
  return result.record === null ? null : validateRecord(result.record, identity);
}
