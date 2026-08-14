// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { attachmentsOverlay } from './overlays.js';
import { detachConsoleAttachment, queueConsoleAttachment } from '../experience/attachments.js';

export async function handleAttachmentCommand(name, argument, workspace) {
  if (name === '/attach') {
    const item = await queueConsoleAttachment(workspace, argument);
    workspace.projection.showNotice('attachment', `Queued ${item.path} for the next message.`);
    return;
  }
  if (name === '/attachments') {
    workspace.projection.openOverlay(attachmentsOverlay(workspace.projection.active()));
    return;
  }
  if (name === '/detach') {
    const removed = detachConsoleAttachment(workspace, argument);
    workspace.projection.showNotice('attachment', `Removed ${removed} queued attachment${removed === 1 ? '' : 's'}.`);
    return;
  }
  const [action, id, ...message] = argument.split(/\s+/u).filter(Boolean);
  if (action === 'remove' && id && message.length === 0) {
    await workspace.removeActiveAttachment(id);
    workspace.projection.showNotice('attachment', `Removed managed attachment ${id}.`);
    return;
  }
  if (action === 'retry' && id && message.length > 0) {
    workspace.retryActiveAttachment(id, message.join(' '));
    return;
  }
  throw new ContractError('attachment_command_invalid', 'use /attachment retry ID MESSAGE or /attachment remove ID');
}
