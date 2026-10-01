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
import { NotificationSessions } from '../notifications/session-state.ts';
import { NotificationModelText } from '../notifications/model-text.ts';

export function createPushServices() {
  const store = new PushSubscriptionStore(join(ENV.dataDir, 'push-subscriptions.json'));
  const visibility = new PushVisibility();
  const badges = new PushBadges();
  const delivery = new PushDelivery({ store, visibility, badges, subject: () => pushSubject(process.env.NOTNATIVE_PUSH_SUBJECT) });
  return { store, visibility, badges, delivery, sessions: new NotificationSessions(), text: new NotificationModelText() };
}

/** Shares the server-owned harness feed; no browser must be open for events to arrive. */
export function attachPushNotifications(services: ReturnType<typeof createPushServices>, feed: QueueFeed): () => void {
  let attached = true;
  const handle = createDesktopNotificationEventHandler({ settings: () => readMergedSettings('web'),
    notify: async (payload) => {
      const queuedRevision = services.badges?.checkpoint();
      const observed = services.sessions?.get(payload.sessionId);
      // Invariant: delayed subtask text needs a tracked parent to reject stale work.
      if (services.text && payload.kind === 'subtask' && !observed) return false;
      const completedRevision = observed?.completedRevision;
      const startedRevision = observed?.startedRevision;
      const eligible = () => {
        if (!attached) return false;
        if (observed) {
          const current = services.sessions.get(payload.sessionId);
          if (current !== observed || current.startedRevision !== startedRevision) return false;
          if ((payload.kind === 'completion' || payload.kind === 'error')
            && (current.status !== 'idle' || current.completedRevision !== completedRevision)) return false;
          if (payload.kind === 'question' && payload.eventId && !current.forms.has(payload.eventId)) return false;
        }
        const settings = readMergedSettings('web');
        const eventEnabled = payload.kind === 'completion' ? settings.notifyOnCompletion
          : payload.kind === 'error' ? settings.notifyOnError
          : payload.kind === 'question' ? settings.notifyOnQuestion : settings.notifyOnSubtasks;
        return settings.nativeNotificationsEnabled === true && eventEnabled === true;
      };
      const rendered = services.text ? await services.text.render(payload, eligible) : payload;
      if (!eligible()) return false;
      services.sessions?.publish({ type: 'notnative:notification', properties: { ...rendered } });
      return (await (queuedRevision === undefined ? services.delivery.deliver(rendered, eligible)
        : services.delivery.deliver(rendered, eligible, queuedRevision))).sent > 0;
    } });
  const stopConnected = feed.onConnected(() => { void services.sessions?.refresh(true).catch(() => undefined); });
  const stopEvents = feed.onEvent((envelope) => {
    services.sessions?.observe(envelope);
    handle({ type: envelope.payload.type, properties: envelope.payload.properties, directory: envelope.directory });
  });
  return () => { attached = false; stopConnected(); stopEvents(); services.text?.dispose(); };
}
