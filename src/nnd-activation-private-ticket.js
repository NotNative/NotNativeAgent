// SPDX-License-Identifier: Apache-2.0
/** Dormant held-owner proof of one private NND UI ticket and its redemption. */
import { join, resolve } from 'node:path';
import { ContractError } from './ids.js';
import { assertHeldNndServiceLease, withNndServiceLease } from './nnd-service-lock.js';
import { assertManifestLease, runManifestLeaseWork } from './persistence/manifest-lock.js';
import { assertNndAttach } from './nnd-service-attach.js';
import { verifyNndPublishedTrialHealthUnderOwnership } from './nnd-activation-post-publication-health.js';

const USED = new WeakSet();
const invalid = () => new ContractError('nnd_activation_health_invalid',
  'Private NND attach proof is unresolved; retain the admission barrier and both owners.');
const samePath = (left, right) => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

function assertSelected(identity, state, serviceLease, registryLease, options) {
  if (!identity || !options || Object.keys(options).some(key => !['operationId', 'stageOperationId', 'generation', 'signal'].includes(key))
    || !state?.unpublishedTrial || state.published || state.stopping || USED.has(state)
    || state.identity !== identity || state.lease !== serviceLease || state.child?.failed
    || !state.child?.child || state.child.child.exitCode !== null
    || state.record?.instance_id !== options?.generation || state.controller?.isListening?.() !== true
    || state.native?.isListening?.() !== true || !state.ui) throw invalid();
  assertHeldNndServiceLease(serviceLease, identity.data_id);
  const target = assertManifestLease(registryLease);
  if (!samePath(target.path, join(identity.data_root, 'config', 'nnd-package.json'))) throw invalid();
  const evidence = state.native.selectedPrincipalEvidence?.(state);
  if (!evidence || evidence.operation_id !== options.operationId
    || evidence.stage_operation_id !== options.stageOperationId
    || evidence.generation !== options.generation) throw invalid();
  return evidence;
}

async function readBody(response) {
  const reader = response.body?.getReader(); if (!reader) throw invalid();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.byteLength;
      if (size > 4096) { await reader.cancel(); throw invalid(); }
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw invalid(); }
}

async function redeemPrivateTicket(endpoint, ticket, signal) {
  const url = `${endpoint}/auth/native-bootstrap`;
  const redeemed = await fetch(url, { method: 'POST', redirect: 'error', signal,
    headers: { origin: endpoint, 'content-type': 'application/json' }, body: JSON.stringify({ ticket }) });
  if (redeemed.status !== 200 || redeemed.redirected || redeemed.url !== url
    || (await readBody(redeemed))?.authenticated !== true) throw invalid();
  const header = redeemed.headers.get('set-cookie');
  if (!header || header.length > 8192) throw invalid();
  const cookie = /^([A-Za-z0-9_-]{1,64}=[A-Za-z0-9._-]{1,4096});/u.exec(header)?.[1];
  if (!cookie) throw invalid();
  const sessionUrl = `${endpoint}/auth/session`;
  const session = await fetch(sessionUrl, { redirect: 'error', signal, headers: { cookie } });
  if (session.status !== 200 || session.redirected || session.url !== sessionUrl
    || (await readBody(session))?.authenticated !== true) throw invalid();
  const replay = await fetch(url, { method: 'POST', redirect: 'error', signal,
    headers: { origin: endpoint, 'content-type': 'application/json' }, body: JSON.stringify({ ticket }) });
  if (replay.status !== 401 || replay.redirected || replay.url !== url) throw invalid();
  await replay.body?.cancel();
}

// Never returns a ticket or cookie. The one attempt is burned before child IPC,
// including timeout and unknown-result paths; no external controller route opens.
export async function probeNndPrivateTicketUnderOwnership(identity, state, serviceLease, registryLease, options) {
  assertSelected(identity, state, serviceLease, registryLease, options);
  return withNndServiceLease(serviceLease, identity.data_id, leaseSignal => runManifestLeaseWork(registryLease, async () => {
    const signal = AbortSignal.any([leaseSignal, AbortSignal.timeout(15000),
      ...(options.signal ? [options.signal] : [])]);
    try {
      const before = await verifyNndPublishedTrialHealthUnderOwnership(identity, state,
        serviceLease, registryLease, { ...options, signal, afterVerified: undefined });
      const selected = assertSelected(identity, state, serviceLease, registryLease, options);
      if (before.registration_revision !== selected.registration_revision
        || before.journal_sha256 !== selected.journal_sha256 || before.native_state !== selected.native_state) throw invalid();
      USED.add(state);
      const frame = await state.child.command('issue_ui_ticket');
      if (!exact(frame, ['type', 'protocol', 'generation', 'request_id', 'ticket', 'expires_at'])
        || frame.type !== 'ui_ticket' || frame.protocol !== '1.0' || frame.generation !== options.generation
        || typeof frame.request_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(frame.request_id)) throw invalid();
      assertNndAttach({ protocol: '1.0', installation_id: identity.installation_id,
        data_id: identity.data_id, generation: options.generation, endpoint: state.ui,
        ticket: frame.ticket, expires_at: frame.expires_at }, state.record);
      await redeemPrivateTicket(state.ui, frame.ticket, signal);
      const after = await verifyNndPublishedTrialHealthUnderOwnership(identity, state,
        serviceLease, registryLease, { ...options, signal, afterVerified: undefined });
      if (after.registration_revision !== before.registration_revision || after.journal_sha256 !== before.journal_sha256
        || after.native_state !== before.native_state) throw invalid();
      return Object.freeze({ state: 'private_ticket_verified_unresolved', operation_id: options.operationId,
        generation: options.generation, registration_revision: before.registration_revision,
        journal_sha256: before.journal_sha256 });
    } catch { throw invalid(); }
  }), { timeoutMs: 300000 });
}
