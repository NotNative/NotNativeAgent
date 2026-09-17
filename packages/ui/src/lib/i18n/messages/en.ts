// SPDX-License-Identifier: Apache-2.0
/**
 * Canonical English dictionary (doc 14 §H.2): the flat dotted key→string map;
 * the exported I18nKey type is the CLOSED key set — non-EN catalogs may only
 * carry subsets. P5-4 scope: shell/boot-notification keys; the settings
 * surfaces grow their namespaces as their pages land (§Letters A–E in
 * PROGRESS).
 */

const en = {
  'app.title': 'NotNativeDesktop',
  'shell.sessions': 'Sessions',
  'shell.newSession': 'New session',
  'shell.chatPlaceholder': 'Send a message to the harness…',
  'shell.send': 'Send',
  'shell.noSession': 'No session selected',
  'shell.connecting': 'Connecting to harness…',
  'shell.connected': 'Harness connected',
  'shell.offline': 'Harness offline',
  'shell.mockBanner': 'Mock harness — NotNativeAgent integration pending',
  'shell.busy': 'Working…',
  'shell.recovery.title': 'Startup did not finish',
  'shell.recovery.retry': 'Retry',
  // Pre-dictionary bootstrap strings (§H.3): splash/connection copy that
  // speaks before dictionaries install (bootstrap.ts resolves these ids).
  'bootstrap.connecting': 'Connecting…',
  'bootstrap.loading': 'Loading NotNativeDesktop…',
  'bootstrap.cliMissing': 'Harness CLI not found on this machine.',
  'bootstrap.devServerWait': 'Waiting for the dev server… (port {port})',
  'bootstrap.offline': 'The connection dropped. Retrying…',
  // Notification template i18n-key DEFAULTS (§G.8): templates hold KEYS,
  // never raw strings; the defaults page (P6+) writes these references.
  'settings.notifications.page.template.defaults.completion.title': 'Agent finished',
  'settings.notifications.page.template.defaults.completion.message': 'The session completed its turn.',
  'settings.notifications.page.template.defaults.error.title': 'Agent error',
  'settings.notifications.page.template.defaults.error.message': 'The session hit an error.',
  'settings.notifications.page.template.defaults.question.title': 'Agent question',
  'settings.notifications.page.template.defaults.question.message': 'The agent needs your input.',
  'settings.notifications.page.template.defaults.subtask.title': 'Subtask progress',
  'settings.notifications.page.template.defaults.subtask.message': 'A subtask reported new progress.',
};

export type I18nKey = keyof typeof en;
export type Dictionary = Record<I18nKey, string>;
export type PartialDictionary = Partial<Dictionary>;
export default en as Dictionary;
