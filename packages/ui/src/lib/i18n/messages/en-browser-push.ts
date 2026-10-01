// SPDX-License-Identifier: Apache-2.0
export const enBrowserPush = {
  'push.heading': 'Background notifications',
  'push.hint': 'Register this browser with the current connection to receive notifications while the application is closed.',
  'push.unavailable': 'Background notifications require a supported secure browser connected to this application’s origin.',
  'push.checking': 'Checking browser subscription…',
  'push.existing': 'A browser subscription exists. Register it to confirm this connection.',
  'push.registered': 'This browser is registered with this connection.',
  'push.off': 'This browser is not subscribed.',
  'push.unknown': 'Subscription status is unconfirmed. Refresh or retry.',
  'push.failed': 'The change was not confirmed. Check browser permission and the connection, then retry.',
  'push.enable': 'Register this browser',
  'push.disable': 'Unsubscribe this browser',
  'push.refresh': 'Refresh subscription',
  'push.saving': 'Updating subscription…',
} as const;
