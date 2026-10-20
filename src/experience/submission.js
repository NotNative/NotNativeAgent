// SPDX-License-Identifier: Apache-2.0
import { ContractError, newId } from '../ids.js';

export function beginSessionSubmission(workspace, session, content, options) {
  const requestId = options.requestId ?? newId(options.requestPrefix);
  const alreadyPending = session.pendingSubmission;
  if (alreadyPending && alreadyPending.requestId !== requestId) {
    throw new ContractError('turn_submission_pending', 'wait for the pending submission to be accepted');
  }
  const projected = workspace.projection.sessions.get(session.id);
  const queuedAttachments = options.includeAttachments ? [...projected.pendingAttachments] : [];
  const pending = {
    requestId, content, queuedAttachments, accepted: false,
    editorRevision: options.fromEditor ? projected.editor.revision : null,
  };
  if (!alreadyPending) session.pendingSubmission = pending;
  let started;
  try {
    const command = {
      version: '1.0', type: 'submit', request_id: pending.requestId, content,
      ...(options.includeAttachments ? {
        attachments: queuedAttachments.map(({ path, mime_type }) => ({ path, mime_type })),
      } : {}),
    };
    started = typeof session.ingress.start === 'function'
      ? session.ingress.start(command, options.principal)
      : { duplicate: false, operation: session.ingress.submit(command, options.principal) };
  } catch (error) {
    if (!alreadyPending) session.pendingSubmission = null;
    throw error;
  }
  if (started.duplicate) {
    if (!alreadyPending) session.pendingSubmission = null;
    return Promise.resolve(started.result);
  }
  if (alreadyPending) throw new ContractError('turn_submission_pending', 'wait for the pending submission to be accepted');
  return started.operation.then(async (result) => {
    if (pending.accepted) await workspace._maybeAutoName?.(session);
    else if (options.reportRejection && result?.accepted === false) {
      workspace.projection.showNotice('submit', 'Message was not accepted; your draft and attachments remain queued.');
      workspace.onChange();
    }
    return result;
  }).finally(() => { if (session.pendingSubmission === pending) session.pendingSubmission = null; });
}

export function acceptPendingSubmission(workspace, session, event) {
  const pending = session?.pendingSubmission;
  if (event.type !== 'accepted' || event.accepted !== true || pending?.requestId !== event.request_id
    || pending.accepted) return false;
  // Invariant: only a matching accepted ingress receipt consumes operator work.
  pending.accepted = true;
  session.meaningful = true;
  const projected = workspace.projection.sessions.get(session.id);
  if (projected) {
    const consumed = new Set(pending.queuedAttachments);
    projected.pendingAttachments = projected.pendingAttachments.filter((item) => !consumed.has(item));
    if (pending.editorRevision !== null && projected.editor.revision === pending.editorRevision
      && projected.editor.text === pending.content) projected.editor.take();
    workspace.projection.apply(session.id, { type: 'user_input', text: pending.content });
  }
  workspace.tabPersistence.observe(workspace._savePoolForBroker(), workspace._tasksForBroker());
  return true;
}
