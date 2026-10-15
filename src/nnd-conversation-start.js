// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { ContractError, newId } from './ids.js';

/** A draft's stable operation ID recovers its session after a lost create response. */
export function conversationCreation(principal, options, operationId) {
  if (operationId === undefined) return { sessionId: newId('ses'), options };
  if (typeof operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/u.test(operationId)) {
    throw new ContractError('request_invalid', 'Conversation operation ID is invalid');
  }
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const sessionId = `ses_${digest([principal.subjectId, operationId]).slice(0, 40)}`;
  const creationFingerprint = digest([options.directory, options.workspace_id ?? null, options.title ?? null,
    options.modelRoute?.providerId ?? null, options.modelRoute?.model ?? null, options.reviewMode ?? 'default', options.startFingerprint ?? null]);
  return { sessionId, options: { ...options, creationFingerprint } };
}

/** Replay only a session owned by this operator, with exactly the original creation settings. */
export async function replayConversation(existing, options, validate, create) {
  if (!existing || !options.creationFingerprint) return create();
  await validate();
  if (existing.creationFingerprint !== options.creationFingerprint) {
    throw new ContractError('nnd_session_exists', 'Conversation settings changed under the same operation ID');
  }
  return existing;
}
