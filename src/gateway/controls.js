// SPDX-License-Identifier: Apache-2.0
export function attachedControls(alias) {
  return { replyMarkup: { inline_keyboard: [[
    { text: `Detach from ${String(alias).slice(0, 30)}`, callback_data: 'nna:d' },
    { text: 'Sessions', callback_data: 'nna:s' },
  ]] } };
}

export function clearConfirmationControls() {
  return { replyMarkup: { inline_keyboard: [[
    { text: 'Clear conversation', callback_data: 'nna:clear:y' },
    { text: 'Keep conversation', callback_data: 'nna:clear:n' },
  ]] } };
}

export function pendingSubmissionUpdate(update, chatId, cancelId) {
  const text = update?.message?.text?.trim();
  if (typeof text !== 'string' || !text || String(update.message?.chat?.id) !== chatId
    || Number(update.update_id) >= cancelId) return false;
  return !/^\/attach(?:\s|$)/iu.test(text)
    && !/^\/(?:cancel|start|help|sessions|detach|compact(?:@\w+)?|handoff(?:@\w+)?|clear(?:@\w+)?(?:\s+(?:confirm|cancel))?)$/iu.test(text);
}
