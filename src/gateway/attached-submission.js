// SPDX-License-Identifier: Apache-2.0

export async function attachedSubmissionReply(directory, attached, text, updateId) {
  let result;
  try {
    result = await directory.submit(attached, text, `gateway_update_${updateId}`);
  } catch (error) {
    // Why: the durable Telegram inbox acknowledges this update after the reply;
    // never leave an admission error known only to local logs.
    return error?.code === 'turn_submission_pending'
      ? 'That conversation is accepting another message. Please send this one again after it finishes.'
      : 'NNA could not confirm delivery to the attached conversation. Check that conversation before trying again.';
  }
  return result.cancelled ? 'Message cancelled before starting.'
    : result.duplicate ? 'That message was already received by the attached conversation.'
    : result.text || turnFallback(result);
}

export function turnFallback(result) {
  if (result.outcome === 'needs_input') return 'I need more information to continue.';
  if (result.outcome === 'cancelled') return 'Turn cancelled.';
  if (result.outcome === 'failed') {
    const code = result.failure?.code ?? 'internal_failure';
    if (code === 'invalid_event_phase') {
      return `NNA encountered an internal session-maintenance error after processing the request (${code}). Any response already received remains available, and the conversation was preserved. Retry if more work was expected; use /support if this repeats.`;
    }
    return `NNA could not finish the turn (${code}). The conversation was preserved. Please retry; use /support if this repeats.`;
  }
  return `Turn ${result.outcome ?? 'failed'}.`;
}
