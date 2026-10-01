// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { ENV } from '../env.ts';
import { readMergedSettings } from '../lib/settings-store.ts';
import type { QueueFeed } from '../queue/queue-feed.ts';
import { createDesktopNotificationEventHandler } from '../../../../ui/src/sync/desktop-notifications.ts';
import { PushSubscriptionStore } from './subscription-store.ts';
import { PushVisibility } from './visibility.ts';
import { PushDelivery } from './delivery.ts';
import { pushSubject } from './transport.ts';
import { PushBadges } from './badge-state.ts';

export function createPushServices() {
  const store = new PushSubscriptionStore(join(ENV.dataDir, 'push-subscriptions.json'));
  const visibility = new PushVisibility();
  const badges = new PushBadges();
  const delivery = new PushDelivery({ store, visibility, badges, subject: () => pushSubject(process.env.NOTNATIVE_PUSH_SUBJECT) });
  return { store, visibility, badges, delivery };
}

/** Shares the server-owned harness feed; no browser must be open for events to arrive. */
export function attachPushNotifications(services: ReturnType<typeof createPushServices>, feed: QueueFeed): () => void {
  const handle = createDesktopNotificationEventHandler({ settings: () => readMergedSettings('web'),
    notify: async (payload) => (await services.delivery.deliver(payload, () => {
      const settings = readMergedSettings('web');
      const eventEnabled = payload.kind === 'completion' ? settings.notifyOnCompletion
        : payload.kind === 'error' ? settings.notifyOnError
        : payload.kind === 'question' ? settings.notifyOnQuestion : settings.notifyOnSubtasks;
      return settings.nativeNotificationsEnabled === true && eventEnabled === true;
    })).sent > 0 });
  return feed.onEvent((envelope) => handle({ type: envelope.payload.type, properties: envelope.payload.properties, directory: envelope.directory }));
}
