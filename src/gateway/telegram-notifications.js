// SPDX-License-Identifier: Apache-2.0
import { acknowledgeTelegramNotification, MAX_OUTBOX_BATCH, readTelegramOutbox, reconcileTelegramNotifications } from '../notifications/telegram.js';
import { attachedControls } from './controls.js';

export async function drainGatewayNotifications(gateway) {
  const journalCache = new Map();
  const report = (key, type, code) => {
    if (gateway.invalidNotificationIntents.has(key)) return;
    if (gateway.invalidNotificationIntents.size >= 1_024) {
      gateway.invalidNotificationIntents.delete(gateway.invalidNotificationIntents.values().next().value);
    }
    gateway.invalidNotificationIntents.add(key);
    gateway.logger.record({ type, code, outcome: 'failed' });
  };
  const onSourceError = (sessionId, code) => report(`source:${sessionId}:${code}`,
    'gateway_notification_source_failed', code);
  const onFileError = (name, code) => report(`file:${name}:${code}`, 'gateway_notification_file_failed', code);
  await reconcileTelegramNotifications(gateway.paths.telegramOutbox, gateway.paths.sessions, {
    journalCache, offset: gateway.notificationIntentCursor, signal: gateway.controller.signal,
    onInvalid: (name) => report(`intent:${name}`, 'gateway_notification_intent_invalid', 'notification_intent_invalid'),
    onSourceError, onFileError,
  });
  gateway.notificationIntentCursor = (gateway.notificationIntentCursor + MAX_OUTBOX_BATCH) % Number.MAX_SAFE_INTEGER;
  const items = await readTelegramOutbox(gateway.paths.telegramOutbox, gateway.paths.sessions, {
    journalCache, offset: gateway.notificationCursor, signal: gateway.controller.signal, onSourceError, onFileError,
  });
  gateway.notificationCursor = (gateway.notificationCursor + MAX_OUTBOX_BATCH) % Number.MAX_SAFE_INTEGER;
  if (items.length === 0) return;
  const catalog = await gateway.sessionDirectory.list();
  for (const item of items) {
    const source = catalog.find((target) => target.id === item.session_id);
    for (const chatId of gateway.config.authorized_user_ids) {
      const attached = gateway.attachments.get(String(chatId));
      const options = source && attached && attached.targetId === source.targetId ? attachedControls(source.alias)
        : source ? { replyMarkup: { inline_keyboard: [[
          { text: `Attach ${source.alias}`, callback_data: `nna:a:${source.targetId}` },
          { text: 'Sessions', callback_data: 'nna:s' },
        ]] } } : {};
      await gateway.api.sendMessage(String(chatId), `NNA notification (${item.outcome}):\n${item.message}`, gateway.controller.signal, options);
    }
    await acknowledgeTelegramNotification(item);
    gateway.logger.record({ type: 'gateway_notification_delivered', outcome: 'completed', session_id: item.session_id });
  }
}
