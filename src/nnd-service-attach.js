// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { assertStatusEnvelope, exactRecord, isNndLoopbackEndpoint } from './nnd-service-contract.js';

const ATTACH_KEYS = ['protocol', 'installation_id', 'data_id', 'generation', 'endpoint', 'ticket', 'expires_at'];
const TICKET_KEYS = ['type', 'protocol', 'generation', 'request_id', 'ticket', 'expires_at'];
function invalid() { return new ContractError('nnd_service_protocol_invalid', 'Native NND attach response is invalid'); }
function validTicket(value, now) {
  return typeof value.ticket === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value.ticket)
    && typeof value.expires_at === 'string' && Date.parse(value.expires_at) > now
    && Date.parse(value.expires_at) <= now + 65000;
}
export function assertSelectedNndStatus(value, record) {
  try { assertStatusEnvelope(value); } catch { throw invalid(); }
  if (value.installation_id !== record.installation_id || value.data_id !== record.data_id
    || value.instance_id !== record.instance_id) throw invalid();
  return value;
}
export function assertNndAttach(value, record, now = Date.now()) {
  if (!exactRecord(value, ATTACH_KEYS) || value.protocol !== '1.0'
    || value.installation_id !== record.installation_id || value.data_id !== record.data_id
    || value.generation !== record.instance_id || !isNndLoopbackEndpoint(value.endpoint)
    || !validTicket(value, now)) throw invalid();
  return value;
}
export async function issueNndAttach(record, status, issueTicket) {
  const before = assertSelectedNndStatus(status(), record);
  if (!['ready', 'setup_required', 'degraded'].includes(before.service_state) || !before.endpoint) {
    throw new ContractError('nnd_health_unavailable', 'NND UI transport is not ready for attachment');
  }
  const ticket = await issueTicket();
  if (!exactRecord(ticket, TICKET_KEYS) || ticket.type !== 'ui_ticket' || ticket.protocol !== '1.0'
    || ticket.generation !== record.instance_id || typeof ticket.request_id !== 'string'
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(ticket.request_id) || !validTicket(ticket, Date.now())) throw invalid();
  const after = assertSelectedNndStatus(status(), record);
  if (!['ready', 'setup_required', 'degraded'].includes(after.service_state) || after.endpoint !== before.endpoint) {
    throw new ContractError('nnd_health_unavailable', 'NND UI changed while issuing an attachment');
  }
  return assertNndAttach({ protocol: '1.0', installation_id: record.installation_id, data_id: record.data_id,
    generation: record.instance_id, endpoint: after.endpoint, ticket: ticket.ticket, expires_at: ticket.expires_at }, record);
}
export function nndServiceCapabilities(identity) {
  return Object.freeze({ protocol: '1.0', installation_id: identity.installation_id, data_id: identity.data_id,
    native_version: identity.version,
    capabilities: ['service_supervision', 'setup_control_plane', 'atomic_ui_attach', 'installer_guard'],
    commands: ['start', 'status', 'stop', 'attach', 'install-guard'] });
}
