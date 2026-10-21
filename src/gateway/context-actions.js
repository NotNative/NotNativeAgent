// SPDX-License-Identifier: Apache-2.0

// Invariant: record a single command attempt and its target before a context effect.
// A crash after this point recovers as uncertain; replay never repeats the effect.
export async function runGatewayContextAction({ action, chatId, updateId, userId, replay,
  selection, directory, standalone, logger, prestarted = false, fenceRequestIds = [] }) {
  const attached = selection
    ? (await directory.list()).find((item) => item.targetId === selection.targetId)
    : null;
  if (selection && !attached) {
    await replay.queueReply(updateId, chatId, userId,
      `${selection.alias} is no longer available. ${action} was not applied to the standalone conversation.`, '');
    return;
  }
  if (!prestarted) await replay.beginControl(updateId, action, selection?.targetId ?? null);
  let message;
  try {
    let result;
    if (attached && action === 'cancel') result = attached.turn_id || fenceRequestIds.length
      ? await directory.cancel(attached, attached.turn_id ?? undefined, fenceRequestIds)
      : { accepted: true, already_terminal: true };
    else if (attached) result = await directory[action](attached);
    else if (action === 'cancel') result = await standalone();
    else {
      const engine = await standalone();
      result = await engine[standaloneMethod(action)]();
    }
    message = successMessage(action, result, attached?.alias ?? null);
  } catch (error) {
    const busy = ['compaction_busy', 'handoff_busy', 'clear_busy'].includes(error?.code);
    message = busy ? `Cannot ${action} while a turn is active. Wait for it to finish or use /cancel first.`
      : `NNA could not confirm whether ${action} took effect. Inspect this conversation before retrying.`;
    await replay.queueReply(updateId, chatId, userId, message, attached?.alias ?? '');
    logger.record({ type: 'gateway_context_control_failed', operation: action,
      code: error?.code ?? 'context_control_failed', outcome: 'failed' });
    return;
  }
  await replay.queueReply(updateId, chatId, userId, message, attached?.alias ?? '');
  logger.record({ type: `gateway_context_${action === 'clear' ? 'cleared' : action === 'compact' ? 'compacted' : action}`,
    outcome: 'completed', attached: Boolean(attached) });
}

function standaloneMethod(action) {
  return { compact: 'compactConversation', handoff: 'handoffConversation', clear: 'clearConversation' }[action];
}

function successMessage(action, result, alias) {
  if (action === 'cancel') {
    if (result?.target_unknown === true) return 'NNA could not safely identify the active turn to cancel.';
    if (result?.already_terminal === true) return 'No active turn.';
    if (result?.accepted === true) return alias ? `Cancellation requested for ${alias}.` : 'Cancellation requested.';
    throw new TypeError('cancellation result is incomplete');
  }
  const fields = action === 'clear' ? ['removed'] : action === 'handoff' ? ['omitted'] : ['omitted', 'retained'];
  if (!result || fields.some((field) => !Number.isSafeInteger(result[field]) || result[field] < 0)
    || action === 'compact' && result.reduced !== undefined
      && (!Number.isSafeInteger(result.reduced) || result.reduced < 0)) {
    throw new TypeError('context control result is incomplete');
  }
  if (action === 'clear') return `Conversation cleared. Removed ${result.removed} context records.`;
  if (action === 'handoff') return `Terse self-handoff created from ${result.omitted} records. Future context starts from that handoff.`;
  const reduced = result.reduced ? ` Reduced ${result.reduced} retained payloads.` : '';
  return `Context compacted. Omitted ${result.omitted} settled records and retained ${result.retained}.${reduced}`;
}
