// SPDX-License-Identifier: Apache-2.0
import en from '../lib/i18n/messages/en.ts';

type NotificationKind = 'completion' | 'error' | 'question' | 'subtask';
type NotificationSettings = {
  nativeNotificationsEnabled?: boolean;
  notificationMode?: 'always' | 'hidden-only';
  notifyOnCompletion?: boolean;
  notifyOnError?: boolean;
  notifyOnQuestion?: boolean;
  notifyOnSubtasks?: boolean;
  notificationTemplates?: Record<string, { titleKey?: string; messageKey?: string }>;
};

type NotificationPayload = { title: string; body: string; kind: NotificationKind; sessionId: string; directory: string; tag: string; requireHidden: boolean };
type DesktopNotificationEvent = { type: string; properties?: Record<string, unknown>; directory?: string };

const DEFAULTS: Record<NotificationKind, { title: string; body: string }> = {
  completion: { title: 'Agent finished', body: 'The session completed its turn.' },
  error: { title: 'Agent error', body: 'The session hit an error.' },
  question: { title: 'Agent question', body: 'The agent needs your input.' },
  subtask: { title: 'Subtask progress', body: 'A subtask reported new progress.' },
};

function boundedString(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function localizedTemplate(settings: NotificationSettings, kind: NotificationKind): { title: string; body: string } {
  const fallback = DEFAULTS[kind];
  const template = settings.notificationTemplates?.[kind];
  const title = template?.titleKey ? en[template.titleKey as keyof typeof en] : undefined;
  const body = template?.messageKey ? en[template.messageKey as keyof typeof en] : undefined;
  return { title: typeof title === 'string' ? title : fallback.title, body: typeof body === 'string' ? body : fallback.body };
}

function classifyEvent(event: DesktopNotificationEvent, props: Record<string, unknown>): { kind: NotificationKind; eventId: string } | null {
  if (event.type === 'session.idle') return { kind: 'completion', eventId: '' };
  if (event.type === 'session.error') return { kind: 'error', eventId: '' };
  if (event.type === 'question.asked') return { kind: 'question', eventId: boundedString(props.id, 256) };
  if (event.type === 'nnd.activity' && props.kind === 'subagent'
    && (props.status === 'completed' || props.status === 'failed')) {
    return { kind: 'subtask', eventId: boundedString(props.id, 256) };
  }
  return null;
}

/** Convert live harness events into preference-gated runtime notifications.
 * Stable question/activity ids and short-lived settle fingerprints suppress
 * reconnect replays without hiding a later turn in the same session. */
export function createDesktopNotificationEventHandler(input: {
  settings: () => NotificationSettings;
  notify: (payload: NotificationPayload) => Promise<boolean> | boolean;
  resolveDirectory?: (sessionId: string) => string | undefined;
  shouldNotify?: (event: DesktopNotificationEvent, kind: NotificationKind, sessionId: string) => boolean;
  now?: () => number;
}): (event: DesktopNotificationEvent) => void {
  const delivered = new Map<string, { timestamp: number; stableEventId: boolean }>();
  const now = input.now ?? Date.now;

  return (event) => {
    const props = event.properties ?? {};
    const sessionId = boundedString(props.sessionID, 500);
    if (!sessionId) return;
    const directory = boundedString(event.directory, 2_000)
      || boundedString(input.resolveDirectory?.(sessionId), 2_000);
    const routedEvent = directory ? { ...event, directory } : event;
    const classified = classifyEvent(event, props);
    if (!classified) return;
    const { kind, eventId } = classified;

    const settings = input.settings();
    if (settings.nativeNotificationsEnabled !== true) return;
    const enabled = kind === 'completion' ? settings.notifyOnCompletion === true
      : kind === 'error' ? settings.notifyOnError === true
      : kind === 'question' ? settings.notifyOnQuestion === true
      : settings.notifyOnSubtasks === true;
    if (!enabled) return;
    if (input.shouldNotify && !input.shouldNotify(routedEvent, kind, sessionId)) return;

    const identity = `${directory}\0${sessionId}\0${kind}\0${eventId}`;
    const timestamp = now();
    // Settle events have no authored id, so expire their short fingerprint to
    // allow a later turn in the same session. Question/subtask ids are authored
    // identities and must remain deduped across reconnects, however long they
    // take to happen.
    for (const [key, value] of delivered) {
      if (!value.stableEventId && timestamp - value.timestamp >= 5_000) delivered.delete(key);
    }
    if (delivered.has(identity)) return;
    delivered.set(identity, { timestamp, stableEventId: !!eventId });
    if (delivered.size > 2_000) delivered.delete(delivered.keys().next().value!);

    const template = localizedTemplate(settings, kind);
    const eventText = kind === 'question' ? boundedString((props.questions as { question?: unknown }[] | undefined)?.[0]?.question, 1_000) : '';
    const subtaskText = kind === 'subtask' ? boundedString(props.summary, 1_000) : '';
    const body = eventText || subtaskText || template.body;
    const tag = eventId ? `${kind}:${sessionId}:${eventId}` : `${kind}:${sessionId}`;
    try {
      void Promise.resolve(input.notify({ title: template.title, body, kind, sessionId,
        directory, tag,
        requireHidden: settings.notificationMode === 'hidden-only' })).catch(() => undefined);
    } catch { /* notifications are best-effort and never interrupt event sync */ }
  };
}
