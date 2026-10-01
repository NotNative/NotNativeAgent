// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';

export function notificationProviderReply(body) {
  return body.messages?.[0]?.content?.startsWith('Write a short desktop notification')
    ? JSON.stringify({ title: 'NND_MODEL_NOTIFICATION', body: 'The native agent completed its verified smoke work.' }) : null;
}
export async function probeNotificationModel(sessionId, providerRequests) {
  const { NotificationModelText } = await import('../packages/web/src/server/notifications/model-text.ts');
  const renderer = new NotificationModelText();
  const payload = { title: 'Fallback title', body: 'Fallback body', kind: 'completion', sessionId, directory: '',
    tag: `completion:${sessionId}`, requireHidden: true };
  try {
    const rendered = await renderer.render(payload, () => true);
    assert.equal(rendered.title, 'NND_MODEL_NOTIFICATION', 'native model route fell back instead of generating notification text');
    assert.equal(rendered.body, 'The native agent completed its verified smoke work.');
    assert.equal(rendered.sessionId, sessionId); assert.equal(rendered.tag, payload.tag);
    const call = providerRequests().find((body) => notificationProviderReply(body));
    assert.ok(call, 'notification did not use the native configured provider');
    assert.ok(call.tools === undefined || call.tools.length === 0, 'notification model received tools');
    assert.ok(call.messages[1].content.includes('NND_PARENT_REPLY'), 'notification context omitted the native assistant text');
    const { generateNativeNotification } = await import('../packages/web/src/server/notifications/native-text.ts');
    const override = new NotificationModelText({ generate: (raw, _ports, signal) => generateNativeNotification(raw,
      { settings: async () => ({ smallModelUseDefault: false, smallModelOverride: 'delegated/notification-smoke' }) }, signal) });
    try {
      assert.equal((await override.render(payload, () => true)).title, 'NND_MODEL_NOTIFICATION');
      assert.ok(providerRequests().some((request) => notificationProviderReply(request) && request.model === 'notification-smoke'),
        'Small Model override did not reach the native configured profile/model');
    } finally { override.dispose(); }
  } finally { renderer.dispose(); }
}
